# Test and release procedure

**This page is procedure, not rules.** It says how to run the checks and land a release: which
commands, which lanes, which flags, what evidence to keep. The rules themselves — what must be true,
what is forbidden, what is retired — are in [`AGENTS.md`](../../AGENTS.md), and where the two
disagree about what must be true, `AGENTS.md` wins. The reasoning behind either lives in
[`docs/architecture/agents-decisions.md`](../architecture/agents-decisions.md).

## Tests — change-aware (owner-approved 2026-11-08)

Every release runs the cheap checks on one exact source — `lint`, `check:changelog`,
`check:typography`, `check:security`, `check:model-drift`, `typecheck` — plus the packaged
launch/update smoke. Changed-area regressions run the focused suites for every affected path and
review their callers. The verification record names the changed paths and selected tests, reports each
test's actual completion line and count, and lists every omitted suite with its reason. Exact-source
and log-hash integrity and actual completion of every selected test remain mandatory; an omitted
suite is reported honestly, never implied to have passed.

Full regression — every backend and frontend suite plus release and content-pack lanes — is required
when the change's reach cannot be safely bounded (shared queue, storage or generator infrastructure;
dependencies, toolchain, signing, installer or test-harness changes; a broad refactor) or the last
full-run proof is missing. Reuse earlier passing checks when source, tests, dependencies and toolchain
are unchanged, naming the source commit; a skipped suite reads "skipped (unchanged since <commit>)",
never "passed". The ten-step `story-final-gate` runner at
`_orchestra/app-closeout-20261021/story-final-gate-tools/run-gate.sh <worktree> <evidence-dir>` is the
full fallback and never becomes a narrowed claim.

## Receipts — testctl

Execution and receipts use `~/Developer/portfolio/bin/testctl`; Developer owns its core. Configure
Story's lanes there, scope `paths` only after confirming their complete inputs, and keep `ship-story`
verification as an adapter citing receipt key, source commit and log SHA-256. No second runner.
Story's adapter is `scripts/release/orchestration/story_testctl_proof.py` (proof kind
`testctl-change-aware`) over the shared portfolio core; proofs in the never-qualified old schema-3
format are refused at publication. Report an unsupported scoped proof as blocked rather than bypassing
verification. Never label a failed or superseded run passed, or rerun unrelated suites to satisfy an
old proof format. The earlier standalone runner research under `scripts/release/change-aware/` is
retained **undeployed** on `work/change-aware-release-20261108`: never revive it, copy it or point a
release at it.

## Focused runs while iterating

Run only what you are working on:
`node scripts/testing/run-backend-tests.mjs --only <substring>` (repeatable; matches the test file's
name). A filtered run prints a loud `PARTIAL RUN` banner — **focused, not a full-suite proof**, never
quoted as a green suite. An `--only` matching nothing fails, as does a run reporting zero tests. **A
read-only agent may run a focused `--only` run in its OWN worktree** (within the **Parallel tests**
limits below) — never the full regression, never a competing lane in a shared worktree. For every
suite you cite, report its actual exit status, completion line and test count — a wrapper's exit code
is not the suite's, and "completed" is not "passed". The lane's hang watchdog defaults to 180 minutes
(`STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS`); a kill by it is a machine setting, not a product defect —
raise the number, do not narrow the lane.

## Parallel tests — owner 2026-10-24: "do that whenever possible."

Serial is the exception, kept only where side-by-side has broken a result. The Story full regression
runs alone among Story suites. The backend lane runs its files in a bounded pool of `min(4, cores/2)`
workers (`STORY_STUDIO_BACKEND_TEST_WORKERS` overrides) then a measured `SERIAL_TEST_FILES` list;
`STORY_STUDIO_BACKEND_SERIAL_TESTS` adds names for one run only. A serial entry is measured, never
guessed: it failed while other files ran and passed alone, or it asserts a WALL-CLOCK ceiling or exact
interval-fire count. A slow file is fixed at its cause through an existing seam, never by deleting its
assertion. With no gate running, up to two focused (`--only`) runs may share different worktrees;
Hub/Gateway modules run freely in parallel. Never in parallel: two runs in one worktree, installer
tests (they share `_trash`), or anything touching the real mini, live Gateway or production. A
timing-looking failure while other work ran is rerun alone before being called a defect.

