import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { authenticatePeer } from "./peer-authentication";

it("binds enrolled Ed25519 key to raw bytes, timestamp and exact context, not claimed identity", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const headers = {
    keyId,
    requestId: "r",
    contextId: "topic",
    timestamp: "1791765000",
    recipientId: "owner-a",
    signature: "",
  };
  const raw = Buffer.from('{"on_behalf_of":{"handle":"owner"}}');
  headers.signature = sign(
    null,
    Buffer.concat([
      Buffer.from(JSON.stringify(["dani-dex-peer-v2", "owner-a", keyId, "r", "topic", headers.timestamp]) + "\n"),
      raw,
    ]),
    privateKey,
  ).toString("base64url");
  const lookup = (id: string) =>
    id === keyId
      ? { contactId: "sam", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), revoked: false }
      : null;
  const now = Number(headers.timestamp) * 1000;
  expect(authenticatePeer(raw, headers, lookup, now, "owner-a")).toMatchObject({
    contactId: "sam",
    transportPrincipal: `ed25519:${keyId}`,
    contextId: "topic",
  });
  expect(() => authenticatePeer(raw, headers, lookup, now, "owner-b")).toThrow();
  expect(() => authenticatePeer(Buffer.concat([raw, Buffer.from(" ")]), headers, lookup, now, "owner-a")).toThrow();
  expect(() => authenticatePeer(raw, { ...headers, contextId: "other" }, lookup, now, "owner-a")).toThrow();
  expect(() => authenticatePeer(raw, headers, lookup, now + 300001, "owner-a")).toThrow();
  expect(() => authenticatePeer(raw, headers, () => null, now, "owner-a")).toThrow();
  expect(() => authenticatePeer(raw, headers, (id) => ({ ...lookup(id)!, revoked: true }), now, "owner-a")).toThrow();
});
