import { createHash, randomUUID } from "node:crypto";
import type { DaniDexDatabase } from "./dani-dex-database";
import { type VerifiedPeerSource, validatePeerEnvelope } from "./peer-protocol";

const CAPS = [
  "calendar.freebusy",
  "plans.propose",
  "profile.public",
  "preferences.read",
  "calendar.write",
  "plans.commit",
] as const;
export class PeerTrustStore {
  constructor(private readonly database: DaniDexDatabase) {}
  /** These methods belong only to authenticated local owner controls, never model/peer tools. */
  connect(input: { contactId: string; transportPrincipal: string; humanHandle: string }): void {
    if (Object.values(input).some((x) => !x || x.length > 256)) throw new Error("Invalid peer identity.");
    this.change(input.contactId, "connected", input, (db) =>
      db
        .prepare("INSERT INTO projection_peer_contacts VALUES(?,?,?,1)")
        .run(input.contactId, input.transportPrincipal, input.humanHandle),
    );
  }
  grant(
    input: { contactId: string; purpose: string; capabilities: string[]; audiences: string[]; expiresAt: number },
    now = Date.now(),
  ): string {
    if (
      !input.purpose.trim() ||
      input.purpose.length > 500 ||
      input.capabilities.length === 0 ||
      input.capabilities.some((c) => !CAPS.includes(c as (typeof CAPS)[number])) ||
      input.audiences.length === 0 ||
      input.audiences.length > 20 ||
      input.capabilities.length > CAPS.length ||
      input.audiences.some((a) => !a || a.length > 256) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= now ||
      input.expiresAt > now + 30 * 24 * 60 * 60 * 1000
    )
      throw new Error("Invalid peer grant.");
    if (
      !this.database.connection
        .prepare("SELECT 1 FROM projection_peer_contacts WHERE contact_id=? AND connected=1")
        .get(input.contactId)
    )
      throw new Error("Peer is not connected.");
    const id = randomUUID();
    this.change(input.contactId, "grant-created", { ...input, grantId: id }, (db) =>
      db
        .prepare("INSERT INTO projection_peer_grants VALUES(?,?,?,?,?,?,0)")
        .run(
          id,
          input.contactId,
          input.purpose,
          JSON.stringify(input.capabilities),
          JSON.stringify(input.audiences),
          input.expiresAt,
        ),
    );
    return id;
  }
  revoke(grantId: string): void {
    this.change(grantId, "grant-revoked", {}, (db) => {
      const result = db.prepare("UPDATE projection_peer_grants SET revoked=1 WHERE grant_id=?").run(grantId);
      if (!result.changes) throw new Error("Peer grant not found.");
      db.prepare(
        "UPDATE projection_peer_requests SET state='cancelled' WHERE grant_id=? AND state IN ('accepted','consent-pending')",
      ).run(grantId);
    });
  }
  receive(
    source: VerifiedPeerSource | null,
    value: unknown,
    text: string,
    unverifiedRequestId?: string,
  ): "duplicate" | "message-taker" | "owner-review" {
    const envelope = validatePeerEnvelope(value);
    if (text.length > 32000) throw new Error("Peer message too long.");
    const requestId = source?.requestId ?? unverifiedRequestId ?? randomUUID();
    const previous = this.database.connection
      .prepare(
        "SELECT transport_principal,context_id,envelope_json,text FROM projection_peer_requests WHERE request_id=?",
      )
      .get(requestId);
    if (previous) {
      if (
        previous.transport_principal !== (source?.transportPrincipal ?? "unverified") ||
        previous.context_id !== (source?.contextId ?? requestId) ||
        previous.envelope_json !== JSON.stringify(envelope) ||
        previous.text !== text
      )
        throw new Error("Peer request identity conflicts with recorded provenance.");
      return "duplicate";
    }
    const contact = source
      ? this.database.connection
          .prepare(
            "SELECT * FROM projection_peer_contacts WHERE contact_id=? AND transport_principal=? AND connected=1",
          )
          .get(source.contactId, source.transportPrincipal)
      : null;
    const state = contact ? "owner-review" : "message-taker";
    // Always preserve claimed principal separately; a handle/display is not upgraded into verified authorship.
    this.change(requestId, "request-received", { contactId: contact ? source?.contactId : null, state }, (db) => {
      db.prepare("INSERT INTO projection_peer_received VALUES(?,?)").run(requestId, Date.now());
      return db
        .prepare("INSERT INTO projection_peer_requests VALUES(?,?,?,?,?,?,?, ?,NULL,?)")
        .run(
          requestId,
          contact ? (source?.contactId ?? "") : "unverified",
          source?.transportPrincipal ?? "unverified",
          source?.contextId ?? requestId,
          JSON.stringify(envelope.on_behalf_of),
          JSON.stringify(envelope),
          text,
          state,
          Math.min(
            envelope.reply_by ? Date.parse(envelope.reply_by) : Infinity,
            Date.now() + (contact ? 86400000 : 3600000),
          ),
        );
    });
    return state;
  }
  private allowed(
    input: {
      grantId: string;
      contactId: string;
      purpose: string;
      capability: string;
      audiences: string[];
      localToolAllowed: boolean;
      money: boolean;
      finalMoneyApproval: boolean;
    },
    now = Date.now(),
  ): boolean {
    if (!input.localToolAllowed || (input.money && !input.finalMoneyApproval)) return false;
    const g = this.database.connection
      .prepare(
        "SELECT g.* FROM projection_peer_grants g JOIN projection_peer_contacts c USING(contact_id) WHERE g.grant_id=? AND g.contact_id=? AND g.purpose=? AND g.revoked=0 AND g.expires_at>? AND c.connected=1",
      )
      .get(input.grantId, input.contactId, input.purpose, now);
    if (!g) return false;
    const caps = JSON.parse(String(g.capabilities_json)) as string[];
    const audiences = JSON.parse(String(g.audiences_json)) as string[];
    return (
      caps.includes(input.capability) &&
      input.audiences.length > 0 &&
      input.audiences.every((a) => audiences.includes(a))
    );
  }
  /** Fail closed until an owner-approved durable effect scope and atomic execution lifecycle exist.
   * No caller-supplied tool/money/identity flags can authorize effects. */
  authorizeRequest(_requestId: string, _now = Date.now()): boolean {
    return false;
  }

