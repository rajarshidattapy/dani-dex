import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalVoiceTransport,
  type SpeechOutput,
  SpeechSegmenter,
  speakWithSpeechSynthesis,
} from "./local-voice-transport";
import { VoiceCall } from "./voice-call";

function tone(amplitude: number, length = 1536): Float32Array {
  const frame = new Float32Array(length);
  frame.fill(amplitude);
  return frame;
}

function captureFixture(transcribe: (audio: Uint8Array) => Promise<string>) {
  let onFrame: ((frame: Float32Array, sampleRate: number) => void) | undefined;
  let clock = 0;
  const stopTrack = vi.fn();
  const detach = vi.fn();
  const transport = new LocalVoiceTransport({
    prepareDetection: async () => ({
      detect: async (samples) =>
        Array.from({ length: samples.length / 512 }, (_, i) => (samples[i * 512] === 0 ? 0 : 1)),
      close: async () => undefined,
    }),
    getMicrophone: async () => ({ getTracks: () => [{ stop: stopTrack }] }),
    transcribe,
    speak: async () => undefined,
    attachCapture: (_stream, next) => {
      onFrame = next;
      return detach;
    },
    now: () => clock,
  });
  return {
    transport,
    stopTrack,
    detach,
    feed(amplitude: number, elapsed = 100) {
      clock += elapsed;
      if (!onFrame) throw new Error("Capture has not started.");
      onFrame(tone(amplitude), 16_000);
    },
    utterance() {
      this.feed(0.2);
      this.feed(0.2);
      this.feed(0.2);
      this.feed(0);
      this.feed(0, 700);
    },
  };
}

class TestUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  voice: SpeechSynthesisVoice | null = null;
  constructor(readonly text: string) {}
}

function speechFixture() {
  vi.stubGlobal("SpeechSynthesisUtterance", TestUtterance);
  const utterances: TestUtterance[] = [];
  const speech: SpeechOutput = {
    cancel: vi.fn(),
    getVoices: vi.fn(() => [
      { default: true, lang: "en-US", localService: true, name: "System voice", voiceURI: "system-local" },
    ]),
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
      if (!(utterance instanceof TestUtterance)) throw new Error("Unexpected utterance.");
      utterances.push(utterance);
    }),
  };
  return { speech, utterances };
}

afterEach(() => vi.unstubAllGlobals());

describe("SpeechSegmenter", () => {
  it("includes pre-roll and ends genuine speech after silence hangover", () => {
    const vad = new SpeechSegmenter({ silenceMs: 100, minSpeechMs: 250, preRollFrames: 2 });
    expect(vad.push(tone(0), 0, false)).toBeNull();
    vad.push(tone(0.2), 100, true);
    vad.push(tone(0.2), 200, true);
    vad.push(tone(0.2), 300, true);
    expect(vad.push(tone(0), 400, false)).toBeNull();
    const ended = vad.push(tone(0), 500, false);
    if (ended?.type !== "end") throw new Error("Expected speech end.");
    expect(ended.samples.length).toBe(9216);
  });

  it("discards a tap instead of counting silence toward minimum speech, then accepts the next utterance", () => {
    const vad = new SpeechSegmenter({ silenceMs: 100, minSpeechMs: 250 });
    vad.push(tone(0.2), 0, true);
    expect(vad.push(tone(0), 100, false)).toBeNull();
    expect(vad.push(tone(0), 900, false)).toEqual({ type: "discard" });
    vad.push(tone(0.2), 1000, true);
    vad.push(tone(0.2), 1100, true);
    vad.push(tone(0.2), 1200, true);
    vad.push(tone(0), 1300, false);
    expect(vad.push(tone(0), 1400, false)?.type).toBe("end");
  });

  it("uses captured sample duration rather than callback scheduling delays", () => {
    const vad = new SpeechSegmenter({ silenceMs: 100, minSpeechMs: 250 });
    vad.push(tone(0.2, 480), 0, true, 48_000);
    vad.push(tone(0.2, 480), 1000, true, 48_000);
    vad.push(tone(0, 480), 1100, false, 48_000);
    expect(vad.push(tone(0, 480), 1200, false, 48_000)).toEqual({ type: "discard" });
  });
});

