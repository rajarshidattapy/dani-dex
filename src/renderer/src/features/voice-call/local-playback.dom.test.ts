import { afterEach, describe, expect, it, vi } from "vitest";
import { playLocalWave } from "./local-voice-transport";

afterEach(() => vi.unstubAllGlobals());
describe("Chromium speech playback", () => {
  it("stops playback on interruption and closes the audio context", async () => {
    const ready = Promise.withResolvers<void>();
    const close = vi.fn(async () => undefined);
    const disconnect = vi.fn();
    let ended: (() => void) | undefined;
    const stop = vi.fn(() => ended?.());
    class Context {
      decodeAudioData = async () => ({});
      resume = async () => undefined;
      close = close;
      destination = {};
      createBufferSource() {
        return {
          buffer: null,
          connect: vi.fn(),
          disconnect,
          stop,
          start: () => ready.resolve(),
          set onended(fn: () => void) {
            ended = fn;
          },
        };
      }
    }
    vi.stubGlobal("AudioContext", Context);
    const c = new AbortController();
    const result = playLocalWave(new Uint8Array([1]), c.signal).catch((e) => e.name);
    await ready.promise;
    c.abort();
    expect(await result).toBe("AbortError");
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("does not start stale audio when interrupted during device resume", async () => {
    const resuming = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const createBufferSource = vi.fn();
    const close = vi.fn(async () => undefined);
    class Context {
      decodeAudioData = async () => ({});
      resume = () => {
        resuming.resolve();
        return resumed.promise;
      };
      close = close;
      createBufferSource = createBufferSource;
    }
    vi.stubGlobal("AudioContext", Context);
    const c = new AbortController();
    const result = playLocalWave(new Uint8Array([1]), c.signal).catch((e) => e.name);
    await resuming.promise;
    c.abort();
    resumed.resolve();
    expect(await result).toBe("AbortError");
    expect(createBufferSource).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not open a device for an already cancelled request", async () => {
    const context = vi.fn();
    vi.stubGlobal("AudioContext", context);
    const c = new AbortController();
    c.abort();
    await expect(playLocalWave(new Uint8Array(), c.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(context).not.toHaveBeenCalled();
  });
});
