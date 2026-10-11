import { describe, expect, it, vi } from "vitest";
import { LocalVoiceTransport, SpeechSegmenter } from "./local-voice-transport";

const frame = () => new Float32Array(512);
describe("Silero segmentation and ownership", () => {
  it("dispatches after pause and counts audio duration, not volume", () => {
    const s = new SpeechSegmenter({ silenceMs: 100 });
    for (let i = 0; i < 7; i++) expect(s.push(frame(), i * 32, true)).toBeNull();
    expect(s.push(frame(), 224, true)).toEqual({ type: "start" });
    s.push(frame(), 256, false);
    const end = s.push(frame(), 400, false);
    expect(end?.type).toBe("end");
  });
  it("bounds long utterance including pre-roll within WAV limit", () => {
    const s = new SpeechSegmenter();
    let end: Extract<import("./local-voice-transport").SpeechSegmentResult, { type: "end" }> | undefined;
    for (let i = 0; i < 3760; i++) {
      const event = s.push(frame(), i * 32, true);
      if (event?.type === "end") {
        end = event;
        break;
      }
    }
    expect(end?.samples.length).toBeLessThanOrEqual(1920000);
    expect(end?.samples.length).toBeGreaterThan(1900000);
  });
  it("stops detector and mic together", async () => {
    const close = vi.fn(async () => {}),
      stop = vi.fn();
    const transport = new LocalVoiceTransport({
      getMicrophone: async () => ({ getTracks: () => [{ stop }] }),
      prepareDetection: async () => ({ detect: async () => [0, 0], close }),
      transcribe: async () => "",
      speak: async () => {},
      attachCapture: () => () => {},
    });
    await transport.start({ onSpeechStarted: vi.fn(), onTranscript: vi.fn(), onError: vi.fn() });
    transport.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
