import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createDaniDexLogger } from "@dani-dex/logging";
import {
  VoiceModelService,
  WHISPER_VAD_MODEL_BYTES,
  WHISPER_VAD_MODEL_NAME,
  WHISPER_VAD_MODEL_SHA256,
  WHISPER_VAD_MODEL_URL,
} from "../src/main/voice-model-service";

/** The slices the universal whisper-cli carries. Declared before the build below runs at load. */
const MAC_ARCHITECTURES = ["arm64", "x86_64"] as const;

const logger = createDaniDexLogger("prepare-whisper");

const WHISPER_CPP_COMMIT = "86c40c3bd6fc86f1187fb751d111b49e0fc18e84";
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MODEL_NAME = "ggml-base-q5_1.bin";
const MODEL_BYTES = 59_707_625;
const MODEL_SHA256 = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898";
const buildRoot = resolve(".dani-dex-build/whisper");
const sourceRoot = join(buildRoot, "source");
const cmakeRoot = join(buildRoot, "cmake");
const binaryRoot = join(buildRoot, "bin");
const vadTargetInclude = join(buildRoot, "voice-vad.cmake");
const modelRoot = join(buildRoot, "model");
const modelPath = join(modelRoot, MODEL_NAME);
const executableName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
const sttExecutableName = process.platform === "win32" ? "voice-stt.exe" : "voice-stt";
const vadExecutableName = process.platform === "win32" ? "voice-vad.exe" : "voice-vad";
const runtimeOnly = process.argv.includes("--runtime-only");

if (process.platform !== "darwin" && process.platform !== "win32") {
  throw new Error("Voice assets can currently be prepared only on macOS or Windows.");
}

requireCommand("cmake", ["--version"]);
requireCommand("tar", ["--version"]);
await Promise.all([
  mkdir(binaryRoot, { recursive: true }),
  ...(runtimeOnly ? [] : [mkdir(modelRoot, { recursive: true })]),
]);
if (!runtimeOnly) {
  // Keep existing model caches when changing the default voice model.
  await prepareModel();
  const vad = new VoiceModelService({
    modelPath: join(modelRoot, WHISPER_VAD_MODEL_NAME),
    downloadUrl: WHISPER_VAD_MODEL_URL,
    expectedBytes: WHISPER_VAD_MODEL_BYTES,
    expectedSha256: WHISPER_VAD_MODEL_SHA256,
  });
  const status = await vad.prepare();
  if (status.phase !== "ready") throw new Error(status.message ?? "The VAD model is unavailable.");
}
await prepareSource();
await prepareAudioContextPatch();
const cmakePath = (path: string) => path.replaceAll("\\", "/").replaceAll('"', '\\"');
// CMAKE_PROJECT_INCLUDE preserves the pinned source root and existing architecture build caches.
await writeFile(
  vadTargetInclude,
  [
    "if(NOT TARGET voice-vad)",
    `  add_executable(voice-vad "${cmakePath(resolve("tools/native-voice/voice-vad.cpp"))}")`,
    "  target_compile_features(voice-vad PRIVATE cxx_std_17)",
    "  target_link_libraries(voice-vad PRIVATE whisper)",
    '  set_target_properties(voice-vad PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")',
    "endif()",
    "if(NOT TARGET voice-stt)",
    `  add_executable(voice-stt "${cmakePath(resolve("tools/native-voice/voice-stt.cpp"))}")`,
    "  target_compile_features(voice-stt PRIVATE cxx_std_17)",
    "  target_link_libraries(voice-stt PRIVATE whisper)",
    '  set_target_properties(voice-stt PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")',
    "endif()",
    "",
  ].join("\n"),
);
buildExecutable();
logger.info(`Prepared Whisper voice assets in ${buildRoot}`);

