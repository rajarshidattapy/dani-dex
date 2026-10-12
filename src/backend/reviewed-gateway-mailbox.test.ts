import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MailboxStore } from "./mailbox-store";
import { enqueueReviewedGatewayInput } from "./reviewed-gateway-mailbox";
it("uses durable mailbox receipt and cleans revoked and duplicate document drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-mailbox-"));
  const m = new MailboxStore(join(root, "user"), join(root, "shared"));
  await m.initialize();
  try {
    let checks = 0;
    const input = {
      agentId: "chief",
      idempotencyKey: "gateway:1",
      text: "review",
      attachmentData: [
        { name: "brief.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("real file bytes") },
      ],
      validateApproval: () => {
        checks++;
      },
    };
    const first = await enqueueReviewedGatewayInput(m, input);
    expect(checks).toBe(3);
    const queued = m.nextQueued("chief")!;
    expect(queued.delivery.attachments).toHaveLength(1);
    const file = await m.resolveAttachment(queued.delivery.attachments[0].id);
    expect(await readFile(file!.path, "utf8")).toBe("real file bytes");
    const duplicate = await enqueueReviewedGatewayInput(m, input);
    expect(duplicate.messageId).toBe(first.messageId);
    expect(await readdir(join(root, "user", "attachment-drafts"))).toEqual([]);
    let n = 0;
    await expect(
      enqueueReviewedGatewayInput(m, {
        ...input,
        idempotencyKey: "gateway:2",
        validateApproval: () => {
          if (++n === 2) throw Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(await readdir(join(root, "user", "attachment-drafts"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