describe("LocalVoiceTransport", () => {
  it("releases microphone tracks granted after stop without attaching capture", async () => {
    const microphone = Promise.withResolvers<{ getTracks(): Array<{ stop(): void }> }>();
    const stopTrack = vi.fn();
    const attachCapture = vi.fn(() => vi.fn());
    const transport = new LocalVoiceTransport({
      prepareDetection: async () => ({
        detect: async (samples) =>
          Array.from({ length: samples.length / 512 }, (_, i) => (samples[i * 512] === 0 ? 0 : 1)),
        close: async () => undefined,
      }),
      getMicrophone: () => microphone.promise,
      transcribe: async () => "unused",
      speak: async () => undefined,
      attachCapture,
    });
    const start = transport.start({ onSpeechStarted: vi.fn(), onTranscript: vi.fn(), onError: vi.fn() });
    transport.stop();
    microphone.resolve({ getTracks: () => [{ stop: stopTrack }] });
    await start;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(attachCapture).not.toHaveBeenCalled();
  });

  it("closes suspended audio capture and releases tracks when stopped during resume", async () => {
    const resuming = Promise.withResolvers<void>();
    const close = vi.fn(async () => undefined);
    const resume = vi.fn(() => resuming.promise);
    const stopTrack = vi.fn();
    class Microphone {
      getTracks() {
        return [{ stop: stopTrack }];
      }
    }
    class CaptureContext {
      state = "suspended";
      sampleRate = 16_000;
      destination = {};
      close = close;
      resume = resume;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        return { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }
    vi.stubGlobal("MediaStream", Microphone);
    vi.stubGlobal("AudioContext", CaptureContext);
    const transport = new LocalVoiceTransport({
      prepareDetection: async () => ({
        detect: async (samples) =>
          Array.from({ length: samples.length / 512 }, (_, i) => (samples[i * 512] === 0 ? 0 : 1)),
        close: async () => undefined,
      }),
      getMicrophone: async () => new Microphone(),
      transcribe: async () => "unused",
      speak: async () => undefined,
    });
    const starting = transport.start({ onSpeechStarted: vi.fn(), onTranscript: vi.fn(), onError: vi.fn() });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    transport.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    resuming.resolve();
    await starting;
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects failed audio initialization and releases its context and microphone", async () => {
    const close = vi.fn(async () => undefined);
    const stopTrack = vi.fn();
    class Microphone {
      getTracks() {
        return [{ stop: stopTrack }];
      }
    }
    class CaptureContext {
      close = close;
      createMediaStreamSource() {
        throw new Error("Audio device disconnected");
      }
    }
    vi.stubGlobal("MediaStream", Microphone);
    vi.stubGlobal("AudioContext", CaptureContext);
    const transport = new LocalVoiceTransport({
      prepareDetection: async () => ({
        detect: async (samples) =>
          Array.from({ length: samples.length / 512 }, (_, i) => (samples[i * 512] === 0 ? 0 : 1)),
        close: async () => undefined,
      }),
      getMicrophone: async () => new Microphone(),
      transcribe: async () => "unused",
      speak: async () => undefined,
    });
    await expect(
      transport.start({ onSpeechStarted: vi.fn(), onTranscript: vi.fn(), onError: vi.fn() }),
    ).rejects.toThrow("Audio device disconnected");
    expect(close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("rejects unsupported capture visibly and releases the acquired microphone", async () => {
    const stopTrack = vi.fn();
    const transport = new LocalVoiceTransport({
      prepareDetection: async () => ({
        detect: async (samples) =>
          Array.from({ length: samples.length / 512 }, (_, i) => (samples[i * 512] === 0 ? 0 : 1)),
        close: async () => undefined,
      }),
      getMicrophone: async () => ({ getTracks: () => [{ stop: stopTrack }] }),
      transcribe: async () => "unused",
      speak: async () => undefined,
    });
    await expect(
      transport.start({ onSpeechStarted: vi.fn(), onTranscript: vi.fn(), onError: vi.fn() }),
    ).rejects.toThrow("cannot capture microphone audio");
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("submits no task for silence, a tap or an empty transcript, but recovers for real speech", async () => {
    const transcribe = vi.fn().mockResolvedValueOnce("   ").mockResolvedValueOnce("book a table");
    const fixture = captureFixture(transcribe);
    const submit = vi.fn(async () => ({ deliveryId: "test-delivery" }));
    const call = new VoiceCall({
      transport: fixture.transport,
      submit,
      interrupt: async () => undefined,
      waitForReply: async () => "The booking is confirmed for seven.",
      onEvent: vi.fn(),
    });
    await call.start();
    fixture.feed(0);
    fixture.feed(0, 1000);
    fixture.feed(0.2);
    fixture.feed(0);
    fixture.feed(0, 700);
    expect(transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    fixture.utterance();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    expect(submit).not.toHaveBeenCalled();
    fixture.utterance();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith("book a table"));
    call.stop();
    expect(fixture.detach).toHaveBeenCalledOnce();
    expect(fixture.stopTrack).toHaveBeenCalledOnce();
  });

  it("preserves both paused transcripts when newer speech starts during inference", async () => {
    const old = Promise.withResolvers<string>();
    const latest = Promise.withResolvers<string>();
    const transcribe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const fixture = captureFixture(transcribe);
    const onTranscript = vi.fn();
    await fixture.transport.start({ onTranscript, onSpeechStarted: vi.fn(), onError: vi.fn() });
    fixture.utterance();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    fixture.utterance();
    old.resolve("book for six");
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("book for six"));
    latest.resolve("make that seven");
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("make that seven"));
    expect(onTranscript).toHaveBeenCalledTimes(2);
    fixture.transport.stop();
  });

  it("keeps an accepted utterance when a later short microphone impulse is discarded", async () => {
    const accepted = Promise.withResolvers<string>();
    const fixture = captureFixture(() => accepted.promise);
    const submit = vi.fn(async () => ({ deliveryId: "test-delivery" }));
    const call = new VoiceCall({
      transport: fixture.transport,
      submit,
      interrupt: async () => undefined,
      waitForReply: async () => "Booked for seven.",
      onEvent: vi.fn(),
    });
    await call.start();
    try {
      fixture.utterance();
      fixture.feed(0.2);
      fixture.feed(0);
      fixture.feed(0, 700);
      accepted.resolve("book for seven");
      await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith("book for seven"));
    } finally {
      call.stop();
    }
  });

  it("cancels an older transcript when sustained newer speech is detected, before that utterance ends", async () => {
    const old = Promise.withResolvers<string>();
    const transcribe = vi.fn(() => old.promise);
    const fixture = captureFixture(transcribe);
    const onTranscript = vi.fn();
    await fixture.transport.start({ onSpeechStarted: vi.fn(), onTranscript, onError: vi.fn() });
    fixture.utterance();
    fixture.feed(0.2);
    fixture.feed(0.2);
    fixture.feed(0.2);
    old.resolve("Do not send the cancelled request");
    await old.promise;
    expect(onTranscript).not.toHaveBeenCalled();
    fixture.transport.stop();
  });

  it("does not let a stopped session's pending transcript reach a restarted call", async () => {
    const old = Promise.withResolvers<string>();
    const transcribe = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce("new request");
    const fixture = captureFixture(transcribe);
    const olderTranscript = vi.fn();
    const newerTranscript = vi.fn();
    await fixture.transport.start({ onSpeechStarted: vi.fn(), onTranscript: olderTranscript, onError: vi.fn() });
    fixture.utterance();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    fixture.transport.stop();
    await fixture.transport.start({ onSpeechStarted: vi.fn(), onTranscript: newerTranscript, onError: vi.fn() });
    fixture.utterance();
    old.resolve("cancelled request");
    await vi.waitFor(() => expect(newerTranscript).toHaveBeenCalledExactlyOnceWith("new request"));
    expect(olderTranscript).not.toHaveBeenCalled();
    fixture.transport.stop();
  });

  it("reports transcription failure and accepts the next utterance", async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new Error("Whisper failed")).mockResolvedValueOnce("try again");
    const fixture = captureFixture(transcribe);
    const onError = vi.fn();
    const onTranscript = vi.fn();
    await fixture.transport.start({ onSpeechStarted: vi.fn(), onTranscript, onError });
    fixture.utterance();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Whisper failed"));
    fixture.utterance();
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("try again"));
    fixture.transport.stop();
  });

  it("detects classified low-volume speech while newer playback remains owned", async () => {
    const old = Promise.withResolvers<void>();
    const next = Promise.withResolvers<void>();
    let onFrame: ((frame: Float32Array, sampleRate: number) => void) | undefined;
    const speak = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const transport = new LocalVoiceTransport({
      prepareDetection: async () => ({
        detect: async (samples) =>
          Array.from({ length: samples.length / 512 }, (_, i) => (samples[i * 512] === 0 ? 0 : 1)),
        close: async () => undefined,
      }),
      getMicrophone: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
      transcribe: async () => "unused",
      speak,
      attachCapture: (_stream, capture) => {
        onFrame = capture;
        return () => undefined;
      },
    });
    const onSpeechStarted = vi.fn();
    await transport.start({ onSpeechStarted, onTranscript: vi.fn(), onError: vi.fn() });
    const first = transport.speak("First answer", new AbortController().signal);
    const second = transport.speak("New answer", new AbortController().signal);
    old.resolve();
    await first;
    onFrame?.(tone(0.03), 16_000);
    onFrame?.(tone(0.03), 16_000);
    onFrame?.(tone(0.03), 16_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSpeechStarted).toHaveBeenCalledOnce();
    onFrame?.(tone(0.2), 16_000);
    onFrame?.(tone(0.2), 16_000);
    onFrame?.(tone(0.2), 16_000);
    expect(onSpeechStarted).toHaveBeenCalledOnce();
    transport.stop();
    expect(speak.mock.calls[1]?.[1].aborted).toBe(true);
    next.resolve();
    await second;
  });
});

