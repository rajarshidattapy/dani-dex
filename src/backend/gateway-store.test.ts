import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DaniDexDatabase } from "./dani-dex-database";
import { GatewayStore } from "./gateway-store";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "gateway-"));
  roots.push(root);
  const db = new DaniDexDatabase(root);
  await db.initialize();
  const store = new GatewayStore(db);
  store.register({
    gatewayId: "tg",
    ownerId: "owner",
    agentId: "chief",
    platform: "telegram",
    accountId: "bot1",
    credentialHandle: "vault:telegram:bot1",
  });
  store.pair("tg", "owner", "chat1", "person1");
  store.enable("tg", "owner");
  return { db, store, root };
}
const event = { eventId: "17", conversationId: "chat1", senderId: "person1", body: "Hello", nextOffset: 18 };
it("persists offsets and dedupe across restart", async () => {
  const { db, store, root } = await setup();
  expect(store.ingest("tg", event)).toBe("accepted");
  db.close();
  const next = new DaniDexDatabase(root);
  await next.initialize();
  const loaded = new GatewayStore(next);
  expect(loaded.offset("tg")).toBe(18);
  expect(loaded.ingest("tg", event)).toBe("duplicate");
  expect(loaded.pending("tg")).toHaveLength(1);
  next.close();
});
it("rejects unknown group senders without persisting their text", async () => {
  const { db, store } = await setup();
  expect(store.ingest("tg", { ...event, senderId: "stranger", body: "password demo-secret" })).toBe("rejected");
  expect(store.pending("tg")).toEqual([]);
  expect(JSON.stringify(db.connection.prepare("SELECT * FROM projection_gateway_inbox").all())).not.toContain(
    "demo-secret",
  );
  db.close();
});
it("revocation cancels pending delivery and old pairing", async () => {
  const { db, store } = await setup();
  store.ingest("tg", event);
  store.revoke("tg", "owner");
  expect(store.pending("tg")).toEqual([]);
  store.enable("tg", "owner");
  expect(store.ingest("tg", { ...event, eventId: "19", nextOffset: 20 })).toBe("rejected");
  db.close();
});
it("rejects other owner and invalid offset", async () => {
  const { db, store } = await setup();
  expect(() => store.enable("tg", "wrong")).toThrow();
  expect(() => store.ingest("tg", { ...event, nextOffset: NaN })).toThrow();
  expect(store.offset("tg")).toBe(0);
  db.close();
});
it("binds recipient and words review, stops ambiguous retries and cancels on revoke", async () => {
  const { db, store } = await setup();
  store.queueReply("tg", "r1", "chat1", "person1", "Answer");
  expect(() => store.approveReply("tg", "owner", "r1", "Different", "chat1", "person1")).toThrow();
  store.approveReply("tg", "owner", "r1", "Answer", "chat1", "person1");
  expect(store.claimReply("tg", "r1")?.body).toBe("Answer");
  store.recoverInterruptedSends();
  expect(store.claimReply("tg", "r1")).toBeNull();
  store.settleReply("tg", "r1", "provider1");
  expect(db.connection.prepare("SELECT state FROM projection_gateway_outbox").get()?.state).toBe("sent");
  store.queueReply("tg", "r2", "chat1", "person1", "More");
  store.approveReply("tg", "owner", "r2", "More", "chat1", "person1");
  store.revoke("tg", "owner");
  expect(store.claimReply("tg", "r2")).toBeNull();
  db.close();
});
it("pairing permits receipt, not execution; exact owner review is required", async () => {
  const { db, store } = await setup();
  store.ingest("tg", event);
  expect(store.approved("tg")).toEqual([]);
  expect(() => store.approveInbound("tg", "owner", "17", "different", "chat1", "person1")).toThrow();
  store.approveInbound("tg", "owner", "17", "Hello", "chat1", "person1");
  expect(store.approved("tg")).toHaveLength(1);
  store.revoke("tg", "owner");
  expect(store.approved("tg")).toEqual([]);
  db.close();
});
it("WhatsApp cannot activate and credentials must be handles", async () => {
  const { db, store } = await setup();
  store.register({
    gatewayId: "wa",
    ownerId: "owner",
    agentId: "chief",
    platform: "whatsapp",
    accountId: "number",
    credentialHandle: "vault:whatsapp",
  });
  expect(() => store.enable("wa", "owner")).toThrow("held");
  expect(() =>
    store.register({
      gatewayId: "secret",
      ownerId: "owner",
      agentId: "chief",
      platform: "telegram",
      accountId: "bot2",
      credentialHandle: "raw-token",
    }),
  ).toThrow("handle");
  db.close();
});

it("rejection preserves offset and cannot dispatch or later approve the request",async()=>{
 const {db,store}=await setup();store.ingest("tg",event);store.rejectInbound("tg","owner","17");expect(store.pending("tg")).toEqual([]);expect(store.approved("tg")).toEqual([]);expect(store.offset("tg")).toBe(18);expect(()=>store.approveInbound("tg","owner","17","Hello","chat1","person1")).toThrow();db.close();
});
