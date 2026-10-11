import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, expect, it } from "vitest";
import { App } from "./App";
import { AppProviders } from "./app-providers";
import { installDanidexStub } from "./app-test-harness";
import { CHANNEL_SELECTION_STORAGE_KEY } from "./features/channels/channel-selection";
import { useChannels } from "./features/channels/channels-context";
import { AccountDock } from "./lazy-views";

beforeEach(installDanidexStub);

async function seedChannel() {
  await window.danidex.agent.channelCommand({
    type: "save",
    operationId: "seed-preserved-room",
    channelId: "channel-preserved",
    draft: {
      name: "Launch room",
      title: "Keep delegation records",
      instructions: "Preserve these records",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
}

it("shows channel navigation without unexpectedly restoring an old selection", async () => {
  await AccountDock.preload();
  await seedChannel();
  const original = await window.danidex.agent.listChannels();
  window.localStorage.setItem(
    CHANNEL_SELECTION_STORAGE_KEY,
    JSON.stringify({ "user-1": { local: "channel-preserved" } }),
  );
  render(() => <App />);
  await screen.findByRole("heading", { name: "Chief" });
  expect(await screen.findByRole("button", { name: /Launch room/ })).toBeInTheDocument();
  expect(screen.queryByRole("main", { name: "Channel conversation" })).not.toBeInTheDocument();
  expect(await window.danidex.agent.listChannels()).toEqual(original);
});

it("opens a real channel while preserving its records", async () => {
  await seedChannel();
  function Probe() {
    const channels = useChannels();
    return (
      <>
        <button type="button" onClick={() => void channels.open("channel-preserved")}>
          Try opening preserved channel
        </button>
        <output aria-label="Selected channel">{channels.state.selectedId ?? "none"}</output>
        <output aria-label="Internal channel count">{channels.state.channels.length}</output>
      </>
    );
  }
  render(() => (
    <AppProviders>
      <Probe />
    </AppProviders>
  ));
  await waitFor(() => expect(screen.getByLabelText("Internal channel count")).toHaveTextContent("1"));
  await fireEvent.click(screen.getByRole("button", { name: "Try opening preserved channel" }));
  await waitFor(() => expect(screen.getByLabelText("Selected channel")).toHaveTextContent("channel-preserved"));
  expect(await window.danidex.agent.listChannels()).toHaveLength(1);
});
