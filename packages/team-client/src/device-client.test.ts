import { expect, it } from "vitest";
import { DeviceTeamClient, parseDeviceInvitation } from "./device-client";
import { remoteHostFingerprint } from "./remote-directory";

const identity = {
  serverId: "host-1",
  serverName: "Dani-Dex",
  publicKey: "host-key",
  fingerprint: remoteHostFingerprint("host-key"),
  enabledOnLaunch: false,
  logoVersion: null,
};
const connection = {
  apiUrl: "https://host.example",
  sessionToken: "private-device-session",
  hostId: identity.serverId,
  publicKey: identity.publicKey,
  fingerprint: identity.fingerprint,
  memberId: "member-1",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};
it("accepts only HTTPS one-use device invitation fragments", () => {
  const link = `https://host.example/device-pairing#ticket=${"a".repeat(43)}&host=host-1&fingerprint=${identity.fingerprint}`;
  expect(parseDeviceInvitation(link)).toMatchObject({ apiUrl: connection.apiUrl, hostId: connection.hostId });
  expect(parseDeviceInvitation(link.replace("https:", "http:"))).toBeNull();
  expect(parseDeviceInvitation(link + "&ticket=duplicate")).toBeNull();
  expect(parseDeviceInvitation(link.replace("host.example", "user:password@host.example"))).toBeNull();
});
it("verifies the exact paired host and member directly, without account/Signal calls", async () => {
  const paths: string[] = [];
  const client = new DeviceTeamClient(
    connection,
    async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      expect(url.origin).toBe(connection.apiUrl);
      expect(url.search).toBe("");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${connection.sessionToken}`);
      return Response.json(
        url.pathname === "/v1/identity"
          ? identity
          : {
              id: "member-1",
              username: "owner",
              email: null,
              name: null,
              avatarUrl: null,
              role: "owner",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
      );
    },
    "0.17.8",
  );
  await client.verifyHost();
  expect(paths).toEqual(["/v1/identity", "/v1/me"]);
  await expect(client.request("GET", "https://other.example/v1/me", (value) => value)).rejects.toThrow("path");
});
it("rejects a changed host and revoked session", async () => {
  const changed = new DeviceTeamClient(
    connection,
    async () => Response.json({ ...identity, publicKey: "another-key" }),
    "0.17.8",
  );
  await expect(changed.verifyHost()).rejects.toThrow("identity changed");
  const revoked = new DeviceTeamClient(
    connection,
    async () => Response.json({ error: "Authentication required." }, { status: 401 }),
    "0.17.8",
  );
  await expect(revoked.request("GET", "/v1/me", (value) => value)).rejects.toThrow("session has ended");
});
