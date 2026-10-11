// @vitest-environment node
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ResidentWhisper } from "./resident-whisper";

const roots: string[] = [];
const workers: ResidentWhisper[] = [];
afterEach(async () => {
  for (const worker of workers) worker.stop();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(hold = false) {
  const root = await mkdtemp(join(tmpdir(), "resident-stt-test-"));
  roots.push(root);
  const file = join(root, "worker");
  await writeFile(
    file,
    `#!/usr/bin/env node
process.stdout.write('READY\\n');let data=Buffer.alloc(0);process.stdin.on('data',b=>{data=Buffer.concat([data,b]);if(data.length>=12){const size=12+data.readUInt32LE(0)*4;if(data.length>=size){data=data.subarray(size);${hold ? "" : "process.stdout.write(JSON.stringify('Resident result')+'\\n');"}}}});`,
  );
  await chmod(file, 0o755);
  const worker = new ResidentWhisper(file, "model", "vad");
  workers.push(worker);
  return worker;
}
function wav() {
  const b = new Uint8Array(44 + 3200);
  return b;
}
it("keeps a resident process usable across independent requests", async () => {
  const w = await fixture();
  expect(await w.transcribe(wav(), 55, "en", new AbortController().signal)).toBe("Resident result");
  expect(await w.transcribe(wav(), 55, "en", new AbortController().signal)).toBe("Resident result");
});
it("aborts a held inference and does not leave the promise hanging", async () => {
  const w = await fixture(true);
  const c = new AbortController();
  const p = w.transcribe(wav(), 55, "en", c.signal);
  setTimeout(() => c.abort(), 100);
  await expect(p).rejects.toThrow("Interrupted");
});
it("rejects already aborted requests without starting", async () => {
  const w = await fixture();
  const c = new AbortController();
  c.abort();
  await expect(w.transcribe(wav(), 55, "en", c.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("prepares without a transcription and reuses that worker", async () => {
  const w = await fixture();
  await w.prepare();
  expect(await w.transcribe(wav(), 55, "en", new AbortController().signal)).toBe("Resident result");
});
it("rejects malformed audio before writing it", async () => {
  const w = await fixture();
  await expect(w.transcribe(new Uint8Array(43), 55, "en", new AbortController().signal)).rejects.toThrow(
    "Invalid resident voice audio",
  );
});

it("waits for a cancelled worker to close before a replacement starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "resident-close-test-"));
  roots.push(root);
  const file = join(root, "worker");
  await writeFile(
    file,
    `#!/usr/bin/env node
const fs=require('node:fs');const marker=${JSON.stringify(join(root, "starts"))};fs.appendFileSync(marker,'start\\n');process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250));process.stdout.write('READY\\n');process.stdin.on('data',()=>{});`,
  );
  await chmod(file, 0o755);
  const w = new ResidentWhisper(file, "model", "vad");
  workers.push(w);
  await w.prepare();
  const c = new AbortController();
  const pending = w.transcribe(wav(), 55, "en", c.signal);
  setTimeout(() => c.abort(), 40);
  const start = Date.now();
  await expect(pending).rejects.toThrow("Interrupted");
  expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  await w.prepare();
});

it("hard watchdog reaps a stuck inference before restarting", async () => {
  const root = await mkdtemp(join(tmpdir(), "resident-watchdog-"));
  roots.push(root);
  const file = join(root, "worker");
  await writeFile(
    file,
    `#!/usr/bin/env node
process.stdout.write('READY\\n');process.stdin.on('data',()=>{});`,
  );
  await chmod(file, 0o755);
  const w = new ResidentWhisper(file, "model", "vad", 70);
  workers.push(w);
  await w.prepare();
  const start = Date.now();
  await expect(w.transcribe(wav(), 55, "en", new AbortController().signal)).rejects.toThrow("timed out");
  expect(Date.now() - start).toBeLessThan(1500);
  await w.prepare();
});
