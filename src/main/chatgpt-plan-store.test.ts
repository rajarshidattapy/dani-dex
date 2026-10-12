import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatGptAuthorizationAttempt } from "./chatgpt-plan-oauth";
import { ChatGptPlanStore, type ChatGptRegistration } from "./chatgpt-plan-store";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});
const cipher = {
  encrypt: (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x55)),
  decrypt: (b: Buffer) =>
    Buffer.from(b)
      .map((n) => n ^ 0x55)
      .toString(),
};
const record: ChatGptRegistration = {
  clientId: "issued-1",
  subject: "subject-1",
  email: "test@example.com",
  accessToken: "private-access",
  refreshToken: "private-refresh",
  idToken: "private-id",
  scopes: ["openid"],
  expiresAt: 1900000000,
};
async function fixture() {
  const h = await mkdtemp(join(tmpdir(), "dani-oauth-store-"));
  homes.push(h);
  return join(h, "accounts.json");
}
describe("ChatGPT protected registrations", () => {
  it("persists stable host identity and ciphertext across restart", async () => {
    const path = await fixture(),
      store = new ChatGptPlanStore(path, cipher);
    await store.load();
    const host = store.hostId();
    expect(host).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    await store.save(record);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("private-access");
    expect(raw).not.toContain("test@example.com");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const next = new ChatGptPlanStore(path, cipher);
    await next.load();
    expect(next.hostId()).toBe(host);
    expect(next.read("issued-1")).toEqual(record);
    await store.select("issued-1");
    const restarted = new ChatGptPlanStore(path, cipher);
    await restarted.load();
    expect(restarted.selected()).toEqual(record);
  });
  it("upgrades a legacy bare UUID in place and produces the accepted authorize parameter", async () => {
    const path = await fixture();
    const uuid = "de305d54-75b4-431b-adb2-eb6b9e546014";
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        ciphertext: cipher
          .encrypt(
            JSON.stringify({ version: 1, hostId: uuid, registrations: [record], selectedClientId: record.clientId }),
          )
          .toString("base64"),
      }),
    );
    const store = new ChatGptPlanStore(path, cipher);
    await store.load();
    expect(store.hostId()).toBe(`urn:uuid:${uuid}`);
    expect(store.selected()).toEqual(record);
    const auth = new URL(
      new ChatGptAuthorizationAttempt({
        hostId: store.hostId(),
        appName: "Dani-Dex",
        redirectUri: "http://127.0.0.1:54321/auth/callback",
      }).authorizationUrl,
    );
    expect(auth.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${uuid}`);
    const restarted = new ChatGptPlanStore(path, cipher);
    await restarted.load();
    expect(restarted.hostId()).toBe(store.hostId());
    expect(restarted.selected()).toEqual(record);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    expect(JSON.parse(cipher.decrypt(Buffer.from(envelope.ciphertext, "base64"))).hostId).toBe(`urn:uuid:${uuid}`);
  });
  it("serializes concurrent updates and removes only the selected registration", async () => {
    const store = new ChatGptPlanStore(await fixture(), cipher);
    await store.load();
    await Promise.all([store.save(record), store.save({ ...record, clientId: "issued-2", subject: "subject-2" })]);
    expect(store.list()).toHaveLength(2);
    await expect(store.save({ ...record, subject: "different" })).rejects.toThrow("identity");
    await store.select("issued-2");
    await store.remove("issued-1");
    expect(store.selected()?.clientId).toBe("issued-2");
    expect(store.list().map((r) => r.clientId)).toEqual(["issued-2"]);
  });
  it("keeps unreadable storage instead of overwriting unrelated credentials", async () => {
    const path = await fixture();
    await writeFile(path, "old-unreadable");
    const store = new ChatGptPlanStore(path, cipher);
    await expect(store.load()).rejects.toThrow("kept");
    await expect(store.save(record)).rejects.toThrow("secure storage");
    expect(await readFile(path, "utf8")).toBe("old-unreadable");
  });
  it("does not write plaintext or publish memory when OS encryption fails", async () => {
    const path = await fixture();
    const store = new ChatGptPlanStore(path, {
      encrypt: () => {
        throw Error("Locked keychain");
      },
      decrypt: cipher.decrypt,
    });
    await expect(store.load()).rejects.toThrow("Locked");
    await expect(readFile(path)).rejects.toThrow();
    expect(() => store.hostId()).toThrow("secure storage");
  });
});
