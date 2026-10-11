import { describe, expect, it, vi } from "vitest";
import { LocalVoiceTransport } from "./local-voice-transport";

describe("speaker-on speech gate", () => {
  it("rejects moderate echo during output but accepts strong interruption and resumes normal listening", async () => {
    let frame: ((samples: Float32Array, rate: number) => void) | undefined;
    let probability = 0.8;
    const completed = Promise.withResolvers<void>();
    const started = vi.fn();
    const transport = new LocalVoiceTransport({
      getMicrophone: async () => ({ getTracks: () => [] }),
      prepareDetection: async () => ({
        detect: async () => [probability, probability, probability],
        close: async () => undefined,
      }),
      transcribe: async () => "test",
      speak: () => completed.promise,
      attachCapture: (_stream, next) => {
        frame = next;
        return () => undefined;
      },
    });
    await transport.start({ onSpeechStarted: started, onTranscript: vi.fn(), onError: vi.fn() });
    const output = transport.speak("test output", new AbortController().signal);
    const feed = () => {
      if (!frame) throw Error("no capture");
      frame(new Float32Array(1536), 16000);
    };
    for (let i = 0; i < 4; i++) feed();
    await vi.waitFor(() => expect(started).not.toHaveBeenCalled());
    probability = 0.98;
    for (let i = 0; i < 4; i++) feed();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    completed.resolve();
    await output;
    transport.stop();
  });
});
