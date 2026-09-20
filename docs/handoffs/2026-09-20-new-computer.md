# Story Studio KH — new-computer handoff

Prepared 2026-09-20. Start here before resuming the interrupted audit.

## Current checkpoint — 2026-09-21

Fresh setup on this computer is explicitly selected. No migration backup or
old Library restoration is required; normal GenStudio/provider, Store, and
YouTube authentication remains ordinary user setup. Source **v1.4.213** has
completed independent scoped review, corrected full test lanes and production
build. PR #123 is merged; the main-built DMG and installed first run are verified.
See [local release acceptance](2026-09-21-local-release.md) for the current
integration/artifact state, exact counts and explicit remaining limitations.

A5 and A6 have bounded accepted evidence in the current ledger, while their
broader acceptance remains open. A8 deliberately preserves valid zero/no-op
operations and uses only narrow caller fixes; it was never blanket-fixed. The
89-row ledger contains many open/source-only cases and is not an 89-fixed-bug
claim. The local unsigned app is installed/open for fresh setup; normal account
configuration and historical follow-ups remain separate from release acceptance.

The migration and backup instructions below are retained as dated historical
contingency guidance, not as a requirement for the selected fresh setup.

**Latest follow-up (2026-09-21):** the clone and isolated recovery worktree exist.
The [16-task workflow](../superpowers/plans/2026-09-20-handoff-completion.md)
and [current progress/remaining checks](../audit/2026-09-20-workflow-progress.md)
record the implemented repair batch and fresh verification. The local-release
acceptance document supersedes the older pending-state snapshots below.

Evidence labels: **[MEASURED]** checked directly against source/command output;
**[REPORTED]** a historical or worker claim that has not been independently
established; **[ASSUMED]** an explicit working assumption. Proposed fixes and
priorities are instructions/judgment, not claims that a repair already exists.

## 1. Which branch to use

[MEASURED] Repository: <https://github.com/theng12/story-studio-kh> (private).
The migration branch is **`codex/recover-interrupted-audit`**. It contains the
70 inherited local commits plus recovery checkpoint
`fca27c955225134ae78c2ac51744c858b10772eb`, and this handoff's documentation.
Historical starting instruction: before PR #123, this branch was required to
resume. The reviewed recovery is now integrated into `main`; use current main
for normal development. The recovery branch remains preserved.

```sh
git clone --branch codex/recover-interrupted-audit https://github.com/theng12/story-studio-kh.git
cd story-studio-kh
git status --short --branch
git rev-parse HEAD
git ls-remote origin refs/heads/codex/recover-interrupted-audit
```

Compare the local HEAD with the remote branch hash. Authenticate to GitHub using
the new computer's own credential flow; no credentials belong in this document.

[MEASURED] At migration preparation, GitHub `main` remains
`9d34df7d58c571e17e90566bdc7936748fa018d2`. Local historical `main` was
`08aa6ee02735788cfc036c8a9ae7d3d17f6eab0f`. The recovery branch preserves both
in its ancestry. Pushing a migration branch is a backup, not approval to release
all inherited changes. Review their inventory before merging.

[MEASURED] Separate unmerged work is already on GitHub:
`codex/upload-center-clarity` at
`0e439aa3707b44a9a46cdd0dd0bebb79e2834d8b`. Preserve it; compare its actual diff
before deciding whether to merge or supersede it. Old worktree directories are
not needed to recover committed branch content.

[MEASURED] GitHub Actions is disabled (`actions/permissions: enabled=false`).
Keep it disabled. Do not dispatch, rerun, or enable hosted workflows. All checks
in this handoff were local.

## 2. What is and is not ready

[MEASURED] Source manifests are v1.4.210. The recovery fixed a queue race where
removing terminal history could clear a still-running worker's stop signal and
allow late completion to restore the deleted row. Cancellation now follows
worker lifetime, including deterministic recovery IDs and in-place Finish
missing images. Independent review and deterministic regression checks cover
the patch. A stale content-pack policy text assertion was also corrected.

