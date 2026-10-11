import type {
  AgentApproval,
  AgentEvent,
  BrowserTakeoverRequest,
  QueueSnapshot,
  Routine,
} from "@dani-dex/contracts/ipc";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button } from "../../components/ui";
import type { AgentProfile } from "../../data";

export function AgentWorkOverview(props: {
  agent: AgentProfile;
  agents: readonly AgentProfile[];
  prompt?: Extract<AgentEvent, { type: "prompt" }>;
  approval?: AgentApproval;
  takeover?: BrowserTakeoverRequest;
  onOpenAgent?: (id: string) => void;
  onCreateSchedule: () => void;
  onManageSchedules: () => void;
  onSettings: () => void;
  onChannels: () => void;
}) {
  const [state, setState] = createSignal<{ queues: QueueSnapshot[]; routines: Routine[]; at: string } | null>(null);
  const [error, setError] = createSignal(false);
  let generation = 0;
  const scope = () =>
    props.agent.id === "chief" || props.agent.id === "chief-of-staff"
      ? [...new Set([props.agent.id, ...props.agents.map((a) => a.id)])]
      : [props.agent.id];
  const name = (id: string) => props.agents.find((a) => a.id === id)?.name ?? id;
  async function reload() {
    const g = ++generation;
    setError(false);
    try {
      const ids = scope();
      const [queues, routines] = await Promise.all([
        Promise.all(ids.map((id) => window.danidex.agent.listQueue(id))),
        Promise.all(ids.map((id) => window.danidex.agent.listRoutines(id))),
      ]);
      if (g === generation) setState({ queues, routines: routines.flat(), at: new Date().toLocaleTimeString() });
    } catch {
      if (g === generation) setError(true);
    }
  }
  createEffect(
    () => props.agent.id,
    () => {
      setState(null);
      void reload();
    },
  );
  const unsubscribe = window.danidex.agent.onEvent((event) => {
    if (event.type === "queue-changed" || event.type === "routines-changed") void reload();
  });
  onCleanup(() => {
    generation++;
    unsubscribe();
  });
  const deliveries = () =>
    state()?.queues.flatMap((q) => q.deliveries.filter((d) => d.recipientAgentId === q.agentId)) ?? [];
  const working = () => deliveries().filter((d) => d.status === "starting" || d.status === "running");
  const attention = (): QueueSnapshot["deliveries"] => [];
  const pending = () => deliveries().filter((d) => d.status === "queued");
  const scheduled = () => state()?.routines.filter((r) => r.active && scope().includes(r.agentId)) ?? [];
  return (
    <div class="agent-work-overview">
      <h2>{scope().length > 1 ? "Your team, right now" : `${props.agent.name}, right now`}</h2>
      <p class="agent-channel-note">Needs you · Working · Up next</p>
      <Show when={error()}>
        <p role="alert">Could not refresh work. Previous data may be stale.</p>
      </Show>
      <Show when={!state()}>
        <p>{error() ? "Work unavailable." : "Loading work..."}</p>
      </Show>
      <Show when={state()}>
        <section>
          <h3>Needs you</h3>
          <Show when={props.prompt || props.approval || props.takeover}>
            <div class="overview-work-card">
              <strong>Review needed in this conversation</strong>
              <p>Open the original question or action before answering.</p>
              <Button onClick={() => props.onOpenAgent?.(props.agent.id)}>Open conversation</Button>
            </div>
          </Show>
          <For each={attention()}>
            {(d) => (
              <div class="overview-work-card">
                <strong>
                  {name(d.recipientAgentId)} · {d.status}
                </strong>
                <p>{d.error ?? "Inspect the original work before retrying."}</p>
                <Button onClick={() => props.onOpenAgent?.(d.recipientAgentId)}>Open conversation</Button>
              </div>
            )}
          </For>
          <Show when={!attention().length && !props.prompt && !props.approval && !props.takeover}>
            <p class="agent-channel-note">No queue decisions shown.</p>
          </Show>
          <p class="overview-source-note">
            Other agents' questions and permission reviews are not covered by this queue view.
          </p>
        </section>
        <section>
          <h3>Working now</h3>
          <For each={working()}>
            {(d) => (
              <div class="overview-work-card">
                <strong>
                  {name(d.recipientAgentId)} · {d.status}
                </strong>
                <p>{d.text.slice(0, 180)}</p>
                <Button onClick={() => props.onOpenAgent?.(d.recipientAgentId)}>Open work conversation</Button>
              </div>
            )}
          </For>
          <Show when={!working().length}>
            <p class="agent-channel-note">No mailbox work running in the checked queues.</p>
          </Show>
          <p class="overview-source-note">
            Direct sessions and channel tasks have separate state. This is not a full idle claim.
          </p>
        </section>
        <section>
          <h3>Up next</h3>
          <For each={pending()}>
            {(d) => (
              <div class="overview-work-card">
                <strong>
                  {name(d.recipientAgentId)} · {d.editing ? "Editing" : "Queued"}
                </strong>
                <p>{d.text.slice(0, 120)}</p>
                <Button onClick={() => props.onOpenAgent?.(d.recipientAgentId)}>Open queue</Button>
              </div>
            )}
          </For>
          <For each={scheduled()}>
            {(r) => (
              <div class="overview-work-card">
                <strong>{r.name}</strong>
                <p>
                  {name(r.agentId)} · {new Date(r.trigger.nextRunAt).toLocaleString()}
                </p>
                <Button
                  onClick={() =>
                    r.agentId === props.agent.id ? props.onManageSchedules() : props.onOpenAgent?.(r.agentId)
                  }
                >
                  {r.agentId === props.agent.id ? "Manage schedules" : "Open owner conversation"}
                </Button>
              </div>
            )}
          </For>
          <Button onClick={props.onCreateSchedule}>Create schedule</Button>
          <p class="agent-channel-note">Custom cron · Daily / weekly · Intervals</p>
          <Button variant="ghost" onClick={props.onManageSchedules}>
            Manage routines
          </Button>
          <p class="overview-source-note">One-shot watches are not ready yet.</p>
        </section>
        <section>
          <h3>Recent results</h3>
          <p class="agent-channel-note">
            Open the work conversation for its actual output. Completed delivery alone is not a verified result.
          </p>
        </section>
        <section>
          <Button variant="ghost" onClick={props.onChannels}>
            Open Channels
          </Button>
          <p class="agent-channel-note">Setup and live checks remain separate from work status.</p>
        </section>
        <p class="overview-source-note">Queues and schedules checked {state()?.at}. Coverage is partial.</p>
      </Show>
      <Button variant="ghost" onClick={props.onSettings}>
        Agent settings
      </Button>
      <Button variant="ghost" onClick={() => void reload()}>
        Refresh work
      </Button>
    </div>
  );
}
