import { existsSync } from "node:fs";
import { join } from "node:path";
/** Local voice binaries are prepared once per checkout; model downloads remain integrity-cached. */
export function ensureDevelopmentVoiceRuntime(root: string, platform: string, prepare: () => void): boolean {
  if (platform !== "darwin" && platform !== "win32") return false;
  const bin = join(root, ".dani-dex-build", "whisper", "bin");
  const extension = platform === "win32" ? ".exe" : "";
  if (existsSync(join(bin, `whisper-cli${extension}`)) && existsSync(join(bin, `voice-vad${extension}`))) return false;
  prepare();
  if (!existsSync(join(bin, `whisper-cli${extension}`)) || !existsSync(join(bin, `voice-vad${extension}`)))
    throw new Error("Local voice runtime preparation did not produce both executables.");
  return true;
}
