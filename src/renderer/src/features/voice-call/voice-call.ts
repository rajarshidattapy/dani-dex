import type { DuplexVoiceEvent } from "@dani-dex/contracts/full-duplex-voice";
import { errorMessage } from "../../error-message";
import type { RealtimeTransportHandlers } from "./realtime-voice-transport";
import { isRepetitiveVoiceTranscript, usableVoiceTranscript } from "./voice-transcript";

export interface VoiceCallTransport {
  start(handlers: RealtimeTransportHandlers): Promise<void>;
  speak(text: string, signal: AbortSignal): Promise<void>;
  stop(): void;
  closeMicrophone?(): void;
  setMuted?(muted: boolean): void;
}

export type VoiceCallEvent =
  | DuplexVoiceEvent
  | { type: "input-level"; level: number }
  | { type: "connecting" }
  | { type: "ended" }
  | { type: "queued-input"; count: number; lines?: readonly string[] }
  | { type: "held-input"; text: string };

export interface VoiceCallSubmission {
  deliveryId: string;
}

export interface VoiceCallDeps {
  transport: VoiceCallTransport;
  /** The ordinary thread submit returns the accepted recipient delivery, including queued work. */
  submit: (text: string) => Promise<VoiceCallSubmission | null>;
  waitForReply: (submission: VoiceCallSubmission, signal: AbortSignal) => Promise<string>;
  interrupt: (submission: VoiceCallSubmission) => Promise<void>;
  onEvent: (event: VoiceCallEvent) => void;
  waitUntilIdle?: (signal: AbortSignal) => Promise<void>;
}

