import { expect, it, vi } from "vitest";
import { TelegramTransport, TelegramTransportError } from "./telegram-transport";
const token = "123:TEST_FAKE_TOKEN";
it("posts bounded polling offset and returns validated updates", async () => {
  const request = vi.fn(
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
    expect((error as TelegramTransportError).retryAfterSeconds).toBe(15);
    expect(String(error)).not.toContain(token);
  }
});
it("refuses missing credentials, oversized replies and invalid recipient before network", async () => {
  const request = vi.fn();
  await expect(new TelegramTransport(() => null, request).updates(0)).rejects.toThrow();
  await expect(new TelegramTransport(() => token, request).send("wrong", "hi")).rejects.toThrow();
  await expect(new TelegramTransport(() => token, request).send("12", "a".repeat(4097))).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it("verifies the provider bot identity without returning the credential",async()=>{
 const t=new TelegramTransport(()=>token,async()=>new Response(JSON.stringify({ok:true,result:{id:123,is_bot:true,username:"chief_bot"}})));
 expect(await t.identity()).toEqual({id:"123",username:"chief_bot"});
 const user=new TelegramTransport(()=>token,async()=>new Response(JSON.stringify({ok:true,result:{id:123,is_bot:false,username:"user"}})));
 await expect(user.identity()).rejects.toThrow();
});
