import { createHash, createPublicKey, verify } from "node:crypto";
export interface PeerKeyRecord {
  contactId: string;
  publicKeyPem: string;
  revoked: boolean;
}
/** Keys arrive from local owner enrollment. The received envelope never supplies or upgrades a key. */
export function authenticatePeer(
  raw: Buffer,
  headers: {
    keyId: string;
    requestId: string;
    contextId: string;
    timestamp: string;
    recipientId: string;
    signature: string;
  },
  lookup: (id: string) => PeerKeyRecord | null,
  now = Date.now(),
  recipientId = "",
) {
  if (
    raw.length > 65536 ||
    !recipientId ||
    headers.recipientId !== recipientId ||
    ![headers.keyId, headers.requestId, headers.contextId].every((s) => s.length > 0 && s.length <= 256) ||
    !/^\d{10}$/.test(headers.timestamp) ||
    Math.abs(now - Number(headers.timestamp) * 1000) > 300000 ||
    !/^[-_A-Za-z0-9]{86}$/.test(headers.signature)
  )
    throw Error("Peer authentication failed.");
  const record = lookup(headers.keyId);
  if (!record || record.revoked) throw Error("Peer authentication failed.");
  const key = createPublicKey(record.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw Error("Peer authentication failed.");
  const fingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (headers.keyId !== fingerprint) throw Error("Peer authentication failed.");
  const content = Buffer.concat([
    Buffer.from(
      JSON.stringify([
        "dani-dex-peer-v2",
        recipientId,
        headers.keyId,
        headers.requestId,
        headers.contextId,
        headers.timestamp,
      ]) + "\n",
    ),
    raw,
  ]);
  if (!verify(null, content, key, Buffer.from(headers.signature, "base64url")))
    throw Error("Peer authentication failed.");
  return {
    contactId: record.contactId,
    transportPrincipal: `ed25519:${fingerprint}`,
    requestId: headers.requestId,
    contextId: headers.contextId,
  };
}
