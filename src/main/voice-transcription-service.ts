import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "@dani-dex/contracts/input-limits";
import type { VoiceModelStatus, VoiceTranscriptionResult } from "@dani-dex/contracts/ipc";
import { isString } from "@dani-dex/contracts/runtime-values";
import { createDaniDexLogger } from "@dani-dex/logging";

import { ResidentWhisper } from "./resident-whisper";
import { VoiceModelService, WHISPER_VAD_MODEL_BYTES, WHISPER_VAD_MODEL_SHA256 } from "./voice-model-service";
import { WhistleService } from "./whistle-service";

const logger = createDaniDexLogger("voice-transcription-service");

const TRANSCRIPTION_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 1_000;

interface VoiceTranscriptionEvents {
  modelStatus: [status: VoiceModelStatus];
}

const RUNTIME_UNAVAILABLE_MESSAGE =
  process.platform === "darwin" || process.platform === "win32"
    ? "The local voice runtime is not installed. Run `bun run voice:prepare-runtime`, then try voice again."
    : "Local voice transcription is not available on this platform.";

interface VoiceTranscriptionServiceOptions {
  resourcesRoot: string;
  /** Explicit development-only local QA directory, never supplied by the renderer. */
  diagnosticRoot?: string;
  whistleRoot?: string;
  modelPath: string;
  modelDownloadUrl: string | null;
  vadModelPath: string;
  vadModelDownloadUrl: string | null;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class VoiceTranscriptionService extends EventEmitter<VoiceTranscriptionEvents> {
  private readonly diagnosticRoot: string | undefined;
  private readonly resident: ResidentWhisper | null;
  private readonly whistle: WhistleService | null;
  private activeChild: ChildProcess | null = null;
  private activeRequest: AbortController | null = null;
  private readonly executable: string;
  private readonly model: VoiceModelService;
  private readonly vadModel: VoiceModelService;
  private readonly vadExecutable: string;
  private whisperStatus: VoiceModelStatus = {
    phase: "missing",
    progress: null,
    message: null,
  };
  private vadStatus: VoiceModelStatus = {
    phase: "missing",
    progress: null,
    message: null,
  };

  constructor(options: VoiceTranscriptionServiceOptions) {
    super();
    this.diagnosticRoot = options.diagnosticRoot;
    this.whistle =
      options.whistleRoot && WhistleService.available(options.whistleRoot)
        ? new WhistleService(options.whistleRoot)
        : null;
    this.executable = join(
      options.resourcesRoot,
      "bin",
      process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli",
    );
    const worker = join(options.resourcesRoot, "bin", process.platform === "win32" ? "voice-stt.exe" : "voice-stt");
    this.resident = existsSync(worker) ? new ResidentWhisper(worker, options.modelPath, options.vadModelPath) : null;
    this.model = new VoiceModelService({
      modelPath: options.modelPath,
      downloadUrl: options.modelDownloadUrl,
      fetch: options.fetch,
    });
    this.vadExecutable = join(
      options.resourcesRoot,
      "bin",
      process.platform === "win32" ? "voice-vad.exe" : "voice-vad",
    );
    this.vadModel = new VoiceModelService({
      modelPath: options.vadModelPath,
      downloadUrl: options.vadModelDownloadUrl,
      fetch: options.fetch,
      expectedBytes: WHISPER_VAD_MODEL_BYTES,
      expectedSha256: WHISPER_VAD_MODEL_SHA256,
    });
    this.model.on("status", (status) => {
      this.whisperStatus = status;
      this.emit("modelStatus", this.combinedStatus());
    });
    this.vadModel.on("status", (status) => {
      this.vadStatus = status;
      this.emit("modelStatus", this.combinedStatus());
    });
  }

  get vadModelPath(): string {
    return this.vadModel.modelPath;
  }

  async getModelStatus(): Promise<VoiceModelStatus> {
    const missing = this.runtimeMissing();
    if (missing) return missing;
    this.whisperStatus = this.whistle
      ? await this.whistle.prepare().then(
          () =>
            ({
              phase: "ready",
              progress: 100,
              message: null,
            }) satisfies VoiceModelStatus,
        )
      : await this.model.getStatus();
    this.vadStatus = await this.vadModel.getStatus();
    return this.combinedStatus();
  }

  async prepareModel(signal?: AbortSignal): Promise<VoiceModelStatus> {
    const missing = this.runtimeMissing();
    if (missing) return missing;
    this.whisperStatus = this.whistle
      ? await this.whistle.prepare(signal).then(
          () =>
            ({
              phase: "ready",
              progress: 100,
              message: null,
            }) satisfies VoiceModelStatus,
        )
      : await this.model.prepare(signal);
    signal?.throwIfAborted();
    if (this.whisperStatus.phase !== "ready") return this.combinedStatus();
    this.vadStatus = await this.vadModel.prepare(signal);
    signal?.throwIfAborted();
    if (this.resident && this.vadStatus.phase === "ready") {
      // Prepare resident Whisper before the microphone opens, not on the first spoken sentence.
      const whisper = await this.model.prepare(signal);
      if (whisper.phase !== "ready") return whisper;
      await this.resident.prepare(signal);
    }
    return this.combinedStatus();
  }

  async transcribe(
    audio: Uint8Array,
    signal: AbortSignal,
    options: { language?: "en" | "hi" | "bn"; engine?: "whisper" } = {},
  ): Promise<VoiceTranscriptionResult> {
    throwIfAborted(signal);
    if (this.activeRequest) throw new Error("A voice transcription is already in progress.");
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.activeRequest = request;
    let temporaryRoot: string | undefined;
    let unavailableMessage: string | undefined;
    const startedAt = Date.now();

    let diagnosticPath: string | undefined;
    const diagnostic = async (result: VoiceTranscriptionResult) => {
      if (diagnosticPath)
        await writeFile(
          `${diagnosticPath}.json`,
          JSON.stringify({
            startedAt,
            completedAt: Date.now(),
            elapsedMs: Date.now() - startedAt,
            language: options.language ?? "auto",
            engine: options.engine ?? "default",
            result,
          }),
          { mode: 0o600 },
        ).catch(() => undefined);
      return result;
    };
    try {
      if (this.diagnosticRoot) {
        try {
          await mkdir(this.diagnosticRoot, { recursive: true, mode: 0o700 });
          diagnosticPath = join(this.diagnosticRoot, `${startedAt}-${crypto.randomUUID()}`);
          await writeFile(`${diagnosticPath}.wav`, audio, { mode: 0o600 });
        } catch {
          diagnosticPath = undefined;
          logger.warn("Local voice QA capture could not be saved.");
        }
      }
      const modelStatus = await this.prepareModel(request.signal);
      throwIfAborted(request.signal);
      if (modelStatus.phase !== "ready") {
        unavailableMessage = modelStatus.message ?? "The voice model is unavailable.";
        throw new Error(unavailableMessage);
      }
      if (
        this.whistle &&
        options.engine !== "whisper" &&
        options.language !== "hi" &&
        options.language !== "bn" &&
        whistleSupportsWav(audio)
      ) {
        const result = await this.whistle.transcribe(audio, request.signal, options.language);
        logger.info(`Whistle transcription completed in ${Date.now() - startedAt}ms.`);
        return await diagnostic(result);
      }
      if (this.whistle) {
        const fallback = await this.model.prepare(request.signal);
        throwIfAborted(request.signal);
        if (fallback.phase !== "ready") throw new Error(fallback.message ?? "The fallback voice model is unavailable.");
      }
      const audioContext = whisperAudioContextForWav(audio);
      if (this.resident && audioContext < 1500) {
        const text = await this.resident.transcribe(audio, audioContext, options.language, request.signal);
        if (text.length > INPUT_LIMITS.messageText) throw new Error("The voice transcript is too long.");
        logger.info(`Resident voice transcription completed in ${Date.now() - startedAt}ms.`);
        return await diagnostic({ text });
      }
      temporaryRoot = await mkdtemp(join(tmpdir(), "dani-dex-voice-"));
      throwIfAborted(request.signal);
      const inputPath = join(temporaryRoot, "recording.wav");
      const outputPath = join(temporaryRoot, "transcript");
      await writeFile(inputPath, audio, { signal: request.signal });
      throwIfAborted(request.signal);
      await this.run(
        this.executable,
        [
          "--model",
          this.model.modelPath,
          "--file",
          inputPath,
          "--language",
          options.language ?? "auto",
          "--output-txt",
          "--output-file",
          outputPath,
          "--no-timestamps",
          "--no-gpu",
          "--threads",
          String(Math.min(8, availableParallelism())),
          "--audio-ctx",
          "1500",
          "--beam-size",
          "1",
          "--best-of",
          "1",
          "--no-fallback",
        ],
        request.signal,
      );
      const text = (
        await readFile(`${outputPath}.txt`, {
          encoding: "utf8",
          signal: request.signal,
        })
      ).trim();
      throwIfAborted(request.signal);
      if (text.length > INPUT_LIMITS.messageText) throw new Error("The voice transcript is too long.");
      logger.info(`Voice transcription completed in ${Date.now() - startedAt}ms.`);
      return await diagnostic({ text });
    } catch (error) {
      if (request.signal.aborted) throw abortError();
      if (unavailableMessage) throw new Error(unavailableMessage);
      logger.error(`Voice transcription failed after ${Date.now() - startedAt}ms.`, errorCategory(error));
      throw userFacingError(error);
    } finally {
      try {
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      } finally {
        signal.removeEventListener("abort", abort);
        if (this.activeRequest === request) this.activeRequest = null;
      }
    }
  }

  shutdown(): void {
    this.activeRequest?.abort();
    this.resident?.stop();
    this.whistle?.shutdown();
    this.model.shutdown();
    this.vadModel.shutdown();
  }

  /**
   * Return an error when either required native executable is absent. The status does not
   * claim that model assets alone make full-duplex voice available.
   */
  private runtimeMissing(): Promise<VoiceModelStatus> | null {
    if (existsSync(this.executable) && existsSync(this.vadExecutable)) return null;
    const status: VoiceModelStatus = {
      phase: "error",
      progress: null,
      message: RUNTIME_UNAVAILABLE_MESSAGE,
    };
    this.emit("modelStatus", status);
    return Promise.resolve(status);
  }

  private combinedStatus(): VoiceModelStatus {
    return {
      ...(this.whisperStatus.phase === "ready" ? this.vadStatus : this.whisperStatus),
    };
  }

  private run(executable: string, arguments_: string[], signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const child = spawn(executable, arguments_, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.activeChild = child;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    };
    const abort = () => stop(abortError());
    signal.addEventListener("abort", abort, { once: true });
    // Drain diagnostics, but do not retain paths, transcript text, or other private native output.
    child.stderr?.resume();
    const timer = setTimeout(() => stop(new Error("Voice transcription timed out.")), TRANSCRIPTION_TIMEOUT_MS);
    child.once("error", (error) => {
      failure ??= error;
    });
    // Only close proves that the process and its stdio are gone. Keep ownership until then.
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (this.activeChild === child) this.activeChild = null;
      if (signal.aborted) reject(abortError());
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error("Whisper inference failed."));
    });
    if (signal.aborted) abort();
    return promise;
  }
}

