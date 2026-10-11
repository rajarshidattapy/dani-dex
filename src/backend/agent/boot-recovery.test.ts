// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentStore } from "../agent-store";
import { ChannelStore } from "../channel-store";
import { MailboxStore } from "../mailbox-store";
import { BootRecovery, type BootRecoveryOptions } from "./boot-recovery";

it.each(["idle", "delivery", "turn"])(
  "retirement covers owned idle group execution threads, without replay; busy=%s",
  async (busy) => {
    const root = await mkdtemp(join(tmpdir(), "dani-boot-retirement-"));
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
    const mailbox = new MailboxStore(join(root, "user-data"), store.sharedRoot, store.database);
    try {
      await store.initialize();
      await mailbox.initialize();
      await store.getOrCreate("owner");
      await store.updateAgent({ agentId: "owner", provider: "opencode", model: "dani/dani-free-auto" });
      const channels = new ChannelStore(store.database);
      channels.update(
        channels.create("test-room", {
          name: "Test room",
          title: "Test",
          instructions: "",
          members: [{ agentId: "owner" }],
          leadAgentId: "owner",
        }),
      );
      const room = channels.context("test-room", "owner").threadId;
      store.database.bindProviderSession({
        threadId: room,
        provider: "opencode",
        externalSessionId: "room-wire",
        model: "dani/dani-free-auto",
        effort: "medium",
      });
      store.database.appendWorkerHistory(room, { kind: "retirement", turnId: "old", reason: "deadline" }, "room-wire");
      if (busy === "turn") {
        const snapshot = store.database.readConversation("owner", room);
        snapshot.activeTurnId = "active";
        store.database.persistConversation(snapshot, "turn.started");
      }
      vi.spyOn(mailbox, "hasUnfinishedDelivery").mockReturnValue(busy === "delivery");
      const retire = vi.fn(),
        register = vi.fn();
      const options: BootRecoveryOptions = {
        store,
        mailbox,
        providers: { clientFor: () => null, clientForAgent: () => null },
        conversation: {
          registerExecutionThread: register,
          bindThread: vi.fn(),
          ensureSnapshot: vi.fn(),
          setSnapshot: vi.fn(),
          publishConversation: vi.fn(),
          isExecutionThread: () => false,
        },
        mailboxSync: { emitQueue: vi.fn(), syncMailboxMessages: vi.fn() },
        threads: { retireProviderSession: retire, threadParams: async () => ({}) },
        hooks: {
          executionThreads: () => [
            { id: "owner", threadId: room },
            { id: "missing", threadId: "not-owned" },
          ],
          emitError: vi.fn(),
        },
      };
      await new BootRecovery(options).reconcileUnresolvedDeliveries();
      expect(register).toHaveBeenCalledWith("owner", room);
      if (busy !== "idle") expect(retire).not.toHaveBeenCalled();
      else {
        expect(retire).toHaveBeenCalledTimes(1);
        expect(retire).toHaveBeenCalledWith(expect.objectContaining({ id: "owner", threadId: room }), "room-wire");
      }
    } finally {
      store.database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
