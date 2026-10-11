import type { RealtimeTransportHandlers } from "./realtime-voice-transport";
import type { VoiceCallDeps, VoiceCallSubmission } from "./voice-call";
import { isRepetitiveVoiceTranscript, usableVoiceTranscript } from "./voice-transcript";

interface VoiceJob {
  id: number;
  submission: VoiceCallSubmission;
  done: boolean;
}
interface Output {
  job: VoiceJob;
  text: string;
  final: boolean;
}

/** Prototype: audio interruption never cancels a durable accepted thread delivery. */
export class BackgroundVoiceCall {
  #running = false;
  #generation = 0;
  #nextId = 0;
  #lifetime: AbortController | null = null;
  #speech: AbortController | null = null;
  #inputCount = 0;
  #outputs: Output[] = [];
  #submissions: Promise<void> = Promise.resolve();
  constructor(private readonly deps: VoiceCallDeps) {}
  get running(): boolean {
    return this.#running;
  }
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const generation = ++this.#generation;
    const lifetime = new AbortController();
    this.#lifetime = lifetime;
    const current = () => this.#running && generation === this.#generation;
    const listening = () =>
      this.deps.onEvent({
        type: "phase",
        phase: "listening",
        turnId: this.#nextId,
      });
    const handlers: RealtimeTransportHandlers = {
      onInputLevel: (level) => {
        if (current()) this.deps.onEvent({ type: "input-level", level });
      },
      onSpeechStarted: () => {
        if (!current()) return;
        this.#inputCount += 1;
        this.#speech?.abort();
        listening();
      },
      onTranscriptionStarted: () => {
        if (current())
          this.deps.onEvent({
            type: "phase",
            phase: "transcribing",
            turnId: this.#nextId,
          });
      },
      onTranscriptionFinished: () => {
        if (!current()) return;
        this.#inputCount = Math.max(0, this.#inputCount - 1);
        listening();
        queueMicrotask(() => {
          if (current()) void this.#pump(generation);
        });
      },
      onTranscript: (raw) => {
        if (!current()) return;
        const text = usableVoiceTranscript(raw);
        if (!text || isRepetitiveVoiceTranscript(text)) {
          void this.#pump(generation);
          return;
        }
        const id = ++this.#nextId;
        this.deps.onEvent({ type: "transcript", text, turnId: id });
        this.#submissions = this.#submissions
          .catch(() => undefined)
          .then(async () => {
            if (!current()) return;
            try {
              const submission = await this.deps.submit(text);
              if (!current()) return; // Accepted work remains in the durable thread after call end.
              if (!submission) throw new Error("Could not send what you said. Try again.");
              const job: VoiceJob = { id, submission, done: false };
              this.#outputs.push({
                job,
                text: "Your request is in the chat queue. You can keep talking.",
                final: false,
              });
              void this.#watch(job, lifetime.signal, generation);
              void this.#pump(generation);
            } catch (error) {
              if (current()) this.#error(error, id);
            }
          });
      },
      onError: (message) => {
        if (current()) {
          this.#error(new Error(message), -1);
          this.stop();
        }
      },
    };
    this.deps.onEvent({ type: "connecting" });
    try {
      await this.deps.transport.start(handlers);
    } catch (error) {
      if (current()) {
        this.stop();
        throw error;
      }
      return;
    }
    if (current()) listening();
  }
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    ++this.#generation;
    this.#lifetime?.abort(); // Releases voice observers only, never sends delivery cancellation.
    this.#lifetime = null;
    this.#speech?.abort();
    this.#speech = null;
    this.#outputs = [];
    this.#inputCount = 0;
    this.#submissions = Promise.resolve();
    this.deps.transport.stop();
    this.deps.onEvent({ type: "ended" });
  }
  async #watch(job: VoiceJob, signal: AbortSignal, generation: number): Promise<void> {
    try {
      const answer = await this.deps.waitForReply(job.submission, signal);
      if (!this.#running || generation !== this.#generation || signal.aborted) return;
      job.done = true;
      this.#outputs = this.#outputs.filter((output) => output.job !== job);
      this.deps.onEvent({ type: "answer", text: answer, turnId: job.id });
      this.#outputs.push({ job, text: answer, final: true });
      void this.#pump(generation);
    } catch (error) {
      if (!this.#running || generation !== this.#generation || signal.aborted) return;
      job.done = true;
      this.#outputs = this.#outputs.filter((output) => output.job !== job);
      this.#error(error, job.id);
    }
  }
  async #pump(generation: number): Promise<void> {
    if (!this.#running || generation !== this.#generation || this.#speech || this.#inputCount > 0) return;
    const output = this.#outputs.shift();
    if (!output) return;
    if (!output.final && output.job.done) {
      void this.#pump(generation);
      return;
    }
    const speech = new AbortController();
    this.#speech = speech;
    this.deps.onEvent({
      type: "phase",
      phase: "speaking",
      turnId: output.job.id,
    });
    try {
      await this.deps.transport.speak(output.text, speech.signal);
    } catch (error) {
      if (!speech.signal.aborted && this.#running && generation === this.#generation) this.#error(error, output.job.id);
    } finally {
      if (this.#speech === speech) this.#speech = null;
      if (this.#running && generation === this.#generation) {
        this.deps.onEvent({
          type: "phase",
          phase: "listening",
          turnId: output.job.id,
        });
        void this.#pump(generation);
      }
    }
  }
  #error(error: unknown, turnId: number): void {
    this.deps.onEvent({
      type: "error",
      message: error instanceof Error ? error.message : "Voice job failed.",
      turnId,
    });
  }
}
