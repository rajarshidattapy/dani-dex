// @vitest-environment node

import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceModelService } from "./voice-model-service";
import {
  VoiceTranscriptionService,
  whisperAudioContextForWav,
  whistleSupportsWav,
} from "./voice-transcription-service";
import { WhistleService } from "./whistle-service";

const roots: string[] = [];
const services: VoiceTranscriptionService[] = [];
const ready = { phase: "ready", progress: 100, message: null } as const;

beforeEach(() => {
  // Model integrity/download behavior has its own real-I/O boundary tests.
  vi.spyOn(VoiceModelService.prototype, "prepare").mockResolvedValue(ready);
  vi.spyOn(VoiceModelService.prototype, "getStatus").mockResolvedValue(ready);
});

afterEach(async () => {
  for (const service of services.splice(0)) service.shutdown();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wav(samples: number): Uint8Array {
  const audio = new Uint8Array(44 + samples * 2);
  const view = new DataView(audio.buffer);
  const text = new TextEncoder();
  audio.set(text.encode("RIFF"), 0);
  view.setUint32(4, audio.byteLength - 8, true);
  audio.set(text.encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  audio.set(text.encode("data"), 36);
  view.setUint32(40, samples * 2, true);
  return audio;
}

async function fixture(whistleRoot?: string): Promise<{ root: string; service: VoiceTranscriptionService }> {
  const root = await mkdtemp(join(tmpdir(), "dani-dex-voice-process-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  const executable = join(root, "bin", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  // This real child tests process lifetime with file barriers, not Whisper inference quality.
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const input = process.argv[process.argv.indexOf("--file") + 1];
const output = process.argv[process.argv.indexOf("--output-file") + 1];
if (fs.existsSync(root + "/hold")) {
  const watcher = fs.watch(root, () => {
    if (fs.existsSync(root + "/release")) {
      watcher.close(); process.exit(0);
    }
  });
  process.on("SIGTERM", () => fs.writeFileSync(root + "/terminated", "received"));
  fs.writeFileSync(root + "/pid", String(process.pid));
  fs.writeFileSync(root + "/input", input);
  fs.writeFileSync(root + "/started", "ready");
} else {
  fs.writeFileSync(output + ".txt", "Completed provider result.");
}
`,
  );
  await chmod(executable, 0o755);
  await writeFile(join(root, "bin", process.platform === "win32" ? "voice-vad.exe" : "voice-vad"), "fixture");
  const service = new VoiceTranscriptionService({
    resourcesRoot: root,
    whistleRoot,
    modelPath: join(root, "model.bin"),
    modelDownloadUrl: null,
    vadModelPath: join(root, "vad.bin"),
    vadModelDownloadUrl: null,
  });
  services.push(service);
  return { root, service };
}

describe("Whisper audio coverage", () => {
  it.each([1, 1600, 16000, 48001, 159999, 447999])("covers every recorded sample for %i samples", (samples) => {
    const context = whisperAudioContextForWav(wav(samples));
    expect(context * 320).toBeGreaterThanOrEqual(samples);
    expect(context).toBeLessThan(1500);
  });

  it("keeps full context for long audio and WAVs whose duration cannot be verified", () => {
    expect(whisperAudioContextForWav(wav(480000))).toBe(1500);
    expect(whisperAudioContextForWav(new Uint8Array(8))).toBe(1500);
    const inconsistent = wav(16000);
    new DataView(inconsistent.buffer).setUint32(40, 4, true);
    expect(whisperAudioContextForWav(inconsistent)).toBe(1500);
  });
});

describe.skipIf(process.platform === "win32")("VoiceTranscriptionService provider process", () => {
  it("waits for cancelled child closure, removes input files, then accepts a replacement", async () => {
    const { root, service } = await fixture();
    await writeFile(join(root, "hold"), "hold");
    const controller = new AbortController();
    const outcome = service.transcribe(wav(16000), controller.signal).catch((error: Error) => error);
    await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true), { timeout: 5000 });
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    const inputPath = await readFile(join(root, "input"), "utf8");
    controller.abort();
    await vi.waitFor(() => expect(existsSync(join(root, "terminated"))).toBe(true));
    expect(existsSync(inputPath)).toBe(true);
    await expect(service.transcribe(wav(16000), new AbortController().signal)).rejects.toThrow("already in progress");
    await writeFile(join(root, "release"), "release");
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(dirname(inputPath))).toBe(false);
    await rm(join(root, "hold"));
    await expect(service.transcribe(wav(16000), new AbortController().signal)).resolves.toEqual({
      text: "Completed provider result.",
    });
  });

  it("does not keep the service busy after preparation rejects", async () => {
    const { service } = await fixture();
    vi.mocked(VoiceModelService.prototype.prepare).mockRejectedValueOnce(new Error("Preparation failed"));
    await expect(service.transcribe(wav(16000), new AbortController().signal)).rejects.toThrow("could not transcribe");
    await expect(service.transcribe(wav(16000), new AbortController().signal)).resolves.toEqual({
      text: "Completed provider result.",
    });
  });

  it("releases ownership after a failed native process and allows the next turn", async () => {
    const { root, service } = await fixture();
    const executable = join(root, "bin", "whisper-cli");
    const workingRuntime = await readFile(executable);
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stderr.write('private native diagnostics'); process.exit(7);\n",
    );
    await expect(service.transcribe(wav(16000), new AbortController().signal)).rejects.toThrow("could not transcribe");
    await writeFile(executable, workingRuntime);
    await expect(service.transcribe(wav(16000), new AbortController().signal)).resolves.toEqual({
      text: "Completed provider result.",
    });
  });

  it("waits for cancelled preparation cleanup before allowing another request", async () => {
    const { service } = await fixture();
    const preparation = Promise.withResolvers<typeof ready>();
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    vi.mocked(VoiceModelService.prototype.prepare).mockImplementationOnce((signal) => {
      signal?.addEventListener("abort", () => stopped.resolve(), {
        once: true,
      });
      started.resolve();
      return preparation.promise;
    });
    const controller = new AbortController();
    const outcome = service.transcribe(wav(16000), controller.signal).catch((error: Error) => error);
    await started.promise;
    controller.abort();
    await stopped.promise;
    await expect(service.transcribe(wav(16000), new AbortController().signal)).rejects.toThrow("already in progress");
    preparation.resolve(ready);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await expect(service.transcribe(wav(16000), new AbortController().signal)).resolves.toEqual({
      text: "Completed provider result.",
    });
  });

  it("shutdown stops the owned child and a closed request does not block restart", async () => {
    const { root, service } = await fixture();
    await writeFile(join(root, "hold"), "hold");
    const outcome = service.transcribe(wav(16000), new AbortController().signal).catch((error: Error) => error);
    await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true), { timeout: 5000 });
    service.shutdown();
    await vi.waitFor(() => expect(existsSync(join(root, "terminated"))).toBe(true));
    await writeFile(join(root, "release"), "release");
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await rm(join(root, "hold"));
    await expect(service.transcribe(wav(16000), new AbortController().signal)).resolves.toEqual({
      text: "Completed provider result.",
    });
  });

  it("does not report ready when the VAD asset or runtime is missing", async () => {
    const { root, service } = await fixture();
    vi.mocked(VoiceModelService.prototype.getStatus).mockResolvedValueOnce(ready).mockResolvedValueOnce({
      phase: "missing",
      progress: null,
      message: null,
    });
    expect(await service.getModelStatus()).toMatchObject({
      phase: "missing",
    });
    await rm(join(root, "bin", "voice-vad"));
    expect(await service.getModelStatus()).toMatchObject({ phase: "error" });
  });
});

describe("Whistle audio routing boundary", () => {
  it("uses Whistle up to exactly 30 seconds and Whisper after that", () => {
    expect(whistleSupportsWav(wav(480_000))).toBe(true);
    expect(whistleSupportsWav(wav(480_001))).toBe(false);
    expect(whistleSupportsWav(wav(1_920_000))).toBe(false);
  });
  it("never routes a noncanonical or truncated WAV to Needle", () => {
    expect(whistleSupportsWav(new Uint8Array(8))).toBe(false);
    const invalidHeaders: ReadonlyArray<readonly [number, number]> = [
      [4, 0],
      [20, 2],
      [22, 2],
      [24, 48_000],
      [28, 0],
      [32, 4],
      [34, 8],
      [40, 2],
    ];
    for (const [offset, value] of invalidHeaders) {
      const inconsistent = wav(16_000);
      new DataView(inconsistent.buffer).setUint32(offset, value, true);
      expect(whistleSupportsWav(inconsistent)).toBe(false);
    }
  });
});

describe.skipIf(process.platform === "win32")("Whistle to Whisper integration", () => {
  it("preserves long dictation using Whisper without passing it to Needle", async () => {
    vi.spyOn(WhistleService, "available").mockReturnValue(true);
    vi.spyOn(WhistleService.prototype, "prepare").mockResolvedValue(undefined);
    const needle = vi.spyOn(WhistleService.prototype, "transcribe").mockResolvedValue({ text: "short result" });
    const { service } = await fixture("fixture-root");
    await expect(service.transcribe(wav(480_001), new AbortController().signal)).resolves.toEqual({
      text: "Completed provider result.",
    });
    expect(needle).not.toHaveBeenCalled();
    await expect(service.transcribe(wav(16_000), new AbortController().signal)).resolves.toEqual({
      text: "short result",
    });
    expect(needle).toHaveBeenCalledOnce();
  });

  it("bypasses Whistle for unsupported languages or the explicit Whisper choice", async () => {
    vi.spyOn(WhistleService, "available").mockReturnValue(true);
    vi.spyOn(WhistleService.prototype, "prepare").mockResolvedValue(undefined);
    const needle = vi.spyOn(WhistleService.prototype, "transcribe").mockResolvedValue({ text: "short result" });
    const { service } = await fixture("fixture-root");
    for (const language of ["hi", "bn"] as const) {
      await expect(
        service.transcribe(wav(16_000), new AbortController().signal, {
          language,
        }),
      ).resolves.toEqual({ text: "Completed provider result." });
    }
    await service.transcribe(wav(16_000), new AbortController().signal, {
      language: "en",
      engine: "whisper",
    });
    expect(needle).not.toHaveBeenCalled();
    await service.transcribe(wav(16_000), new AbortController().signal, {
      language: "en",
    });
    expect(needle).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(AbortSignal), "en");
  });
});

it("stores local QA audio only when the host explicitly supplies a diagnostic root", async () => {
  const { root } = await fixture();
  const diagnosticRoot = join(root, "diagnostic");
  const service = new VoiceTranscriptionService({
    resourcesRoot: root,
    modelPath: join(root, "model.bin"),
    modelDownloadUrl: null,
    vadModelPath: join(root, "vad.bin"),
    vadModelDownloadUrl: null,
    diagnosticRoot,
  });
  services.push(service);
  const audio = wav(16000);
  await service.transcribe(audio, new AbortController().signal, { engine: "whisper", language: "en" });
  const files = await (await import("node:fs/promises")).readdir(diagnosticRoot);
  expect(files.filter((f) => f.endsWith(".wav"))).toHaveLength(1);
  expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(1);
  const audioFile = files.find((f) => f.endsWith(".wav"));
  if (!audioFile) throw new Error("Missing captured audio");
  expect(new Uint8Array(await readFile(join(diagnosticRoot, audioFile)))).toEqual(audio);
});
