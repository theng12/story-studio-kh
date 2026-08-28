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

Observed at `<owner-home>/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/`; external JSON was not modified in this task.

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
- `STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT=<owner-home>/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23 node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
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
- Boot recovery materializes kind-correct Formula, Topic, Recipe, Pastel,
  Impasto, and Oil documents, keeps the multi-Style root active while all six
  exact versions are retained, and disables root discovery when the third
  Style is absent.
- Story Studio's persisted/public quote projection carries the same six ordered
  positions, normalized kinds, versions, entitlement families, and configured
  quote price at the truthful Kit floor `1.4.32`, without a purchase POST,
  debit, grant, receipt creation, or commerce semantics change.
- The Kit floor is exactly `1.4.32`. An explicit `1.4.31` install attempt names
  required `1.4.32` and current `1.4.31`, changes neither runtime state nor
  project metadata, and the customer-facing Store route returns
  `CONTENT_PACK_REQUIRES_NEWER_APP` with both exact versions before archive
  download.

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

### Task 3 review corrections

- The Store delivery path now resolves one current app version per coordinated
  delivery, uses it consistently for preflight/install/closure verification,
  and retains required/current exact versions in the safe local refusal. A
  route factory exposes only that app-version test seam; production still
  resolves its packaged/source application version normally.
- RED after review: the exact Store route assertion received required-only
  detail before the compatibility message was corrected. GREEN proves required
  `1.4.32`, current `1.4.31`, zero archive GETs, and unchanged Content Pack
  runtime/project state.
- The historical floor check no longer requires the live package to remain
  exactly `1.4.32`; it uses the production exact-semver compatibility helper to
  require current runtime `>= 1.4.32`, while the explicit `1.4.31` refusal and
  manifest floor remain fixed regression facts.
- Checkout now uses `createContentStoreQuote` plus the commerce journal and
  public dependency normalization rather than treating the raw GenStudio
  client response as end-to-end Story Studio evidence. Recovery archives now
  carry documents whose declared kinds match all six root components.

### Scope and blocker

Only compatibility fixtures changed in `content-store-paid-bundle.test.ts`;
checkout, quote, purchase, receipt, pricing, ownership, and commerce production
semantics are unchanged. The review correction changes only Store delivery
compatibility plumbing and the route's app-version test seam so the safe
required/current detail is durable. No identity was reserved, no Content Pack
successor was authored, and no external evidence or handoff was touched. No
DMG, deploy, tag, push, publish, upload, purchase, grant, or other external
mutation occurred.

`app-release-not-deployed` remains an explicit Kit stocking blocker. The local
`1.4.32` version/changelog update is release preparation only and is not
deployment evidence.

## Task 4 atomic leaf-successor reservation

Task 4 started from `2a532353fd0f26081ce9f7f160e328cdcb39d883` on the
required `codex/content-expansion-portfolio` branch with a clean worktree.
Registry validation reported revision `16` with `74` records before mutation.

### Immutable predecessor evidence

- Recipe `1.0.0` now has exact SHA-256 assertions for its `pack.json`, content
  document, four preview assets, and four complete provenance rows.
- Pastel `1.0.0` now has exact SHA-256 assertions for its `pack.json`, content
  document, preview asset, and complete provenance row.
- The immutable test passed before reservation. The reservation/scaffold test
  then failed RED only because its request file did not yet exist, and passed
  after the exact receipt-bound evidence was present.

### Serialized reservation evidence

- One and only one reserve call used coordinator task
  `symbolic-psychology-studio-unblock-leaf-successors`, branch
  `codex/content-expansion-portfolio`, and expected revision `16`.
- The call returned revision `17` and receipt
  `authoring:f12a9e8de181d536fe2e8367df5028460ce9e84948f43cc6978bfe5b5340bdfd`.
  The registry now has `77` records.
- Formula, Recipe, and Pastel `1.0.1` are each bound to that exact receipt and
  remain `reserved`. Each exact expected identity, copied without
  `receipt_ref`, passed an independent `verify-receipt` call at revision `17`.
- Every leaf uses `{{MIN_APP_VERSION}}` with status `release-bound`; the
  schema-compatible leaf build floor remains the truthful `1.0.843`. No Kit
  minimum was reused or invented.

### Preserved gates and scope

- Recipe and Pastel have receipt-derived, non-discoverable SDD checklists for
  immutable predecessor hashes, required returned evidence, and exact visual
  acceptance. Both explicitly set `registry_transition_allowed: false`.
- Formula, Recipe, and Pastel `1.0.1` Content Pack source directories are
  absent. No successor manifest, content document, asset, future asset hash,
  returned prompt/quote value, creative byte, lifecycle transition, archive,
  or promotion was created.
- The Symbolic Psychology Studio Kit `1.0.1` source and registry record are
  absent. No Kit reservation, external generation, Studio Hub handoff,
  commerce mutation, deploy, tag, or push occurred.
- Fresh Task 4 JSON contains no `component_summary`.

### Verification

- `npm run content-pack:registry -- validate` — revision `17`, `77` records.
- `node --test scripts/content-packs/__tests__/authoring-registry.test.mjs` —
  32 passed, 0 failed.
- `npx tsx --test electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
  — 6 passed, 0 failed.
