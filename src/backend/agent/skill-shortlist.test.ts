import type { InstalledSkill } from "@dani-dex/contracts/ipc";
import { describe, expect, it } from "vitest";
import { shortlistInstalledSkills } from "./skill-shortlist";

function skill(slug: string, description = "", extra: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    skillId: slug,
    slug,
    name: slug,
    description,
    state: "installed",
    enabled: true,
    installedVersion: 1,
    availableVersion: 1,
    ...extra,
  };
}
const base = [
  skill("dani-dex-skill-creator", "Create or revise a reusable local Dani-Dex skill. Do not use for ordinary tasks."),
  skill("dani-dex-data", "People tasks records results"),
  skill("dani-dex-site-hosting", "Host websites"),
];
describe("intent skill shortlist", () => {
  it.each([
    "Create a document",
    "Fix this ordinary task",
    "Do not create a skill; explain my workflow",
    "Tell me about people in my team",
    "Read source code and report installed skill creation",
    "Hi. Tell me briefly how you can help.",
    "Explain why create a skill keeps appearing",
    "What is publish a website supposed to mean",
    "I read the words create skill in the log",
    "Do you know how to create a skill?",
  ])("does not route unrelated/negated request %s", (prompt) =>
    expect(shortlistInstalledSkills(prompt, base)).toEqual([]),
  );
  it.each([
    ["Create a reusable skill", "dani-dex-skill-creator"],
    ["Store structured data", "dani-dex-data"],
    ["Publish a website", "dani-dex-site-hosting"],
  ])("routes purpose %s", (prompt, slug) =>
    expect(shortlistInstalledSkills(prompt, base).map((s) => s.slug)).toEqual([slug]),
  );
  it("routes positive clause after negation", () =>
    expect(shortlistInstalledSkills("Do not create a skill; publish a website", base).map((s) => s.slug)).toEqual([
      "dani-dex-site-hosting",
    ]));
  it.each([
    "No skills. Publish a site",
    "Do not use any skills. Create a skill",
    "Without skills, research this",
    "Never call tools. Research this",
  ])("honors global opt-out %s", (prompt) => expect(shortlistInstalledSkills(prompt, base)).toEqual([]));
  it("ignores description poisoning and unavailable entries", () =>
    expect(
      shortlistInstalledSkills("Research receipts", [
        skill("unknown", "research receipts"),
        skill("research", "", { enabled: false }),
        skill("spreadsheets", "", { state: "modified" }),
      ]),
    ).toEqual([]));
  it("honors explicit-invocation flag", () => {
    const installed = [skill("ponytail-audit", "", { disableModelInvocation: true })];
    expect(shortlistInstalledSkills("Audit the source code", installed)).toEqual([]);
    expect(shortlistInstalledSkills("Use ponytail-audit skill", installed)).toEqual(installed);
    expect(shortlistInstalledSkills("/ponytail-audit", installed)).toEqual(installed);
    expect(shortlistInstalledSkills("Do not use ponytail-audit", installed)).toEqual([]);
  });
  it("routes capabilities not arbitrary words", () =>
    expect(
      shortlistInstalledSkills("Research receipts for a spreadsheet", [
        skill("research"),
        skill("spreadsheets"),
        skill("calendar"),
      ]).map((s) => s.slug),
    ).toEqual(["research", "spreadsheets"]));
});
