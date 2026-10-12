import { afterEach, expect, it, vi } from "vitest";
import { DEVICE_PAIRING_CLIENT, DEVICE_PAIRING_PAGE } from "./device-pairing-page";

function page() {
  document.documentElement.innerHTML = DEVICE_PAIRING_PAGE;
}
async function settled() {
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#refresh")?.disabled).toBe(false));
}
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it("restores a paired tab, reads a conversation safely and prevents repeat sends after ambiguous failure", async () => {
  page();
  sessionStorage.setItem("dani-device-session", "private-token");
  sessionStorage.setItem("dani-device-host", "host-1");
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      requests.push(input);
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer private-token");
      if (input === "/v1/identity") return Response.json({ serverId: "host-1", serverName: "Dani-Dex" });
      if (input === "/v1/agents") return Response.json([{ id: "agent-1", name: "Chief" }]);
      if (input.endsWith("/conversation"))
        return Response.json({ botId: "agent-1", messages: [{ author: "assistant", text: "<script>bad()</script>" }] });
      if (input.endsWith("/messages")) throw Error("reply lost");
      throw Error("Unexpected route");
    }),
  );
  // biome-ignore lint/security/noGlobalEval: execute the fixed first-party page script in its DOM test fixture.
  window.eval(DEVICE_PAIRING_CLIENT);
  await settled();
  document.querySelector<HTMLButtonElement>("#agents button")?.click();
  await settled();
  expect(document.querySelector("#messages")?.textContent).toContain("<script>bad()</script>");
  expect(document.querySelector("#messages script")).toBeNull();
  const draft = document.querySelector<HTMLTextAreaElement>("#draft");
  if (!draft) throw Error("Missing composer");
  draft.value = "hello";
  draft.dispatchEvent(new Event("input"));
  document.querySelector("#composer")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await settled();
  expect(document.querySelector<HTMLButtonElement>("#send")?.disabled).toBe(true);
  expect(draft.value).toBe("hello");
  document.querySelector("#composer")?.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(requests.filter((p) => p.endsWith("/messages"))).toHaveLength(1);
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await settled();
  expect(document.querySelector<HTMLButtonElement>("#send")?.disabled).toBe(false);
});

it("shows streamed and saved replies without Refresh and catches up after reconnect", async () => {
  page();
  sessionStorage.setItem("dani-device-session", "private-token");
  sessionStorage.setItem("dani-device-host", "host-1");
  const sockets: Array<{
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    readyState: number;
  }> = [];
  class Socket {
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  let reply = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/v1/identity") return Response.json({ serverId: "host-1", serverName: "Dani-Dex" });
      if (input === "/v1/agents") return Response.json([{ id: "agent-1", name: "Chief" }]);
      return Response.json({
        botId: "agent-1",
        messages: reply
          ? [
              {
                id: "reply-1",
                author: "assistant",
                text: reply,
                createdAt: new Date().toISOString(),
                status: "completed",
              },
            ]
          : [],
      });
    }),
  );
  // biome-ignore lint/security/noGlobalEval: execute the fixed first-party page script in its DOM test fixture.
  window.eval(DEVICE_PAIRING_CLIENT);
  await settled();
  document.querySelector<HTMLButtonElement>("#agents button")?.click();
  await settled();
  sockets[0].onmessage?.({
    data: JSON.stringify({
      type: "conversation-delta",
      botId: "agent-1",
      messageId: "reply-1",
      turnId: "turn-1",
      delta: "Streamed reply",
      createdAt: new Date().toISOString(),
    }),
  });
  expect(document.querySelector("#messages")?.textContent).toContain("Streamed reply");
  reply = "Saved reply";
  sockets[0].onmessage?.({ data: JSON.stringify({ type: "turn-completed", botId: "agent-1" }) });
  await vi.waitFor(() => expect(document.querySelector("#messages")?.textContent).toContain("Saved reply"));
  reply = "Reply while disconnected";
  sockets[0].readyState = 3;
  sockets[0].onclose?.();
  await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2000 });
  await vi.waitFor(() =>
    expect(document.querySelector("#messages")?.textContent).toContain("Reply while disconnected"),
  );
});

it("restores persistent pairing without a tab session and clears it on Disconnect", async () => {
  page();
  localStorage.setItem("dani-device-session", "persistent-token");
  localStorage.setItem("dani-device-host", "host-1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer persistent-token");
      if (input === "/v1/identity") return Response.json({ serverId: "host-1", serverName: "Dani-Dex" });
      if (input === "/v1/agents") return Response.json([]);
      if (input === "/v1/auth/logout") return new Response(null, { status: 204 });
      throw Error("Unexpected route");
    }),
  );
  // biome-ignore lint/security/noGlobalEval: execute the fixed first-party page script in its DOM test fixture.
  window.eval(DEVICE_PAIRING_CLIENT);
  await settled();
  expect(document.querySelector<HTMLElement>("#host")?.hidden).toBe(false);
  document.querySelector<HTMLButtonElement>("#disconnect")?.click();
  await settled();
  expect(localStorage.getItem("dani-device-session")).toBeNull();
  expect(localStorage.getItem("dani-device-host")).toBeNull();
});

it("renders ordinary questions and posts exact answers, but never collects secret fields", async () => {
  page();
  localStorage.setItem("dani-device-session", "token");
  localStorage.setItem("dani-device-host", "host-1");
  let socket: { onopen?: () => void; onmessage?: (e: { data: string }) => void; readyState: number } | undefined;
  class Socket {
    readyState = 1;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    constructor() {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    send() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  const answers: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      if (input === "/v1/identity") return Response.json({ serverId: "host-1", serverName: "Dani-Dex" });
      if (input === "/v1/agents") return Response.json([{ id: "agent-1", name: "Chief" }]);
      if (input.endsWith("/conversation")) return Response.json({ botId: "agent-1", messages: [] });
      if (input === "/v1/prompts/respond") {
        answers.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      throw Error(input);
    }),
  );
  // biome-ignore lint/security/noGlobalEval: execute the fixed first-party page script in its DOM test fixture.
  window.eval(DEVICE_PAIRING_CLIENT);
  await settled();
  document.querySelector<HTMLButtonElement>("#agents button")?.click();
  await settled();
  const question = { id: "purpose", header: "Purpose", question: "What should it do?", isSecret: false, options: null };
  if (!socket) throw Error("Missing socket fixture");
  socket.onmessage?.({
    data: JSON.stringify({ type: "prompt", requestId: "q1", botId: "agent-1", questions: [question] }),
  });
  const field = document.querySelector<HTMLTextAreaElement>("#approvals textarea");
  if (!field) throw Error("Missing answer field");
  field.value = "Research product ideas";
  document.querySelector<HTMLFormElement>("#approvals form")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await settled();
  expect(answers).toEqual([{ requestId: "q1", answers: { purpose: ["Research product ideas"] } }]);
  if (!socket) throw Error("Missing socket fixture");
  socket.onmessage?.({
    data: JSON.stringify({
      type: "prompt",
      requestId: "q2",
      botId: "agent-1",
      questions: [{ ...question, isSecret: true }],
    }),
  });
  expect(document.querySelector("#approvals textarea")).toBeNull();
  expect(document.querySelector<HTMLButtonElement>("#approvals button")?.disabled).toBe(true);
  expect(document.querySelector("#approvals")?.textContent).toContain("entered securely on the host");
});
