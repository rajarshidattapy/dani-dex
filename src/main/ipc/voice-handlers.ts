import { isDynamicRecord } from "@dani-dex/contracts/runtime-values";
import type { CodexRealtimeService } from "../codex-realtime-service";
// The local Whisper model, dictation, and Realtime call credentials.

import type {
  ProviderApiKeyStatus,
  RealtimeVoiceSession,
  VoiceModelStatus,
  VoiceSpeechInput,
  VoiceTranscriptionResult,
} from "@dani-dex/contracts/ipc";
import { isString } from "@dani-dex/contracts/runtime-values";
import { type Event, type IpcMainInvokeEvent, systemPreferences } from "electron";
import type { OpenAiRealtimeSessionService } from "../openai-realtime-session";
import { type ProviderCredentialStore, REALTIME_CREDENTIAL_ID } from "../provider-credential-store";
import type { VoiceActivityService } from "../voice-activity-service";
import type { VoiceTranscriptionService } from "../voice-transcription-service";
import { authorizedHandler, handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { stringPayload } from "./validation";
import { parseVoiceDetection, parseVoiceSpeech, parseVoiceTranscription } from "./voice-inputs";

/** Long enough for any OpenAI key, short enough that nothing large reaches the cipher. */
const MAX_REALTIME_API_KEY_LENGTH = 512;

export interface VoiceIpcDependencies {
  codex: Pick<CodexRealtimeService, "status" | "connect" | "start" | "stop">;
  voice: Pick<VoiceTranscriptionService, "getModelStatus" | "prepareModel" | "transcribe">;
  activity: Pick<VoiceActivityService, "start" | "detect" | "stop">;
  speech: {
    prepare?(): Promise<void>;
    speak(input: VoiceSpeechInput): Promise<Uint8Array | void>;
    stop(id: string): Promise<void>;
  };
  mainRendererId: () => number | null;
  realtime: Pick<OpenAiRealtimeSessionService, "create">;
  credentials: Pick<ProviderCredentialStore, "set" | "clear" | "status">;
}

export function voiceIpcHandlers({
  voice,
  activity,
  speech,
  mainRendererId,
  codex,
  realtime,
  credentials,
}: VoiceIpcDependencies): Pick<IpcGroupHandlers, "voice"> {
  const fromMainRenderer = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== mainRendererId() || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Rejected local speech request from a renderer that does not own the conversation.");
  };
  const transcriptions = new Map<string, { controller: AbortController; done: Promise<VoiceTranscriptionResult> }>();
  const detections = new Map<string, () => void>();
  const own = (event: IpcMainInvokeEvent, stop: () => void): (() => void) => {
    const navigation = (_event: Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) stop();
    };
    event.sender.once("destroyed", stop);
    event.sender.once("render-process-gone", stop);
    event.sender.on("did-start-navigation", navigation);
    return () => {
      event.sender.removeListener("destroyed", stop);
      event.sender.removeListener("render-process-gone", stop);
      event.sender.removeListener("did-start-navigation", navigation);
    };
  };
  return {
    voice: {
      codexStatus: handler(() => codex.status()),
      codexConnect: handler(() => codex.connect()),
      codexStop: handler(() => codex.stop()),
      codexStart: payloadHandler(
        (value: unknown) => {
          if (!isDynamicRecord(value) || typeof value.sdp !== "string" || value.consent !== true)
            throw new Error("A WebRTC offer and explicit plan-usage consent are required.");
          return { sdp: value.sdp, consent: true };
        },
        (input) => codex.start(input.sdp, input.consent),
      ),
      requestMicrophoneAccess: authorizedHandler(
        fromMainRenderer,
        () => undefined,
        async () => {
          if (process.platform !== "darwin") return true;
          const granted = await systemPreferences.askForMediaAccess("microphone");

          return granted;
        },
      ),
      getModelStatus: handler((): Promise<VoiceModelStatus> => voice.getModelStatus()),
      prepareModel: handler(async (): Promise<VoiceModelStatus> => {
        const status = await voice.prepareModel();
        if (status.phase === "ready") await speech.prepare?.();
        return status;
      }),
      transcribe: authorizedHandler(fromMainRenderer, parseVoiceTranscription, async (event, input) => {
        if (transcriptions.has(input.id)) throw new Error("This voice transcription is already in progress.");
        const controller = new AbortController();
        const release = own(event, () => controller.abort());
        const done = voice.transcribe(input.audio, controller.signal, input);
        transcriptions.set(input.id, { controller, done });
        try {
          return await done;
        } finally {
          transcriptions.delete(input.id);
          release();
        }
      }),
      cancelTranscription: authorizedHandler(
        fromMainRenderer,
        stringPayload("Voice transcription id"),
        async (_event, id) => {
          const request = transcriptions.get(id);
          if (!request) return;
          request.controller.abort();
          await request.done.catch(() => undefined);
        },
      ),
      startLocalDetection: authorizedHandler(
        fromMainRenderer,
        stringPayload("Voice detection id"),
        async (event, id) => {
          for (const [previous, release] of detections) {
            release();
            detections.delete(previous);
            await activity.stop(previous);
          }
          const stop = () => {
            const release = detections.get(id);
            release?.();
            detections.delete(id);
            void activity.stop(id);
          };
          const release = own(event, stop);
          detections.set(id, release);
          try {
            await activity.start(id);
          } catch (error) {
            if (detections.get(id) === release) {
              release();
              detections.delete(id);
            }
            throw error;
          }
        },
      ),
      detectLocalSpeech: authorizedHandler(fromMainRenderer, parseVoiceDetection, (_event, input) =>
        activity.detect(input),
      ),
      stopLocalDetection: authorizedHandler(
        fromMainRenderer,
        stringPayload("Voice detection id"),
        async (_event, id) => {
          detections.get(id)?.();
          detections.delete(id);
          await activity.stop(id);
        },
      ),
      speakLocal: authorizedHandler(fromMainRenderer, parseVoiceSpeech, async (event, input) => {
        const stop = () => {
          void speech.stop(input.id);
        };
        const stopOnNavigation = (_event: Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
          if (isMainFrame && !isInPlace) stop();
        };
        const owner = event.sender;
        owner.once("destroyed", stop);
        owner.once("render-process-gone", stop);
        owner.on("did-start-navigation", stopOnNavigation);
        try {
          return await speech.speak(input);
        } finally {
          owner.removeListener("destroyed", stop);
          owner.removeListener("render-process-gone", stop);
          owner.removeListener("did-start-navigation", stopOnNavigation);
        }
      }),
      stopLocal: authorizedHandler(fromMainRenderer, stringPayload("Voice speech id"), (_event, id) => speech.stop(id)),
      createRealtimeSession: handler((): Promise<RealtimeVoiceSession> => realtime.create()),
      // A status, never the key, as with provider keys.
      setRealtimeApiKey: payloadHandler(parseRealtimeApiKey, async (key): Promise<ProviderApiKeyStatus> => {
        await credentials.set(REALTIME_CREDENTIAL_ID, key);
        return credentials.status(REALTIME_CREDENTIAL_ID);
      }),
      clearRealtimeApiKey: handler(async (): Promise<ProviderApiKeyStatus> => {
        await credentials.clear(REALTIME_CREDENTIAL_ID);
        return credentials.status(REALTIME_CREDENTIAL_ID);
      }),
      getRealtimeApiKeyStatus: handler(
        async (): Promise<ProviderApiKeyStatus> => credentials.status(REALTIME_CREDENTIAL_ID),
      ),
    },
  };
}

/** The one place the user's OpenAI key enters the main process from the renderer. */
export function parseRealtimeApiKey(value: unknown): string {
  if (!isString(value) || !value.trim()) throw new Error("An OpenAI API key is required.");
  if (value.length > MAX_REALTIME_API_KEY_LENGTH) throw new Error("The OpenAI API key is too long.");
  return value.trim();
}
