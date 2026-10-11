import type { ConversationPage, QueueDelivery, QueuedMessageReceipt, VoiceModelStatus } from "@dani-dex/contracts/ipc";
import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { installDanidexStub } from "../../app-test-harness";
import type { AgentMessage } from "../../data";
import { readAgentReplyMessages } from "../conversation/conversation-context";
import { findFinalAgentReply, interruptAgentDelivery, waitForAgentReply } from "./agent-reply";
import type { RealtimeTransportHandlers } from "./realtime-voice-transport";
import { VoiceCall, type VoiceCallEvent, type VoiceCallTransport } from "./voice-call";
import { createVoiceCallStore } from "./voice-call-store";

const agent = (id: string, body: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id,
  author: "agent",
  body,
  time: "",
  turnId: "turn-1",
  ...extra,
});

function delivery(id = "delivery-1", extra: Partial<QueueDelivery> = {}): QueueDelivery {
  return {
    id,
    messageId: `message-${id}`,
    recipientAgentId: "agent",
    sender: { kind: "user" },
    text: "Request",
    attachments: [],
    replyToMessageId: null,
    status: "running",
    position: null,
    turnId: "turn-1",
    error: null,
    createdAt: "",
    ...extra,
  };
}

function receipt(id = "delivery-1"): QueuedMessageReceipt {
  return { messageId: `message-${id}`, deliveries: [{ id, recipientAgentId: "agent", status: "queued", position: 1 }] };
}

describe("final agent reply", () => {
  it("accepts the actual completed final_answer projection without speaking commentary", () => {
    expect(
      findFinalAgentReply(
        [
          agent("thinking", "not aloud", { itemType: "commentary", kind: "thinking" }),
          agent("answer", "Hello Chief.", { itemType: "final_answer", status: "completed" }),
        ],
        "turn-1",
      ),
    ).toBe("Hello Chief.");
  });
  it("reads only completed answer text from the accepted turn, never tools or old tasks", () => {
    const messages = [
      agent("old", "Earlier answer", { turnId: "old-turn" }),
      agent("progress", "Looking now", { kind: "thinking", itemType: "commentary" }),
      agent("first", "First answer"),
      agent("final", "Done: booked for 7."),
      agent("tool", "Tool result", { itemType: "commandExecution" }),
      agent("other", "Another task", { turnId: "other-turn" }),
    ];
    expect(findFinalAgentReply(messages, "turn-1")).toBe("Done: booked for 7.");
    expect(findFinalAgentReply([...messages, agent("stream", "partial", { streaming: true })], "turn-1")).toBeNull();
    expect(findFinalAgentReply([agent("old", "Earlier", { turnId: "old-turn" })], "turn-1")).toBeNull();
  });

  it("waits for exact delivery completion then reads the authoritative final snapshot", async () => {
    const [deliveries, setDeliveries] = createSignal([delivery()]);
    const readMessages = vi.fn(async () => [agent("answer", "Hello there.")]);
    const reply = waitForAgentReply({ deliveries, readMessages }, "delivery-1", new AbortController().signal);
    flush();
    expect(readMessages).not.toHaveBeenCalled();
    setDeliveries([delivery("delivery-1", { status: "completed" })]);
    flush();
    await expect(reply).resolves.toBe("Hello there.");
  });

  it("settles a completed turn with no answer instead of leaving a ghost wait", async () => {
    const reply = waitForAgentReply(
      {
        deliveries: () => [delivery("delivery-1", { status: "completed" })],
        readMessages: async () => [agent("tool", "stdout", { itemType: "commandExecution" })],
      },
      "delivery-1",
      new AbortController().signal,
    );
    flush();
    await expect(reply).rejects.toThrow("The agent finished without a spoken reply.");
  });

  it("reports the real provider failure without speaking partial output", async () => {
    const reply = waitForAgentReply(
      {
        deliveries: () => [delivery("delivery-1", { status: "failed", error: "Provider quota exhausted" })],
        readMessages: async () => [agent("partial", "Unfinished answer")],
      },
      "delivery-1",
      new AbortController().signal,
    );
    flush();
    await expect(reply).rejects.toThrow("Provider quota exhausted");
  });

  it("settles a lost provider even if its running delivery never receives a terminal event", async () => {
    const [failure, setFailure] = createSignal<string | null>(null);
    const readMessages = vi.fn(async () => [agent("partial", "Unfinished answer")]);
    const reply = waitForAgentReply(
      {
        deliveries: () => [delivery()],
        failure,
        readMessages,
      },
      "delivery-1",
      new AbortController().signal,
    );
    flush();
    setFailure("The local provider process exited.");
    flush();
    await expect(reply).rejects.toThrow("The local provider process exited.");
    expect(readMessages).not.toHaveBeenCalled();
  });

  it("rejects a provider error even when the delivery reports completion", async () => {
    const reply = waitForAgentReply(
      {
        deliveries: () => [delivery("delivery-1", { status: "completed" })],
        readMessages: async () => [agent("error", "Provider request failed", { kind: "error" })],
      },
      "delivery-1",
      new AbortController().signal,
    );
    flush();
    await expect(reply).rejects.toThrow("Provider request failed");
  });

  it("releases reactive subscriptions on abort and ignores a late final read", async () => {
    const abort = new AbortController();
    const finalRead = Promise.withResolvers<readonly AgentMessage[]>();
    const readMessages = vi.fn(() => finalRead.promise);
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const [deliveries, setDeliveries] = createSignal([delivery("delivery-1", { status: "completed" })]);
    const reply = waitForAgentReply({ deliveries, readMessages }, "delivery-1", abort.signal);
    flush();
    await vi.waitFor(() => expect(readMessages).toHaveBeenCalledOnce());
    abort.abort();
    await expect(reply).rejects.toMatchObject({ name: "AbortError" });
    finalRead.resolve([agent("late", "Must not escape")]);
    setDeliveries([delivery("delivery-1", { status: "completed" })]);
    flush();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(readMessages).toHaveBeenCalledOnce();
  });
});

