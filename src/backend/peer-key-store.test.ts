import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DaniDexDatabase } from "./dani-dex-database";
import { PeerKeyStore } from "./peer-key-store";

it("persists owner-enrolled public identity across restart and refuses key/contact substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-keys-"));
  let db = new DaniDexDatabase(root);
  await db.initialize();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  try {
    let s = new PeerKeyStore(db);
    expect(() =>
      s.enroll({
        contactId: "private",
        humanHandle: "private",
        publicKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
    ).toThrow("never a private key");
    const id = s.enroll({ contactId: "sam", humanHandle: "sam", publicKeyPem });
    expect(s.enroll({ contactId: "sam", humanHandle: "sam", publicKeyPem })).toBe(id);
    expect(() => s.enroll({ contactId: "other", humanHandle: "sam", publicKeyPem })).toThrow();
    db.close();
    db = new DaniDexDatabase(root);
    await db.initialize();
    s = new PeerKeyStore(db);
    expect(s.lookup(id)).toMatchObject({ contactId: "sam", revoked: false });
    s.revoke(id);
    expect(s.lookup(id)?.revoked).toBe(true);
    expect(() => s.enroll({ contactId: "sam", humanHandle: "sam", publicKeyPem })).toThrow();
    expect(() => s.enroll({ contactId: "new", humanHandle: "new", publicKeyPem: "bad" })).toThrow();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
