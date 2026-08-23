# Symbolic Psychology Studio unblock — progress

## Task 1 evidence reconciliation

Task 1 is complete. The reviewed external evidence is internally consistent: the
overall disposition is `partial-review-complete-blocked`, Oil is individually
`ready-for-owner-stocking`, Recipe/Pastel/Kit remain blocked, all nine review
categories are complete, and the receiver has no pending reviews. This record is
documentation only; it does not authorize stocking or any external mutation.

### Plan and commit baseline

- Unblock-plan baseline: `7cf294adc6d6d7cbf4bcb30e9d40003a5da388af`
  (`docs: plan symbolic psychology studio unblock`).
- Prior plan commit at documentation-task start:
  `852f6411ba673488eb48d9e600f6aa8487d45649` (`docs: correct symbolic successor
  unblock plan`).
- Current plan commit: `f04d3726edc9002f9cf99774f8e0d9275595a7e0`
  (`docs: preserve legacy selection and summary evidence`). This coordinator
  commit is outside the Task 1 evidence-record commit.
- Task 1 audit commit consumed: `43aa024e3705354e54f1c2df9d5df43743eec38d`
  (`test(content-packs): audit completed review truth`).
- Documentation-task start HEAD: `852f6411ba673488eb48d9e600f6aa8487d45649`.

### External evidence after values

Observed at `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/`; external JSON was not modified in this task.

| File | SHA-256 after | Bytes |
| --- | --- | ---: |
| `candidate-handoffs.json` | `127d80aa7e33abf255cc7d12d12ef0da9587beb6ce7be94448779e09643251d5` | 26,035 |
| `review-requests.json` | `e7b2225228bfb7a3dd6bf315f586c62751e0abadbf9635b9bf42b2b678d69761` | 11,520 |
| `receiver-handoff.json` | `6bb9a9eeafef64406747c7390bd27987c5c183b3870404b4dc88f1cb1e9e360a` | 9,246 |
| `evidence-ledger.json` (preserved historical ledger) | `6fe1650aeca9d2cc76307ecbc3e7dc0893e1c886b20c702c10118cb6ed766a5e` | 22,039 |

The historical ledger remains byte-identical and its existing `component_summary`
entries remain grandfathered evidence. No source pack, registry, archive,
quarantine item, publisher code, or external JSON was changed.

### Preserved authority, quarantine, and Oil evidence

- Authority remains fail-closed: the structured Recipe request has
  `quote_approved: false`, `job_submission_authorized: false`, and
  `generation_authorized: false`; both replacement requests are capability-and-
  quote-only. The receiver explicitly records upload, drafts, pricing,
  purchase/grant, signing, publication, and GenStudio mutation as not done.
- Active archives contain only Oil:
  `archives/com.storystudio.pack.style.oil-painting-classical@1.0.0.sspack`,
  SHA-256 `95f6271a0f56afd850c1548bfff703177ba9b5977584093fea833f1bbf02e3fc`,
  403,483 bytes.
- Blocked diagnostic evidence remains quarantined: Pastel
  `d70083a8bddc67e032d465c63f91845d6178ae60c785d6aba9ce4e7db357a054`, blocked
  Recipe `559e82c35197f4f56dc929c8bfa49faaf64a74cf4c21407eb219cc706334e7e6`,
  superseded Recipe `64e0ec9afcd86b18e9655999de84e5bc4b7f3410997d3731334cbe0a208a8ebb`,
  and rejected preview #4 `fb5be086761b7effc5ae325ac8d2458f7da071c710c3e4dcfb5155fb523b1166`.
  Kit and Gothic have no retained archive.

### Verification

- `env -u STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
  — 2 passed, 0 failed, 2 intentional skips.
- `STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT=/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23 node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
  — 4 passed, 0 failed, 0 skipped.
- Independent read-only comparison and stale-string scan are recorded in
  `evidence-reconciliation-review.md`.