describe("speech synthesis", () => {
  it("speaks the genuine agent reply and settles only after playback ends", async () => {
    const { speech, utterances } = speechFixture();
    const signal = new AbortController().signal;
    const removeListener = vi.spyOn(signal, "removeEventListener");
    const result = speakWithSpeechSynthesis("Your table is booked for seven.", signal, speech);
    const settled = vi.fn();
    void result.then(settled);
    expect(utterances[0]?.text).toBe("Your table is booked for seven.");
    expect(settled).not.toHaveBeenCalled();
    utterances[0]?.onend?.();
    await result;
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(utterances[0]?.onend).toBeNull();
    expect(utterances[0]?.onerror).toBeNull();
  });

  it("cuts playback off on abort and removes every completion handler", async () => {
    const { speech, utterances } = speechFixture();
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const result = speakWithSpeechSynthesis("A spoken answer", abort.signal, speech);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await rejected;
    expect(speech.cancel).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(utterances[0]?.onend).toBeNull();
    expect(utterances[0]?.onerror).toBeNull();
  });

  it("settles replaced playback so its later abort cannot cancel the new reply", async () => {
    const { speech, utterances } = speechFixture();
    const oldAbort = new AbortController();
    const first = speakWithSpeechSynthesis("Old reply", oldAbort.signal, speech);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = speakWithSpeechSynthesis("New reply", new AbortController().signal, speech);
    await rejected;
    const cancelCount = vi.mocked(speech.cancel).mock.calls.length;
    oldAbort.abort();
    expect(speech.cancel).toHaveBeenCalledTimes(cancelCount);
    expect(utterances[0]?.onend).toBeNull();
    utterances[1]?.onend?.();
    await second;
  });

  it("cleans up speech errors and synchronous output failures", async () => {
    const { speech, utterances } = speechFixture();
    const abort = new AbortController();
    const result = speakWithSpeechSynthesis("An answer", abort.signal, speech);
    const rejected = expect(result).rejects.toThrow("Could not speak the reply.");
    utterances[0]?.onerror?.();
    await rejected;
    const cancelCount = vi.mocked(speech.cancel).mock.calls.length;
    abort.abort();
    expect(speech.cancel).toHaveBeenCalledTimes(cancelCount);
    expect(utterances[0]?.onend).toBeNull();
    expect(utterances[0]?.onerror).toBeNull();
    vi.mocked(speech.speak).mockImplementationOnce(() => {
      throw new Error("Audio output unavailable");
    });
    const nextAbort = new AbortController();
    const removeListener = vi.spyOn(nextAbort.signal, "removeEventListener");
    await expect(speakWithSpeechSynthesis("Next answer", nextAbort.signal, speech)).rejects.toThrow(
      "Audio output unavailable",
    );
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("local system voices", () => {
  it("selects an installed local voice rather than a network default", async () => {
    const { speech, utterances } = speechFixture();
    vi.mocked(speech.getVoices).mockReturnValue([
      { default: true, lang: "en-US", localService: false, name: "Cloud voice", voiceURI: "network" },
      { default: false, lang: "en-US", localService: true, name: "OS voice", voiceURI: "installed" },
    ]);
    const result = speakWithSpeechSynthesis("Your booking is confirmed.", new AbortController().signal, speech);
    expect(utterances[0]?.voice?.voiceURI).toBe("installed");
    utterances[0]?.onend?.();
    await result;
  });

  it("reports unavailable local speech rather than silently choosing a network voice", async () => {
    const { speech } = speechFixture();
    vi.mocked(speech.getVoices).mockReturnValue([
      { default: true, lang: "en-US", localService: false, name: "Cloud voice", voiceURI: "network" },
    ]);
    await expect(speakWithSpeechSynthesis("Must stay local.", new AbortController().signal, speech)).rejects.toThrow(
      "No local system voice is available",
    );
    expect(speech.speak).not.toHaveBeenCalled();
  });
});

describe("short microphone impulses", () => {
  it("does not treat a brief tap inside a large capture buffer as sustained speech", () => {
    const vad = new SpeechSegmenter({ minSpeechMs: 250 });
    const tap = tone(0, 4096);
    tap.fill(0.2, 0, 160);
    vad.push(tap.subarray(0, 160), 0, true);
    vad.push(tone(0, 4096), 256, false);
    expect(vad.push(tone(0, 4096), 1000, false)).toEqual({ type: "discard" });
  });
});

describe("ambiguous repeated transcript", () => {
  it("shows a retry, dispatches no task, and recovers for the next real sentence", async () => {
    const fixture = captureFixture(
      vi.fn().mockResolvedValueOnce("هلو هلو هلو هلو هلو هلو").mockResolvedValueOnce("Dani read my notes"),
    );
    const onTranscript = vi.fn();
    const onError = vi.fn();
    await fixture.transport.start({ onSpeechStarted: vi.fn(), onTranscript, onError });
    fixture.utterance();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("Please say a full sentence again")),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    fixture.utterance();
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Dani read my notes"));
    fixture.transport.stop();
  });
});

it("microphone close flushes the final sentence and preserves pending STT", async () => {
  const pending = Promise.withResolvers<string>();
  const transcribe = vi.fn(() => pending.promise);
  const f = captureFixture(transcribe);
  const onTranscript = vi.fn();
  await f.transport.start({ onTranscript, onSpeechStarted: vi.fn(), onError: vi.fn() });
  f.feed(0.2);
  f.feed(0.2);
  f.feed(0.2);
  f.feed(0.2);
  f.transport.closeMicrophone();
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  expect(f.stopTrack).toHaveBeenCalledOnce();
  expect(onTranscript).not.toHaveBeenCalled();
  pending.resolve("keep the final sentence");
  await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledExactlyOnceWith("keep the final sentence"));
  f.transport.stop();
});

it("muting pauses capture without ending output or the voice session", async () => {
  const transcribe = vi.fn(async () => "real speech");
  const f = captureFixture(transcribe);
  const heard = vi.fn();
  await f.transport.start({ onTranscript: heard, onSpeechStarted: vi.fn(), onError: vi.fn() });
  f.transport.setMuted(true);
  f.utterance();
  await Promise.resolve();
  await Promise.resolve();
  expect(transcribe).not.toHaveBeenCalled();
  expect(f.stopTrack).not.toHaveBeenCalled();
  f.transport.setMuted(false);
  f.utterance();
  await vi.waitFor(() => expect(heard).toHaveBeenCalledWith("real speech"));
  f.transport.stop();
});
