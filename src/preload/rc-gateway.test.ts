import { expect, it } from "vitest";
import { decodeLocalRcGateway } from "./rc-gateway";

const valid = {
  enabled: true,
  phase: "online",
  origin: "https://host.example",
  previousOrigin: null,
  changedAt: null,
  message: null,
};
it("accepts only every exact RC phase and nullable string fields", () => {
  for (const phase of ["off", "connecting", "online", "reconnecting", "error"])
    expect(decodeLocalRcGateway({ ...valid, phase }).phase).toBe(phase);
  for (const phase of ["ready", false, {}, null])
    expect(() => decodeLocalRcGateway({ ...valid, phase })).toThrow("Invalid RC");
  for (const field of ["origin", "previousOrigin", "changedAt", "message"])
    expect(() => decodeLocalRcGateway({ ...valid, [field]: 123 })).toThrow("Invalid RC");
  expect(() => decodeLocalRcGateway({ ...valid, enabled: "yes" })).toThrow("Invalid RC");
  expect(decodeLocalRcGateway(valid)).toEqual(valid);
});
