import { INPUT_LIMITS } from "@dani-dex/contracts/input-limits";
import type {
  CreateRoutineInput,
  Routine,
  RoutineRun,
  RoutineRunStatus,
  UpdateRoutineInput,
} from "@dani-dex/contracts/ipc";
import type { DaniDexDatabase } from "./dani-dex-database";
import {
  type DueRoutine,
  type OwnedRoutine,
  type OwnedRoutineRun,
  RoutineStore,
  type RoutineTables,
} from "./routine-store";

export interface DueRoutineTrigger {
  routine: Routine;
  triggerId: string;
  nextRunAt: string;
  schedule: DueRoutine["schedule"];
}

const AGENT_ROUTINE_TABLES: RoutineTables = {
  routineTable: "projection_agent_routines",
  triggerTable: "projection_routine_triggers",
  runTable: "projection_routine_runs",
  ownerColumn: "agent_id",
  handleColumn: "delivery_id",
  routineAggregate: "agent-routine",
  runAggregate: "routine-run",
  commandPrefix: "routine",
  eventPrefix: "routine",
  limit: INPUT_LIMITS.agentRoutines,
  limitMessage: `An agent can have at most ${INPUT_LIMITS.agentRoutines} routines.`,
};

/**
 * The agent-shaped names over the shared store: `ownerId` reads as `agentId` and the run handle
 * reads as `deliveryId`. The SQL, the constraints and the command ids all live in `RoutineStore`,
 * so this file only translates - which is why the callers and `agent-routine-store.test.ts` did not
 * change with the extraction.
 */
export class AgentRoutineStore extends RoutineStore {
  constructor(database: DaniDexDatabase) {
    super(database, AGENT_ROUTINE_TABLES);
  }

  list(agentId: string): Routine[] {
    return this.listRoutines(agentId).map(toRoutine);
  }

  get(agentId: string, routineId: string): Routine | null {
    const routine = this.getRoutine(agentId, routineId);
    return routine ? toRoutine(routine) : null;
  }

  duplicate(sourceAgentId: string, targetAgentId: string, now = new Date()): Map<string, Routine> {
    const duplicated = new Map<string, Routine>();
    for (const routine of this.list(sourceAgentId)) {
      duplicated.set(
        routine.id,
        this.create(
          {
            agentId: targetAgentId,
            name: routine.name,
            instruction: routine.instruction,
            active: routine.active,
            timezone: routine.timezone,
            schedule: routine.trigger.schedule,
          },
          now,
        ),
      );
    }
    return duplicated;
  }

  create(input: CreateRoutineInput, now = new Date()): Routine {
    const { agentId, ...fields } = input;
    return toRoutine(this.createRoutine(agentId, fields, now));
  }

  update(input: UpdateRoutineInput, now = new Date()): Routine {
    const { agentId, ...fields } = input;
    return toRoutine(this.updateRoutine(agentId, fields, now));
  }

  listRuns(agentId: string, routineId: string, limit = 50): RoutineRun[] {
    return this.listRunRows(agentId, routineId, limit).map(toRun);
  }

  pendingRuns(): RoutineRun[] {
    return this.pendingRunRows()
      .filter((run) => !this.isEventRun(run.id))
      .map(toRun);
  }
  pendingEventRuns(): RoutineRun[] {
    return this.pendingRunRows()
      .filter((run) => this.isEventRun(run.id))
      .map(toRun);
  }
  private isEventRun(runId: string): boolean {
    // Generic startup has no source validator. Creation events survive receipt pruning.
    return Boolean(
      this.database.connection
        .prepare(
          "SELECT 1 FROM orchestration_events WHERE aggregate_type='routine-run' AND command_id LIKE 'routine-run:event:%' AND json_extract(payload_json,'$.runId')=? LIMIT 1",
        )
        .get(runId),
    );
  }

  activeRuns(agentId: string, routineId: string): RoutineRun[] {
    return this.activeRunRows(agentId, routineId).map(toRun);
  }

  due(now = new Date(), excludedAgentIds: ReadonlySet<string> = new Set()): DueRoutineTrigger[] {
    return this.dueRoutines(now, excludedAgentIds).map((entry) => ({
      routine: toRoutine(entry.routine),
      triggerId: entry.triggerId,
      nextRunAt: entry.nextRunAt,
      schedule: entry.schedule,
    }));
  }

  createRun(routine: Routine, triggerId: string | null, kind: RoutineRun["kind"], scheduledFor: string): RoutineRun {
    return toRun(this.createRunRow(toOwnedRoutine(routine), triggerId, kind, scheduledFor));
  }

  /** Durable owner-event identity. Event body never becomes routine instructions. */
  createEventRun(routine: Routine, eventKey: string, now = new Date()): RoutineRun {
    if (!/^[a-f0-9]{64}$/.test(eventKey)) throw Error("Hashed source event identity required.");
    const commandId = `routine-run:event:${routine.agentId}:${routine.id}:${eventKey}`;
    const creation = this.database.connection
      .prepare(
        "SELECT json_extract(payload_json,'$.runId') run_id FROM orchestration_events WHERE command_id=? AND aggregate_type='routine-run' AND event_type='routine.run-created' ORDER BY sequence LIMIT 1",
      )
      .get(commandId);
    if (typeof creation?.run_id === "string") return toRun(this.currentRunRow(creation.run_id));
    const receipt = toRun(this.createRunRow(toOwnedRoutine(routine), null, "manual", now.toISOString(), eventKey));
    return toRun(this.currentRunRow(receipt.id));
  }
  attachDelivery(runId: string, deliveryId: string): RoutineRun {
    return toRun(this.attachHandleRow(runId, deliveryId));
  }

  updateRunStatus(runId: string, status: RoutineRunStatus, error: string | null = null): RoutineRun {
    return toRun(this.updateRunRow(runId, status, error));
  }

  runForDelivery(deliveryId: string): RoutineRun | null {
    const run = this.runForHandleRow(deliveryId);
    return run ? toRun(run) : null;
  }
}

function toRoutine({ ownerId, ...fields }: OwnedRoutine): Routine {
  return { ...fields, agentId: ownerId };
}

function toOwnedRoutine({ agentId, ...fields }: Routine): OwnedRoutine {
  return { ...fields, ownerId: agentId };
}

function toRun({ ownerId, handleId, ...fields }: OwnedRoutineRun): RoutineRun {
  return { ...fields, agentId: ownerId, deliveryId: handleId };
}
