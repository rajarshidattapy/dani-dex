import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { DaniDexDatabase } from "../backend/dani-dex-database";
import { TelegramController } from "./telegram-controller";
it("stores encrypted credentials and preserves disabled setup across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-controller-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  const cipher = {
    encrypt: (s: string) => Buffer.from([...s].reverse().join("")),
    decrypt: (b: Buffer) => [...b.toString()].reverse().join(""),
  };
  const request = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: "test_bot" } })),
  );
  const agents = {
    listAgents: vi.fn(() => [{ id: "chief-of-staff" }]),
    deliverReviewedGatewayMessage: vi.fn(),
    readConversation: vi.fn(async () => ({ messages: [] })),
  };
  const path = join(root, "secret.json");
  const controller = new TelegramController({ database: db, agents, credentialPath: path, cipher, request });
  try {
    await controller.initialize();
    await controller.configure("123:FAKE_TOKEN");
    controller.pair("12", "7");
    expect(controller.status()).toMatchObject({ configured: true, enabled: false });
    expect(await readFile(path, "utf8")).not.toContain("FAKE_TOKEN");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const restarted = new TelegramController({ database: db, agents, credentialPath: path, cipher, request });
    await restarted.initialize();
    expect(restarted.status()).toMatchObject({ configured: true, enabled: false });
    expect(request).toHaveBeenCalledTimes(1);
    restarted.stop();
  } finally {
    controller.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("a locked vault refuses saving and does not register an enabled gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-locked-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  const controller = new TelegramController({
    database: db,
    agents: {
      listAgents: vi.fn(() => [{ id: "chief-of-staff" }]),
      deliverReviewedGatewayMessage: vi.fn(),
      readConversation: vi.fn(async () => ({ messages: [] })),
    },
    credentialPath: join(root, "secret"),
    cipher: {
      encrypt: () => {
        throw new Error("locked");
      },
      decrypt: () => {
        throw new Error("locked");
      },
    },
  });
  try {
    await expect(controller.configure("123:FAKE")).rejects.toThrow("locked");
    expect(controller.status()).toMatchObject({ configured: false, enabled: false });
  } finally {
    controller.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("collects only the completed Chief turn for the original request and reviews before send", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-reply-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  const { GatewayStore } = await import("../backend/gateway-store");
  const store = new GatewayStore(db);
  const request = vi.fn(
    async (url: URL | RequestInfo) =>
      new Response(
        JSON.stringify({
          ok: true,
          result: String(url).endsWith("getMe") ? { id: 123, is_bot: true, username: "test_bot" } : { message_id: 55 },
        }),
      ),
  );
  const agents = {
    listAgents: vi.fn(() => [{ id: "chief-of-staff" }]),
    deliverReviewedGatewayMessage: vi.fn(),
    readConversation: vi.fn(async () => ({
      messages: [
        {
          id: "reply",
          author: "assistant",
          turnId: "turn1",
          status: "completed",
          itemType: "final_answer",
          text: "Chief result",
        },
        { id: "other", author: "assistant", turnId: "turn2", status: "completed", text: "Other private reply" },
      ],
    })),
  };
  const controller = new TelegramController({
    database: db,
    agents,
    credentialPath: join(root, "secret"),
    cipher: { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
    request,
  });
  try {
    await controller.configure("123:FAKE");
    controller.pair("12", "7");
    store.enable("telegram:123", "local-owner");
    store.ingest("telegram:123", { eventId: "1", conversationId: "12", senderId: "7", body: "request", nextOffset: 2 });
    store.approveInbound("telegram:123", "local-owner", "1", "request", "12", "7");
    store.delivered("telegram:123", "1", 1, "m1");
    db.connection
      .prepare("INSERT INTO projection_mailbox_messages VALUES('m1','user',NULL,'request',NULL,'now','{}',0)")
      .run();
    db.connection
      .prepare(
        "INSERT INTO projection_deliveries VALUES('d1','m1','chief-of-staff','completed','turn1',NULL,'now','{}',0)",
      )
      .run();
    await controller.collectReplies();
    await controller.collectReplies();
    expect(controller.status().replies).toEqual([
      { replyId: "reply:1:turn1", conversationId: "12", senderId: "7", body: "Chief result" },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    await controller.approveReply("reply:1:turn1", "Chief result", "12", "7");
    expect(request).toHaveBeenCalledTimes(2);
    await controller.approveReply("reply:1:turn1", "Chief result", "12", "7").catch(() => {});
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    controller.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
