import type { PeerOwnerReview, V2ControlStatus } from "@dani-dex/contracts/ipc";
import { createSignal, createStore, For, onSettled, Show } from "solid-js";
import { Button, Input, Text, Textarea } from "../../components/ui";

/** Owner-local controls only. This panel never enables a public listener or sends a peer message. */
export function SettingsPeople(props: { agentId: string }) {
  const chief = () => props.agentId === "chief" || props.agentId === "chief-of-staff";
  const [step, setStep] = createSignal(1);
  const [state, set] = createStore({
    name: "",
    key: "",
    fingerprint: "",
    preview: "",
    verified: false,
    busy: false,
    error: "",
    status: null as V2ControlStatus | null,
    inbox: [] as PeerOwnerReview[],
  });
  async function refresh() {
    const [status, inbox] = await Promise.all([window.danidex.host.v2Status(), window.danidex.host.peerInbox()]);
    set((s) => {
      s.status = status;
      s.inbox = inbox;
    });
  }
  async function action(run: () => Promise<void>) {
    if (state.busy) return;
    set((s) => {
      s.busy = true;
      s.error = "";
    });
    try {
      await run();
      await refresh();
    } catch {
      set((s) => {
        s.error = "This change could not be saved. Review the details and try again.";
      });
    } finally {
      set((s) => {
        s.busy = false;
      });
    }
  }
  onSettled(() => {
    if (chief()) void action(refresh);
  });
  return (
    <div class="flex flex-col gap-3 p-4">
      <Show
        when={chief()}
        fallback={
          <Text>People connections are managed by your Chief. This specialist has no separate peer network.</Text>
        }
      >
        <h3>Connect a person</h3>
        <Text>
          Step {step()} of 2. Verify their agent's public key with them. Connection allows messages only; sharing needs
          separate permission.
        </Text>
        <Show when={step() === 1}>
          <Input
            aria-label="Person name or handle"
            placeholder="Name / handle"
            value={state.name}
            onValueChange={(v) =>
              set((s) => {
                s.name = v;
              })
            }
          />
          <Button disabled={!state.name.trim() || state.busy} onClick={() => setStep(2)}>
            Continue
          </Button>
        </Show>
        <Show when={step() === 2}>
          <Text>Person: {state.name}. Paste their Ed25519 public key, never a private key.</Text>
          <Textarea
            aria-label="Peer public key"
            placeholder="Public key (PEM)"
            value={state.key}
            onValueChange={(v) =>
              set((s) => {
                s.key = v;
                s.preview = "";
                s.verified = false;
              })
            }
          />
          <Button disabled={state.busy} onClick={() => setStep(1)}>
            Back
          </Button>
          <Button
            disabled={state.busy || !state.key.trim()}
            onClick={() =>
              void action(async () => {
                if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(state.key.trim()))
                  throw Error("Public key required");
                const binary = atob(state.key.replace(/-----[A-Z ]+-----|\s/g, ""));
                const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
                const hash = await crypto.subtle.digest("SHA-256", bytes);
                set((s) => {
                  s.preview = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
                });
              })
            }
          >
            Show fingerprint
          </Button>
          <Show when={state.preview}>
            <Text>Compare this fingerprint with the person through a trusted channel:</Text>
            <code class="break-all text-xs">{state.preview}</code>
            <label>
              <input
                type="checkbox"
                checked={state.verified}
                onChange={(e) =>
                  set((s) => {
                    s.verified = e.currentTarget.checked;
                  })
                }
              />{" "}
              I compared this fingerprint with {state.name}.
            </label>
          </Show>
          <Button
            disabled={state.busy || !state.verified || !state.preview}
            onClick={() =>
              void action(async () => {
                const fingerprint = await window.danidex.host.peerEnroll({
                  contactId: state.name.trim(),
                  humanHandle: state.name.trim(),
                  publicKeyPem: state.key,
                });
                set((s) => {
                  s.fingerprint = fingerprint;
                  s.key = "";
                });
              })
            }
          >
            Save verified public key
          </Button>
        </Show>
        <Show when={state.fingerprint}>
          <Text>Saved fingerprint: {state.fingerprint}. Local record only. Public network remains off.</Text>
        </Show>
        <Text>Network is off. No peer messages or calendar actions are sent from this panel.</Text>
        <Show when={state.error}>
          <Text role="alert">{state.error}</Text>
        </Show>
        <Button disabled={state.busy} onClick={() => void action(refresh)}>
          Refresh people and messages
        </Button>
        <For each={state.status?.contacts ?? []}>
          {(person) => (
            <section class="border rounded-md p-3">
              <h4>{person.humanHandle}</h4>
              <Text>
                {person.connected ? "Public identity saved. No blanket sharing permission." : "Disconnected."}
              </Text>
              <Button
                disabled={state.busy || !person.connected}
                onClick={() => void action(() => window.danidex.host.v2DisconnectPeer(person.contactId))}
              >
                Disconnect {person.humanHandle}
              </Button>
            </section>
          )}
        </For>
        <For each={state.status?.grants ?? []}>
          {(grant) => (
            <section class="border rounded-md p-3">
              <Text>
                Permission: {grant.purpose} for {grant.contactId}.{" "}
                {grant.revoked ? "Revoked." : grant.expiresAt <= Date.now() ? "Expired." : "Scoped permission on file."}
              </Text>
              <Button
                disabled={state.busy || grant.revoked}
                onClick={() => void action(() => window.danidex.host.v2RevokeGrant(grant.grantId))}
              >
                Revoke permission
              </Button>
            </section>
          )}
        </For>
        <h3>Incoming messages</h3>
        <Show when={!state.inbox.length}>
          <Text>No messages waiting for review.</Text>
        </Show>
        <For each={state.inbox}>
          {(review) => (
            <section class="border rounded-md p-3 flex flex-col gap-2">
              <h4>{review.state === "message-taker" ? "Unknown sender" : `Verified source: ${review.contactId}`}</h4>
              <Text>
                Claimed name: {review.claimedPrincipal.display} (unverified claim). Context: {review.contextId}.
              </Text>
              <strong>
                Intent: {String(review.envelope.intent)}. Subject: {String(review.envelope.subject)}
              </strong>
              <Show when={review.envelope.intent === "book_request"}>
                <strong>
                  Booking request. Money approval required separately. Budget USD:{" "}
                  {String((review.envelope.payload as { budget_usd?: number })?.budget_usd ?? "not provided")}
                </strong>
              </Show>
              <Text>
                Local deadline: {review.deadline ? new Date(review.deadline).toISOString() : "Expired / unavailable"}
              </Text>
              <Text>Envelope hash: {review.envelopeHash ?? "Unavailable"}</Text>
              <Text>Untrusted message: {review.displayText ?? review.text}</Text>
              <details>
                <summary>Request details</summary>
                <pre class="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(review.displayEnvelope ?? review.envelope, null, 2)}
                </pre>
              </details>
              <Button
                disabled={state.busy || review.state === "uncertain"}
                onClick={() =>
                  void action(() => window.danidex.host.peerDecide({ review, decision: "decline", grantId: null }))
                }
              >
                {review.state === "message-taker" ? "Dismiss message" : "Decline request"}
              </Button>
              <Text>
                No agent work or sharing. Uncertain effects need owner reconciliation, never a retry. Acceptance is
                unavailable.
              </Text>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}
