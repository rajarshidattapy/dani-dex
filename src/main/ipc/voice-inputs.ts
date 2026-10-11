import { INPUT_LIMITS } from "@dani-dex/contracts/input-limits";
import {
  VOICE_AUDIO_LIMITS,
  type VoiceDetectionInput,
  type VoiceSpeechInput,
  type VoiceTranscriptionInput,
} from "@dani-dex/contracts/ipc";
import { isObject, requireString } from "./validation";

export function parseVoiceTranscription(input: unknown): VoiceTranscriptionInput {
  if (!isObject(input) || !(input.audio instanceof Uint8Array)) {
    throw new Error("Voice audio is required.");
  }
  const audio = input.audio;
  if (audio.byteLength < 44 || audio.byteLength > VOICE_AUDIO_LIMITS.maximumWavBytes) {
    throw new Error("Voice audio has an invalid length.");
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (
    ascii(audio, 0, 4) !== "RIFF" ||
    ascii(audio, 8, 12) !== "WAVE" ||
    ascii(audio, 12, 16) !== "fmt " ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== VOICE_AUDIO_LIMITS.channels ||
    view.getUint32(24, true) !== VOICE_AUDIO_LIMITS.sampleRate ||
    view.getUint16(34, true) !== VOICE_AUDIO_LIMITS.bitsPerSample ||
    ascii(audio, 36, 40) !== "data" ||
    view.getUint32(40, true) !== audio.byteLength - 44
  ) {
    throw new Error("Voice audio must be a 16 kHz mono PCM WAV file.");
  }
  if (input.language !== undefined && input.language !== "en" && input.language !== "hi" && input.language !== "bn")
    throw new Error("Unsupported speech language.");
  if (input.engine !== undefined && input.engine !== "whisper") throw new Error("Unsupported speech engine.");
  return {
    id: requireString(input.id, "Voice transcription id"),
    audio,
    ...(input.language ? { language: input.language } : {}),
    ...(input.engine ? { engine: "whisper" as const } : {}),
  };
}

export function parseVoiceSpeech(input: unknown): VoiceSpeechInput {
  if (!isObject(input)) throw new Error("Voice speech is required.");
  return {
    id: requireString(input.id, "Voice speech id"),
    text: requireString(input.text, "Voice speech text", INPUT_LIMITS.messageText),
  };
}

export function parseVoiceDetection(input: unknown): VoiceDetectionInput {
  if (!isObject(input) || !(input.samples instanceof Float32Array)) throw new Error("Voice samples are required.");
  const samples = input.samples;
  if (
    samples.length < 512 ||
    samples.length > 4_096 ||
    samples.length % 512 !== 0 ||
    samples.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)
  ) {
    throw new Error("Voice samples must be complete 16 kHz mono speech detection windows.");
  }
  return { id: requireString(input.id, "Voice detection id"), samples };
}

function ascii(value: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...value.subarray(start, end));
}
