import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { RcGateway } from "./rc-gateway";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.useRealTimers();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rc-gateway-"));
  const children: Array<
    EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    }
  > = [];
  const health = vi.fn().mockResolvedValue(true);
  const gateway = new RcGateway({
    statePath: join(root, "rc.json"),
    executable: "fixture",
    target: async () => "http://localhost:12345",
    health,
    launch: () => {
      const child: EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        pid: number;
        kill: ReturnType<typeof vi.fn>;
      } = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        pid: children.length + 1,
        kill: vi.fn(),
      });
      child.kill.mockImplementation(() => {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0));
        return true;
      });
      children.push(child);
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: fixture implements the child-process surface used by RcGateway.
      return child as unknown as ChildProcess;
    },
  });
  cleanup.push(async () => {
    await gateway.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { gateway, root, children, health };
}
it("persists enablement, reports the real URL and stops without deleting the saved preference", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.gateway.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  f.children[0].stderr.write("https://fixture-rc.trycloudflare.com");
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.gateway.getStatus()).toMatchObject({
    enabled: true,
    phase: "online",
    origin: "https://fixture-rc.trycloudflare.com",
  });
  await f.gateway.shutdown();
  expect(JSON.parse(await readFile(join(f.root, "rc.json"), "utf8"))).toEqual({ enabled: true });
  expect(f.children[0].kill).toHaveBeenCalledWith("SIGTERM");
});
it("restarts a dead child and keeps the previous address visible", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.gateway.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  f.children[0].stderr.write("https://first-rc.trycloudflare.com");
  f.children[0].exitCode = 1;
  f.children[0].emit("exit", 1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.children).toHaveLength(2);
  f.children[1].stderr.write("https://second-rc.trycloudflare.com");
  expect(f.gateway.getStatus()).toMatchObject({
    origin: "https://second-rc.trycloudflare.com",
    previousOrigin: "https://first-rc.trycloudflare.com",
  });
});
it("does not replace on one failed health check, but replaces after three checks and startup grace", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.gateway.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  f.children[0].stderr.write("https://first-rc.trycloudflare.com");
  f.health.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.children[0].kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(61000);
  expect(f.children[0].kill).toHaveBeenCalledWith("SIGTERM");
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.children).toHaveLength(2);
});
it("disables persistently and does not restart", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.gateway.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  await f.gateway.setEnabled(false);
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.children).toHaveLength(1);
  expect(f.gateway.getStatus()).toMatchObject({ enabled: false, phase: "off", origin: null });
});

it("restores an enabled gateway after app launch without generating a pairing code", async () => {
  const f = await fixture();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(f.root, "rc.json"), JSON.stringify({ enabled: true }));
  vi.useFakeTimers();
  await f.gateway.initialize();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.gateway.getStatus().enabled).toBe(true);
  expect(f.children).toHaveLength(1);
});
