import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KittenSpeechService } from "./kitten-speech-service";

vi.mock("./voice-model-service", () => ({
  VoiceModelService: class {
    async getStatus() {
      return { phase: "ready" };
    }
  },
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kitten-test-"));
  await mkdir(join(root, "venv/bin"), { recursive: true });
  await symlink(process.execPath, join(root, "venv/bin/python"));
  const worker = join(root, "worker.cjs");
  await writeFile(
    worker,
    `const readline=require('node:readline');console.log(JSON.stringify({ready:true}));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.text==='fail')console.log(JSON.stringify({ok:false}));});`,
  );
  const service = new KittenSpeechService(root, worker);
  cleanup.push(async () => {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return service;
}
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "done",
    (e) => e.name,
  );
describe("Kitten output lifecycle", () => {
  it("prewarms without synthesis and rejects preparation after shutdown", async () => {
    const s = await fixture();
    await s.prepare();
    await s.prepare();
    await s.shutdown();
    await expect(s.prepare()).rejects.toThrow("closed");
  });
  it("rejects requests after shutdown", async () => {
    const s = await fixture();
    await s.shutdown();
    await expect(s.speak({ id: "x", text: "hello" })).rejects.toThrow("closed");
  });
  it("cancels a queued request before worker preparation", async () => {
    const s = await fixture();
    const r = outcome(s.speak({ id: "x", text: "wait" }));
    await s.stop("x");
    expect(await r).toBe("AbortError");
  });
  it("ignores unrelated stops and cancels only the newest queued request", async () => {
    const s = await fixture();
    const a = outcome(s.speak({ id: "a", text: "wait" }));
    const b = outcome(s.speak({ id: "b", text: "wait" }));
    await s.stop("a");
    await s.stop("b");
    expect(await a).toBe("AbortError");
    expect(await b).toBe("AbortError");
    await expect(s.speak({ id: "c", text: "fail" })).rejects.toThrow("synthesize");
  });
  it("recovers after a worker-reported synthesis failure", async () => {
    const s = await fixture();
    await expect(s.speak({ id: "a", text: "fail" })).rejects.toThrow("synthesize");
    await expect(s.speak({ id: "b", text: "fail" })).rejects.toThrow("synthesize");
  });
});
