import { expect, it, vi } from "vitest";
import { TelegramTransport, TelegramTransportError } from "./telegram-transport";

const token = "123:TEST_FAKE_TOKEN";
it("posts bounded polling offset and returns validated updates", async () => {
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            { update_id: 4, message: { message_id: 1, chat: { id: 12 }, from: { id: 7, is_bot: false }, text: "hi" } },
          ],
        }),
      ),
  );
  const transport = new TelegramTransport(() => token, request);
  expect(await transport.updates(4)).toHaveLength(1);
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
    offset: 4,
    timeout: 20,
    allowed_updates: ["message", "edited_message"],
  });
});
it("does not leak credential-bearing request errors", async () => {
  const transport = new TelegramTransport(
    () => token,
    async () => {
      throw new Error(`https://api.telegram.org/bot${token}`);
    },
  );
  await expect(transport.send("12", "hi")).rejects.toThrow("Telegram request failed.");
});
it("exposes rate backoff without provider description", async () => {
  const transport = new TelegramTransport(
    () => token,
    async () =>
      new Response(JSON.stringify({ ok: false, description: token, parameters: { retry_after: 15 } }), { status: 429 }),
  );
  try {
    await transport.updates(0);
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramTransportError);
    if (!(error instanceof TelegramTransportError)) throw error;
    expect(error.retryAfterSeconds).toBe(15);
    expect(String(error)).not.toContain(token);
  }
});
it("refuses missing credentials, oversized replies and invalid recipient before network", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(new TelegramTransport(() => null, request).updates(0)).rejects.toThrow();
  await expect(new TelegramTransport(() => token, request).send("wrong", "hi")).rejects.toThrow();
  await expect(new TelegramTransport(() => token, request).send("12", "a".repeat(4097))).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it("verifies the provider bot identity without returning the credential", async () => {
  const t = new TelegramTransport(
    () => token,
    async () => new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: "chief_bot" } })),
  );
  expect(await t.identity()).toEqual({ id: "123", username: "chief_bot" });
  const user = new TelegramTransport(
    () => token,
    async () => new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: false, username: "user" } })),
  );
  await expect(user.identity()).rejects.toThrow();
});

it("downloads bounded file bytes with account pinning and no returned credential/path", async () => {
  let current = token;
  const request = vi.fn<typeof fetch>(async (url: URL | RequestInfo) => {
    if (String(url).endsWith("getFile")) {
      current = "999:ROTATED";
      return new Response(
        JSON.stringify({ ok: true, result: { file_id: "f1", file_path: "documents/file_1.pdf", file_size: 3 } }),
      );
    }
    expect(String(url)).toContain(`/file/bot${token}/documents/file_1.pdf`);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
  });
  const bytes = await new TelegramTransport(() => current, request).downloadFile("f1");
  expect([...bytes]).toEqual([1, 2, 3]);
  expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
});
it("rejects unsafe provider paths and oversized metadata before download", async () => {
  for (const file_path of [
    "/etc/passwd",
    "https://evil.test/file",
    "documents/../secret",
    "documents/%2fsecret",
    "documents/file?token=bad",
    "documents/./file",
  ]) {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true, result: { file_id: "f1", file_path } })),
    );
    await expect(new TelegramTransport(() => token, request).downloadFile("f1")).rejects.toThrow(
      "Telegram request failed.",
    );
    expect(request).toHaveBeenCalledTimes(1);
  }
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { file_id: "f1", file_path: "documents/file.pdf", file_size: 21 * 1024 * 1024 },
        }),
      ),
  );
  await expect(new TelegramTransport(() => token, request).downloadFile("f1")).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("rejects wrong file identity, size mismatches and oversized streaming body", async () => {
  for (const kind of ["identity", "size", "stream", "length"]) {
    const request = vi.fn<typeof fetch>(async (url: URL | RequestInfo) =>
      String(url).endsWith("getFile")
        ? new Response(
            JSON.stringify({
              ok: true,
              result: {
                file_id: kind === "identity" ? "other" : "f1",
                file_path: "voice/file.ogg",
                ...(kind === "size" ? { file_size: 5 } : {}),
              },
            }),
          )
        : kind === "stream"
          ? new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new Uint8Array(20 * 1024 * 1024 + 1));
                  c.close();
                },
              }),
            )
          : new Response(new Uint8Array([1, 2, 3]), {
              headers: kind === "length" ? { "content-length": "99999999" } : {},
            }),
    );
    await expect(new TelegramTransport(() => token, request).downloadFile("f1")).rejects.toThrow(
      "Telegram request failed.",
    );
  }
});
it("redacts file errors and validates file ID before any network call", async () => {
  const request = vi.fn<typeof fetch>(async () => {
    throw Error(`https://api.telegram.org/file/bot${token}/private`);
  });
  const transport = new TelegramTransport(() => token, request);
  await expect(transport.downloadFile("bad id")).rejects.toThrow("Invalid Telegram file identifier.");
  expect(request).not.toHaveBeenCalled();
  await expect(transport.downloadFile("f1")).rejects.toThrow("Telegram request failed.");
});
