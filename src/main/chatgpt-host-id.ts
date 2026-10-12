import { z } from "zod";

const uuidV4 = z.uuid({ version: "v4" });

/** Preserve the original UUID of older installs while adding OpenAI's required URI prefix. */
export function chatGptHostId(value: string): string {
  const uuid = value.startsWith("urn:uuid:") ? value.slice("urn:uuid:".length) : value;
  if (!uuidV4.safeParse(uuid).success)
    throw new Error(
      "ChatGPT sign-in could not start because this device's saved host ID is invalid. Existing accounts were kept.",
    );
  return `urn:uuid:${uuid}`;
}
