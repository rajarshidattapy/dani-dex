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
it("wires paired media metadata into owner status and refuses text-only approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-controller-media-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  const cipher = { encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
  const agents = {
    listAgents: vi.fn(() => [{ id: "chief" }]),
    readConversation: vi.fn(async () => ({ messages: [] })),
    deliverReviewedGatewayMessage: vi.fn(),
  };
  let polls = 0;
  const request = vi.fn(async (input: URL | RequestInfo) =>
    Response.json(
      String(input).endsWith("getMe")
        ? { ok: true, result: { id: 123, is_bot: true, username: "qa" } }
        : {
            ok: true,
            result: polls++
              ? []
              : [
                  {
                    update_id: 4,
                    message: {
                      message_id: 1,
                      chat: { id: 12 },
                      from: { id: 7 },
                      document: { file_id: "f", file_unique_id: "u", file_name: "brief.pdf" },
                    },
                  },
                ],
          },
    ),
  );
  const controller = new TelegramController({
    database: db,
    agents,
    credentialPath: join(root, "secret"),
    cipher,
    request,
  });
  try {
    await controller.configure("123:FAKE");
    controller.pair("12", "7");
    controller.enable();
    await vi.waitFor(() => expect(controller.status().mediaPending).toHaveLength(1));
    const item = controller.status().pending[0];
    expect(controller.status().mediaPending[0]).toMatchObject({ messageId: "1", safeName: "brief.pdf", senderId: "7" });
    await expect(
      controller.approveInbound(item.eventId, item.body, item.conversationId, item.senderId),
    ).rejects.toThrow("exact attachment review");
    expect(agents.deliverReviewedGatewayMessage).not.toHaveBeenCalled();
    controller.revoke();
    expect(controller.status().mediaPending).toEqual([]);
  } finally {
    controller.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("downloads only exact reviewed document and reconciles mailbox commit before gateway ack", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-document-delivery-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  const cipher = { encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
  let polls = 0,
    first = true;
  const deliver = vi.fn(
    async (input: { validateApproval: () => void; attachmentData?: Array<{ bytes: Uint8Array; name: string }> }) => {
      input.validateApproval();
      expect(input.attachmentData?.[0].name).toBe("brief.txt");
      expect(new TextDecoder().decode(input.attachmentData?.[0].bytes)).toBe("abc");
      if (first) {
        first = false;
        throw Error("commit ack lost");
      }
      return { messageId: "durable-receipt", deliveries: [] };
    },
  );
  const request = vi.fn(async (input: URL | RequestInfo) => {
    const u = String(input);
    if (u.includes("/file/")) return new Response("abc");
    return Response.json(
      u.endsWith("getMe")
        ? { ok: true, result: { id: 123, is_bot: true, username: "qa" } }
        : u.endsWith("getFile")
          ? { ok: true, result: { file_id: "f", file_unique_id: "u", file_size: 3, file_path: "documents/brief.txt" } }
          : {
              ok: true,
              result: polls++
                ? []
                : [
                    {
                      update_id: 4,
                      message: {
                        message_id: 1,
                        chat: { id: 12 },
                        from: { id: 7 },
                        document: { file_id: "f", file_unique_id: "u", file_size: 3, file_name: "brief.txt" },
                      },
                    },
                  ],
            },
    );
  });
  const c = new TelegramController({
    database: db,
    agents: {
      listAgents: vi.fn(() => [{ id: "chief" }]),
      readConversation: vi.fn(async () => ({ messages: [] })),
      deliverReviewedGatewayMessage: deliver,
    },
    credentialPath: join(root, "secret"),
    cipher,
    request,
  });
  try {
    await c.configure("123:FAKE");
    c.pair("12", "7");
    c.enable();
    await vi.waitFor(() => expect(c.status().mediaPending).toHaveLength(1));
    const m = c.status().mediaPending[0];
    await expect(c.approveMedia("4", "wrong")).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
    await expect(c.approveMedia("4", m.reviewDigest)).rejects.toThrow("commit ack lost");
    await c.approveMedia("4", m.reviewDigest);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][0]).toMatchObject({ idempotencyKey: expect.any(String) });
    expect((deliver.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe(
      (deliver.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(c.status().pending).toEqual([]);
    expect(c.status().mediaPending).toEqual([]);
  } finally {
    c.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
