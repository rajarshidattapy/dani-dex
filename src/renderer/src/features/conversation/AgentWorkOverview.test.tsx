import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { STORY_AGENTS } from "../../preview/fixtures";
import { createMockDaniDex, type MockDaniDexControls } from "../../preview/mock-dani-dex";
import { AgentWorkOverview } from "./AgentWorkOverview";

let mock: MockDaniDexControls | undefined;
afterEach(() => {
  mock?.dispose();
  mock = undefined;
});
it("shows truthful queue coverage and opens existing schedule creation without saving", async () => {
  mock = createMockDaniDex();
  window.danidex = mock.api;
  const create = vi.fn(),
    manage = vi.fn(),
    settings = vi.fn();
  render(() => (
    <AgentWorkOverview
      agent={STORY_AGENTS[0]}
      agents={STORY_AGENTS}
      onCreateSchedule={create}
      onManageSchedules={manage}
      onSettings={settings}
      onChannels={vi.fn()}
    />
  ));
  await screen.findByText("Recent results");
  expect(screen.getByText(/Coverage is partial/)).toBeInTheDocument();
  expect(screen.getByText(/One-shot watches are not ready/)).toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: "Create schedule", exact: true }));
  expect(create).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole("button", { name: "Agent settings", exact: true }));
  expect(settings).toHaveBeenCalledOnce();
});
it("does not turn a failed read into an empty/no-work claim", async () => {
  mock = createMockDaniDex();
  window.danidex = mock.api;
  window.danidex.agent.listQueue = vi.fn(async () => {
    throw Error("offline");
  });
  render(() => (
    <AgentWorkOverview
      agent={STORY_AGENTS[0]}
      agents={STORY_AGENTS}
      onCreateSchedule={vi.fn()}
      onManageSchedules={vi.fn()}
      onSettings={vi.fn()}
      onChannels={vi.fn()}
    />
  ));
  await screen.findByText("Work unavailable.");
  expect(screen.queryByText("No queue decisions shown.")).not.toBeInTheDocument();
});
