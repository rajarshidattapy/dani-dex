/** Internal demo speech route: avoid seven-language auto detection. */
export function transcriptionOptions() {
  return { language: "en" as const, engine: "whisper" as const };
}
