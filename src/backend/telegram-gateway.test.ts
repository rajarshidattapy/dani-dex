import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DaniDexDatabase } from "./dani-dex-database";
import { GatewayStore } from "./gateway-store";
import { TelegramGateway } from "./telegram-gateway";
import { TelegramTransport } from "./telegram-transport";
it("receives once, requires review, reconciles mailbox crash and returns only approved replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-gateway-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const store = new GatewayStore(db);
    store.register({
      gatewayId: "g",
      ownerId: "o",
      agentId: "chief",
      platform: "telegram",
      accountId: "bot",
      credentialHandle: "vault:telegram",
    });
    store.pair("g", "o", "12", "7");
    store.enable("g", "o");
    const request = vi.fn(
      async (url: URL | RequestInfo) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("getUpdates")
              ? {
                  ok: true,
                  result: [{ update_id: 4, message: { message_id: 1, chat: { id: 12 }, from: { id: 7 }, text: "hi" } }],
                }
              : { ok: true, result: { message_id: 10 } },
          ),
        ),
    );
    const receipts = new Map<string, string>();
    let fail = true;
    const deliver = vi.fn(async (_item: unknown, key: string) => {
      receipts.set(key, "mailbox-receipt");
      if (fail) {
        fail = false;
        throw new Error("crash after mailbox committed");
      }
      return receipts.get(key) as string;
    });
    const gateway = new TelegramGateway("g", store, new TelegramTransport(() => "123:FAKE", request), { deliver });
    await gateway.poll();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.pending("g")).toHaveLength(1);
    store.approveInbound("g", "o", "4", "hi", "12", "7");
    await expect(gateway.dispatchApproved()).rejects.toThrow("crash");
    await gateway.dispatchApproved();
    expect(receipts.size).toBe(1);
    expect(store.approved("g")).toEqual([]);
    store.queueReply("g", "r", "12", "7", "answer");
    await gateway.sendReviewedReply("r");
    expect(request).toHaveBeenCalledTimes(1);
    store.approveReply("g", "o", "r", "answer", "12", "7");
    await gateway.sendReviewedReply("r");
    await gateway.sendReviewedReply("r");
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("an interrupted send stays visible and cannot be blindly resent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-uncertain-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const s = new GatewayStore(db);
    s.register({
      gatewayId: "g",
      ownerId: "o",
      agentId: "chief",
      platform: "telegram",
      accountId: "b",
      credentialHandle: "vault:t",
    });
    s.pair("g", "o", "12", "7");
    s.enable("g", "o");
    s.queueReply("g", "r", "12", "7", "hi");
    s.approveReply("g", "o", "r", "hi", "12", "7");
    const request = vi.fn(async () => {
      throw new Error("disconnect");
    });
    const g = new TelegramGateway("g", s, new TelegramTransport(() => "123:FAKE", request), {
      deliver: async () => "unused",
    });
    await expect(g.sendReviewedReply("r")).rejects.toThrow();
    await g.sendReviewedReply("r");
    expect(request).toHaveBeenCalledTimes(1);
    expect(s.uncertainReplies("g")).toEqual([{ replyId: "r", conversationId: "12" }]);
    s.revoke("g", "o");
    expect(s.uncertainReplies("g")).toHaveLength(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("serializes approval dispatch while polling is delivering", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-concurrent-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const s = new GatewayStore(db);
    s.register({
      gatewayId: "g",
      ownerId: "o",
      agentId: "chief",
      platform: "telegram",
      accountId: "b",
      credentialHandle: "vault:t",
    });
    s.pair("g", "o", "12", "7");
    s.enable("g", "o");
    s.ingest("g", { eventId: "1", conversationId: "12", senderId: "7", body: "request", nextOffset: 2 });
    s.approveInbound("g", "o", "1", "request", "12", "7");
    let release!: () => void;
    const deliver = vi.fn(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return "receipt";
    });
    const g = new TelegramGateway("g", s, new TelegramTransport(() => "123:FAKE"), { deliver });
    const first = g.dispatchApproved();
    const second = g.dispatchApproved();
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(s.approved("g")).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("commits media metadata with inbox+offset, skips strangers and cannot text-dispatch reviewed media", async () => {
  const { TelegramMediaStore } = await import("./telegram-media-store");
  const root = await mkdtemp(join(tmpdir(), "tg-atomic-media-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const s = new GatewayStore(db);
    s.register({
      gatewayId: "g",
      ownerId: "o",
      agentId: "chief",
      platform: "telegram",
      accountId: "b",
      credentialHandle: "vault:t",
    });
    s.pair("g", "o", "12", "7");
    s.enable("g", "o");
    const updates = [4, 5].map((id) => ({
      update_id: id,
      message: {
        message_id: id,
        chat: { id: 12 },
        from: { id: id === 4 ? 7 : 9 },
        document: { file_id: `f${id}`, file_unique_id: `u${id}` },
      },
    }));
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: updates })));
    const media = new TelegramMediaStore(db),
      deliver = vi.fn(async () => "receipt");
    const g = new TelegramGateway("g", s, new TelegramTransport(() => "123:FAKE", request), { deliver }, media);
    await g.poll();
    expect(s.offset("g")).toBe(6);
    expect(media.pending("g")).toHaveLength(1);
    expect(media.has("g", "5")).toBe(false);
    const item = s.pending("g")[0];
    s.approveInbound("g", "o", "4", item.body, "12", "7");
    await g.dispatchApproved();
    expect(deliver).not.toHaveBeenCalled();
    await g.poll();
    expect(media.has("g", "4")).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("rolls back inbox and offset if atomic metadata persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-atomic-fail-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const s = new GatewayStore(db);
    s.register({
      gatewayId: "g",
      ownerId: "o",
      agentId: "chief",
      platform: "telegram",
      accountId: "b",
      credentialHandle: "vault:t",
    });
    s.pair("g", "o", "12", "7");
    s.enable("g", "o");
    expect(() =>
      s.ingest("g", { eventId: "4", conversationId: "12", senderId: "7", body: "media", nextOffset: 5 }, () => {
        throw Error("metadata unavailable");
      }),
    ).toThrow("metadata unavailable");
    expect(s.offset("g")).toBe(0);
    expect(s.pending("g")).toEqual([]);
    expect(s.ingest("g", { eventId: "4", conversationId: "12", senderId: "7", body: "media", nextOffset: 5 })).toBe(
      "accepted",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
