import { isDynamicRecord, isString } from "@dani-dex/contracts/runtime-values";
import {
  decodeTeamProtocolV4CurrentHttpResponse,
  encodeTeamProtocolV4CurrentHttpRequest,
} from "@dani-dex/contracts/team-protocol/v4-adapter";
import type { TeamClientFetch } from "./index";
import { remoteHostFingerprint } from "./remote-directory";

export interface DeviceConnection {
  apiUrl: string;
  sessionToken: string;
  hostId: string;
  publicKey: string;
  fingerprint: string;
  memberId: string;
  expiresAt: string;
}
export interface DeviceInvitation {
  apiUrl: string;
  ticket: string;
  hostId: string;
  fingerprint: string;
}

export function parseDeviceInvitation(value: string): DeviceInvitation | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/device-pairing" || url.search)
      return null;
    const params = new URLSearchParams(url.hash.slice(1));
    if (
      [...params.keys()].length !== 3 ||
      ["ticket", "host", "fingerprint"].some((key) => params.getAll(key).length !== 1)
    )
      return null;
    const ticket = params.get("ticket") ?? "",
      hostId = params.get("host") ?? "",
      fingerprint = params.get("fingerprint") ?? "";
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(ticket) ||
      !/^[A-Za-z0-9-]{1,128}$/u.test(hostId) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(fingerprint)
    )
      return null;
    return { apiUrl: url.origin, ticket, hostId, fingerprint };
  } catch {
    return null;
  }
}

/** Direct host access for device sessions. Never calls the account service or Signal. */
export class DeviceTeamClient {
  constructor(
    readonly connection: DeviceConnection,
    private readonly fetcher: TeamClientFetch,
    private readonly appVersion: string,
  ) {}

  async request<T>(method: string, path: string, decode: (value: unknown) => T, body?: unknown): Promise<T> {
    if (!path.startsWith("/v1/") || path.startsWith("//") || path.includes("#"))
      throw Error("Invalid host request path.");
    const target = new URL(path, this.connection.apiUrl);
    if (target.origin !== new URL(this.connection.apiUrl).origin) throw Error("Invalid host request origin.");
    if (Date.parse(this.connection.expiresAt) <= Date.now())
      throw Error("This device session has expired. Pair again.");
    const response = await this.fetcher(target.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.connection.sessionToken}`,
        "Dani-Dex-Protocol-Version": "4",
        "Dani-Dex-App-Version": this.appVersion,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : encodeTeamProtocolV4CurrentHttpRequest(method, path, body),
      signal: AbortSignal.timeout(10000),
    });
    const raw = response.status === 204 ? null : await response.json();
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "This device session has ended. Pair again."
          : "The host did not accept this request.",
      );
    return decode(
      response.status === 204 ? null : decodeTeamProtocolV4CurrentHttpResponse(method, path, response.status, raw),
    );
  }
  async verifyHost(): Promise<void> {
    await this.request("GET", "/v1/identity", (identity) => {
      if (
        !isDynamicRecord(identity) ||
        identity.serverId !== this.connection.hostId ||
        !isString(identity.publicKey) ||
        identity.publicKey !== this.connection.publicKey ||
        remoteHostFingerprint(identity.publicKey) !== this.connection.fingerprint
      )
        throw Error("The paired host identity changed. Refusing to connect.");
    });
    await this.request("GET", "/v1/me", (member) => {
      if (!isDynamicRecord(member) || member.id !== this.connection.memberId)
        throw Error("The paired device member changed.");
    });
  }
}

export async function redeemDeviceInvitation(
  invitation: DeviceInvitation,
  deviceName: string,
  fetcher: TeamClientFetch,
  appVersion: string,
): Promise<DeviceConnection> {
  const identityResponse = await fetcher(new URL("/v1/identity", invitation.apiUrl).toString(), {
    headers: { "Dani-Dex-Protocol-Version": "4", "Dani-Dex-App-Version": appVersion },
    signal: AbortSignal.timeout(10000),
  });
  const identity = await identityResponse.json();
  if (
    !identityResponse.ok ||
    !isDynamicRecord(identity) ||
    identity.serverId !== invitation.hostId ||
    !isString(identity.publicKey) ||
    remoteHostFingerprint(identity.publicKey) !== invitation.fingerprint
  )
    throw Error("The paired host identity changed. Refusing to connect.");
  const response = await fetcher(new URL("/v1/device-pairing/redeem", invitation.apiUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ticket: invitation.ticket,
      hostId: invitation.hostId,
      fingerprint: invitation.fingerprint,
      deviceName,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw Error("This device invitation is invalid or expired.");
  if (
    !isDynamicRecord(result) ||
    !isString(result.sessionToken) ||
    !result.sessionToken ||
    !isString(result.sessionExpiresAt) ||
    !Number.isFinite(Date.parse(result.sessionExpiresAt)) ||
    !isDynamicRecord(result.member) ||
    !isString(result.member.id)
  )
    throw Error("The host returned an invalid device session.");
  return {
    apiUrl: invitation.apiUrl,
    sessionToken: result.sessionToken,
    expiresAt: result.sessionExpiresAt,
    hostId: invitation.hostId,
    publicKey: identity.publicKey,
    fingerprint: invitation.fingerprint,
    memberId: result.member.id,
  };
}
