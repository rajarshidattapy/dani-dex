import { createHash, createPublicKey, randomUUID } from "node:crypto";
import type { DaniDexDatabase } from "./dani-dex-database";
import type { PeerKeyRecord } from "./peer-authentication";
/** Local owner-only enrollment, never reachable from a received peer message. */
export class PeerKeyStore {
  constructor(private readonly db: DaniDexDatabase) {}
  enroll(input: { contactId: string; humanHandle: string; publicKeyPem: string }): string {
    if (!input.contactId || input.contactId.length > 256 || !input.humanHandle || input.humanHandle.length > 256)
      throw Error("Invalid peer identity.");
    if (
      input.publicKeyPem.length > 2048 ||
      !/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(input.publicKeyPem.trim())
    )
      throw Error("Public key PEM required, never a private key.");
    const key = createPublicKey(input.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw Error("Ed25519 key required.");
    const fingerprint = createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex");
    const existing = this.db.connection
      .prepare("SELECT contact_id,public_key_pem,revoked FROM projection_peer_keys WHERE fingerprint=?")
      .get(fingerprint);
    const canonical = key.export({ type: "spki", format: "pem" }).toString();
    if (existing) {
      if (existing.contact_id !== input.contactId || existing.public_key_pem !== canonical || existing.revoked)
        throw Error("Existing peer identity cannot be replaced silently.");
      return fingerprint;
    }
    const contact = this.db.connection
      .prepare("SELECT transport_principal,connected FROM projection_peer_contacts WHERE contact_id=?")
      .get(input.contactId);
    if (contact) throw Error("Contact already enrolled. Revoke and create a new contact for a different key.");
    this.db.dispatch(
      `peer-key:${randomUUID()}`,
      [
        {
          aggregateType: "peer-key",
          aggregateId: fingerprint,
          eventType: "peer-key.enrolled",
          payload: { contactId: input.contactId, fingerprint },
        },
      ],
      (db) => {
        db.prepare("INSERT INTO projection_peer_contacts VALUES(?,?,?,1)").run(
          input.contactId,
          `ed25519:${fingerprint}`,
          input.humanHandle,
        );
        db.prepare("INSERT INTO projection_peer_keys VALUES(?,?,?,0)").run(fingerprint, input.contactId, canonical);
        return null;
      },
    );
    return fingerprint;
  }
  lookup(fingerprint: string): PeerKeyRecord | null {
    const r = this.db.connection
      .prepare(
        "SELECT k.contact_id,k.public_key_pem,k.revoked,c.connected FROM projection_peer_keys k JOIN projection_peer_contacts c USING(contact_id) WHERE fingerprint=?",
      )
      .get(fingerprint);
    return r
      ? {
          contactId: String(r.contact_id),
          publicKeyPem: String(r.public_key_pem),
          revoked: r.revoked === 1 || r.connected !== 1,
        }
      : null;
  }
  revoke(fingerprint: string): void {
    const row = this.lookup(fingerprint);
    if (!row) throw Error("Peer key not found.");
    this.db.dispatch(
      `peer-key:${randomUUID()}`,
      [
        {
          aggregateType: "peer-key",
          aggregateId: fingerprint,
          eventType: "peer-key.revoked",
          payload: { fingerprint },
        },
      ],
      (db) => {
        db.prepare("UPDATE projection_peer_keys SET revoked=1 WHERE fingerprint=?").run(fingerprint);
        db.prepare("UPDATE projection_peer_contacts SET connected=0 WHERE contact_id=?").run(row.contactId);
        db.prepare("UPDATE projection_peer_grants SET revoked=1 WHERE contact_id=?").run(row.contactId);
        db.prepare(
          "UPDATE projection_peer_requests SET state='cancelled' WHERE contact_id=? AND state IN ('owner-review','consent-pending','accepted')",
        ).run(row.contactId);
        return null;
      },
    );
  }
}
