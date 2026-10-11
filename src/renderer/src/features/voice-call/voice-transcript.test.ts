import { describe, expect, it } from "vitest";
import { isRepetitiveVoiceTranscript, usableVoiceTranscript } from "./voice-transcript";

describe("voice transcript", () => {
  it("rejects silence and Whisper no-speech markers", () => {
    for (const text of [
      "",
      " ",
      "[BLANK_AUDIO]",
      "[no speech]",
      "[silence]",
      "[music]",
      "[inaudible]",
      "[BLANK_AUDIO] [silence]",
    ]) {
      expect(usableVoiceTranscript(text)).toBe("");
    }
  });
  it("preserves real words without rewriting their meaning", () => {
    expect(usableVoiceTranscript("  Dani, read my notes.  ")).toBe("Dani, read my notes.");
    expect(usableVoiceTranscript("Explain the [BLANK_AUDIO] error")).toBe("Explain the [BLANK_AUDIO] error");
  });
});

describe("repetitive voice output", () => {
  it("flags repeated-only output across languages without treating Arabic as an error", () => {
    expect(isRepetitiveVoiceTranscript("هلو هلو هلو هلو هلو هلو")).toBe(true);
    expect(isRepetitiveVoiceTranscript("hello, hello hello hello hello hello")).toBe(true);
    expect(isRepetitiveVoiceTranscript("thank you ".repeat(6))).toBe(true);
    expect(isRepetitiveVoiceTranscript("مرحبا أريد قراءة ملاحظاتي اليوم")).toBe(false);
    expect(isRepetitiveVoiceTranscript("hello hello")).toBe(false);
    expect(isRepetitiveVoiceTranscript("Say hello hello hello hello hello hello to Dani")).toBe(false);
  });
});

it("rejects annotation-only room noise without rejecting ordinary words", () => {
  expect(usableVoiceTranscript("(murmur)")).toBe("");
  expect(usableVoiceTranscript("(people chattering) (people chattering)")).toBe("");
  expect(usableVoiceTranscript("Thank you.")).toBe("Thank you.");
});

it("refuses actual five-word and sixteen-word floods, truncated final loops and generated suffixes", () => {
  expect(isRepetitiveVoiceTranscript("Wait what are you doing ".repeat(30) + "Wait what")).toBe(true);
  expect(
    isRepetitiveVoiceTranscript(
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen ".repeat(8),
    ),
  ).toBe(true);
  expect(isRepetitiveVoiceTranscript("This is a useful opening. " + "means ".repeat(100))).toBe(true);
  expect(isRepetitiveVoiceTranscript("Please say hello hello hello hello hello hello to Dani.")).toBe(false);
  expect(isRepetitiveVoiceTranscript("Wait, what are you doing?")).toBe(false);
});
