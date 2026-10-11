import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceModelService } from "./voice-model-service";
import { WhistleService } from "./whistle-service";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dani-whistle-test-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin/whistle-worker"),
    `#!${process.execPath}
const readline=require('node:readline');console.log(JSON.stringify({ready:true}));
readline.createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({text:'fixture transcript'})));`,
    { mode: 0o755 },
  );
  vi.spyOn(VoiceModelService.prototype, "getStatus").mockResolvedValue({
    phase: "ready",
    progress: 100,
    message: null,
  });
  return new WhistleService(root);
}
describe.skipIf(process.platform === "win32")("Whistle process ownership", () => {
  it("keeps one prepared worker for successive requests", async () => {
    const service = await fixture();
    try {
      await Promise.all([service.prepare(), service.prepare()]);
      await expect(service.transcribe(new Uint8Array(44), new AbortController().signal)).resolves.toEqual({
        text: "fixture transcript",
      });
      await expect(service.transcribe(new Uint8Array(44), new AbortController().signal)).resolves.toEqual({
        text: "fixture transcript",
      });
    } finally {
      service.shutdown();
    }
  });
  it("rejects a cancelled request and lets the next request recover", async () => {
    const service = await fixture();
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(service.transcribe(new Uint8Array(44), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
      await expect(service.transcribe(new Uint8Array(44), new AbortController().signal)).resolves.toEqual({
        text: "fixture transcript",
      });
    } finally {
      service.shutdown();
    }
  });
  it("rejects unverified assets without claiming ready", async () => {
    const service = await fixture();
    vi.mocked(VoiceModelService.prototype.getStatus).mockResolvedValue({
      phase: "missing",
      progress: null,
      message: null,
    });
    await expect(service.prepare()).rejects.toThrow("failed verification");
    service.shutdown();
  });
});
