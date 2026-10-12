import { render, fireEvent, waitFor, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { SettingsTelegram } from "./SettingsTelegram";
it("pairs exact identities and sends exact owner reviewed text, never enabling on credential save", async () => {
  const status = {
    configured: true,
    enabled: false,
    error: null,
    uncertainReplies: [{ replyId: "r", conversationId: "12" }],
    replies: [],
    pending: [
      { eventId: "4", conversationId: "12", senderId: "7", body: "Reviewed request", generation: 1, nextOffset: 0 },
    ],
  };
  const host = {
    telegramStatus: vi.fn(async () => status),
    telegramConfigure: vi.fn(async () => {}),
    telegramPair: vi.fn(async () => {}),
    telegramEnable: vi.fn(async () => {}),
    telegramRevoke: vi.fn(async () => {}),
    telegramApprove: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "danidex", { configurable: true, value: { host } });
  const result = render(() => <SettingsTelegram />);
  await waitFor(() => expect(screen.getByText("Approve this request for Chief")).toBeTruthy());
  fireEvent.input(screen.getByLabelText("Telegram chat ID"), { target: { value: "12" } });
  fireEvent.input(screen.getByLabelText("Telegram sender ID"), { target: { value: "7" } });
  fireEvent.click(screen.getByText("Pair chat and sender"));
  await waitFor(() => expect(host.telegramPair).toHaveBeenCalledWith({ conversationId: "12", senderId: "7" }));
  await waitFor(() =>
    expect(screen.getByText("Approve this request for Chief").closest("button")?.disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("Approve this request for Chief"));
  await waitFor(() =>
    expect(host.telegramApprove).toHaveBeenCalledWith({
      eventId: "4",
      body: "Reviewed request",
      conversationId: "12",
      senderId: "7",
    }),
  );
  expect(host.telegramEnable).not.toHaveBeenCalled();
  expect(screen.getByText("Reply delivery unconfirmed: chat 12")).toBeTruthy();
  result.unmount();
});
it("shows exact document review and never routes media through text approval", async () => {
  const media = {
    updateId: "9",
    safeName: "brief.txt",
    senderId: "7",
    conversationId: "12",
    kind: "document",
    size: 3,
    messageId: "1",
    edited: false,
    caption: "review caption",
    reviewDigest: "a".repeat(64),
  };
  const host = {
    telegramStatus: vi.fn(async () => ({
      configured: true,
      enabled: true,
      error: null,
      pending: [{ eventId: "9", body: "[document]", conversationId: "12", senderId: "7" }],
      mediaPending: [media],
      replies: [],
      uncertainReplies: [],
    })),
    telegramApprove: vi.fn(),
    telegramApproveMedia: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "danidex", { configurable: true, value: { host } });
  const view = render(() => <SettingsTelegram />);
  await waitFor(() => expect(screen.getByText("brief.txt from 7, chat 12")).toBeTruthy());
  expect(screen.getByText("review caption")).toBeTruthy();
  expect(screen.getByText("Approve this request for Chief").closest("button")?.disabled).toBe(true);
  fireEvent.click(screen.getByText("Send reviewed document to Chief"));
  await waitFor(() =>
    expect(host.telegramApproveMedia).toHaveBeenCalledWith({ eventId: "9", reviewDigest: "a".repeat(64) }),
  );
  expect(host.telegramApprove).not.toHaveBeenCalled();
  view.unmount();
});
