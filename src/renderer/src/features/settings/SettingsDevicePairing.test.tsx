import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsDevicePairing } from "./SettingsDevicePairing";

afterEach(() => vi.unstubAllGlobals());
it("shows the current RC URL and toggles persistent gateway enablement through desktop IPC", async () => {
  const off = { enabled: false, phase: "off", origin: null, previousOrigin: null, changedAt: null, message: null };
  const enabled = { ...off, enabled: true, phase: "connecting" };
  const set = vi.fn().mockResolvedValue(enabled);
  vi.stubGlobal("danidex", { host: { getRcGateway: vi.fn().mockResolvedValue(off), setRcGateway: set } });
  Object.defineProperty(window, "danidex", {
    configurable: true,
    value: { host: { getRcGateway: vi.fn().mockResolvedValue(off), setRcGateway: set } },
  });
  const page = render(() => <SettingsDevicePairing />);
  await waitFor(() => expect(page.getByText("off")).toBeTruthy());
  fireEvent.click(page.getByText("Enable RC gateway"));
  await waitFor(() => expect(set).toHaveBeenCalledWith(true));
  await waitFor(() => expect(page.getByText("Disable RC gateway")).toBeTruthy());
  page.unmount();
});
it("keeps displayed pairing credentials readonly after a mocked local setup", async () => {
  const host = {
    getRcGateway: vi.fn().mockResolvedValue({
      enabled: false,
      phase: "off",
      origin: null,
      previousOrigin: null,
      changedAt: null,
      message: null,
    }),
    createDevicePairingLink: vi.fn().mockResolvedValue({
      url: "https://host.example/device-pairing#test-only",
      code: "12345678",
      expiresAt: Date.now() + 60000,
    }),
  };
  Object.defineProperty(window, "danidex", { configurable: true, value: { host } });
  const page = render(() => <SettingsDevicePairing />);
  const origin = page.getByRole("textbox", { name: "Device pairing HTTPS origin" });
  fireEvent.input(origin, { target: { value: "https://host.example" } });
  fireEvent.click(page.getByRole("button", { name: "Add RC" }));
  await waitFor(() => expect(page.getByRole("textbox", { name: "RC pairing code" })).toHaveAttribute("readonly"));
  expect(page.getByRole("textbox", { name: "Device pairing link" })).toHaveAttribute("readonly");
  page.unmount();
});
