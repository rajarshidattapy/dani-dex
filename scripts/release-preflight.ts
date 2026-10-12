import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isDynamicRecord, isString } from "@dani-dex/contracts/runtime-values";
import { createDaniDexLogger } from "@dani-dex/logging";

import { releaseCiFailures } from "./release-ci-gate";

const logger = createDaniDexLogger("release-preflight");

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (!isDynamicRecord(packageJson) || !isString(packageJson.version)) {
  throw new Error("package.json has no valid version.");
}
const changelog = await readFile("CHANGELOG.md", "utf8");
const failures: string[] = [];

if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) failures.push("package version is not semver");
if (!changelog.includes(`## [${packageJson.version}]`)) {
  failures.push(`CHANGELOG.md has no ${packageJson.version} release heading`);
}
if (run("git", ["status", "--porcelain"])) failures.push("working tree is not clean");
if (run("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"]) !== "0\t0") {
  failures.push("main is not synchronized with origin/main");
}
if (run("git", ["tag", "--list", `v${packageJson.version}`])) {
  failures.push(`tag v${packageJson.version} already exists`);
}

// This release workflow ships unsigned desktop installers. Signing secrets are not
// prerequisites. Its public pinned Dani Free release is the primary resource source.
try {
  const head = run("git", ["rev-parse", "HEAD"]);
  const runs = JSON.parse(
    run("gh", [
      "run",
      "list",
      "--commit",
      head,
      "--event",
      "push",
      "--limit",
      "50",
      "--json",
      "headSha,workflowName,event,status,conclusion,databaseId,url",
    ]),
  );
  failures.push(...releaseCiFailures(runs, head));
} catch {
  failures.push("Exact-HEAD CI and Build main results could not be verified");
}

if (failures.length > 0) {
  logger.error("Dani-Dex release preflight failed:\n");
  for (const failure of failures) logger.error(`- ${failure}`);
  logger.error("\nNo release tag was created.");
  process.exitCode = 1;
} else {
  logger.info(`Dani-Dex v${packageJson.version} release preflight passed.`);
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}
