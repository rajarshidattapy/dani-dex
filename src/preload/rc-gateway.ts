import { isDynamicRecord, isOneOf } from "@dani-dex/contracts/runtime-values";
export function decodeLocalRcGateway(value: unknown): import("@dani-dex/contracts/ipc").RcGatewayStatus {
  if (
    !isDynamicRecord(value) ||
    typeof value.enabled !== "boolean" ||
    !isOneOf(["off", "connecting", "online", "reconnecting", "error"] as const, value.phase) ||
    !(value.origin === null || typeof value.origin === "string") ||
    !(value.previousOrigin === null || typeof value.previousOrigin === "string") ||
    !(value.changedAt === null || typeof value.changedAt === "string") ||
    !(value.message === null || typeof value.message === "string")
  )
    throw Error("Invalid RC gateway status.");
  return {
    enabled: value.enabled,
    phase: value.phase,
    origin: value.origin,
    previousOrigin: value.previousOrigin,
    changedAt: value.changedAt,
    message: value.message,
  };
}
