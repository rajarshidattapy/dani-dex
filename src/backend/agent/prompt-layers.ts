/**
 * A section of the system prompt, built from a known source so the owner can
 * inspect, edit, or disable it without hunting through assembled text.
 */
export interface PromptLayer {
  /** Stable id used in the assembled output and in `PROMPT_SOURCES`. */
  readonly id: string;
  /** Human-readable source description, or a file path for layers read from disk. */
  readonly source: string;
  /** Layer text, or empty string when the layer has nothing to contribute. */
  readonly text: string;
}

/** Every Dani-Dex prompt layer and where it comes from. */
export const PROMPT_SOURCES: Record<string, string> = {
  identity: "agent profile (runtime)",
  persona: "workspace/PERSONA.md",
  instructions: "workspace/AGENTS.md",
  owner: "agent profile (runtime)",
  principal: "caller principal (runtime)",
  channel: "channel type (runtime)",
  reach: "developer instructions (built-in)",
  setup: "runtime state",
  rules: "developer instructions (built-in)",
  memory: "MEMORY.md + journal (workspace)",
  skills: "installed skills (runtime)",
  approvals: "approval queue (runtime)",
  long_tasks: "runtime continuation protocol",
  now: "current time (runtime)",
};
