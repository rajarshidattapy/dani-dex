import { createStore, onSettled, For, Show } from "solid-js";
import type { TelegramGatewayStatus } from "@dani-dex/contracts/ipc-team-host";
import {
  Button,
  Input,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  Text,
} from "../../components/ui";
export function SettingsTelegram() {
  const [state, set] = createStore({
    token: "",
    chat: "",
    sender: "",
    busy: false,
    error: "",
    status: null as TelegramGatewayStatus | null,
  });
  let disposed = false;
  async function refresh() {
    try {
      const status = await window.danidex.host.telegramStatus();
      if (!disposed)
        set((s) => {
          s.status = status;
        });
    } catch {
      if (!disposed)
        set((s) => {
          s.error = "Telegram setup could not be read.";
        });
    }
  }
  async function action(run: () => Promise<unknown>) {
    if (state.busy) return;
    set((s) => {
      s.busy = true;
      s.error = "";
    });
    try {
      await run();
      await refresh();
    } catch (e) {
      set((s) => {
        s.error = e instanceof Error ? e.message : "Telegram setup failed.";
      });
    } finally {
      set((s) => {
        s.busy = false;
      });
    }
  }
  onSettled(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  });
  return (
    <SettingsSection
      title="Telegram - Chief"
      description="One bot, one Chief. Pair a chat and sender before enabling. Incoming requests need your review before any agent work."
    >
      <ItemGroup>
        <Item>
          <ItemContent>
            <ItemTitle>Bot credential</ItemTitle>
            <ItemDescription>
              Stored using secure system storage. It is never sent to a model. Setup stays off until you enable it.
            </ItemDescription>
            <Input
              aria-label="Telegram bot token"
              type="password"
              autocomplete="off"
              value={state.token}
              onValueChange={(value) =>
                set((s) => {
                  s.token = value;
                })
              }
            />
            <Button
              disabled={state.busy || !state.token}
              onClick={() =>
                void action(async () => {
                  await window.danidex.host.telegramConfigure(state.token);
                  set((s) => {
                    s.token = "";
                  });
                })
              }
            >
              Save token
            </Button>
            <Input
              aria-label="Telegram chat ID"
              placeholder="Chat ID"
              value={state.chat}
              onValueChange={(value) =>
                set((s) => {
                  s.chat = value;
                })
              }
            />
            <Input
              aria-label="Telegram sender ID"
              placeholder="Sender ID"
              value={state.sender}
              onValueChange={(value) =>
                set((s) => {
                  s.sender = value;
                })
              }
            />
            <Button
              disabled={state.busy || !state.status?.configured}
              onClick={() =>
                void action(() =>
                  window.danidex.host.telegramPair({ conversationId: state.chat, senderId: state.sender }),
                )
              }
            >
              Pair chat and sender
            </Button>
            <Button
              disabled={state.busy || !state.status?.configured || state.status.enabled}
              onClick={() => void action(() => window.danidex.host.telegramEnable())}
            >
              Enable Telegram
            </Button>
            <Button
              disabled={state.busy || !state.status?.configured}
              onClick={() => void action(() => window.danidex.host.telegramRevoke())}
            >
              Revoke and stop
            </Button>
            <Text>{state.status?.enabled ? "Enabled. Polling paired chats." : "Off."}</Text>
            <Show when={state.error || state.status?.error}>
              <ItemDescription role="alert">{state.error || state.status?.error}</ItemDescription>
            </Show>
            <ItemDescription>
              Text-only first slice. Voice, files and edits are not wired yet. Chief replies need your review before sending. No live provider test
              completed.
            </ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
      <For each={state.status?.uncertainReplies??[]}>{reply=>(
        <Item><ItemContent><ItemTitle>Reply delivery unconfirmed: chat {reply.conversationId}</ItemTitle><ItemDescription>The connection ended before Telegram confirmed this send. Check this chat before sending again. Dani-Dex will not retry automatically.</ItemDescription></ItemContent></Item>
      )}</For>
      <For each={state.status?.pending ?? []}>
        {(item) => (
          <Item>
            <ItemContent>
              <ItemTitle>
                Review request from {item.senderId}, chat {item.conversationId}
              </ItemTitle>
              <Text>{item.body}</Text>
              <Button
                disabled={state.busy}
                onClick={() =>
                  void action(() =>
                    window.danidex.host.telegramApprove({
                      eventId: item.eventId,
                      body: item.body,
                      conversationId: item.conversationId,
                      senderId: item.senderId,
                    }),
                  )
                }
              >
                Approve this request for Chief
              </Button>
              <Button disabled={state.busy} onClick={()=>void action(()=>window.danidex.host.telegramReject(item.eventId))}>Reject request</Button>
            </ItemContent>
          </Item>
        )}
      </For>
      <For each={state.status?.replies??[]}>{reply=><Item><ItemContent><ItemTitle>Review Chief reply to chat {reply.conversationId}</ItemTitle><Text>{reply.body}</Text><Button disabled={state.busy} onClick={()=>void action(()=>window.danidex.host.telegramApproveReply({replyId:reply.replyId,body:reply.body,conversationId:reply.conversationId,senderId:reply.senderId}))}>Approve and send this reply</Button></ItemContent></Item>}</For>
    </SettingsSection>
  );
}
