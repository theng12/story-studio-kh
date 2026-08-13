# Story Content Pack Contracts — SDD Progress

## Source

- Approved design: `docs/superpowers/specs/2026-08-13-content-pack-store-design.md`
- Execution plan: `docs/superpowers/plans/2026-08-13-story-content-pack-contracts.md`
- Branch: `codex/content-pack-platform`
- Worktree: `/build/Developer/story-studio-kh/.worktrees/content-pack-platform`

## Baseline

- Existing catalog-focused backend tests: 36/36 pass.
- Electron typecheck: pass.
- Frontend typecheck: pass after installing worktree-local frontend dependencies.
- Root dependency install reports two high-severity development-tree audit findings; production audit is deferred to the release gate and must be reported independently.

## Tasks

- [x] Task 1 — strict v1 pack/content contracts
  - RED: `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-contract.test.ts` failed as expected with `ERR_MODULE_NOT_FOUND` for `content-packs/schemas.js`.
  - GREEN: same focused suite passed 9/9; `npm run typecheck:electron` passed; `git diff --check` passed.
  - Commit: `feat: define signed content pack contract`.
- [ ] Task 2 — archive integrity and Ed25519 verification
- [ ] Task 3 — first-party publisher CLI
- [ ] Task 4 — current-catalog migration golden
- [ ] Task 5 — independent review and runtime-plan handoff

## External dependency

- GenStudio handoff filed at `/build/Developer/_handoffs/2026-08-13_to-claude-genstudio_from-gpt-storystudio_content-pack-credit-store-contract.md`.
- Story implementation must keep all paid/store UI dormant until GenStudio publishes and Story verifies the real entitlement contract.
