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
  - Security-review follow-up: removed JSZip extraction entirely. The verifier now parses and cross-checks central and local ZIP records, rejects comments/extras/ZIP64/data descriptors/encryption/special entries, validates actual CRC and uncompressed size, and uses Node bounded raw deflate extraction before verifying any declared payload.
  - Security-review adversarial RED→GREEN: false-small-header deflate bomb, local-name swap, local encryption, DOS-host symlink mode, ZIP64 extra, missing/orphan preview assets, oversized dimensions, and multipage raster cases were added and now pass. Mutation proofs re-ran: disabling bounded inflate plus its post-limit check, local-path matching, or multipage rejection each made its corresponding regression fail; all three protections were restored.
  - Security-review verification: Task 1 + Task 2 focused tests pass 39/39; `npm run typecheck:electron` and `git diff --check` pass.
  - Follow-up commit: `54dd0df fix: harden content pack archive verification`.
  - Final ZIP review follow-up: v1 now requires the central directory to end exactly at EOCD, rejecting any unclaimed gap/digital-signature record. RED observed with injected `HIDDEN` bytes; Task 1 + Task 2 focused tests now pass 40/40 with Electron typecheck and diff check green. Commit: `fix: reject content pack ZIP gaps`.
- [x] Task 3 — first-party publisher CLI
  - RED: `node --test scripts/content-packs/__tests__/publisher-tools.test.mjs` failed 7/7 before the commands existed (`MODULE_NOT_FOUND` for `build-pack.mjs`).
  - GREEN: publisher CLI suite passes 7/7. It generates ephemeral test keys and temporary source trees only; no private key fixture was added.
  - Implementation: `build-pack` accepts an explicit `--private-key` path or the deliberate `STORY_CONTENT_PACK_PRIVATE_KEY_PATH` path, derives items/file bindings from a source directory restricted to `pack.json`, `content/`, and `assets/`, canonicalizes the validated shared manifest, signs it, builds deterministic ZIP bytes, then calls the shared archive verifier before writing output. `validate-pack` requires the explicit key ID, publisher ID, and public-key path and emits only pack ID, version, and archive SHA-256.
  - Verification: Task 1 + Task 2 suites pass 40/40; publisher suite passes 7/7; `npm run typecheck` and `git diff --check` pass.
  - Review: no private key is loaded into output/reporting, no schema/signature/archive policy is duplicated, all validation reaches the shared TypeScript contract, and no runtime/catalog/generation/version/changelog file changed.
  - No-go review follow-up: output paths are rejected before private-key or source-content reads when they equal the key or resolve inside/equal to the source tree, including a physical symlink alias. The validator likewise rejects an archive path resolving to its public-key file.
  - Source snapshot hardening: source enumeration records stable directory/file identities; every source file is reopened with `O_NOFOLLOW`, identity-checked before and after its bounded read, and the complete source tree is rechecked before signing. A swap cannot produce or replace the requested output. Regressions deterministically replace a content file and an ancestor directory with symlinks to external private paths; both are refused with the output sentinel preserved.
  - Documentation follow-up: the publisher guide now defines `(pack_id, exact version, archive SHA-256)` as immutable published identity and corrects namespace wording to IDs rather than paths.
  - Review RED: expanded publisher suite failed 4/11 before the follow-up (key/source and public-key collisions plus file/ancestor symlink swaps).
  - Review GREEN: contract/archive suites pass 40/40, publisher suite passes 11/11, `npm run typecheck`, and `git diff --check` pass.
- [ ] Task 4 — current-catalog migration golden
- [ ] Task 5 — independent review and runtime-plan handoff

## External dependency

- GenStudio handoff filed at `/build/Developer/_handoffs/2026-08-13_to-claude-genstudio_from-gpt-storystudio_content-pack-credit-store-contract.md`.
- Story implementation must keep all paid/store UI dormant until GenStudio publishes and Story verifies the real entitlement contract.
