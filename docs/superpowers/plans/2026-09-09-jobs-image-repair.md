# Jobs image repair — approved implementation plan

Base: fcc24d30 (includes Claude's prepared-request handoff). Worktree: jobs-image-repair; branch codex/jobs-image-repair.

Owner request: Finish missing images must execute from Jobs, keep the original row, transition error/cancelled to queued/running, and preserve valid images. No Scene Review detour.

1. Direct continuity-only job action using saved job settings. Persist same job id before requeue; retain accepted request/billing evidence, provenance and history. Idempotent repeated clicks; enforce project/type/active-owner scope.
2. Jobs button uses action, busy/error feedback, switches failed filter to active view; Retry all includes applicable scene jobs. Scene Review remains an optional inspection link.
3. Fix exact prepared/no-task-id/by-key404 case in Claude handoff: reuse prior request identity/scope/hash for missing-image repair. Accepted IDs, network errors and provider500 remain recovery/uncertain, never an inferred fresh charge. Explicit new generation retains its deliberate fresh identity.
4. Regression checks: same-id transition/persistence; duplicate clicks/restart; complete outputs skipped; queued owner/cancel handling; prepared404 oldkeyonce and500noPOST; frontend row/filter/action behavior. Synthetic desktop/narrow visual QA without production requests.
5. Independent review, official full local verification, next-version changelog, Actions-disabled push/PR/merge, canonical-main smoke DMG and completion receipt.

Dispatch: plan_contract backend route/queue; plan_editor_ui frontend; plan_review prepared replay renderer/manifest; root coordinates all tests/review/release. All start fcc24d30. No paid or production mutation tests. Baseline finish-missing: exit0 3/3, configured root unchanged.

## Implementation checkpoint

The direct action, same-row persistence, admission reservation, prepared-request replay, and immediate queue-store updates are implemented. Focused backend checks passed 7/7 same-row/cancellation tests and 36/36 renderer tests. Frontend targeted checks cover direct action, duplicate clicks, error handling, and readonly project/universal queue stores. Full verification and release receipt follow before completion.

Impeccable's static detector reported incumbent status-border styling; this repair retains the app's existing visual language. Synthetic browser QA exposed and corrected a readonly queue-store update that unit fixtures initially missed. No live generation or customer data changes were used.

## Release verification

- `npm run verify`: exit 0. Backend 4,993/4,993 tests across 440/440 files; frontend 1,565/1,565; release 36/36; Content Packs 366 passed and two optional external-evidence checks skipped. Total 6,960 passed, zero failures. Production frontend/Electron builds and built security/release checks passed.
- Lint reports zero errors with 1,819 existing warnings. The first full attempt caught an incorrectly typed abandonment marker in the new test fixture; it was corrected before the successful run.
- The final route returns only the public job representation. Repeated lint and type checking after that final adjustment both passed, exit 0.
- Independent backend/UI review completed; prepared-renderer changes reviewed separately. Browser checks used synthetic data only: direct Jobs click and keyboard action keep the same route and job identities, switch from failed to queued, and update readonly project/all-project stores. Desktop and narrow layout geometry were checked; no CSS redesign was needed.
- GitHub Actions were verified disabled. Repository integration follows the standing authorization. The canonical-main artifact and integration receipt are recorded at `<owner-home>/pinokio/_handoffs/2026-09-09-story-jobs-image-repair-complete.md` after packaging.
