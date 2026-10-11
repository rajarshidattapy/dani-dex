import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { VoiceModelService } from "./voice-model-service";

export const WHISTLE_BYTES = 16_919_407;
export const WHISTLE_SHA256 = "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb";
const ENGINE_SHA256 = "3ecada76d4ae1c5d6fbba191d51f4319bd19cc6382af13c43da12c8cf23134fe";

/** One isolated, persistent process owns Needle's non-thread-safe speech state. */
export class WhistleService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private starting: Promise<void> | null = null;
  private pending: ((line: string | null) => void) | null = null;
  private busy = false;
  private stopping: Promise<void> | null = null;
  private readonly model: VoiceModelService;
  private readonly engine: VoiceModelService;

  constructor(private readonly root: string) {
    this.model = new VoiceModelService({
      modelPath: join(root, "model/whistle.cact"),
      downloadUrl: null,
      expectedBytes: WHISTLE_BYTES,
      expectedSha256: WHISTLE_SHA256,
    });
    this.engine = new VoiceModelService({
      modelPath: join(root, "bin/libneedle3.dylib"),
      downloadUrl: null,
      expectedBytes: 1_248_832,
      expectedSha256: ENGINE_SHA256,
    });
  }

  static available(root: string): boolean {
    return (
      process.platform === "darwin" &&
      process.arch === "x64" &&
      existsSync(join(root, "bin/whistle-worker")) &&
      existsSync(join(root, "bin/libneedle3.dylib")) &&
      existsSync(join(root, "model/whistle.cact"))
    );
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.stopping) await this.stopping;
    if ((await this.model.getStatus()).phase !== "ready" || (await this.engine.getStatus()).phase !== "ready") {
      throw new Error("The local Whistle assets failed verification.");
    }
    signal?.throwIfAborted();
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting ??= this.start(signal).finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    const child = spawn(
      join(this.root, "bin/whistle-worker"),
      [join(this.root, "bin/libneedle3.dylib"), this.model.modelPath],
      { stdio: "pipe", windowsHide: true },
    );
    this.child = child;
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      const pending = this.pending;
      this.pending = null;
      pending?.(line);
    });
    child.on("error", () => this.pending?.(null));
    child.once("close", () => {
      this.pending?.(null);
      this.pending = null;
      if (this.child === child) {
        this.child = null;
        this.lines?.close();
        this.lines = null;
      }
    });
    try {
      const ready = JSON.parse(await this.response(signal));
      if (ready.ready !== true) throw new Error("Whistle could not start.");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private response(signal?: AbortSignal, send?: () => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const finish = (line: string | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.pending === finish) this.pending = null;
        if (signal?.aborted) reject(new DOMException("Voice transcription was stopped.", "AbortError"));
        else if (line === null) reject(new Error("Whistle could not transcribe speech."));
        else resolve(line);
      };
      const abort = () => {
        finish(null);
        void this.stop();
      };
      const timer = setTimeout(() => {
        finish(null);
        void this.stop();
      }, 30_000);
      this.pending = finish;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else send?.();
    });
  }

  async transcribe(audio: Uint8Array, signal: AbortSignal, language?: "en"): Promise<{ text: string }> {
    if (this.busy) throw new Error("A voice transcription is already in progress.");
    this.busy = true;
    let root: string | undefined;
    try {
      await this.prepare(signal);
      root = await mkdtemp(join(tmpdir(), "dani-dex-whistle-"));
      const path = join(root, "recording.wav");
      await writeFile(path, audio, { signal, mode: 0o600 });
      const result = JSON.parse(
        await this.response(signal, () => {
          this.child?.stdin.write(`${path}\t${language ?? ""}\n`);
        }),
      );
      signal.throwIfAborted();
      if (result.error || typeof result.text !== "string" || result.text.length > 100_000) {
        throw new Error("Whistle could not transcribe speech.");
      }
      return { text: result.text.trim() };
    } catch (error) {
      if (signal.aborted) {
        await this.stop();
        throw new DOMException("Voice transcription was stopped.", "AbortError");
      }
      throw error;
    } finally {
      try {
        if (root) await rm(root, { recursive: true, force: true });
      } finally {
        this.busy = false;
      }
    }
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.stopping) return this.stopping;
    this.stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    }).finally(() => {
      this.stopping = null;
    });
    await this.stopping;
  }

  shutdown(): void {
    void this.stop();
    this.model.shutdown();
    this.engine.shutdown();
  }
}
