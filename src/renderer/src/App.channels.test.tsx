import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { installDanidexStub } from "./app-test-harness";
import { CHANNEL_SELECTION_STORAGE_KEY } from "./features/channels/channel-selection";
import { AccountDock } from "./lazy-views";

beforeAll(async () => {
  await AccountDock.preload();
});

beforeEach(installDanidexStub);

it("keeps parked channel records visible without restoring an old selection", async () => {
  await window.danidex.agent.channelCommand({
    type: "save",
    operationId: "create-parked",
    channelId: "channel-parked",
    draft: {
      name: "Project room",
      title: "",
      instructions: "Research the project",
      members: [{ agentId: "chief" }],
      leadAgentId: "chief",
    },
  });
  window.localStorage.setItem(CHANNEL_SELECTION_STORAGE_KEY, JSON.stringify({ "user-1": { local: "channel-parked" } }));
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  expect(await screen.findByRole("button", { name: /Project room/ })).toBeInTheDocument();
  expect(screen.queryByRole("main", { name: "Channel conversation" })).toBeNull();
  await fireEvent.click(await screen.findByRole("button", { name: /^Chief, Chief of staff/ }));
  await screen.findByRole("main", { name: "Conversation" });
  expect(await window.danidex.agent.listChannels()).toContainEqual(
    expect.objectContaining({ id: "channel-parked", name: "Project room" }),
  );
});

it("does not offer channel creation in the released workspace", async () => {
  render(() => <App />);
  await screen.findByRole("button", { name: /Open account (actions|menu)/ });
  await fireEvent.pointerDown(screen.getByRole("button", { name: "New agent or channel" }), { button: 0 });
  await screen.findByRole("menuitem", { name: "New agent" });
  expect(screen.queryByRole("menuitem", { name: "New channel" })).toBeNull();
  expect(await screen.findByRole("menuitem", { name: "New agent" })).toBeEnabled();
});

it("offers @everyone in an imported group and sends it as one broadcast request", async () => {
  await window.danidex.agent.channelCommand({
    type: "save",
    operationId: "group-broadcast",
    channelId: "group-broadcast",
    draft: {
      name: "Broadcast room",
      title: "",
      instructions: "Wait for a goal",
      members: [{ agentId: "chief" }, { agentId: "sales-outbound" }],
      leadAgentId: "chief",
    },
  });
  render(() => <App />);
  await screen.findByRole("heading", { name: "Chief" });
  await fireEvent.click(await screen.findByRole("button", { name: /^Broadcast room/ }));
  await screen.findByRole("main", { name: "Channel conversation" });
  const editor = await screen.findByRole("textbox", { name: "Message to channel" });
  editor.textContent = "@";
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
  await fireEvent.input(editor);
  expect(screen.queryByRole("button", { name: "Mention everyone" })).toBeNull();
  await screen.findByRole("option", { name: "@everyone All agents in this room" });
  expect(screen.getAllByRole("option")).toHaveLength(3);
  await fireEvent.keyDown(editor, { key: "Enter" });
  expect(editor).toHaveTextContent("@everyone");
  editor.textContent = "@everyone Reply with your role.";
  await fireEvent.input(editor);
  const send = vi.spyOn(window.danidex.agent, "channelCommand");
  await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "send",
      text: "@everyone Reply with your role.",
      channelId: "group-broadcast",
      recipientAgentId: null,
    }),
  );
});
