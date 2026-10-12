import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { ChatGptSignInDialog } from "./ProviderConnectionDialogs";

const report = vi.fn();
const cancel = vi.fn();
afterEach(() => vi.clearAllMocks());
it("shows a browser error exit without raw JSON and routes it to cancellation/recovery", async () => {
  render(() => <ChatGptSignInDialog open onCancel={cancel} onBrowserError={report} />);
  expect(await screen.findByText(/If OpenAI shows an error instead of sign-in/)).toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: "My browser showed an error" }));
  expect(report).toHaveBeenCalledOnce();
  expect(screen.queryByText(/ext_agent_host_id/)).toBeNull();
});
