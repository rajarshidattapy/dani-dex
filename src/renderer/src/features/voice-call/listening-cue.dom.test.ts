import { afterEach, expect, it, vi } from "vitest";
import { playListeningCue } from "./listening-cue";

afterEach(() => vi.unstubAllGlobals());
it("plays a bounded two-pitch tone and closes the device", async () => {
  const stop = vi.fn();
  const start = vi.fn();
  const close = vi.fn(async () => {});
  const pitch = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  let ended!: () => void;
  class Context {
    currentTime = 3;
    destination = {};
    resume = async () => {};
    close = close;
    createOscillator() {
      return {
        type: "",
        frequency: pitch,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start,
        stop: (time: number) => {
          stop(time);
          queueMicrotask(() => ended());
        },
        set onended(fn: () => void) {
          ended = fn;
        },
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
  }
  vi.stubGlobal("AudioContext", Context);
  await playListeningCue();
  expect(start).toHaveBeenCalledWith(3);
  expect(stop).toHaveBeenCalledWith(3.13);
  expect(pitch.setValueAtTime).toHaveBeenCalledWith(660, 3);
  expect(close).toHaveBeenCalledOnce();
});
