import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { VoiceModelStatus } from "@dani-dex/contracts/ipc";

export const WHISPER_MODEL_NAME = "ggml-base-q5_1.bin";
export const WHISPER_MODEL_BYTES = 59_707_625;
export const WHISPER_MODEL_SHA256 = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898";
export const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin";

export const WHISPER_VAD_MODEL_NAME = "ggml-silero-v6.2.0.bin";
export const WHISPER_VAD_MODEL_BYTES = 885_098;
export const WHISPER_VAD_MODEL_SHA256 = "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987";
export const WHISPER_VAD_MODEL_URL =
  "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin";

interface VoiceModelEvents {
  status: [status: VoiceModelStatus];
}

interface VoiceModelServiceOptions {
  modelPath: string;
  downloadUrl: string | null;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  expectedBytes?: number;
  expectedSha256?: string;
}

export class VoiceModelService extends EventEmitter<VoiceModelEvents> {
  readonly #modelPath: string;
  readonly #downloadUrl: string | null;
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #expectedBytes: number;
  readonly #expectedSha256: string;
  #status: VoiceModelStatus = { phase: "missing", progress: null, message: null };
  #preparation: Promise<VoiceModelStatus> | null = null;
  #abortController: AbortController | null = null;
  #verifiedFile: string | null = null;

  constructor(options: VoiceModelServiceOptions) {
    super();
    this.#modelPath = options.modelPath;
    this.#downloadUrl = options.downloadUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#expectedBytes = options.expectedBytes ?? WHISPER_MODEL_BYTES;
    this.#expectedSha256 = options.expectedSha256 ?? WHISPER_MODEL_SHA256;
  }

  get modelPath(): string {
    return this.#modelPath;
  }

  async getStatus(): Promise<VoiceModelStatus> {
    if (this.#status.phase === "downloading") return this.#copyStatus();
    const ready = await this.#isExpectedModel();
    this.#setStatus({ phase: ready ? "ready" : "missing", progress: ready ? 100 : null, message: null });
    return this.#copyStatus();
  }

  prepare(signal?: AbortSignal): Promise<VoiceModelStatus> {
    if (signal?.aborted) return Promise.reject(new DOMException("Model preparation was stopped.", "AbortError"));
    if (!this.#preparation) {
      const controller = new AbortController();
      this.#abortController = controller;
      this.#preparation = this.#prepare(controller.signal).finally(() => {
        this.#preparation = null;
        if (this.#abortController === controller) this.#abortController = null;
      });
    }
    if (!signal) return this.#preparation;
    const controller = this.#abortController;
    const abort = () => controller?.abort();
    signal.addEventListener("abort", abort, { once: true });
    return this.#preparation.finally(() => signal.removeEventListener("abort", abort));
  }

  shutdown(): void {
    this.#abortController?.abort();
  }

  async #prepare(signal: AbortSignal): Promise<VoiceModelStatus> {
    const partialPath = `${this.#modelPath}.part`;
    try {
      if (await this.#isExpectedModel(signal)) {
        signal.throwIfAborted();
        this.#setStatus({ phase: "ready", progress: 100, message: null });
        return this.#copyStatus();
      }
      signal.throwIfAborted();
      await rm(this.#modelPath, { force: true });
      signal.throwIfAborted();
      if (!this.#downloadUrl) {
        this.#setStatus({
          phase: "error",
          progress: null,
          message:
            "Local voice transcription assets are unavailable. Run `bun run voice:prepare` and restart Dani-Dex.",
        });
        return this.#copyStatus();
      }
      this.#setStatus({ phase: "downloading", progress: 0, message: null });
      await mkdir(dirname(this.#modelPath), { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      await rm(partialPath, { force: true });
      signal.throwIfAborted();
      const response = await this.#fetch(this.#downloadUrl, { signal });
      signal.throwIfAborted();
      if (!response.ok || !response.body) throw new Error(`download-status-${response.status}`);

      const hash = createHash("sha256");
      let receivedBytes = 0;
      let lastProgress = -1;
      const destination = await open(partialPath, "wx", 0o600);
      const reader = response.body.getReader();
      const abortRead = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abortRead, { once: true });
      try {
        signal.throwIfAborted();
        while (true) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > this.#expectedBytes) throw new Error("download-too-large");
          hash.update(value);
          let writtenBytes = 0;
          while (writtenBytes < value.byteLength) {
            signal.throwIfAborted();
            const result = await destination.write(value, writtenBytes, value.byteLength - writtenBytes);
            writtenBytes += result.bytesWritten;
          }
          const progress = Math.min(100, Math.floor((receivedBytes / this.#expectedBytes) * 100));
          if (progress !== lastProgress) {
            lastProgress = progress;
            this.#setStatus({ phase: "downloading", progress, message: null });
          }
        }
      } finally {
        signal.removeEventListener("abort", abortRead);
        await reader.cancel().catch(() => {});
        await destination.close();
      }
      signal.throwIfAborted();
      if (receivedBytes !== this.#expectedBytes || hash.digest("hex") !== this.#expectedSha256) {
        throw new Error("download-integrity-failed");
      }
      await rename(partialPath, this.#modelPath);
      signal.throwIfAborted();
      this.#setStatus({ phase: "ready", progress: 100, message: null });
    } catch {
      await rm(partialPath, { force: true });
      this.#setStatus({
        phase: "error",
        progress: null,
        message: signal.aborted
          ? "Voice model download was stopped."
          : "Could not download the voice model. Try again.",
      });
    }
    return this.#copyStatus();
  }

  async #isExpectedModel(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    this.#verifiedFile = existsSync(this.#modelPath) ? this.#verifiedFile : null;
    if (!existsSync(this.#modelPath)) return false;
    const before = await stat(this.#modelPath);
    const key = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    if (before.size !== this.#expectedBytes) {
      this.#verifiedFile = null;
      return false;
    }
    if (key === this.#verifiedFile) return true;
    const valid = await isExpectedModel(this.#modelPath, this.#expectedBytes, this.#expectedSha256, signal);
    const after = await stat(this.#modelPath);
    const afterKey = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
    this.#verifiedFile = valid && key === afterKey ? key : null;
    return this.#verifiedFile !== null;
  }

  #setStatus(status: VoiceModelStatus): void {
    this.#status = status;
    this.emit("status", this.#copyStatus());
  }

  #copyStatus(): VoiceModelStatus {
    return { ...this.#status };
  }
}

async function isExpectedModel(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!existsSync(path) || (await stat(path)).size !== expectedBytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex") === expectedSha256;
}
