import { VOICE_AUDIO_LIMITS, type VoiceDesktopApi } from "@dani-dex/contracts/ipc";
import { pcmToWhisperWav } from "../../voice-recording";
import type { RealtimeTransportHandlers } from "./realtime-voice-transport";
import { transcriptionOptions } from "./speech-preferences";
import type { VoiceCallTransport } from "./voice-call";
import { isRepetitiveVoiceTranscript, usableVoiceTranscript } from "./voice-transcript";

const SILENCE_MS = 700;
const MIN_SPEECH_MS = 250;
const PRE_ROLL_FRAMES = 4;

export interface SpeechSegmenterOptions {
  silenceMs?: number;
  minSpeechMs?: number;
  maxSpeechMs?: number;
  preRollFrames?: number;
}

export type SpeechSegmentResult = { type: "start" } | { type: "end"; samples: Float32Array } | { type: "discard" };

/** Keeps pre-roll and turn boundaries; only the speech model can announce speech or barge-in. */
export class SpeechSegmenter {
  #speaking = false;
  #announced = false;
  #startedAt = 0;
  #silentSince: number | null = null;
  #speechMs = 0;
  #frames: Float32Array[] = [];
  #preRoll: Float32Array[] = [];
  readonly #silenceMs: number;
  readonly #minSpeechMs: number;
  readonly #maxSpeechMs: number;
  readonly #preRollFrames: number;

  constructor(options: SpeechSegmenterOptions = {}) {
    this.#silenceMs = options.silenceMs ?? SILENCE_MS;
    this.#minSpeechMs = options.minSpeechMs ?? MIN_SPEECH_MS;
    this.#maxSpeechMs = options.maxSpeechMs ?? VOICE_AUDIO_LIMITS.maximumSeconds * 1_000;
    this.#preRollFrames = options.preRollFrames ?? PRE_ROLL_FRAMES;
  }

