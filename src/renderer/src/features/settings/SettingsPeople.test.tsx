import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { SettingsPeople } from "./SettingsPeople";
it("guides public-key enrollment without enabling transport and dismisses only the exact unknown review", async () => {
  const review = {
    requestId: "r",
    contactId: "unknown",
    state: "message-taker",
    contextId: "c",
    transportPrincipal: "unverified",
    claimedPrincipal: { display: "Owner", handle: "owner" },
    text: "Hello",
    envelope: { intent: "ask" },
    deadline: null,
  };
  const host = {
    v2Status: vi.fn(async () => ({ contacts: [], grants: [] })),
    peerInbox: vi.fn(async () => [review]),
    peerEnroll: vi.fn(async () => "fingerprint"),
    peerDecide: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "danidex", { configurable: true, writable: true, value: { host } });
  const result = render(() => <SettingsPeople agentId="chief" />);
  await waitFor(() => expect(screen.getByText("Unknown sender")).toBeTruthy());
  expect(screen.queryByLabelText("Peer public key")).toBeNull();
  expect(host.peerEnroll).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText("Dismiss message").closest("button")?.disabled).toBe(false));
  fireEvent.click(screen.getByText("Dismiss message"));
  await waitFor(() => expect(host.peerDecide).toHaveBeenCalledWith({ review, decision: "decline", grantId: null }));
  expect(screen.queryByText("Accept request")).toBeNull();
  result.unmount();
});
it("specialists cannot enroll people or load Chief's peer data", () => {
  const host = { v2Status: vi.fn(), peerInbox: vi.fn(), peerEnroll: vi.fn() };
  Object.defineProperty(window, "danidex", { configurable: true, writable: true, value: { host } });
  const result = render(() => <SettingsPeople agentId="builder" />);
  expect(screen.queryByText("Connect a person")).toBeNull();
  expect(host.peerInbox).not.toHaveBeenCalled();
  result.unmount();
});
