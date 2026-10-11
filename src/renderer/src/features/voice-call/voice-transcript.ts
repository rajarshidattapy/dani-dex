/** Whisper can return non-speech annotations instead of words. Never dispatch them as a task. */
export function usableVoiceTranscript(raw: string): string {
  const text = raw.trim();
  if (/^(?:\[(?:blank[_ ]audio|no[_ ]speech|silence|music|inaudible)\]\s*)+$/iu.test(text)) return "";
  if (/^(?:\((?:murmur|people chattering|music|silence|inaudible|background noise)\)\s*)+$/iu.test(text)) return "";
  return text;
}

/** Repeated-only output is ambiguous. Ask for a retry instead of turning it into an agent task. */
export function isRepetitiveVoiceTranscript(text: string): boolean {
  const tokens =
    text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length < 6) return false;
  // Whole repeated-only output, including a final truncated repetition. Never rewrite it.
  for (let size = 1; size <= Math.min(128, Math.floor(tokens.length / 6)); size += 1) {
    if (tokens.every((token, index) => token === tokens[index % size])) return true;
  }
  // Severe generated suffix loops are unsafe even when an opening sentence is valid.
  // Require >=8 cycles and >=32 tokens. Do not rewrite or truncate the guessed output.
  for (let size = 1; size <= Math.min(128, Math.floor(tokens.length / 8)); size += 1) {
    let matched = 0;
    const lastCycle = tokens.slice(-size);
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (tokens[index] !== lastCycle[(index - (tokens.length - size) + tokens.length * size) % size]) break;
      matched += 1;
    }
    if (matched >= 32 && matched >= size * 8) return true;
  }
  return false;
}
