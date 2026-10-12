import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DaniDexDatabase } from "./dani-dex-database";
import { GatewayStore } from "./gateway-store";
import { telegramMediaManifest } from "./telegram-media";
import { TelegramMediaStore } from "./telegram-media-store";

it("persists exact owner media review across restart, blocks changed identity/wrong owner/revoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-media-store-"));
  let db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    let gateway = new GatewayStore(db);
    gateway.register({
      gatewayId: "g",
      ownerId: "o",
      agentId: "chief",
      platform: "telegram",
      accountId: "b",
      credentialHandle: "vault:t",
    });
    gateway.pair("g", "o", "12", "7");
    gateway.enable("g", "o");
    const manifest = telegramMediaManifest({
      update_id: 4,
      message: { message_id: 1, chat: { id: 12 }, from: { id: 7 }, document: { file_id: "f", file_unique_id: "u" } },
    });
    if (!manifest) throw Error("Missing media fixture");
    gateway.ingest("g", {
      eventId: "4",
      conversationId: "12",
      senderId: "7",
      body: "[Media needs exact review]",
      nextOffset: 5,
    });
    let media = new TelegramMediaStore(db);
    media.record("g", manifest);
    media.record("g", manifest);
    expect(media.pending("g")).toEqual([manifest]);
    expect(() => media.record("g", { ...manifest, reviewDigest: "changed" })).toThrow("changed");
    expect(() => media.assertReviewed("g", "o", "4", manifest.reviewDigest)).toThrow();
    expect(() => media.review("g", "other", "4", manifest.reviewDigest)).toThrow();
    expect(() => media.review("g", "o", "4", "wrong")).toThrow();
    media.review("g", "o", "4", manifest.reviewDigest);
    media.assertReviewed("g", "o", "4", manifest.reviewDigest);
    db.close();
    db = new DaniDexDatabase(root);
    await db.initialize();
    media = new TelegramMediaStore(db);
    gateway = new GatewayStore(db);
    media.assertReviewed("g", "o", "4", manifest.reviewDigest);
    gateway.revoke("g", "o");
    expect(() => media.assertReviewed("g", "o", "4", manifest.reviewDigest)).toThrow();
    expect(media.pending("g")).toEqual([]);
    gateway.pair("g", "o", "12", "7");
    gateway.enable("g", "o");
    expect(() => media.assertReviewed("g", "o", "4", manifest.reviewDigest)).toThrow();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("does not record rejected stranger metadata or approve edits as original messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-media-reject-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const gateway = new GatewayStore(db);
    gateway.register({
      gatewayId: "g",
      ownerId: "o",
      agentId: "chief",
      platform: "telegram",
      accountId: "b",
      credentialHandle: "vault:t",
    });
    gateway.pair("g", "o", "12", "7");
    gateway.enable("g", "o");
    const manifest = telegramMediaManifest({
      update_id: 4,
      edited_message: {
        message_id: 1,
        chat: { id: 12 },
        from: { id: 7 },
        document: { file_id: "f", file_unique_id: "u" },
      },
    });
    if (!manifest) throw Error("Missing media fixture");
    const media = new TelegramMediaStore(db);
    gateway.ingest("g", { eventId: "4", conversationId: "12", senderId: "7", body: "edit", nextOffset: 5 });
    media.record("g", manifest);
    expect(() => media.review("g", "o", "4", manifest.reviewDigest)).toThrow("Edit");
    gateway.ingest("g", { eventId: "5", conversationId: "12", senderId: "stranger", body: "secret", nextOffset: 6 });
    expect(() => media.record("g", { ...manifest, updateId: "5", senderId: "stranger" })).toThrow("pending inbox");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