- `npm test` — 3,241 passed and 2 failed only because this linked worktree had
  not installed `frontend/node_modules` and therefore could not resolve `vue`.
  After `npm --prefix frontend install` reported 0 vulnerabilities, the exact
  failed `content-pack-migration-golden.test.ts` suite passed 7/7. No product or
  lockfile bytes changed during dependency setup.
- Three exact `verify-receipt` CLI calls — Formula, Recipe, and Pastel passed
  at revision `17` against the shared receipt.
- `git diff --check` — clean.

## Task 5 immutable Human Behavior Formula successor

Task 5 started from `e5c924e69ead970f7db526333042864c9333df0d` on the
required `codex/content-expansion-portfolio` branch with a clean worktree.
Registry validation reported revision `17` with `77` records before mutation,
and the Formula expected identity independently verified against the shared
leaf receipt before source authoring.

### Receipt-exact source and TDD proof

- RED: the source suite failed only because
  `human-behavior-explained-v1.0.1/pack.json` was absent; the registry suite
  failed only because the Formula promotion request was absent.
- The immutable Formula `1.0.0` hashes are pinned as
  `9a4dde3a8e889b537b19b45f006b9b981ed9e0982dc5852af705924ae7caa7be`
  for `pack.json` and
  `bc008e06a736dda9e266c39ad4efd9af5df59103d7ac01ce0fb00d09a4961712`
  for `content/series-formula.json`.
- Formula `1.0.1` was copied from that exact predecessor. Its manifest changes
  are only version `1.0.0` → `1.0.1` and changelog
  `Replaces diagnostic tone vocabulary with explicitly non-diagnostic,
  evidence-aware language.` Its document changes only mood entry
  `diagnostic-but-warm` → `non-diagnostic-and-warm`.
- Sorting and normalizing the successor manifest back to version `1.0.0` while
  removing its changelog produces an empty diff against the predecessor.
  Normalizing the successor mood token back produces an empty whole-document
  diff. The direct sorted JSON diff reports exactly the two manifest edits and
  one document edit above.
- The authored successor hashes are
  `31528ed261a5ee51d3f75bf9cf9588d6642289db87cb29fec918bd294d7de90c`
  for `pack.json` and
  `fa40dae5aa700871c5b975da572ed060f918f0edd3f8d41b43199d6369e0882c`
  for `content/series-formula.json`.
- Explicit assertions retain the item, family, SKU, empty dependency closure,
  mood cardinality, every other JSON value, and all existing non-diagnosis,
  non-sensational, evidence-aware safeguards.

### Serialized lifecycle evidence

- One and only one transition request used expected revision `17`, coordinator
  task `symbolic-psychology-studio-unblock-leaf-successors`, branch
  `codex/content-expansion-portfolio`, and receipt
  `authoring:f12a9e8de181d536fe2e8367df5028460ce9e84948f43cc6978bfe5b5340bdfd`.
  Its only change is `{ "status": "authored" }` for the exact Formula
  `1.0.1` pack/version.
