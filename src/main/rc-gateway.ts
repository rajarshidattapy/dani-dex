import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RcGatewayStatus } from "@dani-dex/contracts/ipc";

interface RcGatewayOptions {
  statePath: string;
  executable: string;
  target: () => Promise<string>;
  health?: (origin: string) => Promise<boolean>;
  launch?: (executable: string, target: string) => ChildProcess;
  intervalMs?: number;
}
/** Owns one anonymous RC route. No renderer-provided executable or command is accepted. */
export class RcGateway extends EventEmitter<{ changed: [status: RcGatewayStatus] }> {
  #status: RcGatewayStatus = {
    enabled: false,
    phase: "off",
    origin: null,
    previousOrigin: null,
    changedAt: null,
    message: null,
  };
  #child: ChildProcess | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;
  #closed = false;
  #changing = false;
  #generation = 0;
  #failures = 0;
  #retryDelay = 1000;
  #startedAt = 0;
  constructor(private readonly options: RcGatewayOptions) {
    super();
  }
  getStatus(): RcGatewayStatus {
    return { ...this.#status };
  }
  #publish(patch: Partial<RcGatewayStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("changed", this.getStatus());
  }
  async initialize(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (typeof state === "object" && state !== null && "enabled" in state && state.enabled === true) {
        this.#publish({ enabled: true, phase: "connecting" });
        this.#schedule(0);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        this.#publish({ message: "RC preference could not be read. Enable it again from Settings." });
    }
  }
  async setEnabled(enabled: boolean): Promise<RcGatewayStatus> {
    if (this.#changing) throw Error("RC gateway preference is already changing.");
    this.#changing = true;
    try {
      await mkdir(dirname(this.options.statePath), { recursive: true });
      await writeFile(this.options.statePath + ".tmp", JSON.stringify({ enabled }), { mode: 0o600 });
      await rename(this.options.statePath + ".tmp", this.options.statePath);
      this.#closed = false;
      this.#publish({ enabled, phase: enabled ? "connecting" : "off", message: null });
      if (enabled) this.#schedule(0);
      else {
        this.#generation++;
        this.#clearTimer();
        await this.#stopChild();
        this.#publish({ origin: null });
      }
      return this.getStatus();
    } finally {
      this.#changing = false;
    }
  }
  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
  #schedule(delay: number): void {
    this.#clearTimer();
    if (this.#closed || !this.#status.enabled) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, delay);
    this.#timer.unref?.();
  }
  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (!child || child.exitCode !== null || !child.pid) return;
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  async #tick(): Promise<void> {
    if (this.#closed || !this.#status.enabled || this.#busy) return;
    this.#busy = true;
    const generation = this.#generation;
    let nextDelay = this.options.intervalMs ?? 30000;
    try {
      if (!this.#child) {
        nextDelay = this.#retryDelay;
        const target = await this.options.target();
        if (generation !== this.#generation || this.#closed) return;
        const url = new URL(target);
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/")
          throw Error("RC needs the local host API.");
        this.#publish({ phase: "connecting", message: "Starting a temporary RC gateway..." });
        const child = (
          this.options.launch ??
          ((executable, address) =>
            spawn(executable, ["tunnel", "--protocol", "http2", "--url", address, "--no-autoupdate"], {
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            }))
        )(this.options.executable, target);
        this.#child = child;
        this.#startedAt = Date.now();
        let buffer = "";
        const output = (chunk: Buffer): void => {
          if (this.#child !== child || generation !== this.#generation) return;
          buffer = (buffer + chunk.toString("utf8")).slice(-12000);
          const origin = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u)?.[0];
          if (origin && origin !== this.#status.origin) {
            const previous = this.#status.origin ?? this.#status.previousOrigin;
            this.#publish({
              origin,
              previousOrigin: previous,
              changedAt: new Date().toISOString(),
              message: previous
                ? "RC address changed. Open the new URL and pair again."
                : "Checking the public RC address...",
            });
            this.#failures = 0;
          }
        };
        child.stdout?.on("data", output);
        child.stderr?.on("data", output);
        child.once("error", () => {
          if (this.#child !== child) return;
          this.#child = null;
          this.#publish({
            previousOrigin: this.#status.origin ?? this.#status.previousOrigin,
            origin: null,
            phase: "error",
            message: "RC gateway could not start. Check the installed Cloudflare tunnel runtime.",
          });
          this.#schedule(this.#retryDelay);
          this.#retryDelay = Math.min(this.#retryDelay * 2, 60000);
        });
        child.once("exit", () => {
          if (this.#child !== child) return;
          this.#child = null;
          this.#publish({
            previousOrigin: this.#status.origin ?? this.#status.previousOrigin,
            origin: null,
            phase: "reconnecting",
            message: "Gateway stopped. Restarting automatically...",
          });
          this.#schedule(this.#retryDelay);
          this.#retryDelay = Math.min(this.#retryDelay * 2, 60000);
        });
      }
      if (this.#status.origin) {
        nextDelay = this.options.intervalMs ?? 30000;
        const healthy = await (this.options.health ?? publicHealth)(this.#status.origin);
        if (generation !== this.#generation || this.#closed) return;
        if (healthy) {
          this.#failures = 0;
          this.#retryDelay = 1000;
          this.#publish({
            phase: "online",
            message: "RC gateway is online. Temporary addresses can change after an outage.",
          });
        } else {
          this.#failures++;
          this.#publish({
            phase: "reconnecting",
            message: "Public RC health check failed. Checking again before replacing the route...",
          });
          if (this.#failures >= 3 && Date.now() - this.#startedAt >= 90000) {
            this.#generation++;
            await this.#stopChild();
            this.#publish({ previousOrigin: this.#status.origin ?? this.#status.previousOrigin, origin: null });
            this.#failures = 0;
          }
        }
      } else if (this.#child && Date.now() - this.#startedAt >= 90000) {
        this.#generation++;
        await this.#stopChild();
      }
    } catch {
      if (generation !== this.#generation || this.#closed || !this.#status.enabled) return;
      nextDelay = this.#retryDelay;
      this.#retryDelay = Math.min(this.#retryDelay * 2, 60000);
      this.#publish({ phase: "error", message: "RC gateway is unavailable. Retrying automatically..." });
    } finally {
      this.#busy = false;
      this.#schedule(nextDelay);
    }
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#generation++;
    this.#clearTimer();
    await this.#stopChild();
  }
}
async function publicHealth(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin + "/device-pairing", { signal: AbortSignal.timeout(10000), redirect: "error" });
    return response.ok && (await response.text()).includes("Dani-Dex Remote View");
  } catch {
    return false;
  }
}
