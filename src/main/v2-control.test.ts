import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DaniDexDatabase } from "../backend/dani-dex-database";
import { PeerTrustStore } from "../backend/peer-trust-store";
import { V2Control } from "./v2-control";

it("local inspection omits credentials, grant revoke and peer disconnect cancel queued work", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-control-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const peer = new PeerTrustStore(db);
    peer.connect({ contactId: "sam", humanHandle: "sam", transportPrincipal: "private-key-binding" });
    const grant = peer.grant(
      { contactId: "sam", purpose: "dinner", capabilities: ["plans.propose"], audiences: ["sam"], expiresAt: 10000 },
      1000,
    );
    peer.receive(
      { contactId: "sam", transportPrincipal: "private-key-binding", requestId: "r", contextId: "dinner" },
      {
        oip: "1",
        intent: "ask",
        subject: "dinner",
        on_behalf_of: { handle: "sam", display: "Sam" },
        payload: { question: "Dinner?" },
        needs_consent: true,
      },
      "Dinner?",
    );
    peer.decide("r", "accept", grant, 2000);
    const control = new V2Control(db);
    const status = JSON.stringify(control.status());
    expect(status).not.toContain("SECRET_HANDLE");
    expect(status).not.toContain("private-key-binding");
    expect(() => control.decidePeer({ review: control.peerInbox()[0], decision: "accept", grantId: grant })).toThrow(
      "disabled",
    );
    control.revokeGrant(grant);
    expect(peer.state("r")).toBe("cancelled");
    control.disconnectPeer("sam");
    expect(control.status().contacts[0].connected).toBe(false);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
