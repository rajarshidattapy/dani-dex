import type { AgentRuntimeSnapshot, QueueSnapshot, Routine, RoutineRun } from "@dani-dex/contracts/ipc";

/** A read-only view, never an approval surface or a second task store. */
export interface OverviewSource<T> {
  value: T;
  observedAt: string;
  complete: boolean;
}
export type OverviewTarget =
  | { kind: "review"; agentId: string; threadId: string; turnId: string; requestId: string | number }
  | { kind: "session"; agentId: string; threadId: string; turnId: string }
  | { kind: "queue"; agentId: string; deliveryId?: string }
  | { kind: "routine"; agentId: string; routineId: string; runId?: string }
  | { kind: "message"; agentId: string; messageId: string };
export interface OverviewItem {
  id: string;
  agentId: string;
  label: string;
  state: string;
  target: OverviewTarget;
  at?: string;
}
export interface OverviewInput {
  agentIds: readonly string[];
  runtime?: OverviewSource<AgentRuntimeSnapshot>;
  queues?: OverviewSource<QueueSnapshot[]>;
  routines?: OverviewSource<Routine[]>;
  runs?: OverviewSource<RoutineRun[]>;
  now: number;
  staleAfterMs?: number;
}
export interface WorkOverview {
  sources: Array<{ name: string; state: "current" | "stale" | "unavailable" | "partial" }>;
  needsYou: OverviewItem[];
  workingNow: OverviewItem[];
  upNext: OverviewItem[];
  recentResults: OverviewItem[];
  /** Empty lists alone do not prove an idle team or a completed task. */
  complete: boolean;
}

export function projectWorkOverview(input: OverviewInput): WorkOverview {
  const scope = new Set(input.agentIds);
  const belongs = (agentId: string) => scope.has(agentId);
  const result: WorkOverview = {
    sources: [],
    needsYou: [],
    workingNow: [],
    upNext: [],
    recentResults: [],
    complete: true,
  };
  const fresh = <T>(name: string, source?: OverviewSource<T>): T | undefined => {
    const ts = source ? Date.parse(source.observedAt) : NaN;
    const age = input.now - ts;
    const state = !source
      ? "unavailable"
      : !Number.isFinite(age) || age < 0 || age > (input.staleAfterMs ?? 60_000)
        ? "stale"
        : !source.complete
          ? "partial"
          : "current";
    result.sources.push({ name, state });
    if (state !== "current") result.complete = false;
    return state === "current" || state === "partial" ? source?.value : undefined;
  };
  const runtime = fresh("runtime", input.runtime);
  const queues = fresh("queues", input.queues);
  const routines = fresh("routines", input.routines);
  const runs = fresh("runs", input.runs);
  if (runtime) {
    if (!runtime.attentionComplete) result.complete = false;
    // Never reproduce secret question text or compressed approval details. Drill through to originals.
    for (const prompt of runtime.pendingPrompts.filter((p) => belongs(p.agentId))) {
      result.needsYou.push({
        id: `question:${prompt.agentId}:${prompt.requestId}`,
        agentId: prompt.agentId,
        label: "Answer needed",
        state: "question",
        target: {
          kind: "review",
          agentId: prompt.agentId,
          threadId: prompt.threadId,
          turnId: prompt.turnId,
          requestId: prompt.requestId,
        },
      });
    }
    for (const approval of runtime.pendingApprovals.filter((p) => belongs(p.agentId))) {
      result.needsYou.push({
        id: `approval:${approval.agentId}:${approval.requestId}`,
        agentId: approval.agentId,
        label: "Review original action",
        state: "approval",
        target: {
          kind: "review",
          agentId: approval.agentId,
          threadId: approval.threadId,
          turnId: approval.turnId,
          requestId: approval.requestId,
        },
      });
    }
    for (const takeover of runtime.pendingBrowserTakeovers.filter((p) => belongs(p.agentId))) {
      result.needsYou.push({
        id: `takeover:${takeover.agentId}:${takeover.requestId}`,
        agentId: takeover.agentId,
        label: "Browser takeover requested",
        state: "takeover",
        target: {
          kind: "review",
          agentId: takeover.agentId,
          threadId: takeover.threadId,
          turnId: takeover.turnId,
          requestId: takeover.requestId,
        },
      });
    }
    for (const turn of runtime.failedTurns.filter((t) => belongs(t.agentId))) {
      result.needsYou.push({
        id: `failure:${turn.agentId}:${turn.turnId}`,
        agentId: turn.agentId,
        label: "Work failed - inspect before retry",
        state: "failed",
        target: { kind: "queue", agentId: turn.agentId },
      });
    }
    for (const turn of runtime.activeTurns.filter((t) => belongs(t.agentId))) {
      const item = runtime.work.find(
        (w) => w.agentId === turn.agentId && w.turnId === turn.turnId && w.status !== "failed",
      );
      result.workingNow.push({
        id: `turn:${turn.agentId}:${turn.turnId}`,
        agentId: turn.agentId,
        label: item?.text || "Active session",
        state: item?.status ?? "running",
        target: { kind: "session", ...turn },
      });
    }
    // A message is an output, not evidence that its task succeeded. Do not call it a completed task.
    for (const message of runtime.latestMessages.filter((m) => belongs(m.agentId))) {
      result.recentResults.push({
        id: `message:${message.agentId}:${message.id}`,
        agentId: message.agentId,
        label: message.text,
        state: "conversation-output",
        at: message.createdAt,
        target: { kind: "message", agentId: message.agentId, messageId: message.id },
      });
    }
  }
  for (const queue of queues ?? []) {
    if (!belongs(queue.agentId)) continue;
    if (queue.hold)
      result.upNext.push({
        id: `hold:${queue.agentId}`,
        agentId: queue.agentId,
        label: `Queue waiting on channel: ${queue.hold.channelName}`,
        state: "held",
        target: { kind: "queue", agentId: queue.agentId },
      });
    for (const delivery of queue.deliveries) {
      // An incorrectly mixed source must not leak another agent's queue into this view.
      if (delivery.recipientAgentId !== queue.agentId || delivery.status !== "queued") continue;
      result.upNext.push({
        id: `delivery:${queue.agentId}:${delivery.id}`,
        agentId: queue.agentId,
        label: delivery.text,
        state: delivery.editing ? "editing" : queue.hold ? "held" : "queued",
        target: { kind: "queue", agentId: queue.agentId, deliveryId: delivery.id },
      });
    }
  }
  for (const routine of routines ?? []) {
    if (!belongs(routine.agentId) || !routine.active) continue;
    result.upNext.push({
      id: `routine:${routine.agentId}:${routine.id}`,
      agentId: routine.agentId,
      label: routine.name,
      state: "scheduled",
      at: routine.trigger.nextRunAt,
      target: { kind: "routine", agentId: routine.agentId, routineId: routine.id },
    });
  }
  for (const run of runs ?? []) {
    if (!belongs(run.agentId)) continue;
    const target: OverviewTarget = { kind: "routine", agentId: run.agentId, routineId: run.routineId, runId: run.id };
    const item = {
      id: `run:${run.agentId}:${run.id}`,
      agentId: run.agentId,
      label: run.routineName,
      state: run.status,
      target,
      at: run.updatedAt,
    };
    if (["failed", "interrupted", "needs-attention"].includes(run.status)) result.needsYou.push(item);
    else if (run.status === "succeeded") result.recentResults.push(item);
    // Enqueued/running runs are not results. Queue/session sources own those sections.
  }
  result.recentResults.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return result;
}

