import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentSummary, ConversationSnapshot, QueuedMessageReceipt } from "@dani-dex/contracts/ipc";
import type { DaniDexDatabase } from "../backend/dani-dex-database";
import { GatewayStore } from "../backend/gateway-store";
import { TelegramGateway } from "../backend/telegram-gateway";
import { TelegramTransport, TelegramTransportError } from "../backend/telegram-transport";
import { DEFAULT_CHIEF_ID } from "./chief-of-staff-bootstrap";
import type { SecretCipher } from "./provider-credential-store";
const credentials = z.object({ version: z.literal(1), ciphertext: z.string(), accountId: z.string().regex(/^\d+$/) });
/** Desktop-local only. Never exposed through the public Team API. */
export class TelegramController {
  private readonly store: GatewayStore;
  private gateway: TelegramGateway | null = null;
  private token: string | null = null;
  private gatewayId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private error: string | null = null;
  private stopped = false;
  private chiefId = DEFAULT_CHIEF_ID;
  constructor(
    private readonly options: {
      database: DaniDexDatabase;
      agents: Pick<AgentService, "deliverReviewedGatewayMessage" | "readConversation" | "listAgents">;
      credentialPath: string;
      cipher: SecretCipher;
      request?: typeof fetch;
    },
  ) {
    this.store = new GatewayStore(options.database);
  }
  async initialize(): Promise<void> {
    this.store.recoverInterruptedSends();
    try {
      const raw = credentials.parse(JSON.parse(await readFile(this.options.credentialPath, "utf8")));
      this.token = this.options.cipher.decrypt(Buffer.from(raw.ciphertext, "base64"));
      this.attach(raw.accountId);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        this.error = "Telegram credentials could not be unlocked.";
    }
    if (this.gatewayId && this.store.enabled(this.gatewayId)) this.schedule(0);
  }
  async configure(token: string): Promise<void> {
    if (this.gatewayId && this.store.enabled(this.gatewayId))
      throw new Error("Revoke Telegram before replacing its credential.");
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Enter a valid Telegram bot token.");
    const accountId = token.split(":")[0];
    if (this.gatewayId && this.gatewayId !== `telegram:${accountId}`)
      throw new Error("Revoke and remove the existing bot before changing accounts.");
    const ciphertext = this.options.cipher.encrypt(token).toString("base64");
    const bot = await new TelegramTransport(() => token, this.options.request).identity();
    if (bot.id !== accountId) throw new Error("Telegram bot identity does not match its credential.");
    await mkdir(dirname(this.options.credentialPath), { recursive: true, mode: 0o700 });
    const temp = this.options.credentialPath + ".tmp";
    await writeFile(temp, JSON.stringify({ version: 1, ciphertext, accountId }), { mode: 0o600 });
    await rename(temp, this.options.credentialPath);
    this.token = token;
    this.attach(accountId);
    this.error = null;
  }
  pair(conversationId: string, senderId: string): void {
    if (!/^-?\d+$/.test(conversationId) || !/^\d+$/.test(senderId))
      throw new Error("Telegram chat and sender IDs must be numeric.");
    this.store.pair(this.requireGateway(), "local-owner", conversationId, senderId);
  }
  enable(): void {
    this.store.enable(this.requireGateway(), "local-owner");
    this.stopped = false;
    this.schedule(0);
  }
  revoke(): void {
    this.store.revoke(this.requireGateway(), "local-owner");
    this.stop();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
  }
  status() {
    return {
      configured: Boolean(this.token),
      enabled: this.gatewayId ? this.store.enabled(this.gatewayId) : false,
      error: this.error,
      pending: this.gatewayId ? this.store.pending(this.gatewayId) : [],
      replies: this.gatewayId ? this.store.reviewReplies(this.gatewayId) : [],
      uncertainReplies: this.gatewayId ? this.store.uncertainReplies(this.gatewayId) : [],
    };
  }
  rejectInbound(eventId: string): void {
    this.store.rejectInbound(this.requireGateway(), "local-owner", eventId);
  }
  async approveInbound(eventId: string, body: string, conversationId: string, senderId: string): Promise<void> {
    const id = this.requireGateway();
    this.store.approveInbound(id, "local-owner", eventId, body, conversationId, senderId);
    if (!this.gateway) throw new Error("Telegram transport unavailable.");
    await this.gateway.dispatchApproved();
  }
  async approveReply(replyId: string, body: string, conversationId: string, senderId: string): Promise<void> {
    const id = this.requireGateway();
    this.store.approveReply(id, "local-owner", replyId, body, conversationId, senderId);
    if (!this.gateway) throw new Error("Telegram transport unavailable.");
    await this.gateway.sendReviewedReply(replyId);
  }

