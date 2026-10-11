import type { QueueDelivery } from "@dani-dex/contracts/ipc";
import { createEffect, createRoot } from "solid-js";
import type { AgentMessage } from "../../data";

export interface AgentReplySource {
  deliveries: () => readonly QueueDelivery[];
  failure?: () => string | null;
  /** Read after the delivery settles: the reactive conversation page can still be loading. */
  readMessages: (delivery: QueueDelivery, signal: AbortSignal) => Promise<readonly AgentMessage[]>;
}

/** Only finished answer text from the accepted delivery's exact provider turn can be spoken. */
export function findFinalAgentReply(messages: readonly AgentMessage[], turnId: string): string | null {
  let reply: string | null = null;
  for (const message of messages) {
    if (message.turnId !== turnId || message.author !== "agent") continue;
    if (message.kind === "error") throw new Error(message.body.trim() || "The agent turn failed.");
    if (message.status && message.status !== "completed") continue;
    if (message.kind && message.kind !== "text") continue;
    if (message.itemType && message.itemType !== "agentMessage" && message.itemType !== "final_answer") continue;
    if (message.streaming) return null;
    const body = message.body.trim();
    if (body) reply = body;
  }
  return reply;
}

/** The queue binds the accepted delivery to its turn and supplies a terminal outcome. */
export function waitForAgentReply(source: AgentReplySource, deliveryId: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Interrupted", "AbortError"));
      return;
    }
    createRoot((dispose) => {
      let settled = false;
      let reading = false;
      let seenDelivery = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        dispose();
        settle();
      };
      const fail = (error: unknown) => finish(() => reject(error));
      const onAbort = () => fail(new DOMException("Interrupted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      const readReply = async (delivery: QueueDelivery) => {
        try {
          if (delivery.status !== "completed" && delivery.error) throw new Error(delivery.error);
          const messages = await source.readMessages(delivery, signal);
          if (settled) return;
          if (delivery.status !== "completed") {
            const providerError = messages
              .find((message) => message.turnId === delivery.turnId && message.kind === "error")
              ?.body.trim();
            throw new Error(delivery.error || providerError || `The agent turn was ${delivery.status}.`);
          }
          const reply = delivery.turnId ? findFinalAgentReply(messages, delivery.turnId) : null;
          if (reply === null) throw new Error("The agent finished without a spoken reply.");
          finish(() => resolve(reply));
        } catch (error) {
          fail(error);
        }
      };
      createEffect(
        () => ({
          delivery: source.deliveries().find((delivery) => delivery.id === deliveryId),
          failure: source.failure?.(),
        }),
        ({ delivery, failure }) => {
          if (settled || reading) return;
          if (!delivery) {
            if (seenDelivery) queueMicrotask(() => fail(new Error("The voice message is no longer in the queue.")));
            return;
          }
          seenDelivery = true;
          if (delivery.status === "queued" || delivery.status === "starting" || delivery.status === "running") {
            if (failure) queueMicrotask(() => fail(new Error(failure)));
            return;
          }
          reading = true;
          // Dispose outside the effect, including when the final read rejects synchronously.
          queueMicrotask(() => {
            if (!settled) void readReply(delivery);
          });
        },
      );
    });
  });
}

export interface AgentDeliveryCancellationSource {
  readDelivery: () => Promise<QueueDelivery | undefined>;
  onDelivery: (
    listener: (delivery: QueueDelivery | undefined) => void,
    onFailure: (message: string) => void,
  ) => () => void;
  cancel: () => Promise<void>;
  interrupt: (turnId: string) => Promise<void>;
}

/** Cancel queued work, or interrupt the exact turn if it starts before cancellation reaches it. */
export function interruptAgentDelivery(source: AgentDeliveryCancellationSource): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let working = false;
    let revision = 0;
    let latest: QueueDelivery | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    const advance = async () => {
      if (settled || working) return;
      if (!latest) {
        finish(new Error("The voice message is no longer in the queue."));
        return;
      }
      if (latest.status === "starting" || (latest.status === "running" && !latest.turnId)) return;
      working = true;
      try {
        if (latest.status === "queued") {
          try {
            await source.cancel();
            finish();
          } catch (error) {
            // One authoritative read distinguishes a cancellation failure from a start race.
            const version = revision;
            const current = await source.readDelivery();
            if (version === revision) latest = current;
            if (latest?.status === "queued") {
              finish(error);
              return;
            }
            working = false;
            void advance();
          }
        } else if (latest.status === "running" && latest.turnId) {
          await source.interrupt(latest.turnId);
          finish();
        } else {
          finish();
        }
      } catch (error) {
        finish(error);
      }
    };
    unsubscribe = source.onDelivery(
      (delivery) => {
        revision += 1;
        latest = delivery;
        void advance();
      },
      (message) => finish(new Error(message)),
    );
    if (settled) {
      unsubscribe();
      return;
    }
    const version = revision;
    void source.readDelivery().then(
      (delivery) => {
        if (version !== revision || settled) return;
        latest = delivery;
        void advance();
      },
      (error) => finish(error),
    );
  });
}
