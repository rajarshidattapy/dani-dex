import { describe, expect, it } from "vitest";
import { skillConversationEvent, skillConversationEventItemType } from "./skill-conversation-events";

describe("honest skill suggestion events", () => {
  it("round trips suggestions independently of legacy selected records", () => {
    const itemType = skillConversationEventItemType({ action: "suggested", skillId: "dani-dex-data", revision: 1 });
    const message = {
      id: "suggestion",
      author: "system" as const,
      source: "system" as const,
      status: "completed" as const,
      createdAt: "2026-10-12T00:00:00Z",
      text: "Shared records",
      itemType,
    };
    expect(skillConversationEvent(message)?.action).toBe("suggested");
    expect(skillConversationEvent({ ...message, itemType: itemType.replace("suggested", "selected") })?.action).toBe(
      "selected",
    );
  });
});