- The transition returned revision `18` and transition reference
  `lifecycle:b434f131242b4e28d7860dcb82acd91f51144646620b9318071f145e7efa773c`.
  The registry remains at `77` records, now with `11` lifecycle transitions.
- Formula `1.0.0` remains authored on its baseline receipt and Formula `1.0.1`
  is authored on the shared leaf receipt. Recipe and Pastel `1.0.1` remain
  reserved on that receipt; Kit `1.0.1` remains absent.
- Formula, Recipe, and Pastel each independently passed `verify-receipt` at the
  original batch revision `17` after the Formula transition.

### Verification and preserved scope

- `npx tsx --test electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
  — 7 passed, 0 failed.
- `node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
  — 3 passed, 0 failed, 2 intentional external-evidence skips.
- `node --test scripts/content-packs/__tests__/authoring-registry.test.mjs` —
  32 passed, 0 failed after its authored-source inventory advanced from 65 to
  66 (49 item packs and 17 bundle packs).
- `npm run content-pack:registry -- validate` — revision `18`, `77` records.
- Three exact `verify-receipt` CLI calls — Formula, Recipe, and Pastel passed
  at revision `17` against the shared leaf receipt.
- Recipe/Pastel successor sources and previews remain absent and untouched.
  No archive was built; no generation, handoff, commerce, upload, publication,
  deploy, tag, or push occurred. The independent Task 5 review remains the
  coordinator's post-commit acceptance gate.

## Task 6 returned previews, leaf successors, and the four-piece Kit

Task 6 started from `84754d10` on branch
`content/symbolic-psychology-wave1-2026-08-28` in its own worktree. The
authoring registry was read-only for this task throughout; a separate
coordinated landing agent holds the writer slot.

### Owner authority and the corrected freeze

The owner read both literal prompt batches on 2026-08-28 and replied
`approve of the 2 prompts.` That approval carries quote approval, job-submission
authority, and generation authority for exactly these two generations.

The original freeze files each ended with a trailing newline, so their hashes
(`22a6ab3b…`, `b93bbe5e…`) covered a byte that was never part of the approved
prompt text. The coordinator re-froze both files without it before any spend.
The canonical approved-batch hashes are now
`dae334f3f1bea18569393675d5582324138b1fee53319926da8f42c3035bba0c` and
`f3e3b291dbaad8ec5c3ca8a59d3cde8f60a47e8785843866611a84d1e53e7583`. No
generation was ever run against the superseded hashes.

### Generation

Both images were submitted through Story Studio's own GenStudio path,
`POST /api/projects/:slug/preview-image`, using the owner's configured key. The
key is held encrypted under Electron `safeStorage`; it was never read, decrypted,
printed, or handled. Because the corrected freeze has no trailing whitespace,
that route's `trim()` is a no-op, so the submitted prompt is byte-identical to
the approved batch and hashes to the same value. Each generation returned
`cached:false`, confirming a real charged call rather than a cache replay.

Receiver GenStudio, provider OpenAI, model `gpt-image-2`, 16:9, 1K, 20 credits
each — 40 credits total. `gpt-image-2` publishes `supports_seed:false`, so no
seed exists to record; that is captured as not-published rather than invented.
No reference image, image edit, compositing, masking, title plate, or
post-render overlay was used for either image. Each was accepted on its first
attempt, against a budget of three.

Full 16-item returned evidence for each image lives in `returned-evidence/`.
The untouched original rasters are retained outside the repository at
`<owner-home>/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/returned-originals-2026-08-28/`.

### Known resolution shortfall

Story Studio's preview route never selects a published output option, so
GenStudio applies the model's own `default_resolution` of 1K and both returned
originals are 1280×720. The family standard is 1672×941, so the deterministic
whole-image conversion upscales 1.306×. `gpt-image-2` does publish a 2K 16:9
option at 2560×1440 for 29 credits, but no verbatim-prompt route in the app
exposes a resolution parameter, so 2K was unreachable without either mutating a
project's saved configuration or bypassing the sanctioned path. This is
disclosed in the provenance ledger and in both evidence records rather than
being quietly absorbed.

