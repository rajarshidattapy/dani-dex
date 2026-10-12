import { createHash } from "node:crypto";
import { z } from "zod";
import { TELEGRAM_FILE_BYTES_LIMIT, type TelegramUpdate } from "./telegram-transport";

const media = z.object({
  file_id: z.string().min(1).max(512),
  file_unique_id: z.string().min(1).max(512),
  file_size: z.number().int().nonnegative().safe().optional(),
  file_name: z.string().max(1024).optional(),
  mime_type: z.string().max(128).optional(),
});
export interface TelegramMediaManifest {
  updateId: string;
  messageId: string;
  conversationId: string;
  senderId: string;
  kind: "voice" | "document";
  fileId: string;
  uniqueId: string;
  size: number | null;
  /** Claimed by the sender, not proof of content type. */
  claimedMimeType: string | null;
  safeName: string;
  caption: string;
  edited: boolean;
  /** Bind owner review to the exact metadata, not to an unsupported-media marker. */
  reviewDigest: string;
}
/** Parsing only. Does not authenticate sender, pair a source, fetch, transcribe, or deliver. */
export function telegramMediaManifest(update: TelegramUpdate): TelegramMediaManifest | null {
  const message = update.message ?? update.edited_message;
  if (!message || !message.from || message.from.is_bot || (message.voice && message.document)) return null;
  const kind = message.voice ? "voice" : message.document ? "document" : null;
  if (!kind) return null;
  const parsed = media.safeParse(kind === "voice" ? message.voice : message.document);
  if (!parsed.success || (parsed.data.file_size ?? 0) > TELEGRAM_FILE_BYTES_LIMIT) return null;
  const file = parsed.data;
  // Preserve no remote filesystem path. A displayed name is not a destination path.
  const name = file.file_name
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  const safeName =
    name && name !== "." && name !== ".." ? name.slice(0, 120) : kind === "voice" ? "voice.ogg" : "document.bin";
  const fields = {
    updateId: String(update.update_id),
    messageId: String(message.message_id),
    conversationId: String(message.chat.id),
    senderId: String(message.from.id),
    kind,
    fileId: file.file_id,
    uniqueId: file.file_unique_id,
    size: file.file_size ?? null,
    claimedMimeType: file.mime_type ?? null,
    safeName,
    caption: message.caption ?? "",
    edited: Boolean(update.edited_message),
  };
  return { ...fields, reviewDigest: createHash("sha256").update(JSON.stringify(fields)).digest("hex") };
}

export interface ReviewedTelegramMedia {
  manifest: TelegramMediaManifest;
  bytes: Uint8Array;
}
/** Local orchestration only. A digest match is not consent: caller must re-read the owner/source grant. */
export async function fetchReviewedTelegramMedia(input: {
  update: TelegramUpdate;
  reviewedDigest: string;
  validateOwnerSource: () => void;
  download: (fileId: string) => Promise<Uint8Array>;
}): Promise<ReviewedTelegramMedia> {
  const manifest = telegramMediaManifest(input.update);
  if (!manifest || manifest.reviewDigest !== input.reviewedDigest) throw new Error("Media review no longer matches.");
  // Edits must be separately reviewed as changes, never replayed as a fresh request by this path.
  if (manifest.edited) throw new Error("Telegram edit requires separate change review.");
  input.validateOwnerSource();
  const bytes = await input.download(manifest.fileId);
  input.validateOwnerSource();
  if (bytes.byteLength > TELEGRAM_FILE_BYTES_LIMIT || (manifest.size !== null && bytes.byteLength !== manifest.size))
    throw new Error("Telegram media size mismatch.");
  return { manifest, bytes };
}
