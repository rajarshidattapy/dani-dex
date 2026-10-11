// @vitest-environment node

import { type ChildProcess, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSpeechService } from "../native-speech-service";
import { registerIpcGroup } from "./define-ipc-group";
import { voiceIpcHandlers } from "./voice-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, ...arguments_: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const services: NativeSpeechService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  registrations.clear();
});

class Renderer extends EventEmitter {
  readonly mainFrame: { url: string };

  constructor(
    readonly id: number,
    url = "dani-dex-app://app/index.html",
  ) {
    super();
    this.mainFrame = { url };
  }
}

function event(sender: Renderer, senderFrame = sender.mainFrame) {
  return { sender, senderFrame };
}

async function unused(): Promise<never> {
  throw new Error("This speech test must not use another voice service.");
}

function fixture(exitCode?: number) {
  const children: { child: ChildProcess; ready: Promise<void> }[] = [];
  const speech = new NativeSpeechService("darwin", (complete) => {
    const ready = Promise.withResolvers<void>();
    // A real child owns its lifetime. It does not interpret or echo the supplied speech text.
    const child = execFile(
      process.execPath,
      [
        "-e",
        `process.stdin.resume();
         process.stdin.on("end", () => {
           if (${exitCode !== undefined}) process.exit(${exitCode ?? 0});
           const server = require("node:net").createServer();
           process.on("SIGTERM", () => server.close(() => process.exit(0)));
           server.listen(0, "127.0.0.1", () => process.stdout.write("ready"));
         });`,
      ],
      complete,
    );
    child.stdout?.once("data", () => ready.resolve());
    children.push({ child, ready: ready.promise });
    return child;
  });
  services.push(speech);
  const main = new Renderer(1);
  let mainRendererId: number | null = main.id;
  registerIpcGroup(
    "voice",
    voiceIpcHandlers({
      speech,
      mainRendererId: () => mainRendererId,
      codex: { status: unused, connect: unused, start: unused, stop: unused },
      voice: {
        getModelStatus: unused,
        prepareModel: unused,
        transcribe: unused,
      },
      activity: { start: unused, detect: unused, stop: unused },
      realtime: { create: unused },
      credentials: {
        set: unused,
        clear: unused,
        status: () => {
          throw new Error("This speech test must not read credentials.");
        },
      },
    }).voice,
  );
  return {
    main,
    children,
    selectRenderer(id: number | null) {
      mainRendererId = id;
    },
    started(index = 0) {
      const started = children[index];
      if (!started) throw new Error("The accepted request did not start a speech child.");
      return started;
    },
  };
}

function invoke(channel: string, requestEvent: unknown, payload: unknown): Promise<void> {
  const listener = registrations.get(channel);
  if (!listener) throw new Error(`Missing IPC registration: ${channel}`);
  return Promise.resolve(listener(requestEvent, payload)).then(() => undefined);
}

function outcome(request: Promise<void>): Promise<string> {
  return request.then(
    () => "finished",
    (error: Error) => error.name,
  );
}

function expectReleased(renderer: Renderer): void {
  expect(renderer.listenerCount("destroyed")).toBe(0);
  expect(renderer.listenerCount("render-process-gone")).toBe(0);
  expect(renderer.listenerCount("did-start-navigation")).toBe(0);
}

const OWNER_REJECTION = "Rejected local speech request from a renderer that does not own the conversation.";