  async collectReplies(): Promise<void> {
    if (!this.gatewayId || !this.store.enabled(this.gatewayId)) return;
    const snapshot = await this.options.agents.readConversation(this.chiefId);
    for (const request of this.store.deliveredRequests(this.gatewayId)) {
      const deliveries = this.options.database.connection
        .prepare("SELECT turn_id,status FROM projection_deliveries WHERE message_id=? AND recipient_agent_id=?")
        .all(request.receiptId, this.chiefId);
      for (const delivery of deliveries) {
        if (delivery.status !== "completed" || !delivery.turn_id) continue;
        const texts = snapshot.messages
          .filter(
            (m) =>
              m.turnId === delivery.turn_id &&
              m.author === "assistant" &&
              m.status === "completed" &&
              (m.itemType===undefined||m.itemType==="agentMessage"||m.itemType==="final_answer") &&
              m.text.trim(),
          )
          .map((m) => m.text);
        if (texts.length === 0) continue;
        const text = texts.join("\n\n");
        if (text.length > 4096) {
          this.error = "Chief reply is too long for Telegram. Review it in Dani-Dex.";
          continue;
        }
        this.store.queueReply(
          this.gatewayId,
          `reply:${request.eventId}:${String(delivery.turn_id)}`,
          request.conversationId,
          request.senderId,
          text,
        );
      }
    }
  }

  private attach(accountId: string): void {
    const id = `telegram:${accountId}`;
    const roster = this.options.agents.listAgents();
    const chief = roster.find((a) => a.id === DEFAULT_CHIEF_ID) ?? roster.find((a) => a.id === "chief");
    if (!chief) throw new Error("Chief agent is not available.");
    this.chiefId = chief.id;
    this.gatewayId = id;
    const row = this.options.database.connection
      .prepare("SELECT 1 FROM projection_gateways WHERE gateway_id=?")
      .get(id);
    if (!row)
      this.store.register({
        gatewayId: id,
        ownerId: "local-owner",
        agentId: this.chiefId,
        platform: "telegram",
        accountId,
        credentialHandle: `vault:telegram:${accountId}`,
      });
    this.gateway = new TelegramGateway(id, this.store, new TelegramTransport(() => this.token, this.options.request), {
      deliver: async (item, key) => {
        const receipt = await this.options.agents.deliverReviewedGatewayMessage({
          agentId: this.chiefId,
          idempotencyKey: key,
          text: item.body,
          gatewayId: id,
          conversationId: item.conversationId,
          senderId: item.senderId,
          validateApproval: () => this.store.assertApproved(id, item.eventId, item.generation),
        });
        return receipt.messageId;
      },
    });
  }
  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.cycle();
    }, delay);
  }
  private async cycle(): Promise<void> {
    if (this.abort || !this.gateway || !this.gatewayId || !this.store.enabled(this.gatewayId)) return;
    this.abort = new AbortController();
    let delay = 1000;
    try {
      await this.gateway.poll(this.abort.signal);
      await this.collectReplies();
      this.error = null;
    } catch (error) {
      this.error = "Telegram is disconnected. Pending messages remain saved.";
      delay =
        error instanceof TelegramTransportError && error.retryAfterSeconds
          ? Math.min(error.retryAfterSeconds * 1000, 3600000)
          : 30000;
    } finally {
      this.abort = null;
      this.schedule(delay);
    }
  }
  private requireGateway(): string {
    if (!this.gatewayId) throw new Error("Configure Telegram first.");
    return this.gatewayId;
  }
}