/** Preparation-only adapter for the existing AgentService reads. No IPC, effects or UI wiring. */
export interface OverviewReader {
  listAgents(): Array<{ id: string }>;
  getRuntimeSnapshot(): AgentRuntimeSnapshot;
  listQueue(agentId: string): QueueSnapshot;
  listRoutines(agentId: string): Routine[];
  listRoutineRuns(input: { agentId: string; routineId: string; limit: number }): RoutineRun[];
}
export function readWorkOverview(reader: OverviewReader, agentIds: readonly string[], now = Date.now()): WorkOverview {
  // Never accept hidden/archived/in-progress duplication identities from a caller's stale roster.
  const known = new Set(reader.listAgents().map((a) => a.id));
  const scope = [...new Set(agentIds)].filter((id) => known.has(id));
  const observedAt = new Date(now).toISOString();
  const capture = <T>(read: () => T, complete: boolean): OverviewSource<T> | undefined => {
    try {
      return { value: read(), observedAt, complete };
    } catch {
      return undefined;
    }
  };
  const routines = capture(() => scope.flatMap((id) => reader.listRoutines(id)), true);
  const view = projectWorkOverview({
    agentIds: scope,
    now,
    // Existing runtime API budgets work/attention. Never upgrade it to an exhaustive task inventory.
    runtime: capture(() => reader.getRuntimeSnapshot(), false),
    queues: capture(() => scope.map((id) => reader.listQueue(id)), true),
    routines,
    // Existing API is a bounded history per routine, not every unresolved run (deleted routines too).
    runs: routines
      ? capture(
          () =>
            routines.value.flatMap((r) => reader.listRoutineRuns({ agentId: r.agentId, routineId: r.id, limit: 50 })),
          false,
        )
      : undefined,
  });
  // Real watches and channel tasks need separate scoped reads, not invented schedule cards.
  view.sources.push({ name: "watches", state: "unavailable" }, { name: "channel-tasks", state: "unavailable" });
  view.complete = false;
  return view;
}
