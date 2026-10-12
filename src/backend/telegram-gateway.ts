import { createHash } from "node:crypto";
import type { GatewayInboxItem, GatewayStore } from "./gateway-store";
import { telegramMediaManifest } from "./telegram-media";
import type { TelegramMediaStore } from "./telegram-media-store";
import type { TelegramTransport, TelegramUpdate } from "./telegram-transport";
export interface TelegramDelivery {
  /** Must use the existing mailbox's durable idempotency key; never reinterpret external text as owner permission. */
  deliver(item: GatewayInboxItem, idempotencyKey: string): Promise<string>;
}
/** One cycle at a time. A scheduler can back off or stop without an invisible retry loop. */
export class TelegramGateway {
  private active = false;
  private dispatch: Promise<void> | null = null;
  constructor(
    private readonly gatewayId: string,
    private readonly store: GatewayStore,
    private readonly transport: TelegramTransport,
    private readonly delivery: TelegramDelivery,
    private readonly media?: TelegramMediaStore,
  ) {}
  async poll(signal?: AbortSignal): Promise<void> {
    if (!this.store.enabled(this.gatewayId)) return;
    if (this.active) throw new Error("Telegram poll already running.");
    this.active = true;
    try {
      const updates = await this.transport.updates(this.store.offset(this.gatewayId), signal);
      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) this.accept(update);
      await this.dispatchApproved(signal);
    } finally {
      this.active = false;
    }
  }
  async dispatchApproved(signal?: AbortSignal): Promise<void> {
    if (this.dispatch) {
      await this.dispatch;
      if (signal?.aborted) return;
    }
    // A local approval and the polling cycle can arrive together. Only one owns mailbox dispatch.
    if (this.dispatch) return this.dispatch;
    const work = (async () => {
      for (const item of this.store.approved(this.gatewayId)) {
        if (signal?.aborted) break;
        // Text approval must never stand in for exact media approval or attachment delivery.
        if (this.media?.has(this.gatewayId, item.eventId)) continue;
        const key = `gateway:${createHash("sha256").update(`${this.gatewayId}:${item.generation}:${item.eventId}`).digest("hex")}`;
        const receipt = await this.delivery.deliver(item, key);
        this.store.delivered(this.gatewayId, item.eventId, item.generation, receipt);
      }
    })();
    this.dispatch = work;
    try {
      await work;
    } finally {
      if (this.dispatch === work) this.dispatch = null;
    }
  }
  private accept(update: TelegramUpdate): void {
    const m = update.message ?? update.edited_message;
    const unsupported = Boolean(
      update.edited_message ||
        m?.voice ||
        m?.document ||
        m?.photo ||
        m?.video ||
        m?.audio ||
        m?.animation ||
        m?.sticker ||
        m?.video_note ||
        m?.contact ||
        m?.location ||
        m?.venue ||
        m?.poll ||
        !m?.text,
    );
    const media = this.media;
    const manifest = media ? telegramMediaManifest(update) : null;
    // Unsupported updates are explicitly represented, not silently presented as a complete media adapter.
    this.store.ingest(
      this.gatewayId,
      {
        eventId: String(update.update_id),
        nextOffset: update.update_id + 1,
        conversationId: m ? String(m.chat.id) : "unsupported",
        senderId: m?.from && !m.from.is_bot ? String(m.from.id) : "bot-or-unknown",
        body: unsupported
          ? "[Unsupported Telegram edit or media: owner review required]"
          : (m?.text ?? m?.caption ?? "[Unsupported Telegram update]"),
      },
      manifest && media
        ? (db) => media.recordWithinInbox(db, this.gatewayId, manifest)
        : unsupported
          ? (db) =>
              db
                .prepare(
                  "UPDATE projection_gateway_inbox SET state='rejected' WHERE gateway_id=? AND event_id=? AND state='pending'",
                )
                .run(this.gatewayId, String(update.update_id))
          : undefined,
    );
  }
  async sendReviewedReply(replyId: string, signal?: AbortSignal): Promise<void> {
    const reply = this.store.claimReply(this.gatewayId, replyId);
    if (!reply) return;
    try {
      const receipt = await this.transport.send(reply.conversationId, reply.body, signal);
      this.store.settleReply(this.gatewayId, replyId, receipt);
    } catch (error) {
      this.store.settleReply(this.gatewayId, replyId, null);
      throw error;
    }
  }
}
