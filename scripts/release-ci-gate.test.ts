import { expect, it } from "vitest";
import { releaseCiFailures } from "./release-ci-gate";

const head = "a".repeat(40);
const run = (workflowName: string, databaseId = 1) => ({
  headSha: head,
  workflowName,
  databaseId,
  event: "push",
  status: "completed",
  conclusion: "success",
  url: "https://github.com/somdipto/dani-dex/actions/runs/1",
});
it("requires successful completed push runs for both workflows at the exact HEAD", () => {
  expect(releaseCiFailures([run("CI"), run("Build main")], head)).toEqual([]);
  expect(releaseCiFailures([run("CI")], head)).toHaveLength(1);
  expect(releaseCiFailures([run("CI"), { ...run("Build main"), headSha: "b".repeat(40) }], head)).toHaveLength(1);
  expect(releaseCiFailures([run("CI"), { ...run("Build main"), event: "workflow_dispatch" }], head)).toHaveLength(1);
});
it("never accepts queued, running, failed or cancelled runs", () => {
  for (const state of [
    { status: "queued", conclusion: null },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "cancelled" },
  ])
    expect(releaseCiFailures([run("CI"), { ...run("Build main"), ...state }], head)).toHaveLength(1);
});
it("uses the latest matching run and rejects malformed evidence", () => {
  expect(
    releaseCiFailures([run("CI"), run("Build main"), { ...run("CI", 2), conclusion: "failure" }], head),
  ).toHaveLength(1);
  expect(() => releaseCiFailures([{ workflowName: "CI" }], head)).toThrow();
});
