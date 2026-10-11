import { expect, it } from "vitest";
import { transcriptionOptions } from "./speech-preferences";

it("uses the internal English Whisper route regardless of stale picker storage", () => {
  localStorage.setItem("dani-dex.speech-choice.v1", "auto");
  expect(transcriptionOptions()).toEqual({ language: "en", engine: "whisper" });
  localStorage.removeItem("dani-dex.speech-choice.v1");
});
