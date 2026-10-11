import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TalkKeyPicker } from "./TalkKeyPicker";
import { readTalkKey } from "./talk-key";

beforeEach(() => localStorage.removeItem("dani-dex.talk-key.v1"));
describe("TalkKeyPicker", () => {
  it("shows exactly the default and custom choices, saves custom without touching microphone", async () => {
    const getMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: getMedia } });
    const view = render(() => <TalkKeyPicker platform="darwin" />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await fireEvent.click(screen.getByRole("button", { name: "Choose a custom talk key" }));
    await fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByRole("alert")).toHaveTextContent("not a typing key");
    await fireEvent.keyDown(window, { key: "F8" });
    expect(readTalkKey("darwin")).toEqual({ key: "F8", label: "F8" });
    expect(getMedia).not.toHaveBeenCalled();
    view.unmount();
    render(() => <TalkKeyPicker platform="darwin" />);
    expect(screen.getByRole("status")).toHaveTextContent("F8");
  });
  it("labels the actual platform default", () => {
    render(() => <TalkKeyPicker platform="win32" />);
    expect(screen.getByRole("button", { name: /CtrlControl/ })).toBeInTheDocument();
  });
});
