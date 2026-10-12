import { z } from "zod";

const runsSchema = z.array(
  z.object({
    headSha: z.string(),
    workflowName: z.string(),
    event: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    databaseId: z.number(),
    url: z.string(),
  }),
);

/** Require the newest push run for both workflows at the exact release commit. */
export function releaseCiFailures(value: unknown, head: string): string[] {
  const runs = runsSchema.parse(value);
  return ["CI", "Build main"].flatMap((name) => {
    const run = runs
      .filter(
        (candidate) => candidate.headSha === head && candidate.workflowName === name && candidate.event === "push",
      )
      .sort((left, right) => right.databaseId - left.databaseId)[0];
    if (!run) return [`${name}: no push run found for ${head}`];
    if (run.status !== "completed" || run.conclusion !== "success")
      return [`${name}: ${run.status}/${run.conclusion || "pending"} - ${run.url}`];
    return [];
  });
}
