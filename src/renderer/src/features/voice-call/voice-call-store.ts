import type { QueueDelivery, QueuedMessageReceipt } from "@dani-dex/contracts/ipc";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { AgentMessage } from "../../data";
import { errorMessage } from "../../error-message";
import { waitForAgentReply } from "./agent-reply";
import { BackgroundVoiceCall } from "./background-voice-call";
import { createLocalVoiceTransport } from "./local-voice-transport";
import { RealtimeVoiceTransport } from "./realtime-voice-transport";
import { VoiceCall, type VoiceCallEvent, type VoiceCallTransport } from "./voice-call";

export type VoiceCallPhase =
  | "off"
  | "preparing"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";
export type VoiceCallMode = "local" | "realtime" | "background";

export interface VoiceCallTarget {
  agentId: string;
  serverId: string;
}

export interface VoiceCallStoreDeps {
  target: () => VoiceCallTarget | undefined;
  deliveries: () => readonly QueueDelivery[];
  failure?: () => string | null;
  readMessages: (
    target: VoiceCallTarget,
    delivery: QueueDelivery,
    signal: AbortSignal,
  ) => Promise<readonly AgentMessage[]>;
  /** Preserve the ordinary submit receipt so queued work stays bound to this utterance. */
  submit: (text: string, target: VoiceCallTarget) => Promise<QueuedMessageReceipt | null>;
  holdDraft?: (text: string, target: VoiceCallTarget) => void;
  interrupt: (deliveryId: string, target: VoiceCallTarget) => Promise<void>;
  createTransport?: () => VoiceCallTransport;
  requestMicrophoneConsent?: () => boolean;
}

export function createBrowserRealtimeTransport(): VoiceCallTransport {
  return new RealtimeVoiceTransport({
    createSession: () => window.danidex.voice.createRealtimeSession(),
    getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
    createPeerConnection: () => new RTCPeerConnection(),
    createAudioElement: () => new Audio(),
    fetch: (url, init) => fetch(url, init),
  });
}

