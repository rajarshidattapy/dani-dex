import { z } from "zod";
export const TELEGRAM_FILE_BYTES_LIMIT = 20 * 1024 * 1024;

const telegramMessage = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int() }),
  from: z.object({ id: z.number().int(), is_bot: z.boolean().optional() }).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: z.unknown().optional(),
  document: z.unknown().optional(),
});
export const telegramUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  message: telegramMessage.optional(),
  edited_message: telegramMessage.optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdate>;
export class TelegramTransportError extends Error {
  constructor(readonly retryAfterSeconds: number | null = null) {
    super("Telegram request failed.");
  }
}
/** Credentials stay at the HTTP boundary and never enter model context, URLs in logs, or errors. */
export class TelegramTransport {
  constructor(
    private readonly token: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}
  async identity(signal?: AbortSignal): Promise<{ id: string; username: string }> {
    const result = await this.call("getMe", {}, signal);
    const bot = z
      .object({ id: z.number().int().positive().safe(), is_bot: z.literal(true), username: z.string().min(1) })
      .parse(result);
    return { id: String(bot.id), username: bot.username };
  }
  async updates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Telegram offset.");
    const result = await this.call(
      "getUpdates",
      { offset, timeout: 20, limit: 50, allowed_updates: ["message", "edited_message"] },
      signal,
    );
    return z.array(telegramUpdate).max(50).parse(result);
  }
  async send(conversationId: string, body: string, signal?: AbortSignal): Promise<string> {
    if (!/^-?\d+$/.test(conversationId) || !body.trim() || body.length > 4096)
      throw new Error("Invalid Telegram reply.");
    const result = await this.call("sendMessage", { chat_id: conversationId, text: body }, signal);
    return String(z.object({ message_id: z.number().int() }).parse(result).message_id);
  }
  /** Internal owner-reviewed media primitive. No provider path or credential escapes this boundary. */
  async downloadFile(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!fileId || fileId.length > 512 || /[\x00-\x20]/.test(fileId))
      throw new Error("Invalid Telegram file identifier.");
    try {
      // Pin credential for metadata + bytes, so rotation cannot mix accounts across the await.
      const token = this.token();
      if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new TelegramTransportError();
      const transport = new TelegramTransport(() => token, this.request);
      const metadata = z
        .object({
          file_id: z.string(),
          file_size: z.number().int().nonnegative().safe().optional(),
          file_path: z.string(),
        })
        .parse(await transport.call("getFile", { file_id: fileId }, signal));
      if (
        metadata.file_id !== fileId ||
        (metadata.file_size !== undefined && metadata.file_size > TELEGRAM_FILE_BYTES_LIMIT)
      )
        throw new TelegramTransportError();
      // Cloud Bot API paths only. No absolute/local paths, URL, traversal, encoded separators or query strings.
      if (
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(metadata.file_path) ||
        metadata.file_path.split("/").some((p) => p === "." || p === "..")
      )
        throw new TelegramTransportError();
      const deadline = AbortSignal.timeout(30000);
      const response = await this.request(`https://api.telegram.org/file/bot${token}/${metadata.file_path}`, {
        method: "GET",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TelegramTransportError();
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > TELEGRAM_FILE_BYTES_LIMIT)) {
        await response.body?.cancel();
        throw new TelegramTransportError();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TelegramTransportError();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > TELEGRAM_FILE_BYTES_LIMIT) {
          await reader.cancel();
          throw new TelegramTransportError();
        }
        chunks.push(part.value);
      }
      if (
        (metadata.file_size !== undefined && bytes !== metadata.file_size) ||
        (length !== null && bytes !== Number(length))
      )
        throw new TelegramTransportError();
      return Buffer.concat(chunks, bytes);
    } catch (error) {
      if (error instanceof TelegramTransportError) throw error;
      throw new TelegramTransportError();
    }
  }
  private async call(
    method: "getUpdates" | "sendMessage" | "getMe" | "getFile",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = this.token();
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram credential is missing or invalid.");
    const deadline = AbortSignal.timeout(30000);
    try {
      const response = await this.request(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        redirect: "error",
      });
      // Bound even chunked error bodies; provider descriptions can contain secrets and are discarded.
      const reader = response.body?.getReader();
      if (!reader) throw new TelegramTransportError();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new TelegramTransportError();
        }
        chunks.push(part.value);
      }
      const envelope = z
        .object({
          ok: z.boolean(),
          result: z.unknown().optional(),
          parameters: z.object({ retry_after: z.number().int().positive() }).optional(),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!response.ok || !envelope.ok) throw new TelegramTransportError(envelope.parameters?.retry_after ?? null);
      return envelope.result;
    } catch (error) {
      if (error instanceof TelegramTransportError) throw error;
      throw new TelegramTransportError();
    }
  }
}
