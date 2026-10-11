import { type ChildProcess, execFile } from "node:child_process";
import { INPUT_LIMITS } from "@dani-dex/contracts/input-limits";
import { afterEach, describe, expect, it } from "vitest";
import { parseVoiceSpeech } from "./ipc/voice-inputs";
import { NativeSpeechService } from "./native-speech-service";

const services: NativeSpeechService[] = [];
const completionReleases: (() => void)[] = [];
afterEach(async () => {
  for (const release of completionReleases.splice(0)) release();
  for (const service of services.splice(0)) await service.shutdown();
});

function fixture(holdFirstCompletion = false) {
  const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const firstExited = Promise.withResolvers<void>();
  const firstCompletion = Promise.withResolvers<void>();
  if (holdFirstCompletion) completionReleases.push(firstCompletion.resolve);
  const children: ChildProcess[] = [];
  const service = new NativeSpeechService("darwin", (complete) => {
    const index = children.length;
    const child = execFile(
      process.execPath,
      [
        "-e",
        `let text = "";
         process.stdin.setEncoding("utf8");
         process.stdin.on("data", value => { text += value; });
         process.stdin.on("end", () => {
           if (text === "finish") process.exit(0);
           if (text === "fail") process.exit(7);
           const server = require("node:net").createServer();
           process.on("SIGTERM", () => server.close(() => process.exit(0)));
           server.listen(0, "127.0.0.1", () => process.stdout.write("ready"));
         });`,
      ],
      (error) => {
        if (index === 0 && holdFirstCompletion) {
          firstExited.resolve();
          void firstCompletion.promise.then(() => complete(error));
        } else {
          complete(error);
        }
      },
    );
    child.stdout?.once("data", () => ready[index]?.resolve());
    children.push(child);
    return child;
  });
  services.push(service);
  return {
    service,
    ready,
    children,
    firstExited: firstExited.promise,
    releaseFirstCompletion: firstCompletion.resolve,
  };
}

function outcome(speech: Promise<void>): Promise<string> {
  return speech.then(
    () => "finished",
    (error: Error) => error.name,
  );
}

describe("native local speech lifecycle", () => {
  it("keeps speaking for an unrelated stop and closes the owned child for a matching stop", async () => {
    const { service, ready, children } = fixture();
    const result = outcome(service.speak({ id: "first", text: "wait for interruption" }));
    await ready[0]?.promise;
    await service.stop("unrelated");
    expect(children[0]?.exitCode).toBeNull();
    await service.stop("first");
    expect(await result).toBe("AbortError");
    expect(children[0]?.exitCode).toBe(0);
  });

  it("replaces an answer and prevents a late abort from stopping the newer answer", async () => {
    const { service, ready, children } = fixture();
    const first = outcome(service.speak({ id: "first", text: "old answer" }));
    await ready[0]?.promise;
    const second = outcome(service.speak({ id: "second", text: "new answer" }));
    await ready[1]?.promise;
    expect(await first).toBe("AbortError");
    await service.stop("first");
    expect(children[1]?.exitCode).toBeNull();
    await service.stop("second");
    expect(await second).toBe("AbortError");
    expect(children.every((child) => child.exitCode === 0)).toBe(true);
  });

  it("waits for a real successful child exit and can recover after a failed utterance", async () => {
    const { service, children } = fixture();
    await expect(service.speak({ id: "failed", text: "fail" })).rejects.toThrow("Could not speak the reply");
    await service.speak({ id: "next", text: "finish" });
    expect(children.map((child) => child.exitCode)).toEqual([7, 0]);
  });

  it("closes active speech on shutdown and rejects further speech", async () => {
    const { service, ready, children } = fixture();
    const result = outcome(service.speak({ id: "first", text: "active answer" }));
    await ready[0]?.promise;
    await service.shutdown();
    expect(await result).toBe("AbortError");
    expect(children[0]?.exitCode).toBe(0);
    await expect(service.speak({ id: "later", text: "finish" })).rejects.toThrow("Local speech is closed");
  });

  it("starts only the newest replacement while the old child's completion is pending", async () => {
    const { service, ready, children, firstExited, releaseFirstCompletion } = fixture(true);
    const first = outcome(service.speak({ id: "first", text: "old answer" }));
    await ready[0]?.promise;
    const superseded = outcome(service.speak({ id: "superseded", text: "intermediate answer" }));
    await firstExited;
    const newest = outcome(service.speak({ id: "newest", text: "final answer" }));
    expect(children).toHaveLength(1);
    releaseFirstCompletion();
    expect(await first).toBe("AbortError");
    expect(await superseded).toBe("AbortError");
    await ready[1]?.promise;
    expect(children).toHaveLength(2);
    await service.stop("superseded");
    expect(children[1]?.killed).toBe(false);
    await service.stop("newest");
    expect(await newest).toBe("AbortError");
    expect(children[1]?.exitCode).toBe(0);
  });

  it.each(["stop", "shutdown"])(
    "does not start a queued replacement after %s during old-child cleanup",
    async (cancellation) => {
      const { service, ready, children, firstExited, releaseFirstCompletion } = fixture(true);
      const first = outcome(service.speak({ id: "first", text: "old answer" }));
      await ready[0]?.promise;
      const queued = outcome(service.speak({ id: "queued", text: "queued answer" }));
      await firstExited;
      const cancelled = cancellation === "shutdown" ? service.shutdown() : service.stop("queued");
      releaseFirstCompletion();
      await cancelled;
      expect(await first).toBe("AbortError");
      expect(await queued).toBe("AbortError");
      expect(children).toHaveLength(1);
      if (cancellation === "stop") {
        await service.speak({ id: "recovered", text: "finish" });
        expect(children.map((child) => child.exitCode)).toEqual([0, 0]);
      } else {
        await expect(service.speak({ id: "later", text: "finish" })).rejects.toThrow("Local speech is closed");
      }
    },
  );
});

describe("native speech renderer input", () => {
  it.each([undefined, null, [], { id: "", text: "hello" }, { id: "first", text: " " }])(
    "rejects malformed or empty input before speech",
    (input) => expect(() => parseVoiceSpeech(input)).toThrow("required"),
  );

  it("bounds identifiers and text from an untrusted renderer", () => {
    expect(() => parseVoiceSpeech({ id: "x".repeat(INPUT_LIMITS.identifier + 1), text: "hello" })).toThrow("too long");
    expect(() => parseVoiceSpeech({ id: "first", text: "x".repeat(INPUT_LIMITS.messageText + 1) })).toThrow("too long");
  });
});
