import type { RcGatewayStatus } from "@dani-dex/contracts/ipc";
import { createStore, onSettled, Show } from "solid-js";
import {
  Button,
  Input,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  QrCode,
  SettingsSection,
  Text,
} from "../../components/ui";
/** Owner-local pairing. It does not use or create a Dani-Dex account. */
export function SettingsDevicePairing() {
  const [state, set] = createStore<{
    gateway: RcGatewayStatus | null;
    origin: string;
    busy: boolean;
    error: string;
    url: string;
    code: string;
    expiresAt: number;
  }>({
    gateway: null,
    origin: "",
    busy: false,
    error: "",
    url: "",
    code: "",
    expiresAt: 0,
  });
  let disposed = false;
  function adopt(gateway: RcGatewayStatus) {
    if (disposed) return;
    set((s) => {
      s.gateway = gateway;
      if (gateway.origin) {
        if (s.origin && s.origin !== gateway.origin) {
          s.url = "";
          s.code = "";
        }
        s.origin = gateway.origin;
      }
    });
  }
  async function refresh() {
    try {
      adopt(await window.danidex.host.getRcGateway());
    } catch {
      if (!disposed)
        set((s) => {
          s.error = "RC gateway status could not be read.";
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
  async function action(run: () => Promise<void>) {
    if (state.busy) return;
    set((s) => {
      s.busy = true;
      s.error = "";
    });
    try {
      await run();
    } catch (e) {
      set((s) => {
        s.error = e instanceof Error ? e.message : "RC setup failed.";
      });
    } finally {
      set((s) => {
        s.busy = false;
      });
    }
  }
  return (
    <SettingsSection
      title="Remote View / RC"
      description="Add your own device to this host. No account needed. Pairing gives owner access."
    >
      <ItemGroup>
        <Item>
          <ItemContent>
            <ItemTitle>RC gateway</ItemTitle>
            <Text>{state.gateway?.phase ?? "Checking"}</Text>
            <Show when={state.gateway?.origin}>
              <Text>{state.gateway?.origin}</Text>
            </Show>
            <Show when={state.gateway?.message}>
              <Text>{state.gateway?.message}</Text>
            </Show>
            <Button
              disabled={state.busy}
              onClick={() =>
                void action(async () => adopt(await window.danidex.host.setRcGateway(!state.gateway?.enabled)))
              }
            >
              {state.gateway?.enabled ? "Disable RC gateway" : "Enable RC gateway"}
            </Button>
          </ItemContent>
        </Item>
        <Item>
          <ItemContent>
            <ItemTitle>Host HTTPS address</ItemTitle>
            <Input
              aria-label="Device pairing HTTPS origin"
              value={state.origin}
              placeholder="https://your-host.example"
              onValueChange={(origin) =>
                set((s) => {
                  s.origin = origin;
                })
              }
            />
            <Button
              disabled={state.busy || !state.origin}
              onClick={() =>
                void action(async () => {
                  const result = await window.danidex.host.createDevicePairingLink(state.origin.trim());
                  set((s) => {
                    s.url = result.url;
                    s.code = result.code;
                    s.expiresAt = result.expiresAt;
                  });
                })
              }
            >
              Add RC
            </Button>
            <Show when={state.error}>
              <ItemDescription role="alert">{state.error}</ItemDescription>
            </Show>
          </ItemContent>
        </Item>
        <Show when={state.url}>
          <Item>
            <ItemContent>
              <QrCode value={state.url} label="Remote View pairing QR code" />
              <Input aria-label="RC pairing code" value={state.code} readOnly />
              <Input aria-label="Device pairing link" value={state.url} readOnly />
              <Text>
                Pair only your own device. The code works once for 14 days; the device session lasts 30 days. Generating
                a new code replaces this one.
              </Text>
              <Text>
                Expires at {new Date(state.expiresAt).toLocaleString()}. Disconnect on the RC or revoke its host session
                to remove access. A quick-tunnel address can change after a restart.
              </Text>
            </ItemContent>
          </Item>
        </Show>
      </ItemGroup>
    </SettingsSection>
  );
}