[MEASURED] The recovered source builds and an isolated arm64 v1.4.210 app
booted. Onboarding, channel creation, dashboard, and Project Jobs were inspected
in the rendered app with a disposable library. No paid generation or real
YouTube upload was exercised. The full verification ledger, counts, exit codes,
and limitations are in [the takeover report](../audit/2026-09-20-takeover.md).

[MEASURED] Portable evidence is checked into
[`evidence/2026-09-20/`](evidence/2026-09-20/): compact verification outputs and
actual exit statuses, dependency audit JSON, the inherited commit inventory,
the cancellation review, and exact historical candidate source slices. The
full old-computer logs and Git bundles remain local; this evidence directory
and the GitHub branches are what a normal clone restores.
Absolute `<owner-home>/...` paths inside captured command evidence are
historical provenance with the owner's home path redacted, not runnable paths
on the new computer. Recorded log hashes still identify the original private
logs; displayed summary lines redact only that home prefix. Use the relative
setup commands in this handoff; local preview app bundles were not committed.

[MEASURED] On the old computer, the installed app is v1.4.176; the previously
packaged app/DMG is v1.4.206. Neither proves the current source was released.
The recovery preview is local-only, unsigned, and is not the final DMG.

## 3. Start on the new computer

[ASSUMED] These desktop build instructions target an Apple Silicon Mac, matching
the repository's supported arm64 macOS target. Windows/Linux/Intel desktop
packaging is not established by this handoff.

[MEASURED] The verified old-computer toolchain was Node **v24.15.0**, npm
**11.12.1**, arm64. Reproduce this toolchain first, plus Git and macOS developer
tools needed by Electron/native modules. Then use the checked-in lockfiles:

```sh
npm ci
npm --prefix frontend ci
node scripts/developer/sync-story-authoring-skills.mjs --install --skills-root "$HOME/.agents/skills"
node scripts/developer/sync-story-authoring-skills.mjs --check --skills-root "$HOME/.agents/skills"
npm run build
npm run dev
```

[MEASURED] The skill check expects **5 packages, 13 files**. The existing script
defaults to `~/.codex/skills`; the explicit root above uses the user skill
directory in current official Codex documentation. See
[the skill migration guide](../../developer-migration/SKILLS.md) for the complete
inventory, bundle names, and local-only skills that require separate transfer.

Use a disposable Library for the first startup. Confirm which backend answers,
the displayed app version, and the effective Library path before touching real
projects. For generation, configure the one approved GenStudio endpoint and
credentials through the app. A `127.0.0.1` endpoint means a service on the new
computer; copying an old address does not move that service.

[MEASURED] `npm run fetch:ffmpeg` is the repository's command for obtaining the
ignored bundled FFmpeg binary. Packaging uses it; do not copy `node_modules`,
compiled output, or an old worktree-built DMG as source.

## 4. Data and credentials do not travel in Git

[HISTORICAL CONTINGENCY] The Git branch contains source, Content Pack authoring sources,
canonical Story skills, audit documents, and test fixtures. It does not contain
the user's Library, generated media, installed Store state, OS credentials, or
the global Codex plugin installation.

Historical migration checklist (not required for the selected fresh setup):

1. Back up the Library actually selected in Story Studio, including channel
   folders, output, media, and shared assets. Verify the selected location; do
   not assume a default from an old document.
2. Preserve `~/Library/Application Support/Story Studio KH/` and any configured
   external media roots through a private, protected migration. Review absolute
   paths on the new Mac.
3. Preserve the external `~/Developer/_handoffs/` ledger and its retained history
   if present. It is outside this repository.
4. Migrate Keychain/OS credentials appropriately or re-enter them. Electron
   `safeStorage` files are not portable plaintext exports. Revalidate Store
   ownership and exact installed versions; preserve fail-closed protections.
5. Transfer the custom skills identified in the skill guide. Reinstall plugins
   by their names; do not replace the new computer's whole Codex configuration
   with an old cache or credential directory.

