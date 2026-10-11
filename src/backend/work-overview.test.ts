// @vitest-environment node

import type { AgentRuntimeSnapshot, QueueDelivery, Routine, RoutineRun } from "@dani-dex/contracts/ipc";
import { describe, expect, it } from "vitest";
import { type OverviewInput, type OverviewSource, projectWorkOverview, readWorkOverview } from "./work-overview";

const now = Date.parse("2026-10-11T22:20:00Z");
const source = <T>(value: T): OverviewSource<T> => ({ value, observedAt: new Date(now).toISOString(), complete: true });
const runtime = (): AgentRuntimeSnapshot => ({
  agents: [],
  activeTurns: [],
  work: [],
  latestMessages: [],
  attentionComplete: true,
  pendingPrompts: [],
  pendingApprovals: [],
  pendingBrowserTakeovers: [],
  failedTurns: [],
});
const input = (): OverviewInput => ({
  agentIds: ["chief"],
  now,
  runtime: source(runtime()),
  queues: source([]),
  routines: source([]),
  runs: source([]),
});
const delivery = (id: string, status: QueueDelivery["status"] = "queued"): QueueDelivery => ({
  id,
  messageId: `msg-${id}`,
  recipientAgentId: "chief",
  sender: { kind: "user" },
  text: "Review release",
  attachments: [],
  replyToMessageId: null,
  status,
  position: 1,
  turnId: null,
  error: null,
  createdAt: new Date(now).toISOString(),
});
const routine: Routine = {
  id: "r1",
  agentId: "chief",
  name: "Daily review",
  instruction: "Private instruction",
  active: true,
  timezone: "UTC",
  createdAt: "",
  updatedAt: "",
  trigger: {
    id: "t1",
    routineId: "r1",
    schedule: { kind: "interval", amount: 15, unit: "minutes", anchorAt: new Date(now).toISOString() },
    nextRunAt: new Date(now + 900000).toISOString(),
    createdAt: "",
    updatedAt: "",
  },
};
const run = (status: RoutineRun["status"]): RoutineRun => ({
  id: `run-${status}`,
  agentId: "chief",
  routineId: "r1",
  routineName: "Daily review",
  instruction: "Private instruction",
  status,
  deliveryId: null,
  triggerId: null,
  kind: "manual",
  scheduledFor: "",
  error: null,
  createdAt: "",
  updatedAt: new Date(now).toISOString(),
});
describe("work overview read-only projection", () => {
  it("distinguishes known empty from unavailable", () => {
    expect(projectWorkOverview(input()).complete).toBe(true);
    const view = projectWorkOverview({ agentIds: ["chief"], now });
    expect(view.complete).toBe(false);
    expect(view.sources.every((s) => s.state === "unavailable")).toBe(true);
    expect(view.workingNow).toEqual([]);
  });
  it("suppresses stale, future and malformed source payloads", () => {
    for (const observedAt of [new Date(now - 60001).toISOString(), new Date(now + 1).toISOString(), "invalid"]) {
      const view = projectWorkOverview({
        ...input(),
        queues: { value: [{ agentId: "chief", deliveries: [delivery("d1")] }], observedAt, complete: true },
      });
      expect(view.complete).toBe(false);
      expect(view.upNext).toEqual([]);
      expect(view.sources.find((s) => s.name === "queues")?.state).toBe("stale");
    }
  });
  it("retains partial evidence without presenting it as complete", () => {
    const view = projectWorkOverview({
      ...input(),
      queues: { ...source([{ agentId: "chief", deliveries: [delivery("d1")] }]), complete: false },
    });
    expect(view.upNext).toHaveLength(1);
    expect(view.complete).toBe(false);
    expect(view.sources.find((s) => s.name === "queues")?.state).toBe("partial");
  });
  it("routes exact original reviews and never exposes secret prompt/approval details", () => {
    const state = runtime();
    state.pendingPrompts.push({
      agentId: "chief",
      requestId: 7,
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [{ id: "q1", header: "Secret", question: "Sensitive context", isSecret: true, options: null }],
    });
    state.pendingApprovals.push({
      agentId: "chief",
      requestId: "a1",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "command",
      command: "sensitive",
      cwd: null,
      reason: null,
      permissions: null,
      grantRoot: null,
      truncated: true,
    });
    const view = projectWorkOverview({ ...input(), runtime: source(state) });
    expect(view.needsYou[0]?.target).toEqual({
      kind: "review",
      agentId: "chief",
      requestId: 7,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(JSON.stringify(view)).not.toContain("Sensitive context");
    expect(JSON.stringify(view)).not.toContain("sensitive");
  });
  it("specialist view excludes other agents across every section and rejects mixed queue rows", () => {
    const state = runtime();
    state.activeTurns = [{ agentId: "other", threadId: "t", turnId: "u" }];
    state.failedTurns = [{ agentId: "other", turnId: "u" }];
    state.latestMessages = [{ agentId: "other", id: "m", text: "Other private work", createdAt: "" }];
    const view = projectWorkOverview({
      ...input(),
      runtime: source(state),
      queues: source([
        { agentId: "chief", deliveries: [{ ...delivery("bad"), recipientAgentId: "other" }] },
        { agentId: "other", deliveries: [delivery("bad2")] },
      ]),
      routines: source([{ ...routine, agentId: "other" }]),
      runs: source([{ ...run("succeeded"), agentId: "other" }]),
    });
    expect([view.needsYou, view.workingNow, view.upNext, view.recentResults].flat()).toEqual([]);
  });
  it("binds a session to its exact agent/thread/turn, never by a display name", () => {
    const state = runtime();
    state.activeTurns = [{ agentId: "chief", threadId: "t1", turnId: "u1" }];
    state.work = [
      { id: "d1", agentId: "chief", turnId: "u2", status: "running", text: "Different session", error: null },
    ];
    const view = projectWorkOverview({ ...input(), runtime: source(state) });
    expect(view.workingNow[0]?.label).toBe("Active session");
    expect(view.workingNow[0]?.target).toEqual({ kind: "session", agentId: "chief", threadId: "t1", turnId: "u1" });
  });
  it("does not turn cancelled/queued/running deliveries or runs into success", () => {
    const view = projectWorkOverview({
      ...input(),
      queues: source([
        {
          agentId: "chief",
          deliveries: [
            delivery("d1", "completed"),
            delivery("d2", "cancelled"),
            delivery("d3", "running"),
            delivery("d4"),
          ],
        },
      ]),
      runs: source([run("queued"), run("running"), run("cancelled"), run("succeeded"), run("needs-attention")]),
    });
    expect(view.recentResults.map((i) => i.state)).toEqual(["succeeded"]);
    expect(view.needsYou.map((i) => i.state)).toEqual(["needs-attention"]);
    expect(view.upNext.map((i) => i.state)).toEqual(["queued"]);
  });
  it("preserves editing/channel holds and active scheduled routines, hides instructions", () => {
    const view = projectWorkOverview({
      ...input(),
      queues: source([
        {
          agentId: "chief",
          hold: { reason: "channel-task", channelId: "c1", channelName: "Release", agentId: "other" },
          deliveries: [{ ...delivery("d1"), editing: true }],
        },
      ]),
      routines: source([routine, { ...routine, id: "r2", active: false }]),
    });
    expect(view.upNext.map((i) => i.state)).toEqual(["held", "editing", "scheduled"]);
    expect(JSON.stringify(view)).not.toContain("Private instruction");
  });
  it("conversation output does not imply completion and incomplete attention stays visible", () => {
    const state = runtime();
    state.attentionComplete = false;
    state.latestMessages = [
      { agentId: "chief", id: "m1", text: "Working on it", createdAt: new Date(now).toISOString() },
    ];
    const view = projectWorkOverview({ ...input(), runtime: source(state) });
    expect(view.recentResults[0]?.state).toBe("conversation-output");
    expect(view.complete).toBe(false);
  });
});

describe("existing-service read adapter", () => {
  const reader = () => ({
    listAgents: () => [{ id: "chief" }],
    getRuntimeSnapshot: runtime,
    listQueue: (agentId: string) => ({ agentId, deliveries: [] }),
    listRoutines: () => [routine],
    listRoutineRuns: () => [run("succeeded")],
  });
  it("keeps bounded runtime/run history and absent watches/channels explicitly partial", () => {
    const view = readWorkOverview(reader(), ["chief"], now);
    expect(view.complete).toBe(false);
    expect(view.sources).toContainEqual({ name: "runtime", state: "partial" });
    expect(view.sources).toContainEqual({ name: "runs", state: "partial" });
    expect(view.sources).toContainEqual({ name: "watches", state: "unavailable" });
    expect(view.recentResults).toHaveLength(1);
  });
  it("does not let a failing read turn into known-empty", () => {
    const view = readWorkOverview(
      {
        ...reader(),
        listQueue: () => {
          throw Error("offline");
        },
      },
      ["chief"],
      now,
    );
    expect(view.sources).toContainEqual({ name: "queues", state: "unavailable" });
  });
  it("removes unknown or archived agent IDs before querying queues", () => {
    const ids: string[] = [];
    readWorkOverview(
      {
        ...reader(),
        listQueue: (id: string) => {
          ids.push(id);
          return { agentId: id, deliveries: [] };
        },
      },
      ["chief", "hidden", "chief"],
      now,
    );
    expect(ids).toEqual(["chief"]);
  });
});