  push(
    frame: Float32Array,
    nowMs: number,
    voiced: boolean,
    sampleRate: number = VOICE_AUDIO_LIMITS.sampleRate,
  ): SpeechSegmentResult | null {
    const copy = frame.slice();
    if (!this.#speaking) {
      this.#preRoll.push(copy);
      if (this.#preRoll.length > this.#preRollFrames) this.#preRoll.shift();
      if (!voiced) return null;
      this.#speaking = true;
      this.#startedAt = nowMs;
      this.#frames = this.#preRoll.slice();
    } else this.#frames.push(copy);
    if (voiced) {
      this.#silentSince = null;
      this.#speechMs += (frame.length * 1_000) / sampleRate;
    } else if (this.#silentSince === null) this.#silentSince = nowMs;
    if (!this.#announced && this.#speechMs >= this.#minSpeechMs) {
      this.#announced = true;
      return { type: "start" };
    }
    const sampleCount = this.#frames.reduce((total, part) => total + part.length, 0);
    if (
      sampleCount >= VOICE_AUDIO_LIMITS.maximumSeconds * sampleRate ||
      (this.#silentSince !== null && nowMs - this.#silentSince >= this.#silenceMs) ||
      nowMs - this.#startedAt >= this.#maxSpeechMs
    ) {
      // Include pre-roll in the budget and carry overflow forward, never drop the long sentence.
      const joined = this.#announced ? concat(this.#frames) : null;
      const limit = VOICE_AUDIO_LIMITS.maximumSeconds * sampleRate;
      const samples = joined?.subarray(0, limit) ?? null;
      const remainder = joined?.subarray(limit) ?? null;
      this.reset();
      if (remainder?.length) this.#preRoll = [remainder];
      return samples ? { type: "end", samples } : { type: "discard" };
    }
    return null;
  }

  finish(): Float32Array | null {
    const samples = this.#announced ? concat(this.#frames) : null;
    this.reset();
    return samples;
  }

  reset(): void {
    this.#speaking = false;
    this.#announced = false;
    this.#startedAt = 0;
    this.#silentSince = null;
    this.#speechMs = 0;
    this.#frames = [];
    this.#preRoll = [];
  }
}

export interface CapturedMicrophone {
  getTracks(): Array<{ stop(): void; enabled?: boolean }>;
}

export interface SpeechOutput {
  cancel(): void;
  speak(utterance: SpeechSynthesisUtterance): void;
  getVoices(): SpeechSynthesisVoice[];
}

export interface SpeechDetector {
  detect(samples: Float32Array): Promise<readonly number[]>;
  close(): Promise<void>;
}

interface DetectionCapture {
  detector: SpeechDetector;
  frames: Array<{ samples: Float32Array; now: number }>;
  processing: boolean;
  generation: number;
}

export interface LocalVoiceTransportDeps {
  getMicrophone(): Promise<CapturedMicrophone>;
  prepareDetection(signal: AbortSignal): Promise<SpeechDetector>;
  transcribe(audio: Uint8Array, signal: AbortSignal): Promise<string>;
  speak(text: string, signal: AbortSignal): Promise<void>;
  attachCapture?(
    stream: CapturedMicrophone,
    onFrame: (frame: Float32Array, sampleRate: number) => void,
    signal: AbortSignal,
  ): (() => void) | Promise<() => void>;
  now?(): number;
}

/**
 * Local full-duplex: Silero detects speech, Whisper transcribes it, the thread answers, and the
 * local system voice reads the reply. No cloud speech or OpenAI Realtime session.
 */
export class LocalVoiceTransport implements VoiceCallTransport {
  #handlers: RealtimeTransportHandlers | null = null;
  #stream: CapturedMicrophone | null = null;
  #detach: (() => void) | null = null;
  #capture: AbortController | null = null;
  #vad = new SpeechSegmenter();
  #detection: DetectionCapture | null = null;
  #transcription: AbortController | null = null;
  #speech: AbortController | null = null;
  #generation = 0;
  #utterance = 0;
  #transcribing = false;
  #muted = false;
  #pending: Array<{
    samples: Float32Array;
    sampleRate: number;
    generation: number;
    utterance: number;
    handlers: RealtimeTransportHandlers;
  }> = [];

  constructor(private readonly deps: LocalVoiceTransportDeps) {}

  async start(handlers: RealtimeTransportHandlers): Promise<void> {
    this.stop();
    this.#muted = false;
    const generation = this.#generation;
    this.#handlers = handlers;
    const capture = new AbortController();
    this.#capture = capture;
    try {
      const stream = await this.deps.getMicrophone();
      if (generation !== this.#generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.#stream = stream;
      const detector = await this.deps.prepareDetection(capture.signal);
      if (generation !== this.#generation) {
        await detector.close();
        return;
      }
      this.#detection = { detector, frames: [], processing: false, generation };
      const attach = this.deps.attachCapture ?? attachScriptProcessorCapture;
      const detach = await attach(
        stream,
        (frame, sampleRate) => {
          if (generation !== this.#generation) return;
          if (sampleRate !== VOICE_AUDIO_LIMITS.sampleRate) {
            handlers.onError("This device could not capture 16 kHz microphone audio.");
            this.stop();
            return;
          }
          this.#onFrame(frame);
        },
        capture.signal,
      );
      if (generation !== this.#generation) detach();
      else this.#detach = detach;
    } catch (error) {
      if (generation !== this.#generation) return;
      this.stop();
      throw error;
    }
  }

  async speak(text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
    this.#speech?.abort();
    const speech = new AbortController();
    const onAbort = () => speech.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.#speech = speech;
    try {
      await this.deps.speak(text, speech.signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.#speech === speech) this.#speech = null;
    }
  }

  stop(): void {
    this.closeMicrophone(false);
    this.#speech?.abort();
    this.#speech = null;
  }

  closeMicrophone(preserveInput = true): void {
    const detection = this.#detection;
    this.#detection = null;
    this.#detach?.();
    this.#detach = null;
    if (this.#stream) {
      for (const track of this.#stream.getTracks()) track.stop();
      this.#stream = null;
    }
    const generation = this.#generation;
    const finish = async () => {
      if (preserveInput && detection) {
        while (detection.processing && generation === this.#generation)
          await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (generation !== this.#generation) return;
      const handlers = this.#handlers;
      const final = preserveInput ? this.#vad.finish() : null;
      if (final && handlers && this.#pending.length < 8) {
        this.#pending.push({
          samples: final,
          sampleRate: VOICE_AUDIO_LIMITS.sampleRate,
          generation,
          utterance: this.#utterance,
          handlers,
        });
      }
      this.#handlers = null;
      if (!preserveInput) {
        this.#generation += 1;
        this.#vad.reset();
        this.#pending = [];
        this.#transcription?.abort();
      } else void this.#commit();
      if (detection) {
        detection.frames = [];
        void detection.detector.close().catch(() => undefined);
      }
      this.#capture?.abort();
      this.#capture = null;
    };
    void finish();
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    for (const track of this.#stream?.getTracks() ?? []) track.enabled = !muted;
    if (muted) this.#vad.reset();
  }

  #onFrame(frame: Float32Array): void {
    if (this.#muted) return;
    const level = Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(frame.length, 1));
    this.#handlers?.onInputLevel?.(level);
    const capture = this.#detection;
    if (!capture || !this.#handlers) return;
    if (capture.frames.length >= 64) {
      this.#handlers.onError("Local speech detection could not keep up with the microphone.");
      this.stop();
      return;
    }
    capture.frames.push({
      samples: frame.slice(),
      now: this.deps.now?.() ?? performance.now(),
    });
    if (!capture.processing) void this.#detect(capture);
  }

  async #detect(capture: DetectionCapture): Promise<void> {
    capture.processing = true;
    try {
      while (capture.frames.length && capture.generation === this.#generation) {
        const frame = capture.frames.shift();
        if (!frame) break;
        const probabilities = await capture.detector.detect(frame.samples);
        if (capture.generation !== this.#generation) return;
        for (let index = 0; index < probabilities.length; index += 1) {
          const start = index * 512;
          const end = Math.min(start + 512, frame.samples.length);
          const now = frame.now - ((frame.samples.length - end) * 1_000) / VOICE_AUDIO_LIMITS.sampleRate;
          // Speaker leakage must not trigger barge-in at the normal listening threshold.
          const threshold = this.#speech ? 0.9 : 0.5;
          if (this.#muted) continue;
          this.#record(frame.samples.subarray(start, end), now, (probabilities[index] ?? 0) >= threshold);
        }
      }
    } catch (error) {
      if (capture.generation === this.#generation) {
        this.#handlers?.onError(error instanceof Error ? error.message : "Local speech detection failed.");
        this.stop();
      }
    } finally {
      capture.processing = false;
    }
  }

  #record(frame: Float32Array, now: number, voiced: boolean): void {
    const handlers = this.#handlers;
    if (!handlers) return;
    const event = this.#vad.push(frame, now, voiced);
    if (event?.type === "start") {
      this.#utterance += 1;
      handlers.onSpeechStarted();
    }
    if (event?.type === "end") {
      if (this.#pending.length >= 8) {
        handlers.onError("Voice is falling behind. Please pause while the queued sentences finish.");
        return;
      }
      this.#pending.push({
        samples: event.samples,
        sampleRate: VOICE_AUDIO_LIMITS.sampleRate,
        generation: this.#generation,
        utterance: this.#utterance,
        handlers,
      });
      void this.#commit();
    }
  }

  async #commit(): Promise<void> {
    // Keep completed sentences in order while Whisper handles one request at a time.
    if (this.#transcribing) return;
    this.#transcribing = true;
    try {
      while (this.#pending.length) {
        const pending = this.#pending.shift();
        if (!pending) break;
        const transcription = new AbortController();
        this.#transcription = transcription;
        pending.handlers.onTranscriptionStarted?.();
        try {
          const text = usableVoiceTranscript(
            await this.deps.transcribe(pcmToWhisperWav(pending.samples, pending.sampleRate), transcription.signal),
          );
          if (pending.generation === this.#generation && text) {
            if (isRepetitiveVoiceTranscript(text)) {
              (pending.handlers.onRecognitionError ?? pending.handlers.onError)(
                "I could not reliably recognize that recording. Please say a full sentence again, or type your message.",
              );
            } else {
              pending.handlers.onTranscript(text);
            }
          }
        } catch (error) {
          if (pending.generation === this.#generation) {
            (pending.handlers.onRecognitionError ?? pending.handlers.onError)(
              error instanceof Error ? error.message : "Could not transcribe speech.",
            );
          }
        } finally {
          if (this.#transcription === transcription) this.#transcription = null;
          if (pending.generation === this.#generation) pending.handlers.onTranscriptionFinished?.();
        }
      }
    } finally {
      this.#transcribing = false;
    }
  }
}

export function createLocalVoiceTransport(): VoiceCallTransport {
  // Chromium may enumerate OS voices asynchronously; begin loading while the model/mic prepares.
  globalThis.speechSynthesis?.getVoices();
  return new LocalVoiceTransport({
    getMicrophone: async () => {
      if (!(await window.danidex.voice.requestMicrophoneAccess()))
        throw new Error(
          "Microphone access is not allowed by macOS. Enable Electron or Dani-Dex in System Settings > Privacy & Security > Microphone.",
        );
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    },
    prepareDetection: prepareLocalSpeechDetector,
    transcribe: transcribeLocalSpeech,
    speak: speakLocalReply,
  });
}

async function prepareLocalSpeechDetector(signal: AbortSignal): Promise<SpeechDetector> {
  const id = crypto.randomUUID();
  let closing: Promise<void> | null = null;
  const close = () => {
    signal.removeEventListener("abort", abort);
    closing ??= window.danidex.voice.stopLocalDetection(id);
    return closing;
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
    await window.danidex.voice.startLocalDetection(id);
    if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
    return {
      detect: (samples) => window.danidex.voice.detectLocalSpeech({ id, samples }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function transcribeLocalSpeech(audio: Uint8Array, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
  const id = crypto.randomUUID();
  let cancelled: Promise<void> | null = null;
  const abort = () => {
    cancelled = window.danidex.voice.cancelTranscription(id);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await window.danidex.voice.transcribe({
      id,
      audio,
      ...transcriptionOptions(),
    });
    if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
    return result.text;
  } finally {
    signal.removeEventListener("abort", abort);
    await cancelled;
  }
}

export function speakLocalReply(text: string, signal: AbortSignal): Promise<void> {
  return speakWithNativeSpeech(text, signal);
}

export async function speakWithNativeSpeech(
  text: string,
  signal: AbortSignal,
  voice: Pick<VoiceDesktopApi, "speakLocal" | "stopLocal"> = window.danidex.voice,
): Promise<void> {
  if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
  const id = crypto.randomUUID();
  let stopped: Promise<Error | null> | null = null;
  let failure: Error | null = null;
  const onAbort = () => {
    stopped = voice.stopLocal(id).then(
      () => null,
      () => new Error("Could not stop local speech."),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const audio = await voice.speakLocal({ id, text });
    if (audio instanceof Uint8Array && !signal.aborted) await playLocalWave(audio, signal);
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Could not speak the reply with the local system voice.");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const stopError = await stopped;
  if (stopError) throw stopError;
  if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
  if (failure) throw failure;
}

/** Chromium playback supplies the echo reference for its microphone capture. */
export async function playLocalWave(wave: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
  const context = new AudioContext();
  let source: AudioBufferSourceNode | undefined;
  const abort = () => {
    source?.stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const buffer = await context.decodeAudioData(wave.slice().buffer);
    if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
    await context.resume();
    if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    await new Promise<void>((resolve, reject) => {
      if (!source) {
        reject(new Error("Local audio output is unavailable."));
        return;
      }
      source.onended = () => (signal.aborted ? reject(new DOMException("Interrupted", "AbortError")) : resolve());
      source.start();
    });
  } finally {
    signal.removeEventListener("abort", abort);
    source?.disconnect();
    await context.close();
  }
}

const activeSpeech = new WeakMap<SpeechOutput, () => void>();

export function speakWithSpeechSynthesis(
  text: string,
  signal: AbortSignal,
  speech: SpeechOutput = globalThis.speechSynthesis,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Interrupted", "AbortError"));
  if (!speech) return Promise.reject(new Error("This device cannot speak replies aloud."));
  const voices = speech.getVoices();
  const voice =
    voices.find((candidate) => candidate.localService && candidate.default) ??
    voices.find((candidate) => candidate.localService);
  if (!voice) {
    return Promise.reject(new Error("No local system voice is available. Enable a voice in system settings."));
  }
  activeSpeech.get(speech)?.();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  let settled = false;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    utterance.onend = null;
    utterance.onerror = null;
    if (activeSpeech.get(speech) === onAbort) activeSpeech.delete(speech);
    if (error) reject(error);
    else resolve();
  };
  const onAbort = () => {
    finish(new DOMException("Interrupted", "AbortError"));
    speech.cancel();
  };
  activeSpeech.set(speech, onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  utterance.onend = () => finish();
  utterance.onerror = () => {
    finish(signal.aborted ? new DOMException("Interrupted", "AbortError") : new Error("Could not speak the reply."));
  };
  try {
    speech.cancel();
    speech.speak(utterance);
  } catch (error) {
    finish(error);
  }
  return promise;
}

async function attachScriptProcessorCapture(
  stream: CapturedMicrophone,
  onFrame: (frame: Float32Array, sampleRate: number) => void,
  signal: AbortSignal,
): Promise<() => void> {
  if (!(typeof MediaStream === "function" && stream instanceof MediaStream)) {
    throw new Error("This device cannot capture microphone audio.");
  }
  const context = new AudioContext({
    sampleRate: VOICE_AUDIO_LIMITS.sampleRate,
  });
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let mute: GainNode | undefined;
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    signal.removeEventListener("abort", detach);
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    source?.disconnect();
    mute?.disconnect();
    void context.close();
  };
  signal.addEventListener("abort", detach, { once: true });
  try {
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(1024, 1, 1);
    mute = context.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      // Chromium capture can exceed full scale after microphone processing.
      // Clamp PCM at the capture boundary; keep privileged IPC validation strict.
      const samples = event.inputBuffer
        .getChannelData(0)
        .map((sample) => (Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0));
      onFrame(samples, context.sampleRate);
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    if (context.state === "suspended") await context.resume();
    if (signal.aborted) {
      detach();
      throw new DOMException("Interrupted", "AbortError");
    }
    if (context.state !== "running") throw new Error("Microphone audio capture could not start.");
    return detach;
  } catch (error) {
    detach();
    throw error;
  }
}

function concat(frames: Float32Array[]): Float32Array {
  let length = 0;
  for (const frame of frames) length += frame.length;
  const output = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}
