import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureDevelopmentVoiceRuntime } from "./ensure-development-voice-runtime";

describe("cached development voice runtime", () => {
  it("prepares missing binaries once, then skips the cached pair", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-cache-"));
    try {
      const prepare = vi.fn(() => {
        const bin = join(root, ".dani-dex-build/whisper/bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "whisper-cli"), "fixture");
        writeFileSync(join(bin, "voice-vad"), "fixture");
      });
      expect(ensureDevelopmentVoiceRuntime(root, "darwin", prepare)).toBe(true);
      expect(ensureDevelopmentVoiceRuntime(root, "darwin", prepare)).toBe(false);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not attempt unsupported platforms", () => {
    const prepare = vi.fn();
    expect(ensureDevelopmentVoiceRuntime("/unused", "linux", prepare)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("reports missing build outputs", () =>
    expect(() => ensureDevelopmentVoiceRuntime("/unused", "darwin", () => {})).toThrow());
});
