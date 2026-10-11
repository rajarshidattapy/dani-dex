import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ignored = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  "coverage",
  "dist",
  "out",
  "test-results",
  "playwright-report",
  ".wrangler",
  ".dani-dex-build",
]);
const source = /\.(?:[cm]?[jt]sx?|css|swift|py)$/;
const secret = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|keys)$|\.(?:pem|key|p12)$/;

// Read-only, dependency-free. No symlinks followed and no source text returned.
export async function audit(root) {
  const areas = new Map();
  const hashes = new Map();
  const excluded = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      const name = relative(root, path).split("\\").join("/");
      if (entry.isSymbolicLink() || ignored.has(entry.name) || secret.test(entry.name)) {
        excluded.push(name);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await lstat(path);
      const key = name.includes("/") ? name.split("/").slice(0, 2).join("/") : "(root)";
      const area = areas.get(key) ?? { files: 0, bytes: 0, sourceFiles: 0, sourceLines: 0, testLines: 0 };
      area.files++;
      area.bytes += stat.size;
      if (source.test(entry.name)) {
        const bytes = await readFile(path);
        const lines = bytes.length ? bytes.toString("utf8").split("\n").length - (bytes.at(-1) === 10 ? 1 : 0) : 0;
        area.sourceFiles++;
        area.sourceLines += lines;
        if (/\.(?:test|spec)\./.test(entry.name)) area.testLines += lines;
        const hash = createHash("sha256").update(bytes).digest("hex");
        const group = hashes.get(hash) ?? { bytes: bytes.length, paths: [] };
        group.paths.push(name);
        hashes.set(hash, group);
      }
      areas.set(key, area);
    }
  }
  await walk(root);
  const bundles = [];
  async function output(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await output(path);
      else if (entry.isFile() && /\.(?:js|css)$/.test(entry.name)) {
        const bytes = await readFile(path);
        bundles.push({ path: relative(root, path), bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
      }
    }
  }
  await output(resolve(root, "out"));
  return {
    scope:
      "Working-tree files, excluding generated output, dependencies, git, secrets and symlinks. LOC includes comments and blanks. Existing out JS/CSS measured separately; freshness not asserted.",
    areas: [...areas]
      .map(([area, metrics]) => ({ area, ...metrics }))
      .sort((a, b) => b.bytes - a.bytes || a.area.localeCompare(b.area)),
    duplicates: [...hashes.values()].filter((g) => g.paths.length > 1 && g.bytes > 0).sort((a, b) => b.bytes - a.bytes),
    excluded: excluded.sort(),
    bundles: bundles.sort((a, b) => b.bytes - a.bytes),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? ".");
  console.log(JSON.stringify(await audit(root), null, 2));
}
