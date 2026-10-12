import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { RcGateway } from "./rc-gateway";

it.each(["disabled", "shutdown"])("does not publish a stale target error after RC is %s", async (action) => {
  const root = await mkdtemp(join(tmpdir(), "rc-stop-"));
  let rejectTarget: (error: Error) => void = () => undefined;
  const target = vi.fn(
    () =>
      new Promise<string>((_, reject) => {
        rejectTarget = reject;
      }),
  );
  const launch = vi.fn();
  const gateway = new RcGateway({ statePath: join(root, "rc.json"), executable: "fixture", target, launch });
  try {
    vi.useFakeTimers();
    await gateway.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(target).toHaveBeenCalledOnce();
    if (action === "disabled") await gateway.setEnabled(false);
    else await gateway.shutdown();
    const status = gateway.getStatus();
    rejectTarget(new Error("late target failure"));
    await vi.advanceTimersByTimeAsync(120000);
    expect(gateway.getStatus()).toEqual(status);
    expect(launch).not.toHaveBeenCalled();
    expect(target).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await gateway.shutdown();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not mark a dead route online when its in-flight health check resolves", async () => {
  const root = await mkdtemp(join(tmpdir(), "rc-health-stale-"));
  let resolveHealth: (healthy: boolean) => void = () => undefined;
  const health = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveHealth = resolve;
      }),
  );
  const child = new ChildProcess();
  const setExitCode = (value: number) => Object.defineProperty(child, "exitCode", { value, writable: true });
  const stderr = new PassThrough();
  Object.defineProperties(child, {
    stderr: { value: stderr },
    pid: { value: 1 },
    exitCode: { value: null, writable: true },
  });
  vi.spyOn(child, "kill").mockImplementation(() => {
    setExitCode(0);
    queueMicrotask(() => child.emit("exit", 0));
    return true;
  });
  const launch = vi.fn(() => child);
  const gateway = new RcGateway({
    statePath: join(root, "rc.json"),
    executable: "fixture",
    target: async () => "http://localhost:12345",
    health,
    launch,
  });
  try {
    vi.useFakeTimers();
    await gateway.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    stderr.write("https://fixture-rc.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(30000);
    expect(health).toHaveBeenCalledOnce();
    setExitCode(1);
    child.emit("exit", 1);
    expect(gateway.getStatus()).toMatchObject({ phase: "reconnecting", origin: null });
    resolveHealth(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.getStatus()).toMatchObject({ phase: "reconnecting", origin: null });
  } finally {
    await gateway.shutdown();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
