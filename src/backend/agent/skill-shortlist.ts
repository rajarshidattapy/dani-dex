import type { InstalledSkill } from "@dani-dex/contracts/ipc";

// Intent routes are deliberate product capabilities, not scores over catalogue prose.
// Unknown workflows require an explicit named request. Description text is never a trigger.
const ROUTES: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/\b(?:create|save|revise|update)\b[^.!?;\n]{0,100}\b(?:reusable\s+)?skill\b/i, /^dani-dex-skill-creator$/],
  [
    /\b(?:query|update|count|store|save)\b[^.!?;\n]{0,100}\b(?:records?|database|structured data)\b/i,
    /^dani-dex-data$/,
  ],
  [/\b(?:publish|host|replace|delete)\b[^.!?;\n]{0,100}\b(?:website|site)\b/i, /^dani-dex-site-hosting$/],
  [/\b(?:audit|review)\b[^.!?;\n]{0,100}\b(?:code|codebase|repo|source)\b/i, /^(?:ponytail-audit|ponytail-review)$/],
  [/\bresearch\b/i, /^research$/],
  [/\b(?:spreadsheet|receipts|expenses)\b/i, /^(?:spreadsheets|spreadsheet)$/],
  [/\b(?:write|create)\b[^.!?;\n]{0,100}\bdocument\b/i, /^(?:documents|writing)$/],
  [/\b(?:calendar|schedule|free times)\b/i, /^calendar$/],
];

function positiveClauses(prompt: string): string[] {
  // Negation scopes a clause, not the whole request. A later affirmative request still works.
  return prompt
    .slice(0, 4_000)
    .split(/[.!?;\n]|\bbut\b/i)
    .filter((clause) => !/\b(?:no|not|never|without|don't|do not|avoid|stop)\b/i.test(clause));
}

export function shortlistInstalledSkills(prompt: string, skills: readonly InstalledSkill[]): InstalledSkill[] {
  if (/\b(?:do not|don't|never)\s+(?:use|call|invoke)\s+(?:any\s+|the\s+)?tools?\b/i.test(prompt)) return [];
  if (
    /\b(?:no|without)\s+skills?\b|\b(?:do not|don't|never)\s+(?:use|select|choose|invoke|load|read)\s+(?:any\s+|a\s+|the\s+)?skills?\b/i.test(
      prompt,
    )
  )
    return [];
  const clauses = positiveClauses(prompt);
  const requests = clauses.filter((clause) =>
    /^\s*(?:(?:please\s+)?(?:can|could|will|would)\s+you\s+|please\s+|i\s+(?:want|need)\s+(?:you\s+to\s+)?)?(?:create|save|revise|update|query|count|store|publish|host|replace|delete|audit|review|research|write|make|find|schedule|use|read|select|invoke)\b/i.test(
      clause,
    ),
  );
  const candidates = skills.filter((s) => s.enabled !== false && s.state === "installed");
  const explicit = candidates.filter((skill) =>
    clauses.some((clause) => {
      const names = [skill.slug, skill.name].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return names.some((name) =>
        new RegExp(
          `(?:^|\\s)/${name}(?=$|[\\s,])|\\b(?:use|read|select|invoke)\\s+(?:the\\s+)?${name}(?:\\s+skill)?(?=$|[\\s,.])`,
          "i",
        ).test(clause),
      );
    }),
  );
  const automatic = candidates.filter(
    (skill) =>
      !skill.disableModelInvocation &&
      !explicit.includes(skill) &&
      ROUTES.some(([intent, slug]) => slug.test(skill.slug) && requests.some((clause) => intent.test(clause))),
  );
  return [...explicit, ...automatic].slice(0, 3);
}
