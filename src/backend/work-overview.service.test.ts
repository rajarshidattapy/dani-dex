// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentService } from "./agent-service";
import { createTestService, startAgentTestFixture, stopAgentTestFixture, stores } from "./agent-service-test-harness";
import { readWorkOverview } from "./work-overview";

let root: string;
let service: AgentService | null = null;
beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});
afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});
it("reads real AgentService-owned routines and queues without starting work or claiming full coverage", async () => {
  const { store, mailbox } = stores(root);
  await store.initialize();
  await mailbox.initialize();
  const chief = await store.getOrCreate("chief");
  const specialist = await store.getOrCreate("research");
  service = createTestService({ store, mailbox });
  const routine = await service.createRoutine({
    agentId: chief.id,
    name: "Release check",
    instruction: "Inspect only",
    active: false,
    timezone: "UTC",
    schedule: { kind: "interval", amount: 60, unit: "minutes", anchorAt: new Date().toISOString() },
  });
  const before = service.listQueue(chief.id);
  const view = readWorkOverview(service, [chief.id], Date.now());
  expect(view.complete).toBe(false);
  expect(view.upNext).toEqual([]);
  expect(view.sources).toContainEqual({ name: "queues", state: "current" });
  expect(service.listQueue(chief.id)).toEqual(before);
  expect(service.listRoutineRuns({ agentId: chief.id, routineId: routine.id })).toEqual([]);
  expect(service.listQueue(specialist.id).deliveries).toEqual([]);
});
