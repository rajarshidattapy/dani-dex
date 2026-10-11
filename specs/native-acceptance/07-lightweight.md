# 07 - Lightweight application and codebase

Owner request: October 4, 18:36 IST. Reduce weight while fixing the root microphone issue. Do not trade real 3D, local-first operation, accuracy, security, retained user data or test coverage for a smaller number.

## Reproducible baseline

Run `node scripts/lightweight-audit.mjs` from the exact frozen Mac repo; save JSON outside the checkout. The script is dependency-free, read-only, follows no symlinks, excludes secrets/dependencies/generated output, counts source lines including comments/blanks and reports exact-byte duplicate candidates. Excluded paths are listed. Duplicate matches are leads, not deletion authority.

Supporting Linux candidate measurement at 18:37 IST, not Mac acceptance:
- Working-tree scope: 2,741 files, 56,205,369 bytes; 439,830 source lines, including 125,032 test lines. Includes the audit script/tests and temporary local test config. This is not tracked-only size or installed-app size.
- auth-api: 31,572,529 bytes, 29,309 source lines. Renderer: 7,174,464 bytes, 148,988 lines. Backend: 3,453,661 bytes, 81,758 lines. Main: 2,922,896 bytes, 70,548 lines. Mobile: 2,401,264 bytes, 35,213 lines.
- Existing output only: main index 2,881,325 bytes / 640,629 gzip bytes. No renderer output here, no fresh build asserted. Measure clean production main/preload/renderer and packaged application on Mac.
- 23 exact source duplicate groups. Largest is 1,550 bytes; many are intentional mirrored lint fixtures. Do not delete mirrored fixtures without checking their consumers.

## Ranked reduction plan

1. Inspect largest non-source assets and installed runtime/model costs first. Inventory package resources, dependencies and model cache separately. Report actual bytes and imports; do not infer runtime RAM from repository size.
2. Confirm voice model preparation/download is explicit and on demand. Cold launch and opening choices must not load model sessions or download assets. Prove via process tree, network and file evidence. Preserve offline use after an explicit install.
3. Profile renderer/main startup and idle resources before changing imports. Three cold launches to usable Chief, five minutes idle without voice, then active voice and post-call cleanup. Record Mac/OS/build, median startup, per-process CPU and aggregate RSS. Compare identical release/dev mode, profile and data; dev watchers are separate overhead.
4. Audit retired faces/channels and dependencies with import, route, package/build inclusion and test-consumer evidence. A search miss alone does not establish dead code. Preserve Chief-only and real 3D; preserve regression coverage. Rank removals by measured bundle/installed bytes and native regression risk.
5. Consolidate proven duplicate implementation paths only after consumer parity. Intentional fixture duplication has low payoff. Remove nothing merely to shrink LOC.

## Acceptance and evidence checklist

- [ ] Mac baseline repo areas/LOC, tracked vs generated vs installed dependencies/models measured separately.
- [ ] Fresh production output raw/gzip sizes and packaged-app disk size recorded, with source fingerprint.
- [ ] Startup/idle CPU/RSS captured using the procedure above. No invented targets or claimed savings.
- [ ] Ranked proposal lists each candidate, evidence, bytes, affected contracts, tests and rollback before deletion.
- [ ] Each accepted reduction has before/after numbers, same-snapshot native acceptance and no widened auth/network behavior.
- [ ] Mic failure remains tracked independently. Weight cleanup cannot mark the microphone spec complete.

First safe patch adds this measurement tool and fixture test only. It changes no application runtime, removes no code/dependency/test and claims no size or speed improvement. App reductions remain queued until measurement supports them.
