import { describe, expect, it } from "vitest";
import { sessionWorkerHistory, type WorkerHistoryPayload } from "./session-worker-history";

describe("provider session ledger", () => {
  it("preserves old quarantine without poisoning a fresh wire", () => {
    const records: WorkerHistoryPayload[] = [
      { entry: { kind: "retirement", turnId: "old-turn", reason: "deadline" } },
      { entry: { kind: "terminal", turnId: "old-turn", status: "failed", retiredAttempt: true } },
      {
        externalSessionId: "new-wire",
        entry: { kind: "user", turnId: "new-turn", input: [{ type: "text", text: "hi" }] },
      },
    ];
    expect(sessionWorkerHistory(records, "old-wire", "old-wire")).toHaveLength(2);
    expect(sessionWorkerHistory(records, "new-wire", "old-wire")).toEqual([records[2].entry]);
    expect(sessionWorkerHistory(records, "unknown-wire", "old-wire")).toEqual([]);
    expect(records).toHaveLength(3);
  });
});
