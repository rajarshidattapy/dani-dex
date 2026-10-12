import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DaniDexDatabase } from "./dani-dex-database";
import { AgentRoutineStore } from "./agent-routine-store";
import { GatewayStore } from "./gateway-store";
import { RoutineWatchStore } from "./routine-watch-store";

it("matches only new reviewed source events and reconciles actual routine outcome after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "watch-recovery-"));
  let db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const routines = new AgentRoutineStore(db),
      gateway = new GatewayStore(db),
      watches = new RoutineWatchStore(db);
    const routine = routines.create({
      agentId: "chief",
      name: "Review",
      instruction: "Owner-local instructions.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    gateway.register({
      gatewayId: "g",
      ownerId: "owner",
      agentId: "chief",
      platform: "telegram",
      accountId: "bot",
      credentialHandle: "vault:test",
    });
    gateway.pair("g", "owner", "chat", "sender");
    gateway.enable("g", "owner");
    const ingest = (id: string, approve = true) => {
      gateway.ingest("g", {
        eventId: id,
        conversationId: "chat",
        senderId: "sender",
        body: "Untrusted body",
        nextOffset: 1,
      });
      if (approve) gateway.approveInbound("g", "owner", id, "Untrusted body", "chat", "sender");
    };
    ingest("old");
    const input = {
      ownerId: "owner",
      agentId: "chief",
      routineId: routine.id,
      gatewayId: "g",
      conversationId: "chat",
      senderId: "sender",
      deadline: Date.now() + 60000,
    };
    const w = watches.create(input);
    expect(() => watches.match(w, "old")).toThrow("authorized");
    ingest("pending", false);
    expect(() => watches.match(w, "pending")).toThrow("authorized");
    ingest("new");
    const matched = watches.match(w, "new");
    expect(matched.agentId).toBe("chief");
    expect(watches.match(w, "new").eventKey).toBe(matched.eventKey);
    expect(() => watches.attachRun(w, "wrong-run")).toThrow("Owned active");
    const run = routines.createRun(routine, routine.trigger.id, "manual", new Date().toISOString());
    watches.attachRun(w, run.id);
    expect(() => watches.match(w, "new")).toThrow("resolved");
    expect(db.connection.prepare("SELECT state FROM projection_routine_watches WHERE watch_id=?").get(w)?.state).toBe(
      "running",
    );
    routines.updateRunStatus(run.id, "succeeded");
    db.close();
    db = new DaniDexDatabase(root);
    await db.initialize();
    new RoutineWatchStore(db).reconcileRuns();
    expect(db.connection.prepare("SELECT state FROM projection_routine_watches WHERE watch_id=?").get(w)?.state).toBe(
      "completed",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("cancel, timeout, wrong owner and source revoke stay terminal with no run attached", async () => {
  const root = await mkdtemp(join(tmpdir(), "watch-recovery-"));
  const db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    const routines = new AgentRoutineStore(db),
      gateway = new GatewayStore(db),
      watches = new RoutineWatchStore(db);
    const routine = routines.create({
      agentId: "chief",
      name: "Review",
      instruction: "Owner-local instructions.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    gateway.register({
      gatewayId: "g",
      ownerId: "owner",
      agentId: "chief",
      platform: "telegram",
      accountId: "bot",
      credentialHandle: "vault:test",
    });
    gateway.pair("g", "owner", "chat", "sender");
    gateway.enable("g", "owner");
    const input = {
      ownerId: "owner",
      agentId: "chief",
      routineId: routine.id,
      gatewayId: "g",
      conversationId: "chat",
      senderId: "sender",
      deadline: Date.now() + 60000,
    };
    expect(() => watches.create({ ...input, ownerId: "other" })).toThrow();
    const a = watches.create(input);
    expect(() => watches.cancel(a, "other")).toThrow();
    watches.cancel(a, "owner");
    expect(() => watches.match(a, "any")).toThrow("resolved");
    const b = watches.create(input);
    await watches.processDue(new Date(Date.now() + 60001));
    expect(() => watches.match(b, "any")).toThrow("resolved");
    const c = watches.create(input);
    gateway.ingest("g", {
      eventId: "new",
      conversationId: "chat",
      senderId: "sender",
      body: "Untrusted",
      nextOffset: 1,
    });
    gateway.approveInbound("g", "owner", "new", "Untrusted", "chat", "sender");
    gateway.revoke("g", "owner");
    expect(() => watches.match(c, "new")).toThrow("authorized");
    expect(routines.listRuns("chief", routine.id, 10)).toHaveLength(0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
