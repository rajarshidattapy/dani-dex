import type { AgentMemory, AgentSummary } from "@dani-dex/contracts/ipc";
import { PromptBuilder } from "./prompt-builder";

export function developerInstructions(
  agent: AgentSummary,
  sharedRoot: string,
  memories: AgentMemory[],
  operatingInstructions: string | null = null,
): string {
  return new PromptBuilder(
    agent,
    sharedRoot,
    memories,
    operatingInstructions,
    null, // principal — filled in by thread-lifecycle.ts
    null, // channelType — filled in by thread-lifecycle.ts
  ).render();
}
