import { expect, it } from "vitest";
import { CHATGPT_SIGN_IN_HELP } from "./chatgpt-sign-in-help";

it("provides retry guidance and account reassurance without raw provider errors", () => {
  expect(CHATGPT_SIGN_IN_HELP).toContain("try sign-in again");
  expect(CHATGPT_SIGN_IN_HELP).toContain("saved accounts have not been removed");
  expect(CHATGPT_SIGN_IN_HELP).not.toMatch(/ext_agent_host_id|invalid_authorize_request|\{"error"/);
});
