import { type ChildProcess, spawn } from "node:child_process";
import { availableParallelism } from "node:os";

interface Session {
  child: ChildProcess;
  ready: Promise<void>;
  closed: Promise<void>;
  rejectReady: (e: Error) => void;
  pending: { resolve: (text: string) => void; reject: (e: Error) => void } | null;
}
/** Private resident weights, fresh inference state per utterance, no listener. */
export class ResidentWhisper {
  #session: Session | null = null;
  #closing: Promise<void> = Promise.resolve();
  constructor(
    private readonly executable: string,
    private readonly model: string,
    private readonly vad: string,
    private readonly inferenceTimeoutMs = 15_000,
  ) {}
  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const abort = () => this.stop(new DOMException("Interrupted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.start();
      signal?.throwIfAborted();
    } catch (e) {
      await this.#closing;
      throw e;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async transcribe(
    audio: Uint8Array,
    context: number,
    language: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const abort = () => this.stop(new DOMException("Interrupted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => this.stop(new Error("Voice transcription timed out.")), this.inferenceTimeoutMs);
    try {
      await this.start();
      signal.throwIfAborted();
      const session = this.#session;
      if (!session) throw new Error("Local voice worker stopped.");
      if (session.pending) throw new Error("A voice transcription is already in progress.");
      const samples = (audio.byteLength - 44) / 2;
      if (!Number.isInteger(samples) || samples < 1 || samples > 480000 || context < 50 || context > 1500)
        throw new Error("Invalid resident voice audio.");
      const payload = Buffer.alloc(12 + samples * 4);
      payload.writeUInt32LE(samples, 0);
      payload.writeUInt32LE(context, 4);
      payload.writeUInt32LE(language === "en" ? 1 : language === "hi" ? 2 : language === "bn" ? 3 : 0, 8);
      const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
      for (let i = 0; i < samples; i++) payload.writeFloatLE(view.getInt16(44 + i * 2, true) / 32768, 12 + i * 4);
      return await new Promise<string>((resolve, reject) => {
        session.pending = { resolve, reject };
        session.child.stdin?.write(payload, (e) => {
          if (e && this.#session === session) this.stop(new Error("Local voice worker could not receive audio."));
        });
      });
    } catch (e) {
      await this.#closing;
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  private async start(): Promise<void> {
    await this.#closing;
    if (this.#session) return this.#session.ready;
    const ready = Promise.withResolvers<void>(),
      closed = Promise.withResolvers<void>();
    // Attach the rejection handler immediately: a crash during startup must never be unhandled.
    void ready.promise.catch(() => undefined);
    const child = spawn(this.executable, [this.model, this.vad, String(Math.min(8, availableParallelism()))], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const session: Session = {
      child,
      ready: ready.promise,
      closed: closed.promise,
      rejectReady: ready.reject,
      pending: null,
    };
    this.#session = session;
    let buffer = "",
      initialized = false;
    const fail = () => {
      if (this.#session === session) this.stop(new Error("Local voice worker stopped."));
    };
    const timer = setTimeout(() => {
      if (this.#session === session) this.stop(new Error("Local voice worker could not start."));
    }, 15000);
    child.on("error", fail);
    child.stdin?.on("error", fail);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.#session !== session) return;
      buffer += chunk;
      if (buffer.length > 100000) {
        fail();
        return;
      }
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!initialized && line === "READY") {
          initialized = true;
          clearTimeout(timer);
          ready.resolve();
        } else {
          try {
            const text = JSON.parse(line);
            if (!initialized || typeof text !== "string" || !session.pending) throw new Error();
            const pending = session.pending;
            session.pending = null;
            pending.resolve(text.trim());
          } catch {
            fail();
            return;
          }
        }
        end = buffer.indexOf("\n");
      }
    });
    child.once("close", () => {
      clearTimeout(timer);
      if (this.#session === session) fail();
      closed.resolve();
    });
    return ready.promise;
  }
  stop(error = new Error("Local voice worker stopped.")): void {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    session.rejectReady(error);
    session.pending?.reject(error);
    session.pending = null;
    this.#closing = session.closed;
    session.child.kill();
    const timer = setTimeout(() => session.child.kill("SIGKILL"), 1000);
    timer.unref();
    session.child.once("close", () => clearTimeout(timer));
  }
}
