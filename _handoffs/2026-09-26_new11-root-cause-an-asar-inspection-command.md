# NEW-11 is solved — and it was never packaging

**Date:** 2026-09-26 · **From:** the coordinating session · **Re:** NEW-11 (root cause unidentified)

## The finding

**NEW-11's recorded diagnosis is wrong.** It says packaging rewrote the checkout's root
`package.json` into its trimmed shape. It does not. The guard written for that theory
(`snapshotSourceManifests` / `restoreSourceManifests`) **never fired** during a real 1.4.225
`dist:smoke` — it reported no rewrite, because electron-builder never touched the file.

The actual cause is an **inspection command**:

```bash
npx asar extract-file "dist/mac-arm64/Story Studio KH.app/Contents/Resources/app.asar" package.json
```

`asar extract-file` writes the named file **into the current working directory**. Run from the
repository root — which is where anyone inspecting a build will be standing — it overwrites the
source manifest with the packaged one.

That is exactly the observed shape, and it needs no other explanation:

| Symptom | Explained by |
|---|---|
| `scripts` block gone | the packaged manifest has none |
| `devDependencies` gone | the packaged manifest has none |
| `\u2014` became a literal em-dash | a `JSON.parse`/`JSON.stringify` round trip |
| no trailing newline | `JSON.stringify` output written raw |

**Reproduced on demand, twice, from a clean tree.** `scripts: 0, devDependencies: 0` every time.

## Why it looked like packaging

Because the symptom appears after a build, and the file it damages is one a build legitimately
reads. The correlation was real; the causation was not. It is worth noting that the previous
session hit this *while inspecting the artefact to verify a release* — the same way this session
did. The command that breaks the checkout is the command you run to check the checkout.

## What changed

1. **`electron/server/__tests__/source-manifest-integrity.test.ts`** — the guard that actually
   catches it, in the release gate (`npm run test:backend`), so it cannot go unnoticed for a day
   again. It asserts the file's **shape**: `scripts` present and non-empty, the five gate commands
   still declared, `devDependencies.electron` present, and the escaped `\u2014` intact.
   **Proved to fail on the defect:** reproduced the overwrite, 4 of 4 tests failed; restored,
   4 of 4 pass.
2. **The comments in `release-utils.mjs` and `build-unsigned-dmg.mjs`** were corrected to name the
   real cause. The snapshot/restore is **kept** — it is cheap, and a future electron-builder that
   really does rewrite the file should still be caught. It is just no longer the guard that matters.
3. The mutated manifest is preserved as evidence at
   `_trash/new11-evidence/package.json.MUTATED-by-dist-smoke-2026-09-26-1432.json`.

## What it cannot catch

The test runs when the suite runs, so a checkout can sit broken between the write and the next
gate. The practical rule is the cheaper one anyway: **never run `asar extract-file` with
`package.json` as the target from inside the repository.** Extract to a temp directory, or read
the manifest out of the asar with a tool that prints rather than writes.

## For the next session

NEW-11 can be closed. If you see this symptom again, do not look at the build — check what
inspected the asar.
