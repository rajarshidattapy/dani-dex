import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DaniDexDatabase } from "./dani-dex-database";
import { projectBusyBlocks, validatePeerEnvelope } from "./peer-protocol";
import { PeerTrustStore } from "./peer-trust-store";

const envelope = {
  oip: "1",
  intent: "ask",
  subject: "dinner",
  on_behalf_of: { handle: "sam", display: "Sam" },
  payload: { question: "Dinner?" },
  needs_consent: true,
};
it("connection and spoofed display grant no actions; scope expiry/revoke and local gate remain independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-trust-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const s = new PeerTrustStore(db);
    s.connect({ contactId: "sam", transportPrincipal: "verified-key:1", humanHandle: "sam" });
    expect(
      s.receive(
        { contactId: "sam", transportPrincipal: "wrong-key", requestId: "r1", contextId: "topic" },
        envelope,
        "Dinner?",
      ),
    ).toBe("message-taker");
    expect(
      s.receive(
        { contactId: "sam", transportPrincipal: "verified-key:1", requestId: "r2", contextId: "topic" },
        envelope,
        "Conflicting text",
      ),
    ).toBe("owner-review");
    expect(
      s.receive(
        { contactId: "sam", transportPrincipal: "verified-key:1", requestId: "r2", contextId: "topic" },
        envelope,
        "Conflicting text",
      ),
    ).toBe("duplicate");
    expect(() =>
      s.receive(
        { contactId: "sam", transportPrincipal: "verified-key:1", requestId: "r2", contextId: "topic" },
        envelope,
        "Changed content",
      ),
    ).toThrow("provenance");
    expect(() =>
      s.receive(
        { contactId: "sam", transportPrincipal: "wrong-key", requestId: "r2", contextId: "topic" },
        envelope,
        "Replay",
      ),
    ).toThrow("provenance");
    const grant = s.grant(
      {
        contactId: "sam",
        purpose: "dinner",
        capabilities: ["calendar.freebusy"],
        audiences: ["sam"],
        expiresAt: 10000,
      },
      1000,
    );

    s.revoke(grant);
    expect(s.authorizeRequest("r2", 2000)).toBe(false);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("freebusy projection strips private details and malformed slots fail", () => {
  const result = projectBusyBlocks([
    {
      start: "2026-10-12T10:00:00+05:30",
      end: "2026-10-12T11:00:00+05:30",
      title: "Private",
      attendees: ["hidden"],
      location: "secret",
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("Private");
  expect(() =>
    validatePeerEnvelope({
      ...envelope,
      intent: "propose_times",
      payload: { slots: [{ start: "2026-10-12T11:00:00Z", end: "2026-10-12T10:00:00Z" }] },
    }),
  ).toThrow();
});
it("pending consent does not commit, deadlines and revoke cancel accepted work", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-consent-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const s = new PeerTrustStore(db);
    s.connect({ contactId: "sam", transportPrincipal: "key", humanHandle: "sam" });
    const source = { contactId: "sam", transportPrincipal: "key", requestId: "r", contextId: "dinner" };
    s.receive(source, envelope, "Dinner?");
    s.requestConsent("r");
    expect(s.state("r")).toBe("consent-pending");
    expect(() => s.decide("r", "accept", null, 1000)).toThrow();
    const grant = s.grant(
      { contactId: "sam", purpose: "dinner", capabilities: ["plans.propose"], audiences: ["sam"], expiresAt: 10000 },
      1000,
    );
    s.decide("r", "accept", grant, 2000);
    expect(s.state("r")).toBe("accepted");
    s.revoke(grant);
    expect(s.state("r")).toBe("cancelled");
    s.receive({ ...source, requestId: "r2" }, { ...envelope, reply_by: "2026-10-12T00:00:00Z" }, "Dinner?");
    s.expire(Date.parse("2026-10-13T00:00:00Z"));
    expect(s.state("r2")).toBe("timed-out");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("execution requires accepted exact transport/context request and intent-scoped grant, never a standalone grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-execution-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const s = new PeerTrustStore(db);
    s.connect({ contactId: "sam", transportPrincipal: "key", humanHandle: "sam" });
    const request = {
      ...envelope,
      intent: "request_freebusy",
      payload: { window: { from: "2026-10-12T10:00:00Z", to: "2026-10-12T12:00:00Z" } },
    };
    s.receive({ contactId: "sam", transportPrincipal: "key", requestId: "r", contextId: "topic" }, request, "Free?");
    const grant = s.grant(
      {
        contactId: "sam",
        purpose: "dinner",
        capabilities: ["calendar.freebusy", "plans.commit"],
        audiences: ["sam"],
        expiresAt: 10000,
      },
      1000,
    );
    expect(s.authorizeRequest("r", 2000)).toBe(false);
    s.decide("r", "accept", grant, 2000);
    expect(s.authorizeRequest("r", 2000)).toBe(false);
    s.disconnect("sam");
    expect(s.authorizeRequest("r", 2000)).toBe(false);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
