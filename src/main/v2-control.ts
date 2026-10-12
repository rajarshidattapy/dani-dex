import { randomUUID } from "node:crypto";
import type { PeerOwnerReview, V2ControlStatus } from "@dani-dex/contracts/ipc";
import { redactContextText } from "@dani-dex/logging";
import type { DaniDexDatabase } from "../backend/dani-dex-database";
import { PeerKeyStore } from "../backend/peer-key-store";
import { validatePeerEnvelope } from "../backend/peer-protocol";
import { PeerTrustStore } from "../backend/peer-trust-store";
/** Local owner inspection and revocation. No model tool, public route, or provider activation. */
export class V2Control {
  constructor(private readonly database: DaniDexDatabase) {}
  enrollPeer(input: { contactId: string; humanHandle: string; publicKeyPem: string }): string {
    return new PeerKeyStore(this.database).enroll(input);
  }
  peerInbox(): PeerOwnerReview[] {
    return this.database.connection
      .prepare(
        "SELECT r.*,e.state AS effect_state FROM projection_peer_requests r LEFT JOIN projection_peer_effects e USING(request_id) WHERE r.state IN ('message-taker','owner-review','consent-pending') OR e.state='uncertain' ORDER BY CASE WHEN e.state='uncertain' THEN 0 ELSE 1 END,r.rowid DESC",
      )
      .all()
      .map((r) => {
        try {
          return {
            requestId: String(r.request_id),
            contactId: String(r.contact_id),
            transportPrincipal: String(r.transport_principal),
            contextId: String(r.context_id),
            claimedPrincipal: JSON.parse(String(r.principal_json)),
            verifiedHumanHandle: String(
              this.database.connection
                .prepare("SELECT human_handle FROM projection_peer_contacts WHERE contact_id=? AND connected=1")
                .get(String(r.contact_id))?.human_handle ?? "",
            ),
            text: String(r.text),
            displayText: redactContextText(String(r.text)),
            displayEnvelope: redactPeerView(
              JSON.parse(String(r.envelope_json)),
            ) as import("@dani-dex/contracts/runtime-values").DynamicRecord,
            envelopeHash: new PeerTrustStore(this.database).reviewHash(String(r.request_id)),
            envelope: JSON.parse(String(r.envelope_json)),
            state: r.effect_state === "uncertain" ? "uncertain" : String(r.state),
            deadline: r.deadline === null ? null : Number(r.deadline),
          };
        } catch {
          return {
            requestId: String(r.request_id),
            contactId: String(r.contact_id),
            transportPrincipal: String(r.transport_principal),
            contextId: String(r.context_id),
            claimedPrincipal: { handle: "unavailable", display: "Could not render" },
            text: String(r.text),
            envelope: {},
            state: "render-error",
            deadline: Number(r.deadline),
            envelopeHash: new PeerTrustStore(this.database).reviewHash(String(r.request_id)),
          };
        }
      });
  }
  decidePeer(input: { review: PeerOwnerReview; decision: "accept" | "decline"; grantId: string | null }): void {
    if (input.decision !== "decline") throw Error("Peer acceptance and effects remain disabled.");
    const r = this.peerInbox().find((r) => r.requestId === input.review.requestId);
    if (
      !r ||
      Object.keys(r).some(
        (k) =>
          JSON.stringify(r[k as keyof PeerOwnerReview]) !== JSON.stringify(input.review[k as keyof PeerOwnerReview]),
      )
    )
      throw Error("Peer review no longer matches.");
    if (r.state === "render-error" && input.decision !== "decline")
      throw Error("Unrenderable review cannot be accepted.");
    if (r.state !== "render-error") validatePeerEnvelope(r.envelope);
    if (r.state === "message-taker" || r.state === "render-error") {
      if (input.decision !== "decline") throw Error("Unverified messages cannot authorize work.");
      this.database.dispatch(
        `peer-dismiss:${randomUUID()}`,
        [
          {
            aggregateType: "peer",
            aggregateId: r.requestId,
            eventType: "peer.message-dismissed",
            payload: { requestId: r.requestId },
          },
        ],
        (db) => {
          db.prepare(
            "UPDATE projection_peer_requests SET state='declined' WHERE request_id=? AND state='message-taker'",
          ).run(r.requestId);
          return null;
        },
      );
      return;
    }
    new PeerTrustStore(this.database).decide(r.requestId, input.decision, input.grantId);
  }
  status(): V2ControlStatus {
    const db = this.database.connection;
    return {
      contacts: db
        .prepare("SELECT contact_id,human_handle,connected FROM projection_peer_contacts")
        .all()
        .map((r) => ({
          contactId: String(r.contact_id),
          humanHandle: String(r.human_handle),
          connected: r.connected === 1,
        })),
      grants: db
        .prepare("SELECT grant_id,contact_id,purpose,expires_at,revoked FROM projection_peer_grants")
        .all()
        .map((r) => ({
          grantId: String(r.grant_id),
          contactId: String(r.contact_id),
          purpose: String(r.purpose),
          expiresAt: Number(r.expires_at),
          revoked: r.revoked === 1,
        })),
      requests: db
        .prepare(
          "SELECT request_id,contact_id,state,deadline FROM projection_peer_requests WHERE state IN ('message-taker','owner-review','consent-pending','accepted') LIMIT 100",
        )
        .all()
        .map((r) => ({
          requestId: String(r.request_id),
          contactId: String(r.contact_id),
          state: String(r.state),
          deadline: r.deadline === null ? null : Number(r.deadline),
        })),
    };
  }
  revokeGrant(grantId: string): void {
    new PeerTrustStore(this.database).revoke(grantId);
  }
  disconnectPeer(contactId: string): void {
    new PeerTrustStore(this.database).disconnect(contactId);
  }
}

function redactPeerView(value: unknown): unknown {
  if (typeof value === "string") return redactContextText(value);
  if (Array.isArray(value)) return value.map(redactPeerView);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactPeerView(child)]));
  return value;
}