function abortError(): Error {
  const error = new Error("Voice transcription was stopped.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/**
 * The pinned encoder uses two 10 ms mel frames per context token. Keep one second of
 * padding beyond every recorded sample, and use the full context for long or noncanonical WAVs.
 */
export function whisperAudioContextForWav(audio: Uint8Array): number {
  if (audio.byteLength < 44) return 1500;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  // Big-endian reads compare the four literal RIFF chunk bytes without string allocation.
  const samples = view.getUint32(40, true) / 2;
  if (
    view.getUint32(0, false) !== 0x52494646 ||
    view.getUint32(8, false) !== 0x57415645 ||
    view.getUint32(4, true) !== audio.byteLength - 8 ||
    view.getUint32(12, false) !== 0x666d7420 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== 16000 ||
    view.getUint32(28, true) !== 32000 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(36, false) !== 0x64617461 ||
    view.getUint32(40, true) !== audio.byteLength - 44 ||
    !Number.isInteger(samples)
  )
    return 1500;
  return Math.min(1500, Math.max(50, Math.ceil(samples / 320) + 50));
}

function errorCategory(error: unknown): "unknown" | "runtime-unavailable" | "timeout" | "inference-failed" {
  if (!(error instanceof Error)) return "unknown";
  if (errorCode(error) === "ENOENT") return "runtime-unavailable";
  if (error.message.includes("timed out")) return "timeout";
  return "inference-failed";
}

function userFacingError(error: unknown): Error {
  if (error instanceof Error && error.message.includes("timed out")) return error;
  if (error instanceof Error && errorCode(error) === "ENOENT") {
    return new Error("Local voice transcription is unavailable. Run `bun run voice:prepare` and restart Dani-Dex.");
  }
  return new Error("Dani-Dex could not transcribe this recording.");
}

function errorCode(error: Error): string | undefined {
  const code = "code" in error ? error.code : undefined;
  return isString(code) ? code : undefined;
}

/** Needle's pinned speech API accepts at most 30 seconds per call. Long dictation stays on Whisper. */
export function whistleSupportsWav(audio: Uint8Array): boolean {
  if (audio.byteLength < 44 || audio.byteLength > 960_044) return false;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  return (
    view.getUint32(0, false) === 0x52494646 &&
    view.getUint32(4, true) === audio.byteLength - 8 &&
    view.getUint32(8, false) === 0x57415645 &&
    view.getUint32(12, false) === 0x666d7420 &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 16_000 &&
    view.getUint32(28, true) === 32_000 &&
    view.getUint16(32, true) === 2 &&
    view.getUint16(34, true) === 16 &&
    view.getUint32(36, false) === 0x64617461 &&
    view.getUint32(40, true) === audio.byteLength - 44 &&
    (audio.byteLength - 44) % 2 === 0
  );
}
