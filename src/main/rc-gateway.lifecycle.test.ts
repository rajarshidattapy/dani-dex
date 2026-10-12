import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