## Task 2 multi-Style bundle publisher/application support

Task 2 implementation started from
`87915223df6d9b05c75fd0f8058b16e62d1920db` on the required
`codex/content-expansion-portfolio` branch. The worktree was clean at dispatch.

### Implemented contract

- Bundle-only manifests now accept one-or-more ordered `visual-style`
  components while retaining the exact Formula, Topic, Recipe, uniqueness,
  external-reference, dependency, namespace, file, archive, and trust guards.
  Their dependency list must have identical cardinality and equal the bundle's
  component owner pack/version sequence in that bundle's declared order,
  preserving one component per dependency. The approved Symbolic Psychology
  Kit order is Formula, Topic, Recipe, Pastel, Impasto, then Oil.
- `resolveProjectPreferredSelection` resolves an existing owner/version pin
  first, verifies the exact retained archive hash, and fails closed without
  active discovery. With no owner pin it performs signed discovery and returns
  an exact ref for the existing pin write; only a confirmed catalog miss
  returns `null` for the unchanged legacy/local no-pin write.
- `applyProjectContentBundle` verifies the exact installed root and closure
  under the Content Pack coordination lock, pins every component, activates
  the first ordered Style, retains later Styles as alternatives, and uses the
  existing coordinated project/config write path. Closure and pin conflicts
  reject before either project file is written. Once writing starts, the path
  first persists the fully pinned transitional project, then config, then the
  final project; this is crash-consistent rather than strict crash-level
  all-or-nothing. Runtime write failures attempt best-effort rollback, and the
  injected phase regressions prove restoration when those rollback writes
  succeed. It performs no install, purchase, quote, or network action.
- `POST /content-packs/projects/:slug/bundles/apply` strictly accepts only
  `root` and `bundle_id`, validates slug and exact identities, and runs behind
  the production global 10 MiB JSON parser bound. It returns only known exposed
  400/404/409 failures locally; unknown operational failures reach the terminal
  error boundary for logging and a generic 500 response.

### TDD and regression proof

- RED: the new three-Style contract and publisher fixtures failed on the old
  exactly-one-Style refinement; the publisher build also refused the same
  source for that reason.
- RED: reversed dependency order and unequal dependency/component cardinality
  were accepted before exact ordered-closure validation was added.
- RED: the project-pin suite initially failed because
  `applyProjectContentBundle` did not exist, and the strict route suite returned
  404 because the explicit action had not been registered.
- RED: the transaction phase regression initially could not inject failures at
  the three project/config write boundaries.
- GREEN: focused suites cover deterministic three-Style publisher output;
  ordered default/alternatives; exact style refs; Formula/Topic/Recipe and all
  Style pins; missing, disabled, recalled, corrupt, wrong-kind, duplicate and
  conflicting closures; exact pre-write conflict rejection; crash-consistent
  transitional pinning and successful best-effort rollback at all three write
  boundaries; newer-active isolation; missing,
  recalled, owner-mismatched and hash-mismatched fail-closed selection;
  unpinned Formula/Topic/Style/Recipe discovery and kind validation; and config,
  niche, and topic legacy/local writes after one observed catalog miss each.
- Route regressions prove the pack-state inventory is unchanged by bundle apply,
  so the project action cannot install or activate archive versions as a side
  effect; known conflicts remain explicit while unknown operational failures do
  not leak details.

The plan's word “atomic” is satisfied for validation/conflict rejection and
coordinated successful application. If read as strict crash-level all-or-nothing
across two JSON files, it is stronger than the existing architecture can
guarantee; Task 2 does not claim or prove that stronger property.

### Scope preserved

`runtime-types.ts`, installer/checkout/commerce sources, package versions,
`CHANGELOG.md`, Content Pack source trees, authoring registry, external
evidence, and handoffs are unchanged. No identity reservation, upload,
publication, deploy, tag, push, purchase, or other external mutation occurred.

### Verification