/** Later finalized speech waits in a voice FIFO until the preceding answer is complete. */
export class VoiceCall {
  #running = false;
  #inputClosed = false;
  #generation = 0;
  #nextId = 0;
  #busy = false;
  #queueBlocked = false;
  #jobs: Array<{ text: string; id: number }> = [];
  #lifetime = new AbortController();
  #speech: AbortController | null = null;
  constructor(private readonly deps: VoiceCallDeps) {}
  get running(): boolean {
    return this.#running;
  }
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#inputClosed = false;
    this.#queueBlocked = false;
    this.#lifetime = new AbortController();
    const generation = ++this.#generation;
    const current = () => this.#running && !this.#inputClosed && generation === this.#generation;
    this.deps.onEvent({ type: "connecting" });
    try {
      await this.deps.transport.start({
        onInputLevel: (level) => {
          if (current()) this.deps.onEvent({ type: "input-level", level });
        },
        onSpeechStarted: () => {
          if (!current()) return;
          this.#speech?.abort(); // Stop speaker output only, never accepted agent work.
          this.deps.onEvent({ type: "phase", phase: "listening", turnId: this.#nextId });
        },
        onTranscriptionStarted: () => {
          if (current()) this.deps.onEvent({ type: "phase", phase: "transcribing", turnId: this.#nextId });
        },
        onTranscriptionFinished: () => {
          if (current() && !this.#busy) this.deps.onEvent({ type: "phase", phase: "listening", turnId: this.#nextId });
        },
        onTranscript: (raw) => {
          if (!this.#running || generation !== this.#generation) return;
          const text = usableVoiceTranscript(raw);
          if (!text || isRepetitiveVoiceTranscript(text)) return;
          if (this.#jobs.length >= 8) {
            this.deps.onEvent({ type: "error", message: "Voice queue is full. Please pause.", turnId: -1 });
            return;
          }
          const id = ++this.#nextId;
          this.#jobs.push({ text, id });
          this.deps.onEvent({ type: "transcript", text, turnId: id });
          this.deps.onEvent({
            type: "queued-input",
            count: this.#jobs.length,
            lines: this.#jobs.map((job) => job.text),
          });
          if (this.#inputClosed) this.#holdUnsent();
          else void this.#pump(generation);
        },
        onRecognitionError: (message) => {
          if (current()) this.deps.onEvent({ type: "error", message, turnId: -1 });
        },
        onError: (message) => {
          if (current()) {
            this.deps.onEvent({ type: "error", message, turnId: -1 });
            this.closeMicrophone();
          }
        },
      });
    } catch (error) {
      if (current()) {
        // Report before ended clears the store's call identity. Otherwise startup failures vanish.
        this.deps.onEvent({
          type: "error",
          message: errorMessage(error, "Could not start the voice call. Try again."),
          turnId: -1,
        });
        this.stop();
        throw error;
      }
    }
    if (current()) this.deps.onEvent({ type: "phase", phase: "listening", turnId: this.#nextId });
  }
  setMuted(muted: boolean): void {
    this.deps.transport.setMuted?.(muted);
  }
  closeMicrophone(): void {
    if (!this.#running || this.#inputClosed) return;
    this.#inputClosed = true;
    this.#holdUnsent();
    if (this.deps.transport.closeMicrophone) this.deps.transport.closeMicrophone();
    else this.deps.transport.stop();
    this.deps.onEvent({ type: "ended" });
  }
  #holdUnsent(): void {
    if (!this.#jobs.length) return;
    const text = this.#jobs.map((job) => job.text).join("\n");
    this.#jobs = [];
    this.deps.onEvent({ type: "held-input", text });
    this.deps.onEvent({ type: "queued-input", count: 0 });
  }
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    ++this.#generation;
    this.#lifetime.abort(); // Detach observers, never cancel an accepted backend delivery.
    this.#speech?.abort();
    this.#speech = null;
    this.#jobs = [];
    this.#busy = false;
    this.deps.transport.stop();
    this.deps.onEvent({ type: "queued-input", count: 0 });
    this.deps.onEvent({ type: "ended" });
  }
  async #pump(generation: number): Promise<void> {
    if (this.#busy || this.#queueBlocked) return;
    this.#busy = true;
    const signal = this.#lifetime.signal;
    const current = () => this.#running && generation === this.#generation && !signal.aborted;
    try {
      while (current() && !this.#inputClosed && this.#jobs.length) {
        await this.deps.waitUntilIdle?.(signal);
        if (!current() || this.#inputClosed) break;
        const job = this.#jobs.shift();
        if (!job) break;
        this.deps.onEvent({ type: "queued-input", count: this.#jobs.length, lines: this.#jobs.map((job) => job.text) });
        this.deps.onEvent({ type: "phase", phase: "thinking", turnId: job.id });
        if (!current()) break;
        if (this.#inputClosed) {
          this.#jobs.unshift(job);
          this.#holdUnsent();
          break;
        }
        try {
          const submission = await this.deps.submit(job.text);
          if (!submission) {
            // No receipt means this text was not accepted. Preserve it once, never auto-retry.
            this.deps.onEvent({ type: "held-input", text: job.text });
            throw new Error("Could not send what you said. The words are kept in your draft.");
          }
          if (!current()) break;
          const answer = await this.deps.waitForReply(submission, signal);
          if (!current()) break;
          this.deps.onEvent({ type: "answer", text: answer, turnId: job.id });
          this.deps.onEvent({ type: "phase", phase: "speaking", turnId: job.id });
          const speech = new AbortController();
          this.#speech = speech;
          const abort = () => speech.abort();
          signal.addEventListener("abort", abort, { once: true });
          try {
            await this.deps.transport.speak(answer, speech.signal);
          } catch (error) {
            if (!speech.signal.aborted) throw error;
          } finally {
            signal.removeEventListener("abort", abort);
            if (this.#speech === speech) this.#speech = null;
          }
        } catch (error) {
          if (current()) {
            // A failed reply is not the preceding result. Never flush later speech into chat.
            this.#queueBlocked = true;
            this.deps.onEvent({ type: "error", message: errorMessage(error, "Voice request failed."), turnId: job.id });
          }
          break;
        }
      }
    } catch (error) {
      if (current())
        this.deps.onEvent({
          type: "error",
          message: errorMessage(error, "Could not wait for the current reply."),
          turnId: -1,
        });
    } finally {
      if (generation === this.#generation) this.#busy = false;
      if (current() && !this.#inputClosed)
        this.deps.onEvent({ type: "phase", phase: "listening", turnId: this.#nextId });
    }
  }
}
