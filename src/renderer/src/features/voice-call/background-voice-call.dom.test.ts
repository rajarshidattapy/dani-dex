import { describe, expect, it, vi } from "vitest";
import { BackgroundVoiceCall } from "./background-voice-call";
import type { RealtimeTransportHandlers } from "./realtime-voice-transport";

function fixture() {
  let handlers!: RealtimeTransportHandlers;
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
  const signals: AbortSignal[] = [];
  const spoken: string[] = [];
  let endSpeech = () => {};
  const interrupt = vi.fn(async () => {});
  const submit = vi.fn(async () => ({
    deliveryId: `job-${submit.mock.calls.length}`,
  }));
  const call = new BackgroundVoiceCall({
    transport: {
      start: async (next) => {
        handlers = next;
      },
      stop: vi.fn(),
      speak: (text, signal) => {
        spoken.push(text);
        return new Promise<void>((resolve, reject) => {
          const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(new DOMException("Interrupted", "AbortError"));
          };
          endSpeech = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      },
    },
    submit,
    interrupt,
    onEvent: vi.fn(),
    waitForReply: ({ deliveryId }, signal) => {
      signals.push(signal);
      const result = Promise.withResolvers<string>();
      pending.set(deliveryId, result);
      return result.promise;
    },
  });
  return {
    call,
    submit,
    interrupt,
    spoken,
    pending,
    signals,
    handlers: () => handlers,
    endSpeech: () => endSpeech(),
  };
}

describe("background voice prototype", () => {
  it("acknowledges only accepted work and accepts more speech without cancelling jobs", async () => {
    const f = fixture();
    await f.call.start();
    f.handlers().onTranscript("research the design");
    await vi.waitFor(() => expect(f.spoken).toHaveLength(1));
    f.handlers().onSpeechStarted();
    f.handlers().onTranscript("also compare latency");
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2));
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.signals.every((signal) => !signal.aborted)).toBe(true);
    f.call.stop();
    expect(f.signals.every((signal) => signal.aborted)).toBe(true);
    expect(f.interrupt).not.toHaveBeenCalled();
  });
  it("speaks exact job results, but never late results after call end or restart", async () => {
    const f = fixture();
    await f.call.start();
    f.handlers().onTranscript("first request");
    await vi.waitFor(() => expect(f.pending.has("job-1")).toBe(true));
    f.endSpeech();
    f.pending.get("job-1")?.resolve("Exact first result");
    await vi.waitFor(() => expect(f.spoken).toContain("Exact first result"));
    f.handlers().onSpeechStarted();
    f.handlers().onTranscript("second request");
    await vi.waitFor(() => expect(f.pending.has("job-2")).toBe(true));
    f.call.stop();
    await f.call.start();
    f.pending.get("job-2")?.resolve("Stale result");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.spoken).not.toContain("Stale result");
    expect(f.interrupt).not.toHaveBeenCalled();
    f.call.stop();
  });
  it("does not acknowledge a rejected submission", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new Error("Queue unavailable"));
    await f.call.start();
    f.handlers().onTranscript("research this");
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    expect(f.spoken).toEqual([]);
    f.call.stop();
  });

  it("keeps a late accepted delivery but never attaches voice after call end", async () => {
    const f = fixture();
    const accepted = Promise.withResolvers<{ deliveryId: string }>();
    f.submit.mockImplementationOnce(() => accepted.promise);
    await f.call.start();
    f.handlers().onTranscript("slow acceptance");
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    f.call.stop();
    accepted.resolve({ deliveryId: "late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.pending.size).toBe(0);
    expect(f.spoken).toEqual([]);
    expect(f.interrupt).not.toHaveBeenCalled();
  });
  it("defers a completed result during user speech and releases it after transcription", async () => {
    const f = fixture();
    await f.call.start();
    f.handlers().onTranscript("research");
    await vi.waitFor(() => expect(f.pending.has("job-1")).toBe(true));
    f.handlers().onSpeechStarted();
    f.pending.get("job-1")?.resolve("Completed research");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.spoken).not.toContain("Completed research");
    f.handlers().onTranscriptionFinished?.();
    await vi.waitFor(() => expect(f.spoken).toContain("Completed research"));
    f.call.stop();
  });

  it("does not speak between overlapping captured utterances", async () => {
    const f = fixture();
    await f.call.start();
    f.handlers().onTranscript("research");
    await vi.waitFor(() => expect(f.pending.has("job-1")).toBe(true));
    f.handlers().onSpeechStarted();
    f.handlers().onSpeechStarted();
    f.pending.get("job-1")?.resolve("Overlapping result");
    f.handlers().onTranscript("first overlap");
    f.handlers().onTranscriptionFinished?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.spoken).not.toContain("Overlapping result");
    f.handlers().onTranscript("second overlap");
    f.handlers().onTranscriptionFinished?.();
    await vi.waitFor(() => expect(f.spoken).toContain("Overlapping result"));
    f.call.stop();
  });
});
