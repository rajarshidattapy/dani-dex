import { z } from "zod";
export const peerIntent = z.enum([
  "propose_times",
  "request_freebusy",
  "accept",
  "decline",
  "confirm",
  "ask",
  "inform",
  "share",
  "book_request",
]);
const date = z.string().max(40).datetime({ offset: true });
const slot = z
  .object({ start: date, end: date })
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start), "Invalid slot order.");
export const peerEnvelope = z
  .object({
    oip: z.literal("1"),
    intent: peerIntent,
    subject: z.string().min(1).max(500),
    on_behalf_of: z.object({ handle: z.string().min(1).max(100), display: z.string().min(1).max(100) }).strict(),
    payload: z.record(z.string(), z.unknown()),
    needs_consent: z.boolean(),
    reply_by: date.optional(),
  })
  .strict();
export type PeerEnvelope = z.infer<typeof peerEnvelope>;
const payloads = {
  propose_times: z
    .object({
      slots: z.array(slot).min(1).max(3),
      place_hint: z.string().max(500).optional(),
      duration_min: z.number().int().min(1).max(1440).optional(),
    })
    .strict(),
  request_freebusy: z
    .object({
      window: z
        .object({ from: date, to: date })
        .strict()
        .refine((w) => Date.parse(w.to) > Date.parse(w.from) && Date.parse(w.to) - Date.parse(w.from) <= 31 * 86400000),
    })
    .strict(),
  accept: z.object({ slot, place: z.string().max(500).optional(), note: z.string().max(1000).optional() }).strict(),
  decline: z
    .object({ reason: z.string().max(1000).optional(), alternatives: z.array(slot).max(3).optional() })
    .strict(),
  confirm: z.object({ summary: z.string().max(2000), calendar_event: z.string().max(256).optional() }).strict(),
  ask: z.object({ question: z.string().max(2000), options: z.array(z.string().max(500)).max(10).optional() }).strict(),
  inform: z
    .object({
      facts: z
        .record(z.string().max(100), z.union([z.string().max(500), z.number().finite(), z.boolean()]))
        .refine((v) => Object.keys(v).length <= 20),
    })
    .strict(),
  share: z
    .object({ kind: z.enum(["contact", "location.approx", "link", "file"]), value: z.string().max(2000) })
    .strict(),
  book_request: z
    .object({
      vendor: z.string().max(500),
      details: z
        .object({
          date: date.optional(),
          party_size: z.number().int().min(1).max(100).optional(),
          note: z.string().max(500).optional(),
        })
        .strict(),
      budget_usd: z.number().min(0).max(1000000).optional(),
    })
    .strict(),
};
/** Transport proof is supplied by the adapter, never taken from a payload's display name. */
export interface VerifiedPeerSource {
  contactId: string;
  transportPrincipal: string;
  requestId: string;
  contextId: string;
}
export function validatePeerEnvelope(value: unknown): PeerEnvelope {
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > 12000) throw Error("Peer envelope too large.");
  const check = (v: unknown, depth = 0): void => {
    if (depth > 5) throw Error("Peer payload too deep.");
    if (v && typeof v === "object") for (const child of Object.values(v)) check(child, depth + 1);
  };
  check(value);
  const envelope = peerEnvelope.parse(value);
  payloads[envelope.intent].parse(envelope.payload);
  return envelope;
}
export function projectBusyBlocks(
  events: Array<{ start: string; end: string; [key: string]: unknown }>,
): Array<{ start: string; end: string }> {
  return events.map((e) => slot.parse({ start: e.start, end: e.end }));
}
/** Restrict disclosure to the requested window; overlapping busy events reveal only their union. */
export function projectBusyWindow(
  events: Array<{ start: string; end: string; [key: string]: unknown }>,
  window: { from: string; to: string },
): Array<{ start: string; end: string }> {
  const validated = payloads.request_freebusy.parse({ window }).window;
  const from = Date.parse(validated.from);
  const to = Date.parse(validated.to);
  const blocks = projectBusyBlocks(events)
    .map((event) => ({ start: Math.max(from, Date.parse(event.start)), end: Math.min(to, Date.parse(event.end)) }))
    .filter((event) => event.start < event.end)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && block.start <= last.end) last.end = Math.max(last.end, block.end);
    else merged.push({ ...block });
  }
  return merged.map((block) => ({
    start: new Date(block.start).toISOString(),
    end: new Date(block.end).toISOString(),
  }));
}
