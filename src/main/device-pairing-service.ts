import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError } from "./team-api/http-error";
import type { AuthenticatedMember, TeamIdentity } from "./team-store";

const INVITATION_TTL = 14 * 24 * 60 * 60 * 1_000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1_000;

/** Device-only invitations. The host creates these locally, never through an unauthenticated request. */
export class DevicePairingService {
  #invitation: { hash: Buffer; expiresAt: number; hostId: string } | null = null;

  #code: { hash: Buffer; expiresAt: number; hostId: string; remainingAttempts: number } | null = null;

  constructor(
    private readonly host: {
      getIdentity(): TeamIdentity | null;
      openDeviceSession(deviceName: string, expiresAt: number): Promise<AuthenticatedMember>;
    },
    private readonly now = Date.now,
    private readonly statePath?: string,
  ) {
    if (!statePath) return;
    try {
      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      for (const key of ["invitation", "code"] as const) {
        const item = saved[key];
        if (!item) continue;
        if (
          typeof item.hash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(item.hash) ||
          typeof item.hostId !== "string" ||
          !Number.isFinite(item.expiresAt) ||
          item.expiresAt <= now()
        )
          continue;
        if (key === "invitation") this.#invitation = { ...item, hash: Buffer.from(item.hash, "hex") };
        else if (Number.isInteger(item.remainingAttempts) && item.remainingAttempts > 0 && item.remainingAttempts <= 10)
          this.#code = { ...item, hash: Buffer.from(item.hash, "hex") };
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.#invitation = null;
        this.#code = null;
      }
    }
  }
  #persist(): void {
    if (!this.statePath) return;
    const encode = (item: { hash: Buffer; expiresAt: number; hostId: string } | null) =>
      item ? { ...item, hash: item.hash.toString("hex") } : null;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(
      this.statePath + ".tmp",
      JSON.stringify({ invitation: encode(this.#invitation), code: encode(this.#code) }),
      { mode: 0o600 },
    );
    renameSync(this.statePath + ".tmp", this.statePath);
  }

  createLink(origin: string): { url: string; expiresAt: number; code: string; appUrl: string } {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Device pairing needs the host's HTTPS origin.");
    const identity = this.host.getIdentity();
    if (!identity) throw new Error("The Dani-Dex host is not ready.");
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + INVITATION_TTL;
    this.#invitation = { hash: digest(ticket), expiresAt, hostId: identity.serverId };
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    this.#code = { hash: digest(code), expiresAt, hostId: identity.serverId, remainingAttempts: 10 };
    this.#persist();
    url.pathname = "/device-pairing";
    // The browser does not send the fragment in HTTP requests or Referer headers.
    url.hash = new URLSearchParams({ ticket, host: identity.serverId, fingerprint: identity.fingerprint }).toString();
    return { url: url.toString(), expiresAt, code, appUrl: `${url.origin}/device-pairing` };
  }

  async redeem(ticket: string, hostId: string, fingerprint: string, deviceName: string): Promise<AuthenticatedMember> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket) || !deviceName.trim() || deviceName.length > 80)
      throw new HttpError(400, "This device invitation is invalid or expired.");
    const invitation = this.#invitation;
    const identity = this.host.getIdentity();
    if (
      !invitation ||
      invitation.expiresAt <= this.now() ||
      !identity ||
      identity.serverId !== invitation.hostId ||
      hostId !== identity.serverId ||
      fingerprint !== identity.fingerprint ||
      !timingSafeEqual(invitation.hash, digest(ticket))
    )
      throw new HttpError(400, "This device invitation is invalid or expired.");
    // Consume before any async persistence, so simultaneous redemptions cannot both succeed.
    this.cancel();
    return this.host.openDeviceSession(deviceName.trim(), this.now() + SESSION_TTL);
  }

  async redeemCode(code: string, deviceName: string): Promise<AuthenticatedMember> {
    const invitation = this.#code;
    const identity = this.host.getIdentity();
    if (
      !invitation ||
      invitation.expiresAt <= this.now() ||
      !identity ||
      identity.serverId !== invitation.hostId ||
      invitation.remainingAttempts <= 0
    )
      throw new HttpError(400, "This pairing code is invalid or expired.");
    invitation.remainingAttempts -= 1;
    this.#persist();
    if (
      !/^[0-9]{8}$/u.test(code) ||
      !timingSafeEqual(invitation.hash, digest(code)) ||
      !deviceName.trim() ||
      deviceName.length > 80
    ) {
      if (invitation.remainingAttempts <= 0) this.cancel();
      throw new HttpError(400, "This pairing code is invalid or expired.");
    }
    this.cancel();
    return this.host.openDeviceSession(deviceName.trim(), this.now() + SESSION_TTL);
  }

  cancel(): void {
    this.#invitation = null;
    this.#code = null;
    this.#persist();
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
