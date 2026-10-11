import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DevicePairingService } from "./device-pairing-service";
import { INPUT_LIMITS } from "@dani-dex/contracts/input-limits";
import { TeamStore } from "./team-store";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dani-device-pairing-"));
  roots.push(root);
  const store = new TeamStore(join(root, "team.json"));
  await store.initialize();
  await store.configure("Dani-Dex", "device-owner", "random-owner-password");
  let now = Date.now();
  const pairing = new DevicePairingService(store, () => now);
  const link = () => new URL(pairing.createLink("https://host.example").url);
  const redeem = (url: URL) => {
    const data = new URLSearchParams(url.hash.slice(1));
    return pairing.redeem(
      data.get("ticket") ?? "",
      data.get("host") ?? "",
      data.get("fingerprint") ?? "",
      "Android phone",
    );
  };
  return {
    store,
    pairing,
    link,
    redeem,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("pairs once without an account, persists a revocable device session, and rejects concurrent reuse", async () => {
  const f = await fixture();
  const url = f.link();
  expect(url.search).toBe("");
  const [a, b] = await Promise.allSettled([f.redeem(url), f.redeem(url)]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("rejected");
  if (a.status !== "fulfilled") throw new Error("Expected device session");
  expect(f.store.authenticate(a.value.sessionToken)?.role).toBe("owner");
  await f.store.logout(a.value.sessionToken);
  expect(f.store.authenticate(a.value.sessionToken)).toBeNull();
});
it("rejects expired, replaced, malformed and cancelled invitations", async () => {
  const f = await fixture();
  const old = f.link();
  const current = f.link();
  await expect(f.redeem(old)).rejects.toThrow("invalid or expired");
  f.advance(14 * 24 * 60 * 60 * 1_000 + 1);
  await expect(f.redeem(current)).rejects.toThrow("invalid or expired");
  const next = f.link();
  f.pairing.cancel();
  await expect(f.redeem(next)).rejects.toThrow("invalid or expired");
  await expect(f.pairing.redeem("bad", "host", "key", "phone")).rejects.toThrow("invalid or expired");
});
it("rejects host substitution and insecure/public-origin credentials without consuming the valid invitation", async () => {
  const f = await fixture();
  expect(() => f.pairing.createLink("http://host.example")).toThrow("HTTPS");
  expect(() => f.pairing.createLink("https://user:password@host.example")).toThrow("HTTPS");
  const url = f.link();
  const data = new URLSearchParams(url.hash.slice(1));
  await expect(
    f.pairing.redeem(data.get("ticket") ?? "", "other-host", data.get("fingerprint") ?? "", "phone"),
  ).rejects.toThrow("invalid or expired");
  expect((await f.redeem(url)).sessionToken).toBeTruthy();
});

it("refuses a new device at the session cap instead of silently revoking another device", async () => {
  const f = await fixture();
  const tokens: string[] = [];
  for (let i = 0; i < INPUT_LIMITS.sessionsPerMember; i++) tokens.push((await f.redeem(f.link())).sessionToken);
  await expect(f.redeem(f.link())).rejects.toThrow("Revoke an existing");
  expect(tokens.every((token) => f.store.authenticate(token) !== null)).toBe(true);
});

it("redeems a short host code once and rejects links from the same invitation afterward", async () => {
 const f=await fixture();const invitation=f.pairing.createLink("https://host.example");
 expect(invitation.code).toMatch(/^[0-9]{8}$/u);expect(invitation.appUrl).toBe("https://host.example/device-pairing");
 expect((await f.pairing.redeemCode(invitation.code,"Browser phone")).sessionToken).toBeTruthy();
 await expect(f.pairing.redeemCode(invitation.code,"Browser phone")).rejects.toThrow("invalid or expired");
 await expect(f.redeem(new URL(invitation.url))).rejects.toThrow("invalid or expired");
});
it("limits guessing globally and expires or replaces the host code", async () => {
 const f=await fixture();const old=f.pairing.createLink("https://host.example");const next=f.pairing.createLink("https://host.example");
 await expect(f.pairing.redeemCode(old.code,"phone")).rejects.toThrow();
 const wrong=next.code==="00000000"?"11111111":"00000000";
 for(let i=0;i<9;i++)await expect(f.pairing.redeemCode(wrong,"phone")).rejects.toThrow();
 await expect(f.pairing.redeemCode(next.code,"phone")).rejects.toThrow();
 const expired=f.pairing.createLink("https://host.example");f.advance(900001);
 await expect(f.pairing.redeemCode(expired.code,"phone")).rejects.toThrow();
});

it("allows next-day setup and creates a full 30-day session", async () => {
  const f = await fixture();
  const invitation = f.pairing.createLink("https://host.example");
  const issuedAt = Date.now();
  expect(invitation.expiresAt - issuedAt).toBeGreaterThan(23 * 60 * 60 * 1000);
  f.advance(23 * 60 * 60 * 1000);
  vi.spyOn(Date, "now").mockReturnValue(invitation.expiresAt - 13 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000);
  const paired = await f.pairing.redeemCode(invitation.code, "Personal phone");
  expect(Date.parse(f.store.listSessions().find((s) => s.username === "Personal phone")!.expiresAt) - invitation.expiresAt).toBe(16 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000);
  await expect(f.pairing.redeemCode(invitation.code, "Other phone")).rejects.toThrow();
});
