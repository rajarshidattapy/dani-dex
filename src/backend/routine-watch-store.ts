import { createHash, randomUUID } from "node:crypto";
import type { DaniDexDatabase } from "./dani-dex-database";
import type { RoutineDueSource } from "./routine-timer";

export interface RoutineWatchInput {
  ownerId: string;
  agentId: string;
  routineId: string;
  gatewayId: string;
  conversationId: string;
  senderId: string;
  deadline: number;
}
/** Owner-local one-shot watch. Does not accept arbitrary semantic triggers or instructions from event text. */
export class RoutineWatchStore implements RoutineDueSource {
  constructor(private readonly database: DaniDexDatabase) {}
  create(input: RoutineWatchInput, now = Date.now()): string {
    if (
      Object.entries(input).some(
        ([key, value]) => key !== "deadline" && (typeof value !== "string" || !value || value.length > 256),
      ) ||
      !Number.isSafeInteger(input.deadline) ||
      input.deadline <= now ||
      input.deadline > now + 7 * 86400000
    )
      throw Error("Invalid watch scope/deadline.");
    const db = this.database.connection;
    const gateway = db
      .prepare("SELECT * FROM projection_gateways WHERE gateway_id=? AND owner_id=? AND agent_id=? AND enabled=1")
      .get(input.gatewayId, input.ownerId, input.agentId);
    if (
      !gateway ||
      !db
        .prepare("SELECT 1 FROM projection_gateway_chats WHERE gateway_id=? AND conversation_id=? AND sender_id=?")
        .get(input.gatewayId, input.conversationId, input.senderId)
    )
      throw Error("Owner-enabled paired source required.");
    if (
      !db
        .prepare("SELECT 1 FROM projection_agent_routines WHERE routine_id=? AND agent_id=? AND active=1")
        .get(input.routineId, input.agentId)
    )
      throw Error("Active owned routine required.");
    if (
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM projection_routine_watches WHERE owner_id=? AND state IN ('waiting','matched')",
          )
          .get(input.ownerId)?.n,
      ) >= 100
    )
      throw Error("Watch limit reached.");
    const id = randomUUID();
    this.change(id, "created", (tx) =>
      tx
        .prepare("INSERT INTO projection_routine_watches VALUES(?,?,?,?,?,?,?,?,?,?,'waiting',NULL,NULL)")
        .run(
          id,
          input.ownerId,
          input.agentId,
          input.routineId,
          input.gatewayId,
          input.conversationId,
          input.senderId,
          Number(gateway.generation),
          Number(
            db
              .prepare("SELECT coalesce(max(rowid),0) n FROM projection_gateway_inbox WHERE gateway_id=?")
              .get(input.gatewayId)?.n,
          ),
          input.deadline,
        ),
    );
    return id;
  }
  assertMatched(watchId: string): void {
    if (
      !this.database.connection
        .prepare(
          `SELECT 1 FROM projection_routine_watches w JOIN projection_gateways g USING(gateway_id) JOIN projection_gateway_inbox i ON i.gateway_id=w.gateway_id AND i.event_id=w.event_id JOIN projection_agent_routines r ON r.routine_id=w.routine_id AND r.agent_id=w.agent_id WHERE w.watch_id=? AND w.state='matched' AND w.deadline>? AND g.owner_id=w.owner_id AND g.agent_id=w.agent_id AND g.enabled=1 AND g.generation=w.generation AND i.rowid>w.after_rowid AND i.generation=w.generation AND i.conversation_id=w.conversation_id AND i.sender_id=w.sender_id AND i.state IN ('approved','delivered') AND r.active=1`,
        )
        .get(watchId, Date.now())
    )
      throw Error("Watch/source no longer authorized.");
  }
  match(watchId: string, eventId: string): { agentId: string; routineId: string; eventKey: string } {
    this.change(watchId, "matched", (db) => {
      const row = db.prepare("SELECT * FROM projection_routine_watches WHERE watch_id=?").get(watchId);
      if (!row || (row.state !== "waiting" && !(row.state === "matched" && row.event_id === eventId)))
        throw Error("Watch already resolved.");
      db.prepare("UPDATE projection_routine_watches SET state='matched',event_id=? WHERE watch_id=?").run(
        eventId,
        watchId,
      );
      this.assertMatched(watchId);
    });
    const row = this.database.connection
      .prepare("SELECT agent_id,routine_id FROM projection_routine_watches WHERE watch_id=?")
      .get(watchId);
    if (!row) throw Error("Watch unavailable.");
    return {
      agentId: String(row.agent_id),
      routineId: String(row.routine_id),
      eventKey: createHash("sha256")
        .update(JSON.stringify([watchId, eventId]))
        .digest("hex"),
    };
  }
  /** Status-only recovery. A committed run never authorizes another enqueue. */
  recoverCommittedRuns(): void {
    const rows = this.database.connection
      .prepare("SELECT watch_id,agent_id,routine_id,event_id FROM projection_routine_watches WHERE state='matched'")
      .all();
    for (const row of rows) {
      const eventKey = createHash("sha256")
        .update(JSON.stringify([row.watch_id, row.event_id]))
        .digest("hex");
      const commandId = `routine-run:event:${row.agent_id}:${row.routine_id}:${eventKey}`;
      const receipt = this.database.connection
        .prepare("SELECT result_json FROM orchestration_command_receipts WHERE command_id=?")
        .get(commandId);
      const creation =
        receipt ??
        this.database.connection
          .prepare(
            "SELECT json_object('id',json_extract(payload_json,'$.runId')) result_json FROM orchestration_events WHERE command_id=? AND aggregate_type='routine-run' AND event_type='routine.run-created' ORDER BY sequence LIMIT 1",
          )
          .get(commandId);
      if (!creation) continue;
      let runId: string;
      try {
        const r = JSON.parse(String(creation.result_json));
        if (typeof r?.id !== "string") continue;
        runId = r.id;
      } catch {
        continue;
      }
      const run = this.database.connection
        .prepare(
          "SELECT status,delivery_id FROM projection_routine_runs WHERE run_id=? AND agent_id=? AND routine_id=?",
        )
        .get(runId, row.agent_id, row.routine_id);
      if (!run || (!run.delivery_id && run.status === "queued")) continue;
      this.change(String(row.watch_id), "committed-run-recovered", (db) =>
        db
          .prepare("UPDATE projection_routine_watches SET state=?,run_id=? WHERE watch_id=? AND state='matched'")
          .run(
            run.status === "succeeded"
              ? "completed"
              : ["failed", "cancelled", "interrupted"].includes(String(run.status))
                ? "blocked"
                : "running",
            runId,
            String(row.watch_id),
          ),
      );
    }
  }
  attachRun(watchId: string, runId: string): void {
    this.recoverCommittedRuns();
    const attached = this.database.connection
      .prepare("SELECT run_id FROM projection_routine_watches WHERE watch_id=?")
      .get(watchId);
    if (attached?.run_id === runId) return;
    throw Error("Exact committed watch run required.");
  }
  cancel(watchId: string, ownerId: string): void {
    this.recoverCommittedRuns();
    this.change(watchId, "cancelled", (db) => {
      const r = db
        .prepare(
          "UPDATE projection_routine_watches SET state='cancelled' WHERE watch_id=? AND owner_id=? AND state IN ('waiting','matched')",
        )
        .run(watchId, ownerId);
      if (!r.changes) throw Error("Watch unavailable.");
    });
  }
  reconcileRuns(): void {
    this.recoverCommittedRuns();
    const rows = this.database.connection
      .prepare(
        "SELECT w.watch_id,r.status FROM projection_routine_watches w JOIN projection_routine_runs r ON r.run_id=w.run_id WHERE w.state='running' AND r.status IN ('succeeded','failed','cancelled','interrupted')",
      )
      .all();
    for (const row of rows)
      this.change(String(row.watch_id), "run-reconciled", (db) =>
        db
          .prepare("UPDATE projection_routine_watches SET state=? WHERE watch_id=? AND state='running'")
          .run(row.status === "succeeded" ? "completed" : "blocked", String(row.watch_id)),
      );
  }
  /** Source-only reconciliation. Does not execute routines or cancel committed mailbox work. */
  reconcileSources(): void {
    this.recoverCommittedRuns();
    const rows = this.database.connection
      .prepare(
        `SELECT w.watch_id FROM projection_routine_watches w WHERE w.state IN ('waiting','matched') AND (
        NOT EXISTS(SELECT 1 FROM projection_gateways g WHERE g.gateway_id=w.gateway_id AND g.owner_id=w.owner_id AND g.agent_id=w.agent_id AND g.enabled=1 AND g.generation=w.generation)
        OR NOT EXISTS(SELECT 1 FROM projection_gateway_chats c WHERE c.gateway_id=w.gateway_id AND c.conversation_id=w.conversation_id AND c.sender_id=w.sender_id)
        OR NOT EXISTS(SELECT 1 FROM projection_agent_routines r WHERE r.routine_id=w.routine_id AND r.agent_id=w.agent_id AND r.active=1))`,
      )
      .all();
    for (const row of rows)
      this.change(String(row.watch_id), "source-blocked", (db) =>
        db
          .prepare(
            "UPDATE projection_routine_watches SET state='blocked' WHERE watch_id=? AND state IN ('waiting','matched')",
          )
          .run(String(row.watch_id)),
      );
  }
  nextDueAt(): string | null {
    const r = this.database.connection
      .prepare("SELECT min(deadline) d FROM projection_routine_watches WHERE state IN ('waiting','matched')")
      .get();
    return r?.d ? new Date(Number(r.d)).toISOString() : null;
  }
  async processDue(now: Date): Promise<void> {
    this.reconcileSources();
    const due = this.nextDueAt();
    if (!due || Date.parse(due) > now.getTime()) return;
    this.change("deadlines", "timed-out", (db) =>
      db
        .prepare(
          "UPDATE projection_routine_watches SET state='timed-out' WHERE deadline<=? AND state IN ('waiting','matched')",
        )
        .run(now.getTime()),
    );
  }
  private change(id: string, type: string, project: (db: DaniDexDatabase["connection"]) => unknown): void {
    this.database.dispatch(
      `watch:${randomUUID()}`,
      [{ aggregateType: "routine-watch", aggregateId: id, eventType: `watch.${type}`, payload: { watchId: id } }],
      (db) => {
        project(db);
        return null;
      },
    );
  }
}