  /** Owner-local reviewed effect approval, deliberately not exposed to peer/model/IPC yet.
   * Local tool approval is recorded here, never supplied by an executor. */
  approveEffect(
    requestId: string,
    reviewedEnvelopeHash: string,
    audiences: string[],
    moneyCeiling: number | null,
  ): void {
    this.change(requestId, "effect-approved", { requestId, reviewedEnvelopeHash, audiences, moneyCeiling }, (db) => {
      const r = db
        .prepare("SELECT * FROM projection_peer_requests WHERE request_id=? AND state='accepted'")
        .get(requestId);
      if (!r || this.reviewHash(requestId) !== reviewedEnvelopeHash) throw Error("Exact accepted review required.");
      if (Number(r.deadline) <= Date.now()) throw Error("Expired request.");
      const envelope = validatePeerEnvelope(JSON.parse(String(r.envelope_json)));
      if (["book_request", "accept", "confirm"].includes(envelope.intent))
        throw Error("Commit execution is unavailable until final vendor approval and spend accounting exist.");
      const capability = this.effectCapability(envelope.intent);
      if (
        !capability ||
        !audiences.length ||
        audiences.length > 20 ||
        !this.allowed({
          grantId: String(r.grant_id),
          contactId: String(r.contact_id),
          purpose: envelope.subject,
          capability,
          audiences,
          localToolAllowed: true,
          money: false,
          finalMoneyApproval: false,
        })
      )
        throw Error("Effect outside grant.");
      db.prepare(
        "INSERT INTO projection_peer_effects(request_id,envelope_hash,capability,audiences_json,money_ceiling,state,result_json) VALUES(?,?,?,?,?,'approved',NULL)",
      ).run(requestId, reviewedEnvelopeHash, capability, JSON.stringify(audiences), moneyCeiling);
    });
  }
  /** Called by an adapter immediately before any external effect, including after async awaits. */
  validateEffect(requestId: string, token: string, now = Date.now()): void {
    const r = this.database.connection
      .prepare(
        "SELECT r.*,e.envelope_hash,e.capability,e.audiences_json,e.money_ceiling FROM projection_peer_requests r JOIN projection_peer_effects e USING(request_id) WHERE r.request_id=? AND r.state='accepted' AND e.state='executing' AND e.claim_token=?",
      )
      .get(requestId, token);
    if (!r || Number(r.deadline) <= now || this.reviewHash(requestId) !== r.envelope_hash)
      throw Error("Effect no longer authorized.");
    const envelope = validatePeerEnvelope(JSON.parse(String(r.envelope_json)));
    const contact = this.database.connection
      .prepare("SELECT 1 FROM projection_peer_contacts WHERE contact_id=? AND transport_principal=? AND connected=1")
      .get(String(r.contact_id), String(r.transport_principal));
    const money = false;
    if (
      !contact ||
      r.capability !== this.effectCapability(envelope.intent) ||
      !this.allowed(
        {
          grantId: String(r.grant_id),
          contactId: String(r.contact_id),
          purpose: envelope.subject,
          capability: String(r.capability),
          audiences: JSON.parse(String(r.audiences_json)),
          localToolAllowed: true,
          money,
          finalMoneyApproval: r.money_ceiling !== null,
        },
        now,
      )
    )
      throw Error("Effect no longer authorized.");
  }
  /** Restart cannot silently retry an executing operation with an unknown provider result. */
  recoverEffects(): void {
    if (
      !this.database.connection.prepare("SELECT 1 FROM projection_peer_effects WHERE state='executing' LIMIT 1").get()
    )
      return;
    this.change("effects", "effects-recovered", {}, (db) =>
      db.prepare("UPDATE projection_peer_effects SET state='uncertain' WHERE state='executing'").run(),
    );
  }
  reviewHash(requestId: string): string {
    const row = this.database.connection
      .prepare(
        "SELECT envelope_json,text,context_id,transport_principal,contact_id FROM projection_peer_requests WHERE request_id=?",
      )
      .get(requestId);
    if (!row) throw Error("Request not found.");
    return this.envelopeHash(
      JSON.stringify([row.envelope_json, row.text, row.context_id, row.transport_principal, row.contact_id]),
    );
  }
  envelopeHash(json: string): string {
    return createHash("sha256").update(json).digest("hex");
  }
  private effectCapability(intent: string): string | null {
    return (
      (
        {
          request_freebusy: "calendar.freebusy",
          propose_times: "plans.propose",
        } as Record<string, string>
      )[intent] ?? null
    );
  }
  /** Atomic single-use claim. No executor-selected identity, audience, capability or money flags. */
  claimEffect(
    requestId: string,
    now = Date.now(),
  ): { token: string; capability: string; audiences: string[]; moneyCeiling: number | null } | null {
    let result: { token: string; capability: string; audiences: string[]; moneyCeiling: number | null } | null = null;
    try {
      this.change(requestId, "effect-claimed", { requestId }, (db) => {
        const r = db
          .prepare(
            "SELECT r.*,e.envelope_hash,e.capability,e.audiences_json,e.money_ceiling FROM projection_peer_requests r JOIN projection_peer_effects e USING(request_id) WHERE r.request_id=? AND r.state='accepted' AND e.state='approved'",
          )
          .get(requestId);
        if (!r || Number(r.deadline) <= now || this.reviewHash(requestId) !== r.envelope_hash)
          throw Error("NO_EFFECT_CLAIM");
        const envelope = validatePeerEnvelope(JSON.parse(String(r.envelope_json)));
        const capability = this.effectCapability(envelope.intent);
        const audiences = JSON.parse(String(r.audiences_json)) as string[];
        const money = false;
        if (!capability || r.capability !== capability) throw Error("NO_EFFECT_CLAIM");
        const contact = db
          .prepare(
            "SELECT 1 FROM projection_peer_contacts WHERE contact_id=? AND transport_principal=? AND connected=1",
          )
          .get(String(r.contact_id), String(r.transport_principal));
        if (
          !contact ||
          !this.allowed(
            {
              grantId: String(r.grant_id),
              contactId: String(r.contact_id),
              purpose: envelope.subject,
              capability,
              audiences,
              localToolAllowed: true,
              money,
              finalMoneyApproval: r.money_ceiling !== null,
            },
            now,
          )
        )
          throw Error("NO_EFFECT_CLAIM");
        const token = randomUUID();
        const changed = db
          .prepare(
            "UPDATE projection_peer_effects SET state='executing',claim_token=? WHERE request_id=? AND state='approved'",
          )
          .run(token, requestId);
        if (changed.changes)
          result = {
            token,
            capability,
            audiences,
            moneyCeiling: r.money_ceiling === null ? null : Number(r.money_ceiling),
          };
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "NO_EFFECT_CLAIM") throw error;
    }
    return result;
  }
  finishEffect(requestId: string, token: string, uncertain: boolean, result: unknown): void {
    const encoded = JSON.stringify(result);
    if (!encoded || encoded.length > 4000) throw Error("Effect result too large.");
    this.change(requestId, "effect-finished", { requestId, uncertain }, (db) => {
      const changed = db
        .prepare(
          "UPDATE projection_peer_effects SET state=?,result_json=? WHERE request_id=? AND state='executing' AND claim_token=?",
        )
        .run(uncertain ? "uncertain" : "completed", encoded, requestId, token);
      if (!changed.changes) throw Error("No execution claim.");
      if (!uncertain)
        db.prepare("UPDATE projection_peer_requests SET state='completed' WHERE request_id=? AND state='accepted'").run(
          requestId,
        );
    });
  }

  /** Owner-local reconciliation after checking the external result. Never dispatches another effect. */
  reconcileEffect(
    requestId: string,
    reviewedHash: string,
    resolution: "confirmed-completed" | "confirmed-no-effect",
  ): void {
    this.change(requestId, "effect-reconciled", { requestId, resolution }, (db) => {
      if (this.reviewHash(requestId) !== reviewedHash) throw Error("Review changed.");
      const changed = db
        .prepare("UPDATE projection_peer_effects SET state=?,result_json=? WHERE request_id=? AND state='uncertain'")
        .run(
          resolution === "confirmed-completed" ? "completed" : "cancelled",
          JSON.stringify({ resolution }),
          requestId,
        );
      if (!changed.changes) throw Error("Effect is not uncertain.");
      db.prepare("UPDATE projection_peer_requests SET state=? WHERE request_id=?").run(
        resolution === "confirmed-completed" ? "completed" : "cancelled",
        requestId,
      );
    });
  }
  requestConsent(requestId: string): void {
    this.change(requestId, "consent-pending", { requestId }, (db) => {
      const r = db
        .prepare(
          "UPDATE projection_peer_requests SET state='consent-pending' WHERE request_id=? AND state='owner-review'",
        )
        .run(requestId);
      if (!r.changes) throw new Error("Peer request is not awaiting owner review.");
    });
  }

  decide(requestId: string, decision: "accept" | "decline", grantId: string | null, now = Date.now()): void {
    this.change(requestId, decision, { requestId, grantId }, (db) => {
      const request = db
        .prepare(
          "SELECT * FROM projection_peer_requests WHERE request_id=? AND state IN ('owner-review','consent-pending')",
        )
        .get(requestId);
      if (!request || (request.deadline !== null && Number(request.deadline) <= now))
        throw new Error("Peer decision is expired or already resolved.");
      if (decision === "accept") {
        if (
          !grantId ||
          !db
            .prepare(
              "SELECT 1 FROM projection_peer_grants g JOIN projection_peer_contacts c USING(contact_id) WHERE g.grant_id=? AND g.contact_id=? AND g.purpose=? AND g.revoked=0 AND g.expires_at>? AND c.connected=1",
            )
            .get(
              grantId,
              String(request.contact_id),
              validatePeerEnvelope(JSON.parse(String(request.envelope_json))).subject,
              now,
            )
        )
          throw new Error("A current scoped owner grant is required.");
      }
      db.prepare("UPDATE projection_peer_requests SET state=?,grant_id=? WHERE request_id=?").run(
        decision === "accept" ? "accepted" : "declined",
        grantId,
        requestId,
      );
    });
  }

  prune(now = Date.now()): void {
    const rows = this.database.connection
      .prepare(
        "SELECT * FROM projection_peer_requests WHERE state IN ('declined','completed','cancelled','timed-out') AND request_id IN (SELECT request_id FROM projection_peer_received WHERE received_at<?) AND request_id NOT IN (SELECT request_id FROM projection_peer_effects) LIMIT 100",
      )
      .all(now - 600000);
    if (!rows.length) return;
    this.change("retention", "retention-reviewed", { count: rows.length }, (db) => {
      db.prepare("DELETE FROM projection_peer_replay_tombstones WHERE expires_at<?").run(now);
      for (const r of rows) {
        const digest = this.envelopeHash(
          JSON.stringify([r.text, r.envelope_json, r.transport_principal, r.context_id]),
        );
        db.prepare("INSERT OR REPLACE INTO projection_peer_replay_tombstones VALUES(?,?,?)").run(
          String(r.request_id),
          digest,
          now + 900000,
        );
        const commands = db
          .prepare(
            "SELECT DISTINCT command_id FROM orchestration_events WHERE aggregate_type='peer' AND aggregate_id=?",
          )
          .all(String(r.request_id));
        db.prepare("DELETE FROM projection_peer_received WHERE request_id=?").run(String(r.request_id));
        db.prepare("DELETE FROM projection_peer_requests WHERE request_id=?").run(String(r.request_id));
        for (const command of commands) {
          db.prepare("DELETE FROM orchestration_events WHERE command_id=?").run(String(command.command_id));
          db.prepare("DELETE FROM orchestration_command_receipts WHERE command_id=?").run(String(command.command_id));
        }
      }
    });
  }
  expire(now = Date.now()): void {
    if (
      !this.database.connection
        .prepare(
          "SELECT 1 FROM projection_peer_requests WHERE deadline<=? AND state IN ('message-taker','owner-review','consent-pending','accepted') LIMIT 1",
        )
        .get(now)
    )
      return;
    this.change("deadlines", "deadlines-reviewed", { now }, (db) =>
      db
        .prepare(
          "UPDATE projection_peer_requests SET state='timed-out' WHERE deadline<=? AND state IN ('message-taker','owner-review','consent-pending','accepted')",
        )
        .run(now),
    );
  }

  disconnect(contactId: string): void {
    this.change(contactId, "disconnected", {}, (db) => {
      const result = db.prepare("UPDATE projection_peer_contacts SET connected=0 WHERE contact_id=?").run(contactId);
      if (!result.changes) throw new Error("Peer contact not found.");
      db.prepare("UPDATE projection_peer_grants SET revoked=1 WHERE contact_id=?").run(contactId);
      db.prepare(
        "UPDATE projection_peer_requests SET state='cancelled' WHERE contact_id=? AND state IN ('message-taker','owner-review','consent-pending','accepted')",
      ).run(contactId);
    });
  }

  state(requestId: string): string | null {
    const row = this.database.connection
      .prepare("SELECT state FROM projection_peer_requests WHERE request_id=?")
      .get(requestId);
    return row ? String(row.state) : null;
  }

  private change(
    id: string,
    type: string,
    payload: unknown,
    project: (db: DaniDexDatabase["connection"]) => unknown,
  ): void {
    this.database.dispatch(
      `peer:${randomUUID()}`,
      [{ aggregateType: "peer", aggregateId: id, eventType: `peer.${type}`, payload }],
      (db) => {
        project(db);
        return null;
      },
    );
  }
}
