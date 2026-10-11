import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { audit } from "./lightweight-audit.mjs";

test("counts source and tests, excludes secrets/dependencies/symlinks, reports duplicates and output separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightweight-audit-"));
  try {
    for (const dir of ["src/main", "node_modules", "out/main"]) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "src/main/a.ts"), "one\ntwo\n");
    await writeFile(join(root, "src/main/b.test.ts"), "one\ntwo\n");
    await writeFile(join(root, ".env"), "SECRET");
    await writeFile(join(root, "node_modules/hidden.js"), "ignored");
    await writeFile(join(root, "out/main/index.js"), "built();");
    await symlink(join(root, "src"), join(root, "linked"));
    const result = await audit(root);
    assert.equal(result.areas.length, 1);
    assert.equal(result.areas[0].sourceLines, 4);
    assert.equal(result.areas[0].testLines, 2);
    assert.deepEqual(result.duplicates[0].paths.sort(), ["src/main/a.ts", "src/main/b.test.ts"]);
    assert.equal(result.bundles.length, 1);
    assert.equal(result.bundles[0].bytes, 8);
    assert.ok(result.bundles[0].gzipBytes > 0);
    assert.deepEqual(result.excluded, [".env", "linked", "node_modules", "out"]);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