- `npx tsx --test electron/server/__tests__/content-pack-contract.test.ts electron/server/__tests__/content-pack-project-pins.test.ts electron/server/__tests__/content-pack-routes.test.ts`
  — 62 passed, 0 failed.
- `node --test scripts/content-packs/__tests__/publisher-tools.test.mjs`
  — 24 passed, 0 failed.
- `npm run typecheck:electron` — Electron TypeScript check passes.
- `npm run check:security` — production security check passes.
- `git diff --check` — clean.

## Task 3 archive/install/recovery/checkout/release compatibility

Task 3 started from `e4b2db8ad673e40206b6a13c2ff9fd1990ffcdff` on
`codex/content-expansion-portfolio`, with a clean worktree and application
version `1.4.31` on all three package/lock surfaces.

### Compatibility evidence

- Archive verification accepts the exact six-member bundle-only root in the
  approved Formula `1.0.1` → Topic `1.0.0` → Recipe `1.0.1` → Pastel `1.0.1`
  → Impasto `1.0.0` → Oil `1.0.0` order and still rejects coordinator content
  or asset entries plus the existing unsafe archive variants.
- Receipt-attested delivery binds those six positions to the signed root,
  stages dependencies inactive, and activates the root plus whole closure only
  after every exact member verifies. Missing, recalled, or receipt-hash-
  mismatched third-Style evidence leaves the root inactive and preserves
  existing project pins. Existing interrupted-final-activation recovery still
  reactivates the complete closure in one state checkpoint.
- Boot recovery keeps the multi-Style root active while all six exact versions
  are retained and disables root discovery when the third Style is absent.
- Checkout carries the same six ordered positions, versions, entitlement
  families, and configured quote price without a purchase POST, debit, grant,
  receipt creation, or commerce implementation change.
- The Kit floor is exactly `1.4.32`. An explicit `1.4.31` install attempt names
  required `1.4.32` and current `1.4.31`, changes neither runtime state nor
  project metadata, and Store delivery returns
  `CONTENT_PACK_REQUIRES_NEWER_APP` before archive download.

### TDD and release evidence

- Baseline focused matrix: 67 passed, 0 failed before Task 3 edits.
- RED before release bookkeeping: the new release-floor assertion observed
  package `1.4.31` instead of required `1.4.32`; successful delivery of a root
  truthfully declaring minimum `1.4.32` was refused before download. Fixture
  profile/syntax errors found in the first run were corrected before accepting
  that RED evidence.
- `npm version 1.4.32 --no-git-tag-version` ran exactly once after confirming
  `package.json`, lockfile top level, and lockfile root package all equalled
  `1.4.31`; all three now equal `1.4.32`.
- `CHANGELOG.md` has the newest-first `v1.4.32` entry. Its apply wording is
  coordinated and interruption-safe: it does not claim impossible strict
  cross-file crash-level all-or-nothing semantics.
- Focused compatibility matrix: 73 passed, 0 failed.
- `npm run check:changelog` — package, lockfile, and newest What's New entry
  agree on `v1.4.32`.
- `npm run typecheck:electron` — passed.
- `npm run check:security` — passed.
- `npm run check:model-drift` — passed; 602 source files checked, 32 annotated
  exceptions.
- `git diff --check` — clean.

### Scope and blocker

Only compatibility fixtures changed in `content-store-paid-bundle.test.ts`;
checkout, quote, purchase, receipt, pricing, ownership, and delivery production
sources are unchanged. No identity was reserved, no Content Pack successor was
authored, and no external evidence or handoff was touched. No DMG, deploy, tag,
push, publish, upload, purchase, grant, or other external mutation occurred.

`app-release-not-deployed` remains an explicit Kit stocking blocker. The local
`1.4.32` version/changelog update is release preparation only and is not
deployment evidence.

## Next task

Task 4 remains the separately authorized leaf-successor reservation task. Task
3 did not reserve or mutate any registry identity.
