import type { AttachmentDataInput, QueuedMessageReceipt } from "@dani-dex/contracts/ipc";
import type { MailboxStore } from "./mailbox-store";
/** Existing mailbox owns bytes, receipts and delivery. This adds no parallel task store. */
export async function enqueueReviewedGatewayInput(
  mailbox: MailboxStore,
  input: {
    agentId: string;
    idempotencyKey: string;
    text: string;
    attachmentData?: AttachmentDataInput[];
    validateApproval: () => void;
  },
): Promise<QueuedMessageReceipt> {
  input.validateApproval();
  const drafts = await mailbox.prepareImportedAttachments([], input.attachmentData ?? []);
  try {
    input.validateApproval();
    return await mailbox.enqueue({
      sender: { kind: "user" },
      recipientAgentIds: [input.agentId],
      idempotencyKey: input.idempotencyKey,
      text: input.text,
      draftIds: drafts.map((d) => d.id),
      validateCommit: input.validateApproval,
    });
  } finally {
    // Committed drafts are already gone. Also removes unused duplicates on receipt reconciliation.
    for (const draft of drafts) await mailbox.discardDraft(draft.id);
  }
}
