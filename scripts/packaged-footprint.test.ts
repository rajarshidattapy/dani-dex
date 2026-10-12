import { expect, it } from "vitest";
import { asarFileSizes, assertLeanPackage } from "./packaged-footprint";

it("fails packaging on duplicate renderer dependencies and development payloads", () => {
  for (const path of [
    "node_modules/lucide-solid/dist/x.js",
    "node_modules/three/a.js",
    "node_modules/zod/a.js.map",
    "node_modules/a/b.test.js",
    "node_modules/a/b.d.ts",
  ])
    expect(() => assertLeanPackage([{ path, bytes: 1 }])).toThrow();
  expect(() =>
    assertLeanPackage([
      { path: "out/renderer/index.js", bytes: 2 },
      { path: "node_modules/zod/index.js", bytes: 2 },
      { path: "node_modules/zod/LICENSE", bytes: 2 },
    ]),
  ).not.toThrow();
});
it("reads nested sizes including unpacked entries and rejects malformed headers", () => {
  const header = Buffer.from(
    JSON.stringify({
      files: { out: { files: { "index.js": { size: 7, offset: "0" } } }, "host.js": { size: 5, unpacked: true } },
    }),
  );
  const b = Buffer.alloc(16 + header.length);
  b.writeUInt32LE(header.length, 12);
  header.copy(b, 16);
  expect(asarFileSizes(b)).toEqual([
    { path: "out/index.js", bytes: 7 },
    { path: "host.js", bytes: 5 },
  ]);
  expect(() => asarFileSizes(Buffer.alloc(1))).toThrow();
});
