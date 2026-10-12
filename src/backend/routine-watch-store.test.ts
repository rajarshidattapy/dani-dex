import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentRoutineStore } from "./agent-routine-store";
import { DaniDexDatabase } from "./dani-dex-database";
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
    expect(() => watches.attachRun(w, "wrong-run")).toThrow("Exact committed");
    const run = routines.createEventRun(routine, matched.eventKey);
    routines.attachDelivery(run.id, "durable-delivery");
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
    watches.reconcileSources();
    expect(db.connection.prepare("SELECT state FROM projection_routine_watches WHERE watch_id=?").get(c)?.state).toBe(
      "blocked",
    );
    expect(watches.nextDueAt()).toBeNull();
    expect(routines.listRuns("chief", routine.id, 10)).toHaveLength(0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("recovers lost watch acknowledgement after committed delivery and revoke without reopening work", async () => {
  const root = await mkdtemp(join(tmpdir(), "watch-ack-"));
  let db = new DaniDexDatabase(root);
  await db.initialize();
  try {
    let routines = new AgentRoutineStore(db);
    const gateway = new GatewayStore(db);
    const watches = new RoutineWatchStore(db);
    const routine = routines.create({
      agentId: "chief",
      name: "Follow-up",
      instruction: "Owner instruction",
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
    const w = watches.create({
      ownerId: "owner",
      agentId: "chief",
      routineId: routine.id,
      gatewayId: "g",
      conversationId: "chat",
      senderId: "sender",
      deadline: Date.now() + 60000,
    });
    gateway.ingest("g", {
      eventId: "new",
      conversationId: "chat",
      senderId: "sender",
      body: "Untrusted",
      nextOffset: 1,
    });
    gateway.approveInbound("g", "owner", "new", "Untrusted", "chat", "sender");
    const event = watches.match(w, "new");
    const run = routines.createEventRun(routine, event.eventKey);
    watches.recoverCommittedRuns();
    expect(db.connection.prepare("SELECT state FROM projection_routine_watches WHERE watch_id=?").get(w)?.state).toBe(
      "matched",
    );
    expect(() => watches.attachRun(w, run.id)).toThrow("Exact committed");
    routines.attachDelivery(run.id, "committed-delivery");
    gateway.revoke("g", "owner");
    db.connection
      .prepare("DELETE FROM orchestration_command_receipts WHERE command_id LIKE 'routine-run:event:%'")
      .run();
    db.close();
    db = new DaniDexDatabase(root);
    await db.initialize();
    routines = new AgentRoutineStore(db);
    const recovered = new RoutineWatchStore(db);
    await recovered.processDue(new Date(Date.now() + 120000));
    expect(() => recovered.cancel(w, "owner")).toThrow("unavailable");
    expect(
      db.connection.prepare("SELECT state,run_id FROM projection_routine_watches WHERE watch_id=?").get(w),
    ).toMatchObject({ state: "running", run_id: run.id });
    expect(() => recovered.match(w, "new")).toThrow("resolved");
    expect(routines.createEventRun(routine, event.eventKey).deliveryId).toBe("committed-delivery");
    routines.updateRunStatus(run.id, "succeeded");
    recovered.reconcileRuns();
    expect(db.connection.prepare("SELECT state FROM projection_routine_watches WHERE watch_id=?").get(w)?.state).toBe(
      "completed",
    );
    expect(routines.listRuns("chief", routine.id, 10)).toHaveLength(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