## Long tests run outside the app — owner 2026-10-31

Run release verification and other long jobs through `_orchestra/tools/run-detached.sh <name>
<script>`, then read `<name>.exit` and the log. Verification runs alone as under **Parallel tests**.
When the changed-area set cannot be established, run the full regression. A launchd job has no app
behind it for macOS privacy answers, so a test opening a protected folder can hang: point such paths
at temp dirs, and never change privacy settings to answer it.

## Every release refreshes the graphs — owner 2026-10-31

`_orchestra/tools/refresh-graphs.sh`, detached, beside the changelog step. A worker uses
`_graphs/<app>/graphify-out/graph.json` and asks for a refresh when it is missing or older than its
code; never "if a graph exists".

## Test isolation

Installer tests copy the real script into a private temporary project with its own source, target and
trash, so they never read, move or remove the owner's `_trash/app` or replace the app in
`/Applications`; keep that property in any new installer test. The release lane's `install-local` case
needs `dist/mac-arm64/Story Studio KH.app`, hence the prebuild. Live fixtures use `.test-work/`
(gitignored); content-pack staging uses `../.test-work/<checkout-name>/`, and
`STORY_STUDIO_TEST_WORK_ROOT` may name another real directory outside Trash. Finished containers move
to `_trash/test-fixtures/` (or `STORY_STUDIO_RETAINED_FIXTURES_ROOT`) only after children close and
evidence is reconciled; removing the retained root mid-run is safe, but removing a live work directory
fails the run loudly and stops its process group. Never use Trash for a test's own live fixtures.

## Releases — classification

- **Application release** — any code shipped inside Story Studio (fixes, reliability, UI/API/runtime
  behaviour, dependency updates, migrations): bump the version in **both** `package.json` and
  `package-lock.json` in the same change set.
- **Content-only** — a standalone Content Pack whose kind and schema are already supported ships as
  its own `.sspack`: no application version bump, no changelog entry, no DMG, no deploy, no restart.
  Use the released compatibility floor in `content-packs/release-floor.json`.
- **Mixed** follows the application path only for the runtime behaviour it changes.

Add the newest-first `## vX.Y.Z` entry to `CHANGELOG.md` (the source of in-app **What's New**) and run
`npm run check:changelog`; the release is incomplete if the runtime version, newest entry and What's
New details differ.

## The whole cycle, every time — owner 2026-09-26

Every change is merged, committed, pushed and built into a DMG, and the latest three verified released
installers stay in canonical `dist/` (owner 2026-11-12, raised from two) — nothing ships un-gated,
un-built or un-pushed. An older DMG leaves `dist/` only after the reference checks: never one named by
`release.json`, `previous-release.json`, the retention ledger or a running job, and every move logs its
version, SHA-256 and destination. **A change is not finished while any step below is missing.**

The order is **prebuild → release verification → rebuild from `main`**, and it is not optional:

1. **Prebuild in the release worktree:** `npm run dist:smoke` (stable local signing and isolated
   launch) or `npm run dist:public` (signed/notarized candidate). Verification including
   `test:release` needs this build.
2. **Run release verification** on that exact source (see **Tests** above). Use the full ten-step
   regression only when a trigger above applies; preserve source identity and evidence integrity.
3. **Integrate, then rebuild from `main`.** Build the final DMG from the **main** checkout into the
   repository-root `dist/`; verify its versioned `arm64` filename and bundled `app.asar` version
   against `main`, and never copy a worktree-built DMG into `main`'s `dist/` before its source is
   integrated. Land it on `main` through the `land/<version>-into-main` flow, then push.

## Batch, do not dribble — owner 2026-10-26: "do all 4 if possible so it's faster."

Put related changes into one release and run **one release verification per batch** (focused runs
first for every area touched). Batching never turns a narrowed run into a full-suite claim. Both
desktop builders stage and verify new output before exposing it; replaced same-version candidates are
backed up recoverably, never deleted, and the released rollback pair stays while a candidate is
unverified. After installed functional acceptance and active-job/dependency checks, `npm run dist:retain
-- <trusted-story-pins.json>` invokes the shared portfolio helper — it alone manages its recorded pair,
and unmanaged historical aliases need separate recoverable retirement after dependency checks (see
`scripts/release/orchestration/README.md`). **The one exception is content-only**, which takes no app
version bump and no DMG.