describe("authoritative voice reply pages", () => {
  it("speaks its completed turn beyond the latest page without taking a later task or tool result", async () => {
    installDanidexStub();
    const page = (messages: ConversationPage["messages"], olderCursor: string | null): ConversationPage => ({
      agentId: "agent",
      threadId: "thread",
      activeTurnId: null,
      revision: 4,
      messages,
      references: {},
      pageInfo: { hasOlder: olderCursor !== null, olderCursor },
    });
    vi.mocked(window.danidex.agent.readConversationPage).mockImplementation(async (input, serverId) => {
      if (serverId !== "captured-server") {
        return page(
          [
            {
              id: "wrong",
              author: "assistant",
              text: "Wrong server",
              createdAt: "",
              turnId: "turn-1",
              status: "completed",
            },
          ],
          null,
        );
      }
      if (input.anchor?.type === "latest") {
        return page(
          [
            {
              id: "tool",
              author: "assistant",
              itemType: "commandExecution",
              text: "Tool stdout",
              createdAt: "",
              turnId: "turn-1",
              status: "completed",
            },
            {
              id: "later",
              author: "assistant",
              text: "Other task",
              createdAt: "",
              turnId: "turn-2",
              status: "completed",
            },
          ],
          "before-tool",
        );
      }
      return page(
        [
          {
            id: "delivery-1",
            author: "user",
            text: "Voice request",
            createdAt: "",
            turnId: "turn-1",
            status: "completed",
          },
          {
            id: "answer",
            author: "assistant",
            itemType: "agentMessage",
            text: "Own final answer",
            createdAt: "",
            turnId: "turn-1",
            status: "completed",
          },
        ],
        "older-history",
      );
    });
    const reply = waitForAgentReply(
      {
        deliveries: () => [delivery("delivery-1", { status: "completed" })],
        readMessages: (accepted, signal) =>
          readAgentReplyMessages({ agentId: "agent", serverId: "captured-server" }, accepted, signal),
      },
      "delivery-1",
      new AbortController().signal,
    );
    flush();
    await expect(reply).resolves.toBe("Own final answer");
  });

  it("does not continue a final snapshot read after the call aborts", async () => {
    installDanidexStub();
    const pendingPage = Promise.withResolvers<ConversationPage>();
    const readPage = vi.mocked(window.danidex.agent.readConversationPage).mockReturnValueOnce(pendingPage.promise);
    const abort = new AbortController();
    const reading = readAgentReplyMessages({ agentId: "agent", serverId: "server" }, delivery(), abort.signal);
    abort.abort();
    pendingPage.resolve({
      agentId: "agent",
      threadId: "thread",
      activeTurnId: null,
      revision: 4,
      messages: [],
      references: {},
      pageInfo: { hasOlder: true, olderCursor: "older" },
    });
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(readPage).toHaveBeenCalledOnce();
  });
});

