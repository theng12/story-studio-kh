# AH-001 / AH-002 implementation report

Date: 2026-09-05
Worktree: `codex/agent-handoff-story-recovery`
Baseline: `6cb90aca4e6e340f6f58c5691c4eb820160f3a08` (`v1.4.101`)
Implementation commit: `e3970ddc16f7dd40897e3d88508e2eea4a61281b`

## Root cause and scope

No project `logs/` files existed in this isolated worktree. AH-001 was therefore assessed against its durable candidate recovery tests. The v1.4.101 `recoverSafelySettledStallJobs` path already satisfies the described `201/201` failure: it reclaims accepted image work by its saved task identity, requires authoritative terminal evidence, deduplicates repeated recovery signals, transitions the stalled job to `done`, and lets pipeline continuation execute once. No second stall-recovery mechanism was added.

For AH-002, `generateSubtitlesTranscribe()` correctly verified individual chapter coverage, then caught any auto-stitch error, emitted `Auto-stitch skipped`, and returned. The queue consequently persisted a successful subtitle job even when the required stitched timeline or its metadata was missing/stale. The Jobs-page retry mapping also dropped the exact `sections` allow-list.

## Changes

- Subtitle jobs now require an auto-stitch result of `stitched` and a valid timeline-integrity sidecar. Any skip, failure, or invalid metadata marks the structured result incomplete and throws a recoverable job error; successful section SRTs remain untouched.
- Restored `params.sections` in Jobs-page subtitle Retry so a retry remains confined to its durable missing-section list.
- Added the separate machine-local `paid_subtitle_replacement` setting, defaulting exactly to `{ enabled: false, additional_credit_ceiling: null }`, with strict flat validation and dedicated GET/PUT routes.
- Added the corresponding This Mac control with the owner-provided label: `Automatically buy one replacement for a confirmed failed subtitle section`.
- Bumped the application release to `v1.4.102` and added the newest-first changelog entry.

## Red / green evidence

1. RED: `node scripts/testing/run-backend-tests.mjs --only subtitle-stitcher` failed because `requireWrittenSubtitleStitch` did not exist. The intended failure was a skipped auto-stitch being allowed to return.
2. GREEN: after the boundary was added, the same focused suite passed 6/6 tests.
3. RED: `node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings` failed the new subtitle-setting test with `expected 200, got 404`.
4. GREEN: after implementing the separate app setting and routes, that new setting test passed. The file still has an unrelated baseline failure in its existing frontend composable test because this worktree cannot resolve package `vue`.

## Verification

- `npm run check:changelog` — passed; package, lockfile, and newest changelog entry agree on `v1.4.102`.
- `npm run typecheck:electron` — passed.
- `npm run lint` — exit 0 with 1,775 pre-existing warnings and no errors.
- `node scripts/testing/run-backend-tests.mjs --only job-queue-genstudio-resume --only subtitle-stitcher` — passed; this includes the v1.4.101 AH-001 candidate recovery coverage and the new stitch guard. This is explicitly a partial run, not the release gate.
- `node scripts/testing/run-backend-tests.mjs --only paid-image-replacement-settings` — the new subtitle-policy test passed; the suite remains non-green only due to the pre-existing unresolved frontend `vue` dependency noted above.
- `npm --prefix frontend run typecheck` — blocked before type checking: `nuxi: command not found` in this worktree.

No full verification suite, build, DMG, deployment, publication, provider call, or live-data operation was run.

## Self-review and concerns

The completed fix is deliberately fail-closed: subtitle jobs cannot claim completion without a verified stitched SRT, and the image paid-replacement setting is not reused for subtitles.

AH-002 is **not fully complete** against the entire handoff. The durable per-episode recovery-plan DAG, automated free transcription reconciliation, manual `Buy missing subtitles now` action, and bounded automatic paid replacement execution/settlement protocol still need implementation and the corresponding acceptance suite. The new machine setting and UI are a safe authorization boundary only; they do not yet submit paid replacement transcription work.

## Follow-up verification — 2026-09-05

- Ran `npm ci` and `npm --prefix frontend ci` as requested. Root install reports 3 audit findings (2 moderate, 1 high); frontend install reports none. Neither lockfile changed.
- `npm --prefix frontend run typecheck` now completes successfully.
- Added the real mounted This Mac UI test for the independent subtitle setting and its separate endpoint/body. The broad frontend runner currently has unrelated failing tests and an unresolved `~` alias in `frontend/__tests__/useProject.test.ts`; it is not a clean release suite.

The underlying AH-002 recovery-plan, paid commitment, settlement eligibility, and topological downstream advancement requirements remain unimplemented. This follow-up improves verified UI coverage only and does not widen the completed implementation claim.
