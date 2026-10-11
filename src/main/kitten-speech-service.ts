import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { VoiceSpeechInput } from "@dani-dex/contracts/ipc";
import { VoiceModelService } from "./voice-model-service";

const MODEL_REVISION = "7a1db645b1f3ab9420761d87428e042b9cec3f26";
const ASSETS = [
  ["config.json", 688, "b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64"],
  ["kitten_tts_nano_v0_8.onnx", 56_767_095, "320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e"],
  ["voices.npz", 3_278_902, "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f"],
] as const;
const interrupted = () => new DOMException("Interrupted", "AbortError");

/** Resident offline synthesis; the renderer owns cancellable Chromium playback. */
export class KittenSpeechService {
  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: Interface | null = null;
  #waiting: ((line: string | null) => void) | null = null;
  #generation = 0;
  #id: string | null = null;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #models: VoiceModelService[];
  readonly #modelRoot: string;

  constructor(
    private readonly root: string,
    private readonly workerPath: string,
  ) {
    this.#modelRoot = join(root, "model", "models--KittenML--kitten-tts-nano-0.8", "snapshots", MODEL_REVISION);
    this.#models = ASSETS.map(
      ([name, expectedBytes, expectedSha256]) =>
        new VoiceModelService({
          modelPath: join(this.#modelRoot, name),
          downloadUrl: null,
          expectedBytes,
          expectedSha256,
        }),
    );
  }

  /** Load offline assets before voice capture, without synthesizing or playing invented speech. */
  prepare(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Local speech is closed."));
    const generation = this.#generation;
    const work = this.#queue.then(async () => {
      if (this.#disposed || generation !== this.#generation) throw interrupted();
      await this.#prepare(generation);
    });
    this.#queue = work.catch(() => undefined);
    return work;
  }

  speak(input: VoiceSpeechInput): Promise<Uint8Array> {
    if (this.#disposed) return Promise.reject(new Error("Local speech is closed."));
    const generation = ++this.#generation;
    this.#id = input.id;
    this.#cancelActive();
    const work = this.#queue
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.#generation || this.#disposed) throw interrupted();
        let dir: string | undefined;
        try {
          await this.#prepare(generation);
          if (generation !== this.#generation || this.#disposed) throw interrupted();
          dir = await mkdtemp(join(tmpdir(), "dani-kitten-"));
          const path = join(dir, "reply.wav");
          const result = JSON.parse(
            await this.#response(() => {
              const child = this.#child;
              if (!child) throw new Error("Kitten speech worker stopped.");
              child.stdin.write(`${JSON.stringify({ text: input.text, path })}\n`);
            }),
          );
          if (generation !== this.#generation || this.#disposed) throw interrupted();
          if (result.ok !== true) throw new Error("Kitten could not synthesize this reply.");
          return new Uint8Array(await readFile(path));
        } catch (error) {
          if (generation !== this.#generation || this.#disposed) throw interrupted();
          this.#closeWorker();
          throw error;
        } finally {
          if (dir) await rm(dir, { recursive: true, force: true });
          if (generation === this.#generation) this.#id = null;
        }
      });
    this.#queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  async stop(id: string): Promise<void> {
    if (this.#id !== id) return;
    this.#generation += 1;
    this.#id = null;
    this.#cancelActive();
    await this.#queue;
  }

  async shutdown(): Promise<void> {
    this.#disposed = true;
    this.#generation += 1;
    this.#id = null;
    this.#cancelActive();
    this.#closeWorker();
    await this.#queue;
  }

  #cancelActive(): void {
    // A cancelled inference must not block the next turn or produce a late wave file.
    if (this.#waiting) this.#closeWorker();
  }

  #closeWorker(): void {
    const child = this.#child;
    this.#child = null;
    this.#lines?.close();
    this.#lines = null;
    this.#waiting?.(null);
    this.#waiting = null;
    child?.kill();
  }

  async #prepare(generation: number): Promise<void> {
    if (this.#child) return;
    for (const model of this.#models) {
      if ((await model.getStatus()).phase !== "ready")
        throw new Error("Kitten speech assets are missing or failed verification. Prepare the local speech runtime.");
    }
    if (generation !== this.#generation || this.#disposed) throw interrupted();
    const child = spawn(join(this.root, "venv", "bin", "python"), [this.workerPath, this.#modelRoot], {
      stdio: "pipe",
      env: { ...process.env, HF_HUB_OFFLINE: "1", OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2" },
    });
    this.#child = child;
    child.stderr.resume();
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => this.#waiting?.(line));
    child.once("error", () => this.#waiting?.(null));
    child.once("close", () => {
      if (this.#child === child) this.#closeWorker();
    });
    try {
      const ready = JSON.parse(await this.#response());
      if (ready.ready !== true) throw new Error("Kitten speech could not start.");
    } catch (error) {
      this.#closeWorker();
      throw error;
    }
  }

  #response(send?: () => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const finish = (line: string | null) => {
        clearTimeout(timer);
        if (this.#waiting === finish) this.#waiting = null;
        if (line === null) reject(new Error("Kitten speech worker stopped."));
        else resolve(line);
      };
      const timer = setTimeout(() => {
        finish(null);
        this.#closeWorker();
      }, 30_000);
      this.#waiting = finish;
      try {
        send?.();
      } catch {
        finish(null);
      }
    });
  }
}
