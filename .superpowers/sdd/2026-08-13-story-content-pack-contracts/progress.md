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
  - Review follow-up: expanded Formula, Topic, and Thumbnail contracts to preserve the approved declarative HMH taxonomy; added optional manifest changelog; strengthened URI/routing-text rejection; made Channel Kits exact versioned component references; and made signed manifest identities deterministic.
  - Review RED: expanded focused suite failed 10/14 tests before the follow-up schema implementation (missing rich Formula fields/changelog/Channel Kit semantics plus URI/routing and identity invariants).
  - Review GREEN: focused suite passed 15/15; `npm run typecheck:electron` and `git diff --check` passed.
  - Follow-up commit: `fix: harden content pack contract`.
  - Second review follow-up: added bounded Deep Time visual-pacing/motion and allowlisted creative-profile fields; Formula examples, evidence expectations, metadata descriptions, and recency avoidance; Topic diversity/evidence/compatibility fields; strict reference-token rejection; and dependency coherence for independently versioned Channel Kit components.
  - Second review RED: expanded focused suite failed 6/20 tests before the schema follow-up (missing Formula/Topic fields, unsafe-text probes, and external dependency/version coherence).
  - Second review GREEN: focused suite passed 20/20; `npm run typecheck:electron` and `git diff --check` passed.
  - Second follow-up commit: `fix: complete content pack contract invariants`.
  - Final review follow-up: narrowed routing checks to identifier syntax and imperative routing phrases; recency uses the app-owned `scripture-references` strategy ID rather than downloadable regex/template behavior; motion uses allowlisted `ambient-documentary`; Formula-owned style text is rejected so independently versioned Visual Styles remain authoritative.
  - Final review RED: expanded focused suite failed 3/22 tests before the contract follow-up (allowlisted motion/recency and non-routing provider prose).
  - Final review GREEN: focused suite passed 22/22; `npm run typecheck:electron` and `git diff --check` passed.
  - Final follow-up commit: `fix: restrict content pack behavior to app contracts`.
  - Registry grounding: added app-owned `RECENCY_STRATEGIES` and `MOTION_PROFILES` registries with fail-closed resolvers. The Content Pack schemas derive their IDs from those registries. Existing recency and Formula motion consumers now resolve optional IDs while retaining raw built-in fields as the compatibility fallback during catalog migration.
  - Registry RED: new registry suite failed before implementation because the resolver modules did not exist.
  - Registry GREEN: 53/53 relevant tests passed (registry, Content Pack contract, scene motion, and format loader); `npm run typecheck:electron` and `git diff --check` passed.
  - Registry follow-up commit: `feat: ground content pack behavior registries`.
- [x] Task 2 — archive integrity and Ed25519 verification
  - RED: `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-archive.test.ts` failed as expected with `ERR_MODULE_NOT_FOUND` for `content-packs/archive.js`.
  - GREEN: the archive suite passes 10/10, including exact raw-manifest Ed25519 signatures, hashes and byte counts, absent/undeclared entries, raw path/case/Unicode collision checks, symlink attributes, archive limits, and bad key/publisher/signature cases.
  - Mutation proof: temporarily bypassing signature verification made the raw-manifest tamper test fail; temporarily bypassing canonical collision detection made the collision test fail. Both safeguards were restored immediately.
  - Verification: Task 1 + Task 2 focused tests pass 32/32; `npm run typecheck:electron` and `git diff --check` pass.
  - Commit: `feat: verify immutable content pack archives`.
- [ ] Task 3 — first-party publisher CLI
- [ ] Task 4 — current-catalog migration golden
- [ ] Task 5 — independent review and runtime-plan handoff

## External dependency

- GenStudio handoff filed at `/build/Developer/_handoffs/2026-08-13_to-claude-genstudio_from-gpt-storystudio_content-pack-credit-store-contract.md`.
- Story implementation must keep all paid/store UI dormant until GenStudio publishes and Story verifies the real entitlement contract.