See [the detailed data migration checklist](../operations/new-computer-migration.md).
No private Library or credential migration has been performed by this task.

## 5. The next engineering work

Use [the bug and fix backlog](../audit/2026-09-20-bug-backlog.md), which separates
current evidence from historical allegations, and retains the full recorded
candidate inventory. It is not a claim that every possible app defect has been
discovered. Unknown issues require further workflow and failure-injection tests.

Work in this order:

1. Address the confirmed subtitle-fingerprint path containment gap and triage
   dependency advisories with caller/exposure checks.
2. Finish Scene Plan support for models without a published output ceiling.
   The owner already authorized omission of that limit; do not ask again or
   invent a model allowance. Define an honest batch-size path and test it.
3. Surface invalid Content Pack state recovery without losing quarantined
   bytes or weakening Store validation.
4. Reproduce the high-impact completion, stale-output, archive, and publishing
   candidates before implementing their proposed fixes.
5. Review the inherited commit inventory, resolve the separate Upload Center
   branch, then complete integration and packaging when all gates are satisfied.

[MEASURED] A separate channel-reusable Scene Plan guidance box is requested in
the recorded owner decisions. Its persistence choice (project configuration
versus presets only) is not recorded as decided. Clarify only that missing
product choice before implementing it; episode guidance must remain separate.

## 6. Working rules to carry forward

Read `AGENTS.md`, then the audit evidence. Preserve the owner's live-model,
episode-isolation, preset, provider-display, local-assembly, paid-work recovery,
and verified-completion rules. Never restore retired product features.

Use the strong orchestrator for scope, decisions, verification, and synthesis.
Owner ruling, 2026-09-20: the orchestrator owns planning, architecture,
independent review, verification, and integration. Prefer Luna for
straightforward tasks, Terra for involved cross-file work, and Sol at no more
than high reasoning for data-integrity, security, and lifecycle work.
Assignments include the base commit, owned files, deliverable, and proving
checks. Parallel workers own disjoint write scopes; uncertain bugs require
reproduction before repair. This supersedes earlier Luna-only and unrestricted
model-selection guidance.
Each assignment must include GOAL, INPUT, numbered
STEPS, exact OUTPUT, DON'T, and IF INCOMPLETE. Require quotations and file:line
evidence and check important claims independently. Read-only workers must not
start test suites. Keep durable progress in this handoff/backlog rather than
depending on chat memory.

Use the smallest secure repair. Preserve customer data and unrelated changes.
Run one test suite at a time. A focused backend run is not the full release gate:

```sh
node scripts/testing/run-backend-tests.mjs --only <test-file-substring>
npm run verify
```

Record actual exit status, test counts, and completion lines. Audit dependencies
separately; successful build/security checks do not mean an npm audit is clean.
Inspect rendered UI for visual changes. For application changes, follow the
root manifest version and changelog rules; content-only work has a separate
release path. Do not bump the application for this handoff-only documentation.

The owner permits commits, pushes, PR creation/update, and merge only after
appropriate independent review, local verification, and resolved mergeability.
Never force-push or bypass checks. No deployment, publication, tags, paid calls,
or destructive data disposal is authorized by that repository integration rule.
After application changes are integrated into `main`, build and verify the
versioned arm64 DMG from `main`, per `AGENTS.md`.

## 7. First prompt for the new agent

> Take over Story Studio KH on `codex/recover-interrupted-audit`. Read AGENTS.md,
> docs/handoffs/2026-09-20-new-computer.md,
> docs/audit/2026-09-20-bug-backlog.md, and developer-migration/SKILLS.md first.
> Verify the local branch equals its GitHub remote, inspect Git status, and
> preserve unrelated work. Use the recorded owner decisions. Start with the
> highest-priority confirmed issue, reproduce it, implement the smallest safe
> fix, obtain independent review, and run appropriate local checks. Do not run
> GitHub Actions or claim the inherited audit is complete. Delegate bounded
> work under the latest model policy in AGENTS.md; personally review and verify
> evidence, coordinate integration, and keep the handoff current.
