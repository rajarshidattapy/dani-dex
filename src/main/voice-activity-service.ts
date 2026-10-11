import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import type { VoiceDetectionInput } from "@dani-dex/contracts/ipc";

type StartDetector = (executable: string, modelPath: string) => ChildProcess;
interface DetectionRequest {
  count: number;
  resolve: (probabilities: number[]) => void;
  reject: (error: Error) => void;
}
interface DetectionSession {
  id: string;
  child: ChildProcess;
  closed: Promise<void>;
  pending: DetectionRequest | null;
}

/** One private, resident Silero context for the owning voice call. No network listener. */
export class VoiceActivityService {
  #active: DetectionSession | null = null;
  #requested: string | null = null;
  #generation = 0;
  #disposed = false;
  readonly #executable: string;

  constructor(
    resourcesRoot: string,
    private readonly modelPath: string,
    private readonly startChild: StartDetector = (executable, model) =>
      spawn(executable, [model], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }),
  ) {
    this.#executable = join(resourcesRoot, "bin", process.platform === "win32" ? "voice-vad.exe" : "voice-vad");
  }

  async start(id: string): Promise<void> {
    if (this.#disposed) throw new Error("Local speech detection is closed.");
    const generation = ++this.#generation;
    this.#requested = id;
    const previous = this.#active;
    if (previous) await this.stop(previous.id);
    if (generation !== this.#generation || this.#disposed || this.#requested !== id) throw interrupted();
    const ready = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const child = this.startChild(this.#executable, this.modelPath);
    const session: DetectionSession = { id, child, closed: closed.promise, pending: null };
    this.#active = session;
    let buffer = "";
    let initialized = false;
    let failure: Error | null = null;
    const deadline = setTimeout(() => {
      failure = new Error("Local speech detection could not start.");
      child.kill("SIGKILL");
    }, 10_000);
    const fail = () => {
      failure = new Error("Local speech detection failed.");
      child.kill("SIGKILL");
    };
    child.stdin?.on("error", fail);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > 4_096) {
        fail();
        return;
      }
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!initialized && line === "READY") {
          initialized = true;
          clearTimeout(deadline);
          ready.resolve();
        } else {
          const pending = session.pending;
          const values = line.split(" ").map(Number);
          if (
            !initialized ||
            !pending ||
            values.length !== pending.count ||
            values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
          ) {
            fail();
            return;
          }
          session.pending = null;
          pending.resolve(values);
        }
        end = buffer.indexOf("\n");
      }
    });
    child.once("error", () => {
      failure = new Error("The local speech detection runtime is unavailable.");
    });
    child.once("close", () => {
      clearTimeout(deadline);
      const error =
        generation !== this.#generation || this.#disposed || this.#requested !== id
          ? interrupted()
          : (failure ?? new Error("Local speech detection stopped unexpectedly."));
      ready.reject(error);
      session.pending?.reject(error);
      session.pending = null;
      if (this.#active === session) this.#active = null;
      closed.resolve();
    });
    await ready.promise;
    if (generation !== this.#generation || this.#disposed || this.#requested !== id) {
      await this.stop(id);
      throw interrupted();
    }
  }

  detect(input: VoiceDetectionInput): Promise<number[]> {
    const session = this.#active;
    if (!session || session.id !== input.id || this.#requested !== input.id) return Promise.reject(interrupted());
    if (session.pending) return Promise.reject(new Error("A speech detection frame is already in progress."));
    const request = Promise.withResolvers<number[]>();
    session.pending = { count: input.samples.length / 512, resolve: request.resolve, reject: request.reject };
    const header = Buffer.alloc(4);
    header.writeUInt32LE(input.samples.length);
    session.child.stdin?.write(header);
    session.child.stdin?.write(Buffer.from(input.samples.buffer, input.samples.byteOffset, input.samples.byteLength));
    return request.promise;
  }

  async stop(id: string): Promise<void> {
    if (this.#requested === id) {
      this.#requested = null;
      this.#generation += 1;
    }
    const active = this.#active;
    if (active?.id !== id) return;
    active.child.kill("SIGKILL");
    await active.closed;
  }

  async shutdown(): Promise<void> {
    this.#disposed = true;
    this.#generation += 1;
    this.#requested = null;
    const active = this.#active;
    if (!active) return;
    active.child.kill("SIGKILL");
    await active.closed;
  }
}

function interrupted(): Error {
  return new DOMException("Interrupted", "AbortError");
}