describe("native speech IPC ownership", () => {
  it.each(["untrusted", "wrong-window", "subframe", "no-main-renderer"])(
    "rejects %s speech and stop requests before malformed payload decoding",
    (caller) => {
      const { main, children, selectRenderer } = fixture();
      let requestEvent = event(main);
      let rejection = OWNER_REJECTION;
      if (caller === "untrusted") {
        requestEvent = event(new Renderer(main.id, "https://evil.example/index.html"));
        rejection = "Rejected IPC request from an untrusted renderer.";
      } else if (caller === "wrong-window") {
        requestEvent = event(new Renderer(2));
      } else if (caller === "subframe") {
        requestEvent = event(main, { url: main.mainFrame.url });
      } else {
        selectRenderer(null);
      }
      let decoded = 0;
      const malformed = {
        get id() {
          decoded += 1;
          throw new Error("The malformed payload was decoded.");
        },
      };
      expect(() => invoke("voice:speak-local", requestEvent, malformed)).toThrow(rejection);
      expect(() => invoke("voice:stop-local", requestEvent, malformed)).toThrow(rejection);
      expect(() =>
        invoke("voice:speak-local", requestEvent, {
          id: "rejected",
          text: "reply",
        }),
      ).toThrow(rejection);
      expect(decoded).toBe(0);
      expect(children).toHaveLength(0);
      expectReleased(requestEvent.sender);
    },
  );

  it("accepts the main renderer and does not let another window stop its speech", async () => {
    const { main, started } = fixture();
    const result = outcome(invoke("voice:speak-local", event(main), { id: "owned", text: "reply" }));
    const { child, ready } = started();
    await ready;
    expect(() => invoke("voice:stop-local", event(new Renderer(2)), "owned")).toThrow(OWNER_REJECTION);
    expect(() => invoke("voice:stop-local", event(main, { url: main.mainFrame.url }), "owned")).toThrow(
      OWNER_REJECTION,
    );
    expect(() => invoke("voice:stop-local", event(new Renderer(main.id, "https://evil.example/")), "owned")).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(child.killed).toBe(false);
    await invoke("voice:stop-local", event(main), "owned");
    expect(await result).toBe("AbortError");
    expect(child.exitCode).toBe(0);
    expectReleased(main);
  });

  it("rejects malformed payloads from the authorized renderer without starting speech", () => {
    const { main, children } = fixture();
    expect(() => invoke("voice:speak-local", event(main), null)).toThrow("Voice speech is required");
    expect(() => invoke("voice:stop-local", event(main), null)).toThrow("Voice speech id is required");
    expect(children).toHaveLength(0);
    expectReleased(main);
  });

  it.each(["destroyed", "render-process-gone", "reload"])(
    "aborts the owned child on %s and releases all renderer listeners",
    async (lifecycle) => {
      const { main, started } = fixture();
      const result = outcome(
        invoke("voice:speak-local", event(main), {
          id: "owned",
          text: "reply",
        }),
      );
      const { child, ready } = started();
      await ready;
      if (lifecycle === "reload") {
        main.emit("did-start-navigation", {}, main.mainFrame.url, false, true);
      } else {
        main.emit(lifecycle);
      }
      expect(await result).toBe("AbortError");
      expect(child.exitCode).toBe(0);
      expectReleased(main);
    },
  );

  it("keeps speech during in-place main-frame and non-in-place subframe navigation", async () => {
    const { main, started } = fixture();
    const result = outcome(invoke("voice:speak-local", event(main), { id: "owned", text: "reply" }));
    const { child, ready } = started();
    await ready;
    main.emit("did-start-navigation", {}, `${main.mainFrame.url}#conversation`, true, true);
    main.emit("did-start-navigation", {}, main.mainFrame.url, false, false);
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();
    await invoke("voice:stop-local", event(main), "owned");
    expect(await result).toBe("AbortError");
    expectReleased(main);
  });

  it.each([0, 7])("releases renderer listeners after a child exits with code %s", async (exitCode) => {
    const { main, started } = fixture(exitCode);
    const result = outcome(
      invoke("voice:speak-local", event(main), {
        id: "owned",
        text: "reply",
      }),
    );
    expect(await result).toBe(exitCode === 0 ? "finished" : "Error");
    expect(started().child.exitCode).toBe(exitCode);
    expectReleased(main);
  });

  it("does not let late old-renderer cleanup stop a new renderer's utterance", async () => {
    const { main, started, selectRenderer } = fixture();
    const oldResult = outcome(
      invoke("voice:speak-local", event(main), {
        id: "old",
        text: "old reply",
      }),
    );
    await started().ready;
    const lateDestroy = main.listeners("destroyed")[0];
    if (!lateDestroy) throw new Error("The active speech has no renderer destruction listener.");
    const nextRenderer = new Renderer(2);
    selectRenderer(nextRenderer.id);
    const nextResult = outcome(
      invoke("voice:speak-local", event(nextRenderer), {
        id: "new",
        text: "new reply",
      }),
    );
    expect(await oldResult).toBe("AbortError");
    const { child, ready } = started(1);
    await ready;
    expectReleased(main);
    lateDestroy();
    main.emit("destroyed");
    main.emit("render-process-gone");
    main.emit("did-start-navigation", {}, main.mainFrame.url, false, true);
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();
    await invoke("voice:stop-local", event(nextRenderer), "new");
    expect(await nextResult).toBe("AbortError");
    expectReleased(nextRenderer);
  });
});

describe("voice preparation includes offline speech", () => {
  it("warms speech after STT is ready and propagates a speech startup failure", async () => {
    const prepare = vi.fn(async () => {
      throw new Error("missing speech runtime");
    });
    registerIpcGroup(
      "voice",
      voiceIpcHandlers({
        mainRendererId: () => 1,
        speech: { prepare, speak: unused, stop: unused },
        voice: {
          getModelStatus: unused,
          prepareModel: async () => ({
            phase: "ready",
            progress: 1,
            message: "Ready",
          }),
          transcribe: unused,
        },
        activity: { start: unused, detect: unused, stop: unused },
        codex: { status: unused, connect: unused, start: unused, stop: unused },
        realtime: { create: unused },
        credentials: {
          set: unused,
          clear: unused,
          status: () => {
            throw new Error("No credentials expected");
          },
        },
      }).voice,
    );
    await expect(invoke("voice:prepare-model", event(new Renderer(1)), undefined)).rejects.toThrow(
      "missing speech runtime",
    );
    expect(prepare).toHaveBeenCalledOnce();
  });
});
