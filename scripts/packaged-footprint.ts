import { readFile, stat } from "node:fs/promises";
import { type DynamicRecord, isDynamicRecord } from "@dani-dex/contracts/runtime-values";
import { createDaniDexLogger } from "@dani-dex/logging";

const logger = createDaniDexLogger("packaged-footprint");

/** These libraries are compiled into renderer assets and are never main-process externals. */
export const RENDERER_ONLY_PACKAGES = [
  "lucide-solid",
  "three",
  "@types/three",
  "@dimforge",
  "rrweb",
  "rrdom",
  "rrweb-snapshot",
  "@fontsource-variable",
  "solid-recharts",
  "@solidjs",
  "@kobalte",
  "@norbert_bodziony",
  "@paper-design",
  "@speed-highlight",
  "@tanstack/virtual-core",
  "class-variance-authority",
  "solid-sonner",
  "solid-js",
] as const;
export function asarFileSizes(buffer: Buffer): Array<{ path: string; bytes: number }> {
  if (buffer.length < 16) throw Error("Truncated ASAR header");
  const length = buffer.readUInt32LE(12);
  if (length > buffer.length - 16) throw Error("Invalid ASAR header length");
  const parsed = JSON.parse(buffer.toString("utf8", 16, 16 + length));
  if (!isDynamicRecord(parsed) || !isDynamicRecord(parsed.files)) throw Error("Invalid ASAR file table");
  const result: Array<{ path: string; bytes: number }> = [];
  function walk(files: DynamicRecord, prefix: string) {
    for (const [name, entry] of Object.entries(files)) {
      if (!isDynamicRecord(entry)) throw Error("Invalid ASAR entry");
      const path = prefix + name;
      if (isDynamicRecord(entry.files)) walk(entry.files, `${path}/`);
      else if (typeof entry.size === "number") result.push({ path, bytes: entry.size });
    }
  }
  walk(parsed.files, "");
  return result;
}
export function assertLeanPackage(files: readonly { path: string; bytes: number }[]): void {
  for (const { path } of files) {
    if (RENDERER_ONLY_PACKAGES.some((p) => path.startsWith(`node_modules/${p}/`)))
      throw Error(`Renderer-only dependency duplicated: ${path}`);
    if (path.startsWith("node_modules/") && /(?:\.map|\.d\.ts)$|\.test\./u.test(path))
      throw Error(`Development payload packaged: ${path}`);
  }
}
export async function verifyPackagedFootprint(archive: string): Promise<void> {
  const buffer = await readFile(archive);
  const files = asarFileSizes(buffer);
  assertLeanPackage(files);
  const bytes = (await stat(archive)).size;
  if (bytes > 55 * 1024 * 1024) throw Error(`app.asar exceeds the 55MiB package budget: ${bytes} bytes`);
  logger.info(
    JSON.stringify({
      archive,
      asarBytes: bytes,
      fileContentBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      fileCount: files.length,
    }),
  );
}
