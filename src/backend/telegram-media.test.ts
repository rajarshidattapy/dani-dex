import { expect, it, vi } from "vitest";
import { fetchReviewedTelegramMedia, telegramMediaManifest } from "./telegram-media";
import type { TelegramUpdate } from "./telegram-transport";

function requiredManifest(event: TelegramUpdate) {
  const manifest = telegramMediaManifest(event);
  if (!manifest) throw Error("Missing media fixture");
  return manifest;
}
const update = () => ({
  update_id: 4,
  message: {
    message_id: 1,
    chat: { id: 12 },
    from: { id: 7 },
    caption: "Read this",
    document: {
      file_id: "f1",
      file_unique_id: "u1",
      file_name: "../../release.pdf",
      mime_type: "application/pdf",
      file_size: 3,
    },
  },
});
it("preserves exact update/message/source provenance and safe name without trusting MIME", () => {
  const manifest = telegramMediaManifest(update());
  expect(manifest).toMatchObject({
    updateId: "4",
    messageId: "1",
    conversationId: "12",
    senderId: "7",
    kind: "document",
    safeName: "release.pdf",
    claimedMimeType: "application/pdf",
    edited: false,
  });
  expect(manifest?.reviewDigest).toHaveLength(64);
});
it("changes review digest when caption, sender, file or edit identity changes", () => {
  const original = update();
  const digest = telegramMediaManifest(original)?.reviewDigest;
  for (const changed of [
    { ...original, update_id: 5 },
    { ...original, message: { ...original.message, caption: "Changed" } },
    { ...original, message: { ...original.message, from: { id: 8 } } },
    { ...original, message: { ...original.message, document: { file_id: "f2", file_unique_id: "u1" } } },
    { update_id: 4, edited_message: original.message },
  ])
    expect(telegramMediaManifest(changed)?.reviewDigest).not.toBe(digest);
});
it("does not normalize edited content into an original request", () => {
  const original = update();
  expect(telegramMediaManifest({ update_id: 5, edited_message: original.message })?.edited).toBe(true);
});
it("refuses bot, ambiguous, invalid and oversize media, does not infer consent", () => {
  const original = update();
  for (const changed of [
    { ...original, message: { ...original.message, from: { id: 7, is_bot: true } } },
    { ...original, message: { ...original.message, from: undefined } },
    { ...original, message: { ...original.message, voice: { file_id: "v", file_unique_id: "u" } } },
    {
      ...original,
      message: { ...original.message, document: { file_id: "f", file_unique_id: "u", file_size: 21 * 1024 * 1024 } },
    },
    { ...original, message: { ...original.message, document: { file_id: "f" } } },
  ])
    expect(telegramMediaManifest(changed)).toBeNull();
});
it("uses a safe fallback for empty/path/control-only names and records unknown size", () => {
  const original = update();
  const manifest = telegramMediaManifest({
    ...original,
    message: { ...original.message, document: { file_id: "f", file_unique_id: "u", file_name: "..\\\u0000" } },
  });
  expect(manifest).toMatchObject({ safeName: "document.bin", size: null });
});
it("rechecks exact owner/source authority after download before releasing any bytes", async () => {
  const event = update();
  const reviewedDigest = requiredManifest(event).reviewDigest;
  const validateOwnerSource = vi.fn();
  const download = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const result = await fetchReviewedTelegramMedia({ update: event, reviewedDigest, validateOwnerSource, download });
  expect([...result.bytes]).toEqual([1, 2, 3]);
  expect(validateOwnerSource).toHaveBeenCalledTimes(2);
  let enabled = true;
  await expect(
    fetchReviewedTelegramMedia({
      update: event,
      reviewedDigest,
      validateOwnerSource: () => {
        if (!enabled) throw Error("Revoked");
      },
      download: async () => {
        enabled = false;
        return new Uint8Array([1, 2, 3]);
      },
    }),
  ).rejects.toThrow("Revoked");
});
it("will not fetch stale review, separately reviewed edit or revoked source", async () => {
  const event = update();
  const download = vi.fn(async () => new Uint8Array([1, 2, 3]));
  await expect(
    fetchReviewedTelegramMedia({ update: event, reviewedDigest: "wrong", validateOwnerSource: () => {}, download }),
  ).rejects.toThrow("Media review no longer matches.");
  const edit = { update_id: 5, edited_message: event.message };
  await expect(
    fetchReviewedTelegramMedia({
      update: edit,
      reviewedDigest: requiredManifest(edit).reviewDigest,
      validateOwnerSource: () => {},
      download,
    }),
  ).rejects.toThrow("separate change review");
  await expect(
    fetchReviewedTelegramMedia({
      update: event,
      reviewedDigest: requiredManifest(event).reviewDigest,
      validateOwnerSource: () => {
        throw Error("Revoked");
      },
      download,
    }),
  ).rejects.toThrow("Revoked");
  expect(download).not.toHaveBeenCalled();
});
