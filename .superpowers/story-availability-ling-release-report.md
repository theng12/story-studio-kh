# Story Studio availability + Ling release report

## Scope and history

- Base: `0762a886` (`main`)
- Reviewed branch head before this release audit: `103ce3d7` (`feat/story-availability-reason`)
- Audited implementation head: `54f1afcf` (`feat/story-availability-reason`)
- Application version: `1.4.100`
- Branch commits reviewed:
  - `e25fccdc` — Explain unavailable GenStudio chat models
  - `103ce3d7` — Repair truncated narrative chapters safely
  - `54f1afcf` — Keep narrative repair limited to truncation

This is an application release. `package.json`, `package-lock.json`, and the
newest `CHANGELOG.md` entry already agree on `1.4.100`; the release audit kept
that single unreleased patch version rather than introducing an unnecessary
second bump.

## Reviewed outcomes

1. **Unavailable GenStudio LLM models:** catalogue parsing allowlists only
   `daily_quota_depleted` and `temporary_backpressure`, normalizes only valid
   reported return times, and forwards both through `/api/models`. The picker
   displays a localized future return time only when present and in the future;
   stale, missing, malformed, unknown, and legacy metadata retains the existing
   generic disabled wording. Unavailable options remain visible, `aria-disabled`,
   excluded from keyboard selection, and guarded against click selection.
2. **Ling output truncation:** the durable
   `LANGUAGE_PROVIDER_INCOMPLETE` result and compatible truncation finish
   reasons become the typed incomplete signal. Parseable chapters from a
   truncated batch remain on disk; only missing chapter slots receive one
   separate repair request, each sized at the bounded 8,192-token workload
   budget. Completed slots are not overwritten.

## Finding fixed during this audit

`expandNarrativeSequential` previously caught every
`GenStudioChatIncompleteError`, including non-truncation finish reasons such as
`content_filter`. That could create a billable replacement request for a
provider/content outcome outside the approved Ling truncation path.

The repair guard now requires `error.truncated`. Non-truncation incomplete
results stay terminal and require explicit Retry; their partial customer-facing
chapter output is not written. The regression test was first run red, then
green, and verifies exactly one original expansion request with no repair.

## Verification evidence

- RED: `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke`
  — 14 pass, 1 expected failure (the new non-truncation retry test).
- Focused GREEN:
  `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke --only genstudio-chat-durable --only genstudio-relaxed-queue-catalogue`
  — 53/53 tests, 3/3 files; explicitly a partial iteration run, not a release gate.
- Release metadata: `npm run check:changelog` — passed for `v1.4.100`.
- Full official gate: `npm run verify` — passed after lint/typecheck, all test
  lanes, static frontend build, Electron build, built security, and built
  desktop-release checks:
  - backend: 4,183/4,183 tests; 382/382 files completed
  - frontend: 1,287/1,287 tests; 137/137 files completed
  - release: 36/36 tests; 4/4 files completed
  - content packs: 194 passed, 0 failed, 2 documented skips; 27/27 files completed
- Deterministic GenStudio qualification:
  `node scripts/qualify-genstudio-release.mjs` — 206/206 tests and the
  qualification TypeScript contract passed; the script confirms no provider
  calls, live jobs, or credits were used.

`npm run verify` retains the repository's existing lint warnings (1,772
warnings, 0 errors); this branch does not add or modify them.

## Final review and release state

- `git diff --check` passed.
- The final diff is limited to the approved availability/Ling behavior,
  assertions, required v1.4.100 metadata, and this audit report.
- No deployment, publish, push, merge, DMG build, or live-data operation was
  performed.
- After the local audit-fix and report commits, the worktree is clean.

**Ready for independent review: yes.** The outstanding step is independent
review/integration only; no known release blocker remains.
