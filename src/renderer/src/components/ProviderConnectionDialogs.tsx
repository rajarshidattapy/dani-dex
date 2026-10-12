import { ProviderLogo } from "@dani-dex/brand";
import { Show } from "solid-js";
import { OpenCodeKeyDialog } from "../features/settings/OpenCodeKeyDialog";
import { useProviders } from "../providers";
import { Button, Dialog } from "./ui";
export function ProviderConnectionDialogs() {
  const providers = useProviders();
  return (
    <>
      <Show when={providers.apiKeyProvider()}>
        {(provider) => <OpenCodeKeyDialog provider={provider()} api={window.danidex} onClose={providers.closeApiKey} />}
      </Show>
      <ChatGptSignInDialog
        open={providers.chatGptConnecting()}
        onCancel={providers.cancelChatGpt}
        onBrowserError={providers.reportChatGptBrowserError}
      />
    </>
  );
}

export function ChatGptSignInDialog(props: { open: boolean; onCancel: () => void; onBrowserError: () => void }) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="provider-code-login-backdrop">
          <Dialog.Content class="provider-code-login-dialog chatgpt-sign-in-dialog">
            <Dialog.Title class="provider-code-login-title">
              <span class="voice-auth-brand">
                <ProviderLogo provider="codex" /> Sign in with OpenAI / ChatGPT
              </span>
            </Dialog.Title>
            <Dialog.Description class="provider-code-login-description">
              Finish signing in in your browser. Allow model access to use your ChatGPT plan. Dani-Dex does not need its
              own account.
            </Dialog.Description>
            <p class="provider-code-login-hint">
              If OpenAI shows an error instead of sign-in, return here. Close that browser page before trying again.
            </p>
            <div class="chatgpt-sign-in-actions">
              <Button variant="outline" onClick={() => props.onBrowserError()}>
                My browser showed an error
              </Button>
              <Button onClick={props.onCancel}>Cancel sign-in</Button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