async function prepareModel(): Promise<void> {
  if (await isExpectedModel()) return;
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${MODEL_NAME}`;
  logger.info(`Downloading ${MODEL_NAME}…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download the Whisper model (${response.status}).`);
  await writeFile(modelPath, Buffer.from(await response.arrayBuffer()));
  if (!(await isExpectedModel())) {
    await rm(modelPath, { force: true });
    throw new Error("The downloaded Whisper model failed its size or SHA-256 check.");
  }
}

async function isExpectedModel(): Promise<boolean> {
  if (!existsSync(modelPath) || (await stat(modelPath)).size !== MODEL_BYTES) return false;
  return (await sha256(modelPath)) === MODEL_SHA256;
}

async function prepareSource(): Promise<void> {
  const marker = join(sourceRoot, ".dani-dex-whisper-commit");
  if (existsSync(marker)) {
    const value = await readFile(marker, "utf8");
    if (value.trim() === WHISPER_CPP_COMMIT) return;
  }
  await Promise.all([
    rm(sourceRoot, { recursive: true, force: true }),
    rm(cmakeRoot, { recursive: true, force: true }),
  ]);
  await mkdir(sourceRoot, { recursive: true });
  const archivePath = join(buildRoot, `${WHISPER_CPP_COMMIT}.tar.gz`);
  const response = await fetch(`https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_CPP_COMMIT}.tar.gz`);
  if (!response.ok) throw new Error(`Unable to download whisper.cpp (${response.status}).`);
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", sourceRoot], { stdio: "inherit" });
  await Promise.all([writeFile(marker, `${WHISPER_CPP_COMMIT}\n`), rm(archivePath, { force: true })]);
}

/**
 * The exact pinned source set audio_ctx after auto language detection. Move the existing,
 * bounded assignment before that first encode; the model, language and audio remain unchanged.
 * Accept only the original source fingerprint or this same reversible patch.
 */
async function prepareAudioContextPatch(): Promise<void> {
  const path = join(sourceRoot, "src", "whisper.cpp");
  const fingerprint = "a884ff3eb3bbf7558958c4d06a299cd8d97d87a7d5c7aac9138b8ff6a2ef04d7";
  const block = [
    "    // overwrite audio_ctx, max allowed is hparams.n_audio_ctx",
    "    if (params.audio_ctx > whisper_n_audio_ctx(ctx)) {",
    '        WHISPER_LOG_ERROR("%s: audio_ctx is larger than the maximum allowed (%d > %d)\\n", __func__, params.audio_ctx, whisper_n_audio_ctx(ctx));',
    "        return -5;",
    "    }",
    "    state->exp_n_audio_ctx = params.audio_ctx;",
    "",
    "",
  ].join("\n");
  const earlyAnchor = "    // auto-detect language if not specified";
  const lateAnchor = "    // these tokens determine the task that will be performed";
  const current = await readFile(path, "utf8");
  let original = current;
  if (createHash("sha256").update(original).digest("hex") !== fingerprint) {
    original = current.replace(block + earlyAnchor, earlyAnchor).replace(lateAnchor, block + lateAnchor);
    if (createHash("sha256").update(original).digest("hex") !== fingerprint) {
      throw new Error("The pinned Whisper source fingerprint does not match the audio context patch.");
    }
  }
  const patched = original.replace(block, "").replace(earlyAnchor, block + earlyAnchor);
  if (patched !== current) await writeFile(path, patched);
  await writeFile(
    join(sourceRoot, ".dani-dex-audio-context-patch"),
    [
      `upstream=${WHISPER_CPP_COMMIT}`,
      `original-sha256=${fingerprint}`,
      `patched-sha256=${createHash("sha256").update(patched).digest("hex")}`,
      "",
    ].join("\n"),
  );
}

/**
 * On macOS the executable is universal: one arm64 build and one x86_64 build joined with `lipo`, so
 * local voice works on Intel Macs as well as Apple Silicon. Each slice is its own CMake build rather
 * than one `CMAKE_OSX_ARCHITECTURES="arm64;x86_64"` build, because ggml picks CPU features per
 * architecture at configure time.
 */
function buildExecutable(): void {
  if (process.platform !== "darwin") {
    const slice = buildSlice(cmakeRoot, []);
    copyBuiltExecutable(slice.whisper, executableName, true);
    copyBuiltExecutable(slice.vad, vadExecutableName, false);
    copyBuiltExecutable(slice.stt, sttExecutableName, false);
    return;
  }
  const slices = MAC_ARCHITECTURES.map((architecture) =>
    buildSlice(`${cmakeRoot}-${architecture}`, [`-DCMAKE_OSX_ARCHITECTURES=${architecture}`]),
  );
  for (const target of [
    { name: executableName, paths: slices.map((slice) => slice.whisper), help: true },
    { name: vadExecutableName, paths: slices.map((slice) => slice.vad), help: false },
    { name: sttExecutableName, paths: slices.map((slice) => slice.stt), help: false },
  ]) {
    const universal = join(buildRoot, `${target.name}-universal`);
    execFileSync("lipo", ["-create", ...target.paths, "-output", universal], { stdio: "inherit" });
    const architectures = execFileSync("lipo", ["-archs", universal], { encoding: "utf8" }).trim().split(/\s+/u);
    for (const architecture of MAC_ARCHITECTURES) {
      if (!architectures.includes(architecture)) {
        throw new Error(`The universal ${target.name} is missing its ${architecture} slice.`);
      }
    }
    copyBuiltExecutable(universal, target.name, target.help);
  }
}

/** Build both executables against the same pinned Whisper libraries. */
function buildSlice(buildDirectory: string, extraArguments: string[]): { whisper: string; vad: string; stt: string } {
  execFileSync(
    "cmake",
    [
      "-S",
      sourceRoot,
      "-B",
      buildDirectory,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=OFF",
      "-DGGML_NATIVE=OFF",
      "-DGGML_METAL=OFF",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_BUILD_SERVER=OFF",
      `-DCMAKE_PROJECT_INCLUDE=${vadTargetInclude}`,
      ...(process.platform === "win32" ? ["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"] : []),
      ...extraArguments,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "cmake",
    ["--build", buildDirectory, "--config", "Release", "--target", "whisper-cli", "voice-vad", "voice-stt", "-j", "4"],
    {
      stdio: "inherit",
    },
  );
  const findExecutable = (name: string): string => {
    const candidates = [join(buildDirectory, "bin", name), join(buildDirectory, "bin", "Release", name)];
    const executable = candidates.find(existsSync);
    if (!executable) throw new Error(`The Whisper build did not produce ${name}.`);
    return executable;
  };
  return {
    whisper: findExecutable(executableName),
    vad: findExecutable(vadExecutableName),
    stt: findExecutable(sttExecutableName),
  };
}

function copyBuiltExecutable(builtExecutable: string, name: string, checkHelp: boolean): void {
  // The VAD worker needs its model and protocol input; its native smoke check is separate.
  if (checkHelp) execFileSync(builtExecutable, ["--help"], { stdio: "ignore" });
  const outputExecutable = join(binaryRoot, name);
  copyFileSync(builtExecutable, outputExecutable);
  if (process.platform !== "win32") chmodSync(outputExecutable, 0o755);
}

function requireCommand(command: string, arguments_: string[]): void {
  try {
    execFileSync(command, arguments_, { stdio: "ignore" });
  } catch {
    throw new Error(`${basename(command)} is required to prepare local voice transcription assets.`);
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
