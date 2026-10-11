import { type ChildProcess, execFile } from "node:child_process";
import type { VoiceSpeechInput } from "@dani-dex/contracts/ipc";

type StartSpeech = (complete: (error: Error | null) => void) => ChildProcess;

/** Owns local macOS speech and stops only the utterance named by the caller. Text stays on stdin. */
export class NativeSpeechService {
  #active: { id: string; child: ChildProcess; done: Promise<void> } | null = null;
  #requestId: string | null = null;
  #generation = 0;
  #disposed = false;

  constructor(
    private readonly platform = process.platform,
    private readonly start: StartSpeech = (complete) => execFile("/usr/bin/say", ["-f", "-"], complete),
  ) {}

  async speak(input: VoiceSpeechInput): Promise<void> {
    if (this.#disposed) throw new Error("Local speech is closed.");
    if (this.platform !== "darwin") throw new Error("Native local speech is not available on this platform.");
    const generation = ++this.#generation;
    this.#requestId = input.id;
    const previous = this.#active;
    if (previous) {
      previous.child.kill();
      await previous.done.catch(() => undefined);
    }
    if (generation !== this.#generation || this.#disposed) throw new DOMException("Interrupted", "AbortError");

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const child = this.start((error) => {
      if (this.#active?.child === child) this.#active = null;
      if (generation === this.#generation) this.#requestId = null;
      if (generation !== this.#generation || this.#disposed) reject(new DOMException("Interrupted", "AbortError"));
      else if (error) reject(new Error("Could not speak the reply with the local system voice."));
      else resolve();
    });
    this.#active = { id: input.id, child, done: promise };
    child.stdin?.on("error", () => child.kill());
    // `say` reads embedded commands from stdin too; separate every opener, including overlapping runs.
    child.stdin?.end(input.text.replaceAll("[", "[ "));
    return promise;
  }

  async stop(id: string): Promise<void> {
    if (this.#requestId === id) {
      this.#generation += 1;
      this.#requestId = null;
    }
    const active = this.#active;
    if (active?.id !== id) return;
    active.child.kill();
    await active.done.catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.#disposed = true;
    this.#generation += 1;
    this.#requestId = null;
    const active = this.#active;
    if (!active) return;
    active.child.kill();
    await active.done.catch(() => undefined);
  }
}