describe("accepted delivery interruption", () => {
  it("waits through a queued-to-starting race then interrupts only its own provider turn", async () => {
    let current = delivery("voice", { status: "queued", turnId: null });
    let listener: ((next: QueueDelivery | undefined) => void) | undefined;
    const unsubscribe = vi.fn();
    const backendTurns = new Set(["old-task", "voice-turn", "new-task"]);
    const cancel = vi.fn(async () => {
      current = delivery("voice", { status: "starting", turnId: null });
      listener?.(current);
      throw new Error("Only queued messages can be cancelled.");
    });
    const interrupt = vi.fn(async (turnId: string) => {
      backendTurns.delete(turnId);
    });
    const cancelling = interruptAgentDelivery({
      readDelivery: async () => current,
      onDelivery: (next) => {
        listener = next;
        return unsubscribe;
      },
      cancel,
      interrupt,
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(backendTurns.has("voice-turn")).toBe(true);
    current = delivery("voice", { status: "running", turnId: "voice-turn" });
    listener?.(current);
    await cancelling;
    expect([...backendTurns]).toEqual(["old-task", "new-task"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("settles when the exact starting delivery finishes before interruption", async () => {
    let listener: ((next: QueueDelivery | undefined) => void) | undefined;
    const unsubscribe = vi.fn();
    const interrupt = vi.fn(async () => {});
    const cancelling = interruptAgentDelivery({
      readDelivery: async () => delivery("voice", { status: "starting", turnId: null }),
      onDelivery: (next) => {
        listener = next;
        return unsubscribe;
      },
      cancel: async () => {},
      interrupt,
    });
    listener?.(delivery("voice", { status: "completed", turnId: "voice-turn" }));
    await cancelling;
    expect(interrupt).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("surfaces a real cancellation failure and removes its queue subscription", async () => {
    const unsubscribe = vi.fn();
    const cancelling = interruptAgentDelivery({
      readDelivery: async () => delivery("voice", { status: "queued", turnId: null }),
      onDelivery: () => unsubscribe,
      cancel: async () => {
        throw new Error("Queue persistence failed");
      },
      interrupt: async () => {},
    });
    await expect(cancelling).rejects.toThrow("Queue persistence failed");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("releases a starting-delivery subscription when the captured runtime stops", async () => {
    let failed: ((message: string) => void) | undefined;
    const unsubscribe = vi.fn();
    const interrupt = vi.fn(async () => {});
    const cancelling = interruptAgentDelivery({
      readDelivery: async () => delivery("voice", { status: "starting", turnId: null }),
      onDelivery: (_next, onFailure) => {
        failed = onFailure;
        return unsubscribe;
      },
      cancel: async () => {},
      interrupt,
    });
    failed?.("The captured runtime stopped.");
    await expect(cancelling).rejects.toThrow("The captured runtime stopped.");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
  });
});

function fakeTransport() {
  let handlers: RealtimeTransportHandlers | undefined;
  const spoken: string[] = [];
  let finishSpeech: (() => void) | undefined;
  const transport: VoiceCallTransport = {
    start: vi.fn(async (next: RealtimeTransportHandlers) => {
      handlers = next;
    }),
    speak: vi.fn((text: string, signal: AbortSignal) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      spoken.push(text);
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Interrupted", "AbortError"));
      };
      finishSpeech = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return promise;
    }),
    stop: vi.fn(),
  };
  return {
    transport,
    spoken,
    handlers: () => {
      if (!handlers) throw new Error("The call has not started.");
      return handlers;
    },
    finishSpeech: () => finishSpeech?.(),
  };
}

describe("voice call", () => {
  it("closing microphone keeps an accepted response and playback alive", async () => {
    const fake = fakeTransport();
    const answer = Promise.withResolvers<string>();
    const interrupt = vi.fn(async () => {});
    const submit = vi.fn(async () => ({ deliveryId: "accepted" }));
    const closeMicrophone = vi.fn();
    fake.transport.closeMicrophone = closeMicrophone;
    const call = new VoiceCall({
      transport: fake.transport,
      submit,
      interrupt,
      waitForReply: () => answer.promise,
      onEvent: () => {},
    });
    await call.start();
    fake.handlers().onTranscript("explain this");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    call.closeMicrophone();
    expect(closeMicrophone).toHaveBeenCalledOnce();
    expect(fake.transport.stop).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();

    answer.resolve("The completed response.");
    await vi.waitFor(() => expect(fake.spoken).toEqual(["The completed response."]));
    call.closeMicrophone();
    expect(interrupt).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
    fake.finishSpeech();
    await Promise.resolve();
    call.stop();
  });

  it("sends utterances through the thread and listens again after speaking", async () => {
    const fake = fakeTransport();
    const events: VoiceCallEvent[] = [];
    const submit = vi.fn(async () => ({ deliveryId: "delivery-1" }));
    const call = new VoiceCall({
      transport: fake.transport,
      submit,
      interrupt: async () => {},
      waitForReply: async () => "It is sunny.",
      onEvent: (event) => events.push(event),
    });
    await call.start();
    fake.handlers().onTranscript("what's the weather");
    await vi.waitFor(() => expect(fake.spoken).toEqual(["It is sunny."]));
    expect(submit).toHaveBeenCalledWith("what's the weather");
    fake.finishSpeech();
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "phase", phase: "listening" }));
    call.stop();
  });

  it("barge-in cuts off speech and accepts the next utterance", async () => {
    const fake = fakeTransport();
    const events: VoiceCallEvent[] = [];
    const call = new VoiceCall({
      transport: fake.transport,
      submit: async () => ({ deliveryId: "delivery-1" }),
      interrupt: async () => {},
      waitForReply: async () => "A long answer",
      onEvent: (event) => events.push(event),
    });
    await call.start();
    fake.handlers().onTranscript("tell me a story");
    await vi.waitFor(() => expect(fake.spoken).toHaveLength(1));
    fake.handlers().onSpeechStarted();
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "phase", phase: "listening" }));
    fake.handlers().onTranscript("a shorter story");
    await vi.waitFor(() => expect(fake.spoken).toHaveLength(2));
    call.stop();
  });

  it("reports an undelivered utterance and keeps the call open", async () => {
    const fake = fakeTransport();
    const events: VoiceCallEvent[] = [];
    const call = new VoiceCall({
      transport: fake.transport,
      submit: async () => null,
      interrupt: async () => {},
      waitForReply: async () => "unused",
      onEvent: (event) => events.push(event),
    });
    await call.start();
    fake.handlers().onTranscript("hello");
    await vi.waitFor(() => expect(events.some((event) => event.type === "error")).toBe(true));
    expect(fake.spoken).toEqual([]);
    expect(call.running).toBe(true);
    call.stop();
    expect(fake.transport.stop).toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "ended" });
  });

  it("never submits a transcript cancelled between thinking and dispatch", async () => {
    const fake = fakeTransport();
    const submit = vi.fn(async () => ({ deliveryId: "delivery-1" }));
    const call = new VoiceCall({
      transport: fake.transport,
      submit,
      interrupt: async () => {},
      waitForReply: async () => "Must not be spoken",
      onEvent: (event) => {
        if (event.type === "phase" && event.phase === "thinking") call.stop();
      },
    });
    await call.start();
    fake.handlers().onTranscript("cancel this request");
    await vi.waitFor(() => expect(call.running).toBe(false));
    expect(submit).not.toHaveBeenCalled();
    expect(fake.spoken).toEqual([]);
  });

  it("ignores old callbacks and startup failures after restarting", async () => {
    const pendingStart = Promise.withResolvers<void>();
    let oldHandlers: RealtimeTransportHandlers | undefined;
    const fake = fakeTransport();
    vi.mocked(fake.transport.start).mockImplementationOnce((handlers) => {
      oldHandlers = handlers;
      return pendingStart.promise;
    });
    const submit = vi.fn(async () => ({ deliveryId: "delivery-1" }));
    const events: VoiceCallEvent[] = [];
    const call = new VoiceCall({
      transport: fake.transport,
      submit,
      interrupt: async () => {},
      waitForReply: async () => "The new call's answer.",
      onEvent: (event) => events.push(event),
    });
    const oldStart = call.start();
    call.stop();
    await call.start();
    oldHandlers?.onTranscript("stale request");
    oldHandlers?.onError("stale error");
    oldHandlers?.onTranscriptionStarted?.();
    oldHandlers?.onTranscriptionFinished?.();
    pendingStart.reject(new Error("Old microphone request failed"));
    await oldStart;
    expect(call.running).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(events).not.toContainEqual({ type: "error", message: "stale error", turnId: -1 });
    fake.handlers().onTranscript("fresh request");
    await vi.waitFor(() => expect(fake.spoken).toEqual(["The new call's answer."]));
    call.stop();
  });

  it("shows queued text immediately, holds unsent text on close and keeps accepted reply", async () => {
    const fake = fakeTransport();
    fake.transport.closeMicrophone = vi.fn();
    const first = Promise.withResolvers<string>();
    const submit = vi.fn(async () => ({ deliveryId: "first" }));
    const interrupt = vi.fn(async () => {});
    const events: VoiceCallEvent[] = [];
    const call = new VoiceCall({
      transport: fake.transport,
      submit,
      interrupt,
      waitForReply: () => first.promise,
      onEvent: (e) => events.push(e),
    });
    await call.start();
    fake.handlers().onTranscript("first request");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    fake.handlers().onTranscript("second request");
    expect(events).toContainEqual({ type: "transcript", text: "second request", turnId: 2 });
    expect(submit).toHaveBeenCalledOnce();
    call.closeMicrophone();
    fake.handlers().onTranscript("late finalized request");
    first.resolve("First answer");
    await vi.waitFor(() => expect(fake.spoken).toEqual(["First answer"]));
    fake.finishSpeech();
    await Promise.resolve();
    await Promise.resolve();
    expect(submit).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "held-input", text: "second request" });
    expect(events).toContainEqual({ type: "held-input", text: "late finalized request" });
    call.stop();
  });
  it("does not close the mic on a recoverable recognition rejection", async () => {
    const fake = fakeTransport();
    fake.transport.closeMicrophone = vi.fn();
    const call = new VoiceCall({
      transport: fake.transport,
      submit: async () => ({ deliveryId: "ok" }),
      waitForReply: async () => "ok",
      interrupt: async () => {},
      onEvent: () => {},
    });
    await call.start();
    fake.handlers().onRecognitionError?.("Could not recognize safely");
    expect(fake.transport.closeMicrophone).not.toHaveBeenCalled();
    expect(call.running).toBe(true);
    call.stop();
  });

  it("keeps a late acceptance after call end without output in the restarted call", async () => {
    const fake = fakeTransport();
    const acceptance = Promise.withResolvers<{ deliveryId: string } | null>();
    const submit = vi.fn().mockReturnValueOnce(acceptance.promise).mockResolvedValue({ deliveryId: "new" });
    const interrupt = vi.fn(async () => {});
    const waitForReply = vi.fn(async () => "Fresh answer");
    const call = new VoiceCall({ transport: fake.transport, submit, interrupt, waitForReply, onEvent: () => {} });
    await call.start();
    fake.handlers().onTranscript("old request");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    call.stop();
    await call.start();
    acceptance.resolve({ deliveryId: "old" });
    await Promise.resolve();
    await Promise.resolve();
    expect(interrupt).not.toHaveBeenCalled();
    expect(waitForReply).not.toHaveBeenCalled();
    expect(fake.spoken).toEqual([]);
    fake.handlers().onTranscript("fresh request");
    await vi.waitFor(() => expect(fake.spoken).toEqual(["Fresh answer"]));
    call.stop();
  });
});