### Authored sources

- Thumbnail `1.0.1` at `content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split-v1.0.1`.
  It carries the four retained `1.0.0` previews byte-identically plus the new
  `-6` entry. The rejected preview `#4` slot stays permanently vacant, so the
  new gallery entry is numbered `-6` rather than reusing a rejected identity.
- Style `1.0.1` at `content-packs/psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.1`.
  Its content document is byte-identical to the predecessor; only the preview
  asset and the manifest version/changelog change. The replaced `1.0.0` impasto
  preview is retained unchanged as diagnostic evidence.
- Kit `1.0.1` at `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1`,
  reduced from the six-piece `1.0.0` shape to exactly four pieces — one Formula,
  one Topic, one Style, one thumbnail Recipe. Impasto and Oil drop out; both
  already have their own families. The Topic is repinned to `1.0.1`.

### Measured capacity

Measured through `planIdeaAssignments` with the same binary-search harness the
kit-capacity test uses, on Formula `1.0.1` plus Topic `1.0.1`: capacity rises
from **10** at the current Topic `1.0.0` pin to **1,000** at the `1.0.1` pin.

`channel-kit-idea-capacity.test.ts` still records a floor of `10` for this kit
and still passes, because it resolves each lineage's newest *registered* version
and Kit `1.0.1` is not in the registry yet.

Three edits to that file must land in the **same** change as the Kit
reservation, or the suite goes red the moment the registry moves:

1. Raise the `KIT_FLOORS` row for `com.storystudio.pack.kit.symbolic-psychology-studio`
   from `10` to `PROMISED_IDEAS`, and delete the stale note calling it a
   "six-piece kit governed by its own wave plan".
2. Delete the whole `EXTRA_PIECES` entry for this kit. It grants two surplus
   `visual-style` pieces for the six-piece `1.0.0` shape, and the four-piece
   assertion uses `deepEqual`, so leaving the exemption in place makes the
   correct four-piece Kit **fail** against a six-piece allowance. That file's own
   comment already anticipates this: the repair is to drop the surplus styles
   from the Kit closure, which this task has now done.
3. Delete the `symbolic-psychology-studio` paragraph from the blocked-kits
   comment, since its preview-evidence gate is satisfied.

### Held for the registry writer

No registry write was performed. Three requests are staged as files:

- `reservation-requests/symbolic-psychology-studio-kit-v1.0.1.json` — Kit
  `1.0.1` has no registry record at all, so it needs a reservation before it can
  be promoted.
- `promotions/editorial-psychology-symbolic-split-v1.0.1.json`
- `promotions/pastel-surreal-psychological-collage-v1.0.1.json`

Each is staged with `expected_revision: 86`, the revision on `main` at the end of
this task. That pin is deliberate: if the counter has moved again, these requests
fail closed instead of applying against an unexpected registry. Re-read the live
revision and update all three before executing them.

This branch is based on `84754d10`, and `main` advanced to `53e1401d`
(registry revision `86`, 137 records) while this task ran, so it needs a rebase
before landing. The landing did two things that matter here:

- Topic `human-behavior-social-dynamics@1.0.1` is now `authored`, so the Kit's
  Topic pin no longer rests only on the `human-behavior@1.0.2` precedent.
- Thumbnail and Style `1.0.1` are both still `reserved`, so both promotions
  remain exactly the right next write.

Both source scaffolds now carry `registry_transition_allowed: true`, because
their returned-evidence sets are complete and both previews were accepted.

### Verification

- `npx tsx --test electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
  — 8 passed, 0 failed. The absence assertions were inverted rather than
  deleted: `registry_transition_allowed` is now derived from the returned
  evidence itself, the three ENOENT checks became manifest-identity checks, and
  a new test pins both preview hashes, the 1672×941 decode, and the four-piece
  Kit shape.
- `npx tsx --test electron/server/__tests__/channel-kit-idea-capacity.test.ts`
  — 2 passed, 0 failed.

## Next task

The Kit reservation and both leaf promotions await the registry writer slot.
Nothing else in Task 6 is blocked.
