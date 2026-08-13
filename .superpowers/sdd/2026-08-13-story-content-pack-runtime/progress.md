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
- [x] Task 7 — explicit legacy user forks (`feat: preserve legacy content as explicit user forks`; same-ID Formula/Topic/Thumbnail files remain readable and byte-unchanged until an explicit edit creates a UUID `user:` record in the guarded runtime store. Project-scoped forks serialize through coordination plus project/config locks, update only the requesting project, and leave signed/legacy originals immutable. Independent projects fork independently; explicit signed restore uses the existing exact-selection transaction. Enumeration exposes only bounded genuine same-kind shadows and no paths. Reads/writes reject symlinked runtime roots/stores and filename/record identity drift; refused project edits leave no orphan. Legacy visual-style overrides remain unsupported rather than invented.)
- [x] Task 8 — backend local management and asset routes (`feat: expose local content pack lifecycle`; authenticated backend routes list bounded installed/recovery metadata, import raw signed archives under the 50 MiB limit, manage disable/enable/rollback/uninstall through existing coordinated lifecycle guards, report exact project requirements, and stream only manifest-declared compatible raster assets by SHA-256. Asset serving re-verifies the exact local pack/dependency closure, rejects symlinks and identity drift before/after opening with `O_NOFOLLOW`, hashes the opened descriptor bytes, and sends declared MIME with `nosniff` and immutable caching. Existing Formula/Topic/Style/Recipe adapters now receive the mounted runtime options. No store, account, key, receipt, purchase, or remote behavior was added.)
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

## Task 7 verification

- RED: `content-pack-user-forks.test.ts` first failed because the fork module did not exist. Route REDs then proved the old same-ID save path overwrote legacy files instead of creating explicit identities. Review follow-up REDs proved list/save accepted filename↔record identity drift, read/list could follow a symlinked runtime root, and cross-kind signed IDs were reported as conflicts.
- GREEN: focused user-fork suite passes 7/7; complete Content Pack/current catalog suite passes 174/174. Legacy Formula/Topic/Thumbnail shadows remain unchanged before edit; explicit route/service edits create project-scoped forks; originals remain byte-identical; two projects are independent; signed restore changes only the requesting project; conflict responses contain IDs/slugs only.
- `npm run typecheck`, `npm run lint -- --quiet`, and `git diff --check` pass.
- Independent review: GO after all three Important findings received strict RED→GREEN regressions; no remaining Critical or Important findings.

## Task 8 verification

- RED: `content-pack-routes.test.ts` first failed with `ERR_MODULE_NOT_FOUND` because the management router did not exist. A recovery-compatibility follow-up then failed because a future-app recovery archive appeared in management discovery.
- GREEN: focused route suite passes 9/9; combined Content Pack and existing Formula/Topic/Thumbnail/Format catalog suite passes 183/183. Raw JSON archives are refused, over-50-MiB bodies return 413 without installer state, malformed/unsigned archives fail closed, and route source has no GenStudio, secret/key-store, purchase, receipt, entitlement, account, or commerce dependency.
- Asset coverage proves declared SHA/MIME lookup, `nosniff`, one-year immutable caching, disabled-but-exact asset availability, recovery assets, future-app recovery refusal, undeclared/path-shaped IDs, absent versions, and symlink replacement. Lifecycle coverage proves route-level ID validation and exact rollback/active/pin removal guards; requirements responses contain bounded IDs/kinds/hashes only.
- `npm run typecheck:electron`, `npm run lint -- --quiet`, and `git diff --check` pass.
- Local route smoke uses an isolated mounted Express runtime: signed raw import, catalog read, preview request, disable/discovery audit, exact asset recovery, re-enable, rollback, requirements, active-removal refusal, and inactive uninstall all passed without touching production data. `npm run build:electron` also passes.
- Independent requirements/security review: GO with no Critical or Important findings after confirming every Task 8 boundary and the mounted adapter-option flow.

## Task 9 review corrections

- Important RED→GREEN: a version with durable `pending_removal` could fall through the asset route to a same-version bundled recovery archive. The new route regression first returned 200, then passed after pending removal became an explicit unavailable state. The complete route suite passes 10/10.
- Important RED→GREEN: a valid signed recovery archive requiring a future Story Studio version remained available through registry discovery and exact-pin resolution. The new registry regression first exposed the future style, then passed after compatibility moved to the shared recovery scan boundary. Recovery and registry suites pass 18/18.
- Important RED→GREEN: malformed-state quarantine followed a symlinked `quarantine` child and could write outside the runtime root. The new state regression first observed no rejection, then passed after quarantine creation became a direct-child, non-symlink directory check. The complete state suite passes 20/20.
- Important RED→GREEN: a valid state and signed install could be read through a symlinked runtime root because read-only state access skipped the write-path root guard. The new state regression first accepted the external state, then passed after read-only root validation failed closed without creating directories.
- Important RED→GREEN: adapter routes could surface absolute trust/install paths from Content Pack verification failures. The new visual-style route regression first returned the local install path, then passed after Content Pack trust/runtime details were kept in support logs while renderer-facing responses used bounded route context. Structured `content-pack-missing` recovery data remains intact.