describe("voice call store lifecycle", () => {
  it("ends a failed transport and lets the voice button start a fresh call", async () => {
    const fake = fakeTransport();
    const scope = createRoot((dispose) => ({
      dispose,
      store: createVoiceCallStore({
        requestMicrophoneConsent: () => true,
        target: () => ({ agentId: "agent", serverId: "server" }),
        deliveries: () => [],
        readMessages: async () => [],
        submit: async () => null,
        interrupt: async () => {},
        createTransport: () => fake.transport,
      }),
    }));
    try {
      await scope.store.startCall();
      fake.handlers().onError("Microphone disconnected");
      flush();
      expect(scope.store.voiceCallPhase()).toBe("off");
      await scope.store.startCall();
      flush();
      expect(scope.store.voiceCallPhase()).toBe("listening");
      scope.store.endCall();
    } finally {
      scope.dispose();
    }
  });

  it("shows local inference, returns to listening for silence, and does not overwrite a dispatched turn", async () => {
    const fake = fakeTransport();
    const submit = vi.fn(async () => receipt());
    const scope = createRoot((dispose) => ({
      dispose,
      store: createVoiceCallStore({
        requestMicrophoneConsent: () => true,
        target: () => ({ agentId: "agent", serverId: "server" }),
        deliveries: () => (submit.mock.calls.length ? [delivery()] : []),
        readMessages: async () => [],
        submit,
        interrupt: async () => {},
        createTransport: () => fake.transport,
      }),
    }));
    try {
      await scope.store.startCall();
      fake.handlers().onTranscriptionStarted?.();
      flush();
      expect(scope.store.voiceCallPhase()).toBe("transcribing");
      fake.handlers().onTranscriptionFinished?.();
      flush();
      expect(scope.store.voiceCallPhase()).toBe("listening");
      fake.handlers().onTranscriptionStarted?.();
      flush();
      fake.handlers().onTranscript("accepted request");
      await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
      fake.handlers().onTranscriptionFinished?.();
      flush();
      expect(scope.store.voiceCallPhase()).toBe("thinking");
      expect(fake.spoken).toEqual([]);
    } finally {
      scope.dispose();
    }
  });

  it("unsubscribes on preparation cancellation and never requests a late microphone", async () => {
    installDanidexStub();
    const preparation = Promise.withResolvers<VoiceModelStatus>();
    const removeStatus = vi.fn();
    vi.mocked(window.danidex.voice.onModelStatus).mockReturnValueOnce(removeStatus);
    vi.mocked(window.danidex.voice.prepareModel).mockReturnValueOnce(preparation.promise);
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const scope = createRoot((dispose) => ({
      dispose,
      store: createVoiceCallStore({
        requestMicrophoneConsent: () => true,
        target: () => ({ agentId: "agent", serverId: "server" }),
        deliveries: () => [],
        readMessages: async () => [],
        submit: async () => receipt(),
        interrupt: async () => {},
      }),
    }));
    try {
      const starting = scope.store.startCall();
      flush();
      expect(scope.store.voiceCallPhase()).toBe("preparing");
      scope.store.endCall();
      flush();
      expect(removeStatus).toHaveBeenCalledOnce();
      preparation.resolve({ phase: "ready", progress: 100, message: null });
      await starting;
      flush();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(scope.store.voiceCallPhase()).toBe("off");
      expect(scope.store.voiceCallError()).toBeNull();
      expect(removeStatus).toHaveBeenCalledOnce();
    } finally {
      scope.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("hangs up on a thread switch without cancelling backend work", async () => {
    const fake = fakeTransport();
    const [target, setTarget] = createSignal({ agentId: "agent", serverId: "server" });
    const [deliveries, setDeliveries] = createSignal<QueueDelivery[]>([]);
    const submit = vi.fn(async () => receipt());
    const interrupt = vi.fn(async () => {});
    const readMessages = vi.fn(async () => [agent("late", "Wrong thread")]);
    const scope = createRoot((dispose) => ({
      dispose,
      store: createVoiceCallStore({
        requestMicrophoneConsent: () => true,
        target,
        deliveries,
        readMessages,
        submit,
        interrupt,
        createTransport: () => fake.transport,
      }),
    }));
    try {
      await scope.store.startCall();
      fake.handlers().onTranscript("request");
      await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
      setTarget({ agentId: "other", serverId: "other-server" });
      flush();
      expect(interrupt).not.toHaveBeenCalled();
      setDeliveries([delivery("delivery-1", { status: "completed" })]);
      flush();
      expect(scope.store.voiceCallPhase()).toBe("off");
      expect(fake.spoken).toEqual([]);
      expect(readMessages).not.toHaveBeenCalled();
    } finally {
      scope.dispose();
    }
  });

  it("keeps unavailable local speech visible while listening recovers", async () => {
    const fake = fakeTransport();
    vi.mocked(fake.transport.speak).mockRejectedValueOnce(
      new Error("No local system voice is available. Enable a voice in system settings."),
    );
    const scope = createRoot((dispose) => ({
      dispose,
      store: createVoiceCallStore({
        requestMicrophoneConsent: () => true,
        target: () => ({ agentId: "agent", serverId: "server" }),
        deliveries: () => [delivery("delivery-1", { status: "completed" })],
        readMessages: async () => [agent("answer", "Your table is confirmed for seven.")],
        submit: async () => receipt(),
        interrupt: async () => {},
        createTransport: () => fake.transport,
      }),
    }));
    try {
      await scope.store.startCall();
      fake.handlers().onTranscript("book for seven");
      await vi.waitFor(() => {
        expect(scope.store.voiceCallPhase()).toBe("listening");
        expect(scope.store.voiceCallError()).toBe(
          "No local system voice is available. Enable a voice in system settings.",
        );
      });
      expect(scope.store.voiceCallHeard()).toBe("book for seven");
    } finally {
      scope.dispose();
    }
  });
});

it("waveform uses real input levels and clears on hangup", async () => {
  const fake = fakeTransport();
  const scope = createRoot((dispose) => ({
    dispose,
    store: createVoiceCallStore({
      requestMicrophoneConsent: () => true,
      target: () => ({ agentId: "agent", serverId: "local" }),
      deliveries: () => [],
      readMessages: async () => [],
      submit: async () => null,
      interrupt: async () => {},
      createTransport: () => fake.transport,
    }),
  }));
  try {
    await scope.store.startCall();
    fake.handlers().onInputLevel?.(0.03);
    flush();
    expect(scope.store.voiceCallLevels().at(-1)).toBe(0.03);
    fake.handlers().onInputLevel?.(0);
    flush();
    expect(scope.store.voiceCallLevels().at(-1)).toBe(0);
    scope.store.endCall();
    flush();
    expect(scope.store.voiceCallLevels().every((x) => x === 0)).toBe(true);
  } finally {
    scope.dispose();
  }
});

it("transfers each unaccepted held sentence once to target draft on close, including late final", async () => {
  const fake = fakeTransport();
  fake.transport.closeMicrophone = vi.fn();
  const holdDraft = vi.fn();
  const submit = vi.fn(async () => receipt());
  const scope = createRoot((dispose) => ({
    dispose,
    store: createVoiceCallStore({
      requestMicrophoneConsent: () => true,
      target: () => ({ agentId: "agent", serverId: "local" }),
      deliveries: () => [delivery()],
      readMessages: async () => [],
      submit,
      interrupt: async () => {},
      createTransport: () => fake.transport,
      holdDraft,
    }),
  }));
  await scope.store.startCall();
  fake.handlers().onTranscript("unsent one");
  fake.handlers().onTranscript("unsent two");
  flush();
  expect(scope.store.voiceCallHeard()).toBe("unsent two");
  expect(submit).not.toHaveBeenCalled();
  scope.store.endCall();
  expect(holdDraft).toHaveBeenCalledExactlyOnceWith("unsent one\nunsent two", { agentId: "agent", serverId: "local" });
  fake.handlers().onTranscript("late final");
  expect(holdDraft).toHaveBeenCalledTimes(2);
  expect(holdDraft.mock.calls[1]).toEqual(["late final", { agentId: "agent", serverId: "local" }]);
  expect(submit).not.toHaveBeenCalled();
  scope.dispose();
});

it("does not dispatch the shifted job if mic closes synchronously before submit", async () => {
  const fake = fakeTransport();
  fake.transport.closeMicrophone = vi.fn();
  const submit = vi.fn();
  const held: string[] = [];
  let call: VoiceCall;
  call = new VoiceCall({
    transport: fake.transport,
    submit,
    waitForReply: async () => "answer",
    interrupt: async () => {},
    onEvent: (e) => {
      if (e.type === "phase" && e.phase === "thinking") call.closeMicrophone();
      if (e.type === "held-input") held.push(e.text);
    },
  });
  await call.start();
  fake.handlers().onTranscript("must stay unsent");
  await Promise.resolve();
  await Promise.resolve();
  expect(submit).not.toHaveBeenCalled();
  expect(held).toEqual(["must stay unsent"]);
  call.stop();
});

it("restores definite unaccepted text once after close instead of dropping or retrying", async () => {
  const fake = fakeTransport();
  fake.transport.closeMicrophone = vi.fn();
  const acceptance = Promise.withResolvers<null>();
  const events: VoiceCallEvent[] = [];
  const submit = vi.fn(() => acceptance.promise);
  const call = new VoiceCall({
    transport: fake.transport,
    submit,
    waitForReply: async () => "unused",
    interrupt: async () => {},
    onEvent: (e) => events.push(e),
  });
  await call.start();
  fake.handlers().onTranscript("preserve my unsent words");
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  call.closeMicrophone();
  acceptance.resolve(null);
  await vi.waitFor(() =>
    expect(events.filter((e) => e.type === "held-input")).toEqual([
      { type: "held-input", text: "preserve my unsent words" },
    ]),
  );
  expect(submit).toHaveBeenCalledOnce();
  expect(fake.spoken).toEqual([]);
  call.stop();
});
it("never restores an accepted request when reply fails, avoiding duplicate draft sends", async () => {
  const fake = fakeTransport();
  const events: VoiceCallEvent[] = [];
  const submit = vi.fn(async () => ({ deliveryId: "accepted" }));
  const call = new VoiceCall({
    transport: fake.transport,
    submit,
    waitForReply: async () => {
      throw Error("provider failed after acceptance");
    },
    interrupt: async () => {},
    onEvent: (e) => events.push(e),
  });
  await call.start();
  fake.handlers().onTranscript("accepted text");
  await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true));
  expect(events.filter((e) => e.type === "held-input")).toEqual([]);
  expect(submit).toHaveBeenCalledOnce();
  call.stop();
});

it("keeps an actual denied-mic startup failure visible after ended clears the call", async () => {
  const fake = fakeTransport();
  fake.transport.start = vi.fn(async () => {
    throw Error("Microphone access is not allowed by macOS.");
  });
  const scope = createRoot((dispose) => ({
    dispose,
    store: createVoiceCallStore({
      requestMicrophoneConsent: () => true,
      target: () => ({ agentId: "agent", serverId: "local" }),
      deliveries: () => [],
      readMessages: async () => [],
      submit: async () => null,
      interrupt: async () => {},
      createTransport: () => fake.transport,
    }),
  }));
  await scope.store.startCall();
  flush();
  expect(scope.store.voiceCallPhase()).toBe("off");
  expect(scope.store.voiceCallError()).toBe("Microphone access is not allowed by macOS.");
  scope.dispose();
});

it("never dumps later FIFO after first reply fails, and closes remaining text into draft", async () => {
  const fake = fakeTransport();
  fake.transport.closeMicrophone = vi.fn();
  const answer = Promise.withResolvers<string>();
  const events: VoiceCallEvent[] = [];
  const submit = vi.fn(async () => ({ deliveryId: "first" }));
  const call = new VoiceCall({
    transport: fake.transport,
    submit,
    waitForReply: () => answer.promise,
    interrupt: async () => {},
    onEvent: (e) => events.push(e),
  });
  await call.start();
  fake.handlers().onTranscript("accepted first");
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  fake.handlers().onTranscript("queued second");
  answer.reject(Error("model unavailable"));
  await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true));
  fake.handlers().onTranscript("queued third");
  await Promise.resolve();
  await Promise.resolve();
  expect(submit).toHaveBeenCalledOnce();
  call.closeMicrophone();
  expect(events.filter((e) => e.type === "held-input")).toEqual([
    { type: "held-input", text: "queued second\nqueued third" },
  ]);
  expect(submit).toHaveBeenCalledOnce();
  call.stop();
});
it("keeps FIFO frozen on uncertain acceptance without retrying ambiguous first text", async () => {
  const fake = fakeTransport();
  fake.transport.closeMicrophone = vi.fn();
  const submit = vi.fn(async () => {
    throw Error("receipt lost");
  });
  const events: VoiceCallEvent[] = [];
  const call = new VoiceCall({
    transport: fake.transport,
    submit,
    waitForReply: async () => "unused",
    interrupt: async () => {},
    onEvent: (e) => events.push(e),
  });
  await call.start();
  fake.handlers().onTranscript("uncertain first");
  await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true));
  fake.handlers().onTranscript("keep second");
  await Promise.resolve();
  await Promise.resolve();
  expect(submit).toHaveBeenCalledOnce();
  call.closeMicrophone();
  expect(events.filter((e) => e.type === "held-input")).toEqual([{ type: "held-input", text: "keep second" }]);
  call.stop();
});

it("publishes only unsent FIFO lines to the normal queue display", async () => {
  const fake = fakeTransport();
  const reply = Promise.withResolvers<string>();
  const events: VoiceCallEvent[] = [];
  const submit = vi.fn(async () => ({ deliveryId: "accepted" }));
  const call = new VoiceCall({
    transport: fake.transport,
    submit,
    waitForReply: () => reply.promise,
    interrupt: async () => {},
    onEvent: (event) => events.push(event),
  });
  await call.start();
  fake.handlers().onTranscript("accepted first");
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  fake.handlers().onTranscript("waiting second");
  fake.handlers().onTranscript("waiting third");
  expect(events.filter((event) => event.type === "queued-input").at(-1)).toEqual({
    type: "queued-input",
    count: 2,
    lines: ["waiting second", "waiting third"],
  });
  call.closeMicrophone();
  expect(events.filter((event) => event.type === "queued-input").at(-1)).toEqual({ type: "queued-input", count: 0 });
  expect(events.filter((event) => event.type === "held-input")).toEqual([
    { type: "held-input", text: "waiting second\nwaiting third" },
  ]);
  call.stop();
  reply.resolve("done");
});
