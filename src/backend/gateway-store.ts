import { randomUUID } from "node:crypto";
import { redactText } from "@dani-dex/logging";
import type { DaniDexDatabase } from "./dani-dex-database";

export interface GatewayRegistration {
  gatewayId: string;
  ownerId: string;
  agentId: string;
  platform: "telegram" | "whatsapp" | "slack";
  accountId: string;
  credentialHandle: string;
}
export interface GatewayEvent {
  eventId: string;
  conversationId: string;
  senderId: string;
  body: string;
  nextOffset: number;
}
export interface GatewayInboxItem extends GatewayEvent {
  generation: number;
}

function identifier(value: string): void {
  if (!value || value.length > 256) throw new Error("Invalid gateway identifier.");
}

/** No token values, authorization inferred from text, or alternate task database. */
export class GatewayStore {
  constructor(private readonly database: DaniDexDatabase) {}

  register(input: GatewayRegistration): void {
    for (const value of Object.values(input)) identifier(value);
    if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_:-]+$/.test(input.credentialHandle))
      throw new Error("Credential handle required, never a raw token.");
    this.database.dispatch(
      `gateway-register:${randomUUID()}`,
      [{ aggregateType: "gateway", aggregateId: input.gatewayId, eventType: "gateway.registered", payload: input }],
      (db) => {
        db.prepare(
          `INSERT INTO projection_gateways(gateway_id,owner_id,agent_id,platform,account_id,credential_handle,enabled) VALUES(?,?,?,?,?,?,0)`,
        ).run(input.gatewayId, input.ownerId, input.agentId, input.platform, input.accountId, input.credentialHandle);
        return null;
      },
    );
  }

  enable(gatewayId: string, ownerId: string): void {
    this.requireOwner(gatewayId, ownerId);
    if (
      this.database.connection.prepare("SELECT platform FROM projection_gateways WHERE gateway_id=?").get(gatewayId)
        ?.platform === "whatsapp"
    )
      throw new Error("WhatsApp activation is held.");
    this.change(gatewayId, "enabled", {}, (db) =>
      db.prepare("UPDATE projection_gateways SET enabled=1 WHERE gateway_id=?").run(gatewayId),
    );
  }

  pair(gatewayId: string, ownerId: string, conversationId: string, senderId: string): void {
    this.requireOwner(gatewayId, ownerId);
    identifier(conversationId);
    identifier(senderId);
    this.change(gatewayId, "chat-paired", { conversationId, senderId }, (db) =>
      db
        .prepare("INSERT OR IGNORE INTO projection_gateway_chats VALUES(?,?,?)")
        .run(gatewayId, conversationId, senderId),
    );
  }

  revoke(gatewayId: string, ownerId: string): void {
    this.requireOwner(gatewayId, ownerId);
    this.change(gatewayId, "revoked", {}, (db) => {
      db.prepare("UPDATE projection_gateways SET enabled=0,generation=generation+1 WHERE gateway_id=?").run(gatewayId);
      db.prepare("DELETE FROM projection_gateway_chats WHERE gateway_id=?").run(gatewayId);
      db.prepare("UPDATE projection_gateway_inbox SET state='cancelled' WHERE gateway_id=? AND state='pending'").run(
        gatewayId,
      );
      db.prepare(
        "UPDATE projection_gateway_outbox SET state='cancelled' WHERE gateway_id=? AND state IN ('review','ready')",
      ).run(gatewayId);
      // A send already in flight cannot be claimed undone. Its unknown outcome stays visible.
      db.prepare("UPDATE projection_gateway_outbox SET state='uncertain' WHERE gateway_id=? AND state='sending'").run(
        gatewayId,
      );
    });
  }

  enabled(gatewayId: string): boolean {
    return (
      this.database.connection.prepare("SELECT enabled FROM projection_gateways WHERE gateway_id=?").get(gatewayId)
        ?.enabled === 1
    );
  }

  offset(gatewayId: string): number {
    const row = this.database.connection
      .prepare("SELECT update_offset FROM projection_gateways WHERE gateway_id=?")
      .get(gatewayId);
    if (!row) throw new Error("Gateway not found.");
    return Number(row.update_offset);
  }

  ingest(
    gatewayId: string,
    event: GatewayEvent,
    persistAccepted?: (db: DaniDexDatabase["connection"]) => void,
  ): "accepted" | "rejected" | "duplicate" {
    identifier(event.eventId);
    identifier(event.conversationId);
    identifier(event.senderId);
    if (!Number.isSafeInteger(event.nextOffset) || event.nextOffset < 0 || event.body.length > 32000)
      throw new Error("Invalid gateway event.");
    const db = this.database.connection;
    if (
      db
        .prepare("SELECT 1 FROM projection_gateway_inbox WHERE gateway_id=? AND event_id=?")
        .get(gatewayId, event.eventId)
    )
      return "duplicate";
    const gateway = db.prepare("SELECT enabled,generation FROM projection_gateways WHERE gateway_id=?").get(gatewayId);
    if (!gateway) throw new Error("Gateway not found.");
    const paired = db
      .prepare("SELECT 1 FROM projection_gateway_chats WHERE gateway_id=? AND conversation_id=? AND sender_id=?")
      .get(gatewayId, event.conversationId, event.senderId);
    const accepted = gateway.enabled === 1 && Boolean(paired);
    // Unknown-sender content is not copied into model context or a secret-bearing audit.
    this.change(
      gatewayId,
      "inbound",
      { eventId: event.eventId, conversationId: event.conversationId, senderId: event.senderId, accepted },
      (tx) => {
        tx.prepare("INSERT INTO projection_gateway_inbox VALUES(?,?,?,?,?,?,?,NULL)").run(
          gatewayId,
          event.eventId,
          Number(gateway.generation),
          event.conversationId,
          event.senderId,
          accepted ? redactText(event.body) : "",
          accepted ? "pending" : "rejected",
        );
        if (accepted) persistAccepted?.(tx);
        tx.prepare("UPDATE projection_gateways SET update_offset=MAX(update_offset,?) WHERE gateway_id=?").run(
          event.nextOffset,
          gatewayId,
        );
      },
    );
    return accepted ? "accepted" : "rejected";
  }

  pending(gatewayId: string): GatewayInboxItem[] {
    return this.database.connection
      .prepare(
        `SELECT i.* FROM projection_gateway_inbox i JOIN projection_gateways g USING(gateway_id) WHERE i.gateway_id=? AND i.state='pending' AND g.enabled=1 AND i.generation=g.generation ORDER BY i.rowid`,
      )
      .all(gatewayId)
      .map((row) => ({
        eventId: String(row.event_id),
        conversationId: String(row.conversation_id),
        senderId: String(row.sender_id),
        body: String(row.body),
        generation: Number(row.generation),
        nextOffset: 0,
      }));
  }

  approveInbound(
    gatewayId: string,
    ownerId: string,
    eventId: string,
    reviewedBody: string,
    conversationId: string,
    senderId: string,
  ): void {
    this.requireOwner(gatewayId, ownerId);
    this.change(gatewayId, "inbound-approved", { eventId, conversationId, senderId }, (db) => {
      const result = db
        .prepare(
          `UPDATE projection_gateway_inbox SET state='approved' WHERE gateway_id=? AND event_id=? AND body=? AND conversation_id=? AND sender_id=? AND state='pending' AND EXISTS(SELECT 1 FROM projection_gateways g WHERE g.gateway_id=? AND g.enabled=1 AND g.generation=projection_gateway_inbox.generation)`,
        )
        .run(gatewayId, eventId, reviewedBody, conversationId, senderId, gatewayId);
      if (!result.changes) throw new Error("Inbound owner review no longer matches.");
    });
  }

  rejectInbound(gatewayId: string, ownerId: string, eventId: string): void {
    this.requireOwner(gatewayId, ownerId);
    this.change(gatewayId, "inbound-rejected", { eventId }, (db) => {
      const result = db
        .prepare(
          "UPDATE projection_gateway_inbox SET state='rejected' WHERE gateway_id=? AND event_id=? AND state='pending'",
        )
        .run(gatewayId, eventId);
      if (!result.changes) throw new Error("Request is no longer awaiting review.");
    });
  }

  approved(gatewayId: string): GatewayInboxItem[] {
    return this.database.connection
      .prepare(
        `SELECT i.* FROM projection_gateway_inbox i JOIN projection_gateways g USING(gateway_id) WHERE i.gateway_id=? AND i.state='approved' AND g.enabled=1 AND i.generation=g.generation ORDER BY i.rowid`,
      )
      .all(gatewayId)
      .map((row) => ({
        eventId: String(row.event_id),
        conversationId: String(row.conversation_id),
        senderId: String(row.sender_id),
        body: String(row.body),
        generation: Number(row.generation),
        nextOffset: 0,
      }));
  }

  assertApproved(gatewayId: string, eventId: string, generation: number): void {
    if (
      !this.database.connection
        .prepare(
          `SELECT 1 FROM projection_gateway_inbox i JOIN projection_gateways g USING(gateway_id) WHERE i.gateway_id=? AND i.event_id=? AND i.state='approved' AND i.generation=? AND g.generation=i.generation AND g.enabled=1`,
        )
        .get(gatewayId, eventId, generation)
    )
      throw new Error("Gateway approval was revoked or already delivered.");
  }

  delivered(gatewayId: string, eventId: string, generation: number, receiptId: string): void {
    identifier(receiptId);
    this.change(gatewayId, "inbound-delivered", { eventId, receiptId }, (db) => {
      db.prepare(
        `UPDATE projection_gateway_inbox SET state='delivered',receipt_id=? WHERE gateway_id=? AND event_id=? AND generation=? AND state='approved' AND EXISTS(SELECT 1 FROM projection_gateways g WHERE g.gateway_id=? AND g.enabled=1 AND g.generation=?)`,
      ).run(receiptId, gatewayId, eventId, generation, gatewayId, generation);
    });
  }

  deliveredRequests(
    gatewayId: string,
  ): Array<{ eventId: string; conversationId: string; senderId: string; receiptId: string }> {
    return this.database.connection
      .prepare(
        `SELECT i.* FROM projection_gateway_inbox i JOIN projection_gateways g USING(gateway_id) WHERE i.gateway_id=? AND i.state='delivered' AND i.generation=g.generation AND g.enabled=1`,
      )
      .all(gatewayId)
      .map((r) => ({
        eventId: String(r.event_id),
        conversationId: String(r.conversation_id),
        senderId: String(r.sender_id),
        receiptId: String(r.receipt_id),
      }));
  }

  reviewReplies(gatewayId: string): Array<{ replyId: string; conversationId: string; senderId: string; body: string }> {
    return this.database.connection
      .prepare(
        `SELECT o.* FROM projection_gateway_outbox o JOIN projection_gateways g USING(gateway_id) WHERE o.gateway_id=? AND o.state='review' AND o.generation=g.generation AND g.enabled=1`,
      )
      .all(gatewayId)
      .map((r) => ({
        replyId: String(r.reply_id),
        conversationId: String(r.conversation_id),
        senderId: String(r.sender_id),
        body: String(r.body),
      }));
  }

  uncertainReplies(gatewayId: string): Array<{ replyId: string; conversationId: string }> {
    return this.database.connection
      .prepare(
        "SELECT reply_id,conversation_id FROM projection_gateway_outbox WHERE gateway_id=? AND state='uncertain'",
      )
      .all(gatewayId)
      .map((r) => ({ replyId: String(r.reply_id), conversationId: String(r.conversation_id) }));
  }

  queueReply(gatewayId: string, replyId: string, conversationId: string, senderId: string, body: string): void {
    identifier(replyId);
    identifier(conversationId);
    identifier(senderId);
    if (!body.trim() || body.length > 32000) throw new Error("Invalid reply.");
    this.change(gatewayId, "reply-review", { replyId, conversationId, senderId }, (db) => {
      const g = db
        .prepare("SELECT generation FROM projection_gateways WHERE gateway_id=? AND enabled=1")
        .get(gatewayId);
      if (
        !g ||
        !db
          .prepare("SELECT 1 FROM projection_gateway_chats WHERE gateway_id=? AND conversation_id=? AND sender_id=?")
          .get(gatewayId, conversationId, senderId)
      )
        throw new Error("Reply destination is not paired.");
      const existing = db
        .prepare(
          "SELECT body,conversation_id,sender_id FROM projection_gateway_outbox WHERE gateway_id=? AND reply_id=?",
        )
        .get(gatewayId, replyId);
      const clean = redactText(body);
      if (
        existing &&
        (existing.body !== clean || existing.conversation_id !== conversationId || existing.sender_id !== senderId)
      )
        throw new Error("Reply identity conflict.");
      db.prepare("INSERT OR IGNORE INTO projection_gateway_outbox VALUES(?,?,?,?,?,?,'review',NULL)").run(
        gatewayId,
        replyId,
        Number(g.generation),
        conversationId,
        senderId,
        clean,
      );
    });
  }

  approveReply(
    gatewayId: string,
    ownerId: string,
    replyId: string,
    reviewedBody: string,
    reviewedConversationId: string,
    reviewedSenderId: string,
  ): void {
    this.requireOwner(gatewayId, ownerId);
    this.change(gatewayId, "reply-approved", { replyId }, (db) => {
      const r = db
        .prepare(
          "UPDATE projection_gateway_outbox SET state='ready' WHERE gateway_id=? AND reply_id=? AND body=? AND conversation_id=? AND sender_id=? AND state='review'",
        )
        .run(gatewayId, replyId, reviewedBody, reviewedConversationId, reviewedSenderId);
      if (!r.changes) throw new Error("Reply review no longer matches.");
    });
  }

  claimReply(gatewayId: string, replyId: string): { body: string; conversationId: string; generation: number } | null {
    return this.database.dispatch(
      `gateway-claim:${randomUUID()}`,
      [{ aggregateType: "gateway", aggregateId: gatewayId, eventType: "gateway.reply-claimed", payload: { replyId } }],
      (db) => {
        const row = db
          .prepare(
            `SELECT o.* FROM projection_gateway_outbox o JOIN projection_gateways g USING(gateway_id) JOIN projection_gateway_chats c ON c.gateway_id=o.gateway_id AND c.conversation_id=o.conversation_id AND c.sender_id=o.sender_id WHERE o.gateway_id=? AND o.reply_id=? AND o.state='ready' AND g.enabled=1 AND o.generation=g.generation`,
          )
          .get(gatewayId, replyId);
        if (!row) return null;
        db.prepare("UPDATE projection_gateway_outbox SET state='sending' WHERE gateway_id=? AND reply_id=?").run(
          gatewayId,
          replyId,
        );
        return {
          body: String(row.body),
          conversationId: String(row.conversation_id),
          generation: Number(row.generation),
        };
      },
    );
  }

  settleReply(gatewayId: string, replyId: string, receipt: string | null): void {
    if (receipt !== null) identifier(receipt);
    this.change(gatewayId, "reply-settled", { replyId, receipt }, (db) =>
      db
        .prepare(
          "UPDATE projection_gateway_outbox SET state=?,provider_receipt=? WHERE gateway_id=? AND reply_id=? AND state IN ('sending','uncertain')",
        )
        .run(receipt ? "sent" : "uncertain", receipt, gatewayId, replyId),
    );
  }

  recoverInterruptedSends(): void {
    this.database.connection
      .prepare("UPDATE projection_gateway_outbox SET state='uncertain' WHERE state='sending'")
      .run();
  }

  private requireOwner(gatewayId: string, ownerId: string): void {
    if (
      !this.database.connection
        .prepare("SELECT 1 FROM projection_gateways WHERE gateway_id=? AND owner_id=?")
        .get(gatewayId, ownerId)
    )
      throw new Error("Gateway owner mismatch.");
  }

  private change(
    gatewayId: string,
    type: string,
    payload: unknown,
    project: (db: DaniDexDatabase["connection"]) => unknown,
  ): void {
    this.database.dispatch(
      `gateway:${type}:${randomUUID()}`,
      [{ aggregateType: "gateway", aggregateId: gatewayId, eventType: `gateway.${type}`, payload }],
      (db) => {
        project(db);
        return null;
      },
    );
  }
}
