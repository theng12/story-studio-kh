# Story Content Pack Local Runtime — SDD Progress

## Source

- Approved design: `docs/superpowers/specs/2026-08-13-content-pack-store-design.md`
- Runtime plan: `docs/superpowers/plans/2026-08-13-story-content-pack-runtime.md`
- Foundation final gate: GO at `c7b6d82` with 85/85 backend, 17/17 publisher/fixture, full typecheck, and production audit 0 vulnerabilities.
- Branch/worktree: `codex/content-pack-platform` at `/build/Developer/story-studio-kh/.worktrees/content-pack-platform`

## Tasks

- [x] Task 1 — runtime state, paths, pinned key policy (`feat: add content pack runtime state`; hardened state I/O, token-owned cross-process locking with guarded incarnation-aware stale recovery, semantic coherence, symlink containment, key validation, and packaged-root policy)
- [x] Task 2 — staged verified install and quarantine (`feat: install verified content packs atomically`; UUID staging under the cross-process state lock, expected-SHA and signature verification before materialisation, no-follow exclusive writes, durable retained archives re-verified for every dependency/re-import, exact orphan adoption, cache repair from signed truth, bottom-up nested-directory fsync, and runtime-root/lock symlink protection)
- [x] Task 3 — lifecycle, retention, rollback (`feat: manage content pack rollback and retention`; then hardening follow-up: a completed-but-uncheckpointed deletion now finalises idempotently, every lifecycle/install operation holds the global coordination lock before state/project work, pruning re-authorises current retention under that lock, and BigInt semver comparisons cannot round high components)
- [x] Task 4 — bundled recovery and boot verification (`feat: verify bundled content pack recovery catalog`; signed immutable recovery discovery uses the packaged public key and works from both source and packaged resource roots; boot verifies only local recovery/installed archives, clears only UUID staging directories older than 24 hours, and rolls a corrupt active version back to a retained healthy version. A corrupt archive with no fallback is preserved but made undiscoverable. Recovery rejects symlinked staging and installed ancestors, never imports network/GenStudio/secrets/renderer code, and reports IDs/counts only. A corrupt recovery sibling is ignored so healthy recovery entries remain available.)
- [x] Task 5 — verified registry and legacy adapters (`feat: consume verified content pack catalog`; deterministic pinned → active installed → signed recovery → legacy precedence; disabled/retired discovery guards with exact local-pin recovery; explicit signed Formula/Topic/Recipe/Style adapters; signed-qualified-first legacy loaders with bare IDs kept legacy-only; renderer-safe visual-style API records and a reactive catalog backed by the unchanged 17-style offline recovery set)
- [x] Task 6 — exact project pins and job provenance (`feat: pin project content pack versions`; explicit signed Formula/Topic/Style/Recipe selections pin exact local archives under the shared coordination barrier; explicit upgrade/rollback is the only version mutation; every async and foreground job snapshots immutable provenance before construction and its loaders resolve through that snapshot; missing exact content returns bounded structured recovery and blocks only direct content-document readers; boot remains read-only)
- [ ] Task 7 — explicit legacy user forks
- [ ] Task 8 — backend local management and asset routes
- [ ] Task 9 — final review, release, packaging, visual QA

## Commerce boundary

- GenStudio work order: `/build/Developer/_handoffs/2026-08-13_to-claude-genstudio_from-gpt-storystudio_content-pack-credit-store-contract.md`.
- No purchase, receipt, entitlement, account, or remote store behavior is enabled by this runtime plan.

## Task 4 verification

- RED: `content-pack-recovery.test.ts` initially failed with `ERR_MODULE_NOT_FOUND` for `content-packs/recovery.js`.
- GREEN: recovery suite passes 11/11; combined contract/archive/state/installer/lifecycle/recovery suites pass 104/104; the separately packaged free recovery fixture passes 1/1.
- Safety RED→GREEN follow-ups prove stale cleanup refuses a symlinked staging root; installed verification refuses a symlinked ancestor; a corrupt active pack with no local fallback clears only `active_version` while keeping bytes; and direct recovery listing returns healthy signed siblings when one archive is corrupt.
- `npm run typecheck:electron`, `npm run build:electron`, `git diff --check`, and the Electron Builder `extraResources` assertion pass.
- Independent review: GO after confirming the local-only import boundary, public-key-only resource, packaging inclusion, symlink protections, no-fallback behavior, and corrupt-sibling resilience.

## Task 5 verification

- RED: backend registry/adapter tests initially failed because the registry modules did not exist; frontend catalog tests failed because the reactive catalog did not exist. Follow-up REDs proved recovery provenance was misclassified when another version was installed, disabled packs could reappear through a recovery version, and downloaded-style favorite IDs were lost before asynchronous catalog hydration.
- GREEN: focused registry/adapter/migration-golden tests pass; the combined Content Pack and current catalog suite passes 156/156; the complete frontend suite passes 535/535; Electron and frontend typechecks, lint (0 errors; existing warning baseline), static frontend generation, and `git diff --check` pass.
- Visual QA: the actual dev app exposed all 17 fallback styles at the existing production-backend boundary. Desktop and 390×844 checks confirmed searchable cards, intended internal scrolling, zero page/dialog horizontal overflow, and no browser warnings/errors. Signed preview streaming remains intentionally deferred to Task 8; backend and frontend contract tests prove only opaque API asset URLs reach the renderer.
- Impeccable: one context pass and one bounded detector pass were run. Detector findings were limited to pre-existing thick-border warnings in unrelated page CSS; no speculative restyling was added.
- Independent review: no Critical findings. The only Important finding (a disabled installed pack reappearing from same-ID signed recovery) was reproduced RED and fixed without weakening exact-pin recovery. No filesystem path leakage, private-key/network/store scope creep, or qualified-ID/legacy fallback violation remained.

## Task 6 verification

- RED: project pin/provenance tests initially failed because exact pin fields and queue snapshots did not exist. Review follow-up REDs proved the global error boundary stripped structured recovery, config-backed signed Style/Recipe choices bypassed pinning, and the first consumer map blocked non-readers.
- GREEN: project pin suite passes 11/11, focused pin/error-boundary review suite passes 18/18, and the combined runtime/project/routes/loaders/job-queue/migration-golden suite passes 295/295.
- Race and recovery coverage: real pin writes serialize against uninstall/prune; signed Style/Recipe config changes hold coordination → project → config and use a transitional safe over-pin; queued jobs keep exact archive hashes through later upgrade/disable/uninstall and direct loaders observe the job snapshot.
- `npm run typecheck`, `npm run build:electron`, `npm run lint -- --quiet`, and `git diff --check` pass. The full Content Pack/project/route/queue regression set passes.
- Independent review: no remaining Critical or Important findings after two correction rounds. Structured recovery, signed config-backed selections, exact style resolution, and reader-only selective blocking were re-verified.
