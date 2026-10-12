import { randomUUID } from "node:crypto";
import type { DaniDexDatabase } from "./dani-dex-database";
import { type TelegramMediaManifest, telegramMediaManifestSchema } from "./telegram-media";
export const TELEGRAM_MEDIA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_telegram_media (
 gateway_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 review_digest TEXT NOT NULL,
 reviewed_digest TEXT,
 PRIMARY KEY(gateway_id,event_id),
 FOREIGN KEY(gateway_id,event_id) REFERENCES projection_gateway_inbox(gateway_id,event_id)
);
`;
/** Durable transport metadata, not a new task store. Holds no bytes, tokens or download URLs. */
export class TelegramMediaStore {
  constructor(private readonly database: DaniDexDatabase) {}
  record(gatewayId: string, manifest: TelegramMediaManifest): void {
    this.change(gatewayId, manifest.updateId, "metadata", (db) => this.recordWithinInbox(db, gatewayId, manifest));
  }
  /** Called inside gateway ingest's projector so metadata, inbox and offset commit together. */
  recordWithinInbox(db: DaniDexDatabase["connection"], gatewayId: string, manifest: TelegramMediaManifest): void {
    const inbox = db
      .prepare("SELECT * FROM projection_gateway_inbox WHERE gateway_id=? AND event_id=?")
      .get(gatewayId, manifest.updateId);
    if (
      !inbox ||
      inbox.state !== "pending" ||
      inbox.conversation_id !== manifest.conversationId ||
      inbox.sender_id !== manifest.senderId
    )
      throw Error("Media source does not match pending inbox.");
    const existing = db
      .prepare("SELECT review_digest FROM projection_telegram_media WHERE gateway_id=? AND event_id=?")
      .get(gatewayId, manifest.updateId);
    if (existing) {
      if (existing.review_digest !== manifest.reviewDigest) throw Error("Media identity changed.");
      return;
    }
    db.prepare("INSERT INTO projection_telegram_media VALUES(?,?,?,?,?,NULL)").run(
      gatewayId,
      manifest.updateId,
      inbox.generation,
      JSON.stringify(manifest),
      manifest.reviewDigest,
    );
  }

  reviewed(gatewayId: string, ownerId: string, eventId: string, digest: string): TelegramMediaManifest {
    this.assertReviewed(gatewayId, ownerId, eventId, digest);
    const row = this.database.connection
      .prepare("SELECT manifest_json FROM projection_telegram_media WHERE gateway_id=? AND event_id=?")
      .get(gatewayId, eventId);
    if (!row) throw Error("Media record no longer exists.");
    return telegramMediaManifestSchema.parse(JSON.parse(String(row.manifest_json)));
  }
  has(gatewayId: string, eventId: string): boolean {
    return Boolean(
      this.database.connection
        .prepare("SELECT 1 FROM projection_telegram_media WHERE gateway_id=? AND event_id=?")
        .get(gatewayId, eventId),
    );
  }

  pending(gatewayId: string): TelegramMediaManifest[] {
    return this.database.connection
      .prepare(
        `SELECT m.manifest_json FROM projection_telegram_media m JOIN projection_gateway_inbox i USING(gateway_id,event_id) JOIN projection_gateways g USING(gateway_id) WHERE m.gateway_id=? AND i.state IN ('pending','approved') AND g.enabled=1 AND m.generation=g.generation AND i.generation=g.generation`,
      )
      .all(gatewayId)
      .map((r) => telegramMediaManifestSchema.parse(JSON.parse(String(r.manifest_json))));
  }
  review(gatewayId: string, ownerId: string, eventId: string, digest: string): void {
    this.change(gatewayId, eventId, "reviewed", (db) => {
      const row = db
        .prepare(
          `SELECT m.manifest_json FROM projection_telegram_media m JOIN projection_gateway_inbox i USING(gateway_id,event_id) JOIN projection_gateways g USING(gateway_id) JOIN projection_gateway_chats c ON c.gateway_id=i.gateway_id AND c.conversation_id=i.conversation_id AND c.sender_id=i.sender_id WHERE m.gateway_id=? AND m.event_id=? AND m.review_digest=? AND g.owner_id=? AND g.enabled=1 AND m.generation=g.generation AND i.generation=g.generation AND i.state='pending'`,
        )
        .get(gatewayId, eventId, digest, ownerId);
      if (!row) throw Error("Exact owner media review required.");
      if (telegramMediaManifestSchema.parse(JSON.parse(String(row.manifest_json))).edited)
        throw Error("Edit change review is unavailable.");
      db.prepare("UPDATE projection_telegram_media SET reviewed_digest=? WHERE gateway_id=? AND event_id=?").run(
        digest,
        gatewayId,
        eventId,
      );
    });
  }
  assertReviewed(gatewayId: string, ownerId: string, eventId: string, digest: string): void {
    const row = this.database.connection
      .prepare(
        `SELECT 1 FROM projection_telegram_media m JOIN projection_gateway_inbox i USING(gateway_id,event_id) JOIN projection_gateways g USING(gateway_id) JOIN projection_gateway_chats c ON c.gateway_id=i.gateway_id AND c.conversation_id=i.conversation_id AND c.sender_id=i.sender_id WHERE m.gateway_id=? AND m.event_id=? AND m.review_digest=? AND m.reviewed_digest=m.review_digest AND g.owner_id=? AND g.enabled=1 AND m.generation=g.generation AND i.generation=g.generation AND i.state IN ('pending','approved')`,
      )
      .get(gatewayId, eventId, digest, ownerId);
    if (!row) throw Error("Media owner/source review no longer valid.");
  }
  private change(
    gatewayId: string,
    eventId: string,
    action: string,
    apply: (db: DaniDexDatabase["connection"]) => void,
  ): void {
    this.database.dispatch(
      `telegram-media:${randomUUID()}`,
      [
        {
          aggregateType: "gateway",
          aggregateId: gatewayId,
          eventType: `telegram.media-${action}`,
          payload: { eventId },
        },
      ],
      (db) => {
        apply(db);
        return null;
      },
    );
  }
}