export function createVoiceCallStore(deps: VoiceCallStoreDeps) {
  const [phase, setPhase] = createSignal<VoiceCallPhase>("off");
  const [error, setError] = createSignal<string | null>(null);
  const [levels, setLevels] = createSignal<number[]>(Array(16).fill(0));
  const [heard, setHeard] = createSignal<string | null>(null);
  const [muted, setMuted] = createSignal(false);
  const [queuedInputs, setQueuedInputs] = createSignal(0);
  const [queuedLines, setQueuedLines] = createSignal<readonly string[]>([]);
  const [progress, setProgress] = createSignal<number | null>(null);
  let call: VoiceCall | BackgroundVoiceCall | undefined;
  const detachedResponses = new Set<VoiceCall>();
  let responseTarget: VoiceCallTarget | undefined;
  let removeModelStatus: (() => void) | undefined;

  function handleEvent(event: VoiceCallEvent): void {
    switch (event.type) {
      case "queued-input":
        setQueuedInputs(event.count);
        setQueuedLines(event.lines ?? []);
        return;
      case "input-level":
        setLevels((previous) => [...previous.slice(-15), event.level]);
        return;
      case "connecting":
        setPhase("connecting");
        return;
      case "ended":
        call = undefined;
        removeModelStatus?.();
        removeModelStatus = undefined;
        setPhase("off");
        setProgress(null);
        return;
      case "transcript":
        setHeard(event.text);
        setError(null);
        return;
      case "error":
        setError(event.message);
        return;
      case "phase":
        if (event.phase === "listening") setPhase("listening");
        else if (event.phase === "transcribing") setPhase("transcribing");
        else if (event.phase === "thinking") setPhase("thinking");
        else if (event.phase === "speaking") setPhase("speaking");
        return;
      default:
        return;
    }
  }

  async function startCall(mode: VoiceCallMode = "local"): Promise<void> {
    const target = deps.target();
    if (!target || call) return;
    const consent =
      deps.requestMicrophoneConsent ??
      (() =>
        window.confirm(
          mode === "background"
            ? "Test background voice? Each sentence is sent to this chat as work. Talking over a reply stops only the audio. Ending the call stops the microphone but does not cancel accepted work; use the chat queue controls to stop jobs. Allow microphone access in the macOS prompt if it appears."
            : "Use your microphone for this voice call? Dani-Dex will listen until you end the call and send each sentence to this chat after a pause. Allow microphone access in the macOS prompt if it appears.",
        ));
    if (!consent()) return;
    setMuted(false);
    setError(null);
    setHeard(null);
    setProgress(null);
    responseTarget = target;
    const transport =
      deps.createTransport?.() ??
      (mode === "realtime" ? createBrowserRealtimeTransport() : createLocalVoiceTransport());
    const Coordinator = mode === "background" ? BackgroundVoiceCall : VoiceCall;
    const current = new Coordinator({
      transport,
      submit: async (text) => {
        const receipt = await deps.submit(text, target);
        const delivery = receipt?.deliveries.find((item) => item.recipientAgentId === target.agentId);
        return delivery ? { deliveryId: delivery.id } : null;
      },
      waitForReply: ({ deliveryId }, signal) =>
        waitForAgentReply(
          {
            deliveries: deps.deliveries,
            failure: deps.failure,
            readMessages: (delivery, signal) => deps.readMessages(target, delivery, signal),
          },
          deliveryId,
          signal,
        ),
      waitUntilIdle: async (signal) => {
        while (
          deps
            .deliveries()
            .some(
              (item) =>
                item.recipientAgentId === target.agentId &&
                (item.status === "queued" || item.status === "starting" || item.status === "running"),
            )
        ) {
          if (signal.aborted) throw new DOMException("Stopped", "AbortError");
          const failure = deps.failure?.();
          if (failure) throw new Error(failure);
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(new DOMException("Stopped", "AbortError"));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, 100);
            signal.addEventListener("abort", abort, { once: true });
          });
        }
      },
      interrupt: ({ deliveryId }) => deps.interrupt(deliveryId, target),
      onEvent: (event) => {
        if (call === current) handleEvent(event);
        else if (current instanceof VoiceCall && detachedResponses.has(current) && event.type === "queued-input") {
          setQueuedInputs(event.count);
          setQueuedLines(event.lines ?? []);
        }
        if (event.type === "held-input") deps.holdDraft?.(event.text, target);
      },
    });
    call = current;
    setPhase(mode !== "realtime" ? "preparing" : "connecting");
    try {
      if (mode !== "realtime" && !deps.createTransport) {
        const remove = window.danidex.voice.onModelStatus((status) => {
          if (call === current) setProgress(status.progress);
        });
        removeModelStatus = remove;
        try {
          const status = await window.danidex.voice.prepareModel();
          if (call !== current) return;
          if (status.phase !== "ready") {
            throw new Error(status.message ?? "Could not prepare the voice model. Try again.");
          }
        } finally {
          if (removeModelStatus === remove) {
            remove();
            removeModelStatus = undefined;
          }
        }
      }
      if (call !== current) return;
      await current.start();
    } catch (failure) {
      if (call !== current) return;
      call = undefined;
      setPhase("off");
      setProgress(null);
      setError(callStartError(failure));
    }
  }

  function finishCall(preserveResponse = true): void {
    const current = call;
    call = undefined;
    removeModelStatus?.();
    removeModelStatus = undefined;
    if (preserveResponse && current instanceof VoiceCall) {
      detachedResponses.add(current);
      current.closeMicrophone();
    } else {
      current?.stop();
      for (const response of detachedResponses) response.stop();
      detachedResponses.clear();
      responseTarget = undefined;
    }
    setPhase("off");
    setLevels(Array(16).fill(0));
    setProgress(null);
  }

  // A call belongs to one thread: switching agents or servers hangs up rather than reading another
  // thread's replies aloud.
  createEffect(
    () => deps.target(),
    (target) => {
      if (
        responseTarget &&
        (target?.agentId !== responseTarget.agentId || target?.serverId !== responseTarget.serverId)
      ) {
        finishCall(false);
      }
    },
  );
  onCleanup(() => finishCall(false));

  return {
    voiceCallLevels: levels,
    voiceCallPhase: phase,
    voiceCallError: error,
    voiceCallHeard: heard,
    voiceCallProgress: progress,
    voiceCallQueuedInputs: queuedInputs,
    voiceCallQueuedLines: queuedLines,
    voiceCallMuted: muted,
    toggleVoiceCallMute: () => {
      if (!(call instanceof VoiceCall)) return;
      const next = !muted();
      call.setMuted(next);
      setMuted(next);
    },
    startCall,
    endCall: () => finishCall(),
  };
}

export type VoiceCallStore = ReturnType<typeof createVoiceCallStore>;

function callStartError(failure: unknown): string {
  if (failure instanceof DOMException && (failure.name === "NotAllowedError" || failure.name === "SecurityError")) {
    return "Microphone access is blocked. Allow Dani-Dex to use the microphone in system settings.";
  }
  if (failure instanceof DOMException && failure.name === "NotFoundError") return "No microphone is available.";
  return errorMessage(failure, "Could not start the voice call. Try again.");
}
