import type { WorkerHistoryEntry } from "./worker-history";

export interface WorkerHistoryPayload {
  entry: WorkerHistoryEntry;
  externalSessionId?: string;
}
/** Legacy untagged records belong to the oldest recorded session, never to a new recovery wire. */
export function sessionWorkerHistory(
  payloads: readonly WorkerHistoryPayload[],
  externalId: string,
  legacyOwner: string | undefined,
): WorkerHistoryEntry[] {
  return payloads
    .filter(
      (payload) =>
        payload.externalSessionId === externalId || (!payload.externalSessionId && legacyOwner === externalId),
    )
    .map((payload) => payload.entry);
}

export function parseWorkerHistoryPayload(raw: string): WorkerHistoryPayload {
  const payload: WorkerHistoryPayload = JSON.parse(raw);
  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.entry ||
    typeof payload.entry !== "object" ||
    typeof payload.entry.kind !== "string" ||
    typeof payload.entry.turnId !== "string"
  )
    throw new Error("Invalid worker history payload.");
  return payload;
}
