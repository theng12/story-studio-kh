# Symbolic Psychology Studio Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely unblock the reviewed multi-Style Symbolic Psychology Studio contract, issue immutable Formula and Kit successors, qualify local deterministic candidates, and leave stocking blocked until external preview, independent-review, and deployed-app gates are all true.

**Architecture:** Preserve every issued `1.0.0` identity, source, archive, and review artifact as historical evidence. Extend the existing bundle-only manifest validator from exactly one Style to one-or-more ordered Styles, then add one explicit bundle-application transaction: the first ordered Style becomes the project's active default and every remaining exact Style is installed and retained as an alternative by the already-verified closure. Reserve a receipt-bound `1.0.1` Human Behavior Formula successor and `1.0.1` Symbolic Psychology Studio Kit successor, build keyless candidates locally, and assemble—but never send—a receiver handoff only after all leaf, coordinator, app-release, and independent-review gates pass.

**Tech Stack:** TypeScript, Zod, Node test runner, Content Pack archive/publisher tools, authoring-registry CAS/receipt CLI, SHA-256, sharp, GenStudio Store receipt-attested install fixtures.

**Spec:** `docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md`

## Global Constraints

- Coordinator branch is exactly `codex/content-expansion-portfolio`; do not reserve or transition registry records from another branch.
- Registry baseline observed while writing this plan is revision `16` with `74` records. Validate before every mutation, use the revision returned by the immediately preceding serialized registry operation, and stop on stale CAS state.
- Proposed values are not identities. The stable Formula and Kit lineages and proposed `1.0.1` versions may appear in a reservation request, but no successor source may be authored and no handoff may call either record issued until `verify-receipt` succeeds against the exact new receipt.
- Never edit or regenerate the issued/live Formula source `content-packs/free-starters/formula/human-behavior-explained/` or the blocked Kit `1.0.0` source `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio/`. Their existing registry rows, receipt history, archives, build failure, review findings, and closure remain immutable evidence.
- Formula successor is expected at version `1.0.1`, in `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/`, with the same pack/item/family/SKU lineage as `1.0.0`. Its only editorial change is replacing vocabulary mood `diagnostic-but-warm` with exact text `non-diagnostic-and-warm`; all existing explicit non-diagnosis safeguards remain.
- Kit successor is expected at version `1.0.1`, in `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1/`, with the same pack/bundle/family/SKU lineage as `1.0.0` and this exact ordered closure: Formula `1.0.1`, Topic `1.0.0`, Recipe `1.0.0`, Pastel `1.0.0`, Impasto `1.0.0`, Oil `1.0.0`.
- Bundle-only Channel Kits require exactly one Formula, at least one Topic, one-or-more Styles, and exactly one Recipe. Preserve exact component/dependency equality, order, unique component references, unique item IDs, external-only components, exact dependency use, namespace, archive, and signature/delivery safeguards.
- Ordered Style semantics are structural: the first `visual-style` component is the active project default; the remaining exact Style components are installed alternatives. Do not add `default_style_id`, copy Style documents into the Kit, or introduce a fifth creative schema.
- Install/restore/checkout behavior remains exact-closure and fail-closed. A Kit apply is an explicit project action, never an install side effect, and it never silently upgrades an existing project pin.
- Current application version is `1.4.31`. Multi-Style bundle-only archives must use the application release that first contains this support as their minimum version, expected `1.4.32`; a false `1.0.843` floor is forbidden because a `1.0.843` binary rejects this manifest. Formula `1.0.1`, whose schema is unchanged, may retain the truthful `1.0.843` floor.
- Mandatory application release integrity: bump `package.json` and `package-lock.json` together, add the newest-first matching `CHANGELOG.md` entry, and pass `npm run check:changelog`. If the branch version is no longer `1.4.31` at execution time, stop and recompute the next patch and Kit minimum before building.
- Keyless candidates use `genstudio-store-receipt-v1`, have no `key_id` or `signature.ed25519`, contain only strict JSON/permitted rasters, and remain at or below `52,428,800` bytes.
- `component_summary` v1 appears only in the final local release handoff. It never enters source manifests, registry requests/records, archive manifests, historical rows, build ledgers, or review requests.
- Recipe and Pastel replacement generation remains Studio Hub/owner work. This control Mac may checksum, decode, inspect, deterministically convert whole returned images, build, and validate; it may not generate, edit, submit, reserve capacity, spend, or infer missing prompt/quote/authority evidence.
- No upload, product/release draft, product/release/account/wire identity, price/discount decision, purchase, grant, production signing, publication, deploy, tag, push, or GenStudio commerce mutation is authorized.
- Oil remains independently candidate-ready. Do not deliver its receiver handoff until the evidence wording is reconciled and a fresh independent reviewer records a clean result.

## Architectural Finding: No New Default-Style Manifest Field

The current architecture supports the required semantics with one small application API, not a new manifest field:

1. `ContentPackBundleSchema.components` is ordered and already carries exact `pack_id`, `version`, `item_id`, and `kind` references.
2. `content-store-delivery.ts` binds signed receipt positions to manifest dependency positions, recursively installs every exact dependency, verifies the whole immutable closure, and activates it atomically.
3. `ProjectMeta` and config already represent one active `visual-style`, while the installed catalog can retain multiple exact Style versions.
4. No production code currently consumes `manifest.bundles`; only schema/tests/publisher tooling do. Therefore the smallest missing application surface is one explicit project bundle-apply transaction that resolves the exact root and all exact components, selects the first Style, exact-pins the creative selections, and reports the later ordered Styles as alternatives.

Do not auto-apply during purchase/install: the Store install route has no project context, and coupling install to project mutation would violate the existing transaction and pin boundaries.

## Execution and Review Structure

- The coordinator owns all registry reservations/transitions and stays on `codex/content-expansion-portfolio`.
- For each task, dispatch one fresh implementation subagent with only that task, its consumed interfaces, current start commit, and proof command. The worker must not reserve identities, contact Studio Hub, or perform any external mutation.
- After each implementation task, dispatch a fresh spec-compliance reviewer, then a separate code/evidence-quality reviewer. Fix findings and repeat both reviews before starting the next task.
- Reviewers are read-only except for their report under `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/`. The coordinator validates their claims against files/tests before accepting a task.
- Owner prompt/quote/authority decisions are never delegated. If the exact evidence is absent, the applicable preview task stops as blocked.
- Record task commits, review reports, registry revisions/receipts, build hashes, and blocked gates in `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/progress.md`.

## File Structure

| Path | Responsibility |
| --- | --- |
| `scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs` | Opt-in external truth audit, extended to `review-requests.json` |
| `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/` | Progress, reviews, reservation request, receipt-derived expected identities, build/review reports |
| `electron/server/content-packs/schemas.ts` | One-or-more ordered Style cardinality for bundle-only coordinators |
| `electron/server/content-packs/project-pins.ts` | Exact bundle resolution/application and first-Style default semantics |
| `electron/server/content-packs/runtime-types.ts` | Strict bundle-application request/result types only if route-local types cannot express the boundary cleanly |
| `electron/server/routes/content-packs.ts` | Explicit project bundle-apply endpoint; no Store purchase/install side effect |
| `electron/server/__tests__/content-pack-contract.test.ts` | Multi-Style manifest acceptance and retained negative safeguards |
| `scripts/content-packs/__tests__/publisher-tools.test.mjs` | Deterministic multi-Style bundle-only build/validate contract |
| `electron/server/__tests__/content-pack-project-pins.test.ts` | Default Style, alternatives, atomic pins, conflict behavior |
| `electron/server/__tests__/content-pack-installer.test.ts` | Exact dependency installation and minimum-app refusal |
| `electron/server/__tests__/content-pack-recovery.test.ts` | Multi-Style recovery/boot verification |
| `electron/server/__tests__/content-store-delivery-transaction.test.ts` | Receipt-position closure install/activation and failure rollback |
| `electron/server/__tests__/content-pack-routes.test.ts` | Bundle apply route validation and safe 409 responses |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | Application release containing multi-Style support |
| `content-packs/authoring-registry.json` | Serialized receipt-bound Formula/Kit successor records |
| `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/` | Immutable non-diagnostic Formula successor |
| `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1/pack.json` | Immutable six-node bundle-only Kit successor |
| `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/` | Existing Wave 1 evidence wording reconciled in place; historical bytes otherwise preserved |
| `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/` | Fresh successor build evidence, blocked candidates, reviews, and final local-only receiver handoff |

---

### Task 1: Reconcile External Review Truth Before Any New Work

**Files:**
- Modify: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/candidate-handoffs.json`
- Modify: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/review-requests.json`
- Modify: `scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/evidence-reconciliation-review.md`

**Interfaces:**
- Consumes: final review/rereview truth at `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-wave-1/{final-review.md,final-rereview.md}`.
- Produces: one contradiction-free external evidence set and a durable opt-in audit that reads all three evidence inputs.

- [ ] **Step 1: Write the failing external-truth assertions**

Add `REVIEW_REQUESTS` beside the existing opt-in paths and load it in the evidence test. Assert:

```js
assert.equal(reviewRequests.status, 'review-complete-with-blockers')
assert.deepEqual(reviewRequests.reviews.map(review => review.status), [
  'complete-with-blockers', 'complete-with-blockers', 'complete-with-blockers',
  'complete-with-blockers', 'complete-with-blockers', 'complete-with-blockers',
  'complete-with-blockers', 'complete', 'complete',
])
assert.equal(JSON.stringify(reviewRequests).includes('candidate-built-review-pending'), false)
assert.equal(JSON.stringify(handoffs).includes('review requested'), false)
```

Also assert Pastel and Kit `evidence.golden_prompt_parity` are `blocked` because the completed review found concrete preview/closure blockers, not because review is pending; Oil remains `ready-for-owner-stocking`; and the receiver remains `partial-review-complete-blocked` with `pending: []`.

- [ ] **Step 2: Run RED against the explicit evidence root**

```bash
STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT=/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23 \
  node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
```

Expected: FAIL on Pastel/Kit `review requested` wording and commercial-boundary `candidate-built-review-pending` wording.

- [ ] **Step 3: Reconcile exact wording without changing dispositions**

Change only contradictory prose:

- Pastel `golden_prompt_parity`: completed independent prompt-equivalence review is blocked because the heavy-impasto preview does not demonstrate matte mixed-media collage.
- Kit `golden_prompt_parity`: completed review is blocked by the Pastel mismatch and the Formula `1.0.0` diagnostic language; no review is pending.
- Commercial-boundary acceptance: receiver must remain `partial-review-complete-blocked`, Oil may remain candidate-ready, and no receiver delivery or stocking mutation is authorized.

Do not change hashes, archive paths, identities, counts, review results, Formula/Kit blockers, or the Oil readiness result.

- [ ] **Step 4: Run both portability lanes**

```bash
env -u STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT=/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23 \
  node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
```

Expected: no-env lane explicitly skips external assertions; explicit lane passes every assertion.

- [ ] **Step 5: Independent evidence review and commit**

Have a fresh reviewer compare both JSON files, `receiver-handoff.json`, final rereview, and test assertions. Record `passed` only if every status and prose field agrees. Do not send or copy the Oil receiver handoff.

```bash
git add scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/evidence-reconciliation-review.md
git commit -m "test(content-packs): reconcile symbolic review truth"
```

External JSON is not a repository commit; record its SHA-256 before/after in the review report.

---

### Task 2: Add Multi-Style Bundle Publisher and Application Support

**Files:**
- Modify: `electron/server/content-packs/schemas.ts`
- Modify: `electron/server/content-packs/project-pins.ts`
- Modify: `electron/server/content-packs/runtime-types.ts` only for the strict route contract
- Modify: `electron/server/routes/content-packs.ts`
- Modify: `electron/server/__tests__/content-pack-contract.test.ts`
- Modify: `electron/server/__tests__/content-pack-project-pins.test.ts`
- Modify: `electron/server/__tests__/content-pack-routes.test.ts`
- Modify: `scripts/content-packs/__tests__/publisher-tools.test.mjs`

**Interfaces:**
- Consumes: ordered `ContentPackBundleSchema.components` and exact installed `ContentPackVersionRef` values.
- Produces: `applyProjectContentBundle(slug, request, options)` and a strict POST route that atomically applies Formula, Topics, first Style, and Recipe while reporting remaining Styles as alternatives.

- [ ] **Step 1: Write RED manifest/publisher tests**

Build a bundle-only fixture with component order Formula, Topic, Recipe, Style A, Style B, Style C and matching dependencies. Assert it parses and builds deterministically. Retain negative cases for zero Styles, duplicate Style/item IDs, two Recipes, two Formulas, missing Topic, same-pack components, unused/missing dependencies, content/assets in a coordinator, namespace violations, and mismatched dependency order.

The positive cardinality assertion is exact:

```ts
const counts = parsed.bundles[0]!.components.reduce<Record<string, number>>(
  (result, component) => ({ ...result, [component.kind]: (result[component.kind] ?? 0) + 1 }),
  {},
)
assert.deepEqual(counts, {
  'series-formula': 1,
  'topic-pack': 1,
  'thumbnail-recipe': 1,
  'visual-style': 3,
})
```

Run:

```bash
npx tsx --test electron/server/__tests__/content-pack-contract.test.ts
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs
```

Expected: multi-Style positive cases fail on the current exactly-one-Style refinement; every old negative safeguard remains green.

- [ ] **Step 2: Make the smallest schema change**

In the bundle-only refinement, replace `count('visual-style') !== 1` with `< 1`; retain `count('series-formula') !== 1`, `count('topic-pack') < 1`, and `count('thumbnail-recipe') !== 1`. Change the error to:

```text
bundle-only coordination packs require exactly one Formula, at least one Topic Pack, one or more Styles, and exactly one Recipe component
```

Do not alter `ContentPackComponentReferenceSchema`, uniqueness checks, dependency matching, external-component checks, file restrictions, or archive trust rules.

- [ ] **Step 3: Write RED bundle-application tests**

Test a project with the six exact installed components. Require:

- Formula and Topic IDs are applied in bundle order.
- Pastel, the first Style, becomes `active_style_preset_id`.
- Impasto and Oil are returned as ordered alternatives and remain exact installed closure members.
- Recipe becomes `thumbnail_template_id`.
- exact component pack versions/items are pinned atomically;
- a missing, recalled, disabled, hash-mismatched, wrong-kind, duplicate, or conflicting-version component makes the whole operation fail with no config/project mutation;
- an existing pin at a different version yields a clear 409 and is never silently upgraded;
- bundle order, not name or current catalog default, determines the Style default.

Define the narrow interface:

```ts
export interface ProjectContentBundleApplicationRequest {
  root: ContentPackVersionRef
  bundle_id: string
}

export interface ProjectContentBundleApplicationResult {
  project_slug: string
  bundle_id: string
  formula_id: string
  topic_pack_ids: string[]
  default_style_id: string
  alternative_style_ids: string[]
  thumbnail_recipe_id: string
  content_pack_versions: Record<string, string>
}
```

- [ ] **Step 4: Implement exact resolution and one atomic project write**

Inside the content-pack coordination lock:

1. resolve `request.root` by pack/version/SHA;
2. require exactly one matching bundle-only manifest and `bundle_id`;
3. call `verifyInstalledContentPackClosure` on the root;
4. resolve every component's exact pack/version and confirm the item ID and kind exist;
5. derive `styles = components.filter(kind === 'visual-style')`, `default = styles[0]`, alternatives `styles.slice(1)`;
6. update config and project metadata consistently, applying all exact component pins but setting only the first Style active;
7. return the exact result above.

Use existing `applyContentSelections`/consistent project mutation primitives. Add no persisted `default_style_id`, no auto-upgrade, and no install/purchase side effect.

- [ ] **Step 5: Add strict route validation**

Add `POST /content-packs/projects/:slug/bundles/apply` with a body containing only `root` and `bundle_id`. Reject unknown keys, invalid slugs/IDs, non-bundle roots, absent projects, and pin conflicts with safe 400/404/409 responses. The endpoint performs no network, quote, purchase, or install.

- [ ] **Step 6: GREEN and focused review**

```bash
npx tsx --test \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-project-pins.test.ts \
  electron/server/__tests__/content-pack-routes.test.ts
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs
npm run typecheck:electron
```

After two-stage review, commit:

```bash
git add electron/server/content-packs/schemas.ts \
  electron/server/content-packs/project-pins.ts \
  electron/server/content-packs/runtime-types.ts \
  electron/server/routes/content-packs.ts \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-project-pins.test.ts \
  electron/server/__tests__/content-pack-routes.test.ts \
  scripts/content-packs/__tests__/publisher-tools.test.mjs
git commit -m "feat(content-packs): support ordered multi-style kits"
```

If route-local schemas are sufficient and `runtime-types.ts` remains unchanged, omit it from `git add`; do not create an unused shared type.

---

### Task 3: Prove Archive, Install, Recovery, Checkout, and Release Compatibility

**Files:**
- Modify: `electron/server/__tests__/content-pack-archive.test.ts`
- Modify: `electron/server/__tests__/content-pack-installer.test.ts`
- Modify: `electron/server/__tests__/content-pack-recovery.test.ts`
- Modify: `electron/server/__tests__/content-store-delivery-transaction.test.ts`
- Modify: `electron/server/__tests__/content-store-paid-bundle.test.ts` only for a non-mutating compatibility fixture
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the Task 2 manifest/application contract.
- Produces: application release `1.4.32` (expected), clear older-app refusal, and regression proof that no commerce implementation changed.

- [ ] **Step 1: Write compatibility tests before release bookkeeping**

Create an exact six-member receipt-root fixture with three Style dependencies in manifest order. Assert:

- archive verification accepts the bundle-only root and rejects malformed/unsafe variants;
- install downloads/stages each exact dependency, activates none until all six plus root verify, then activates the whole closure in one checkpoint;
- missing/recalled/hash-mismatched third Style rolls back root activation and preserves existing project pins;
- recovery verifies and discovers the multi-Style root only when its exact closure is retained;
- checkout/quote data can carry all six ordered bundle components without changing price, ownership, receipt, or purchase logic;
- an app version below `1.4.32` rejects the Kit before installation with `CONTENT_PACK_REQUIRES_NEWER_APP`, a detail naming required/current versions, no archive activation, and no project mutation.

Run RED on the new floor assertion before the package bump:

```bash
npx tsx --test \
  electron/server/__tests__/content-pack-archive.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/content-pack-recovery.test.ts \
  electron/server/__tests__/content-store-delivery-transaction.test.ts \
  electron/server/__tests__/content-store-paid-bundle.test.ts
```

- [ ] **Step 2: Bump the application release exactly once**

Confirm `package.json` and `package-lock.json` both say `1.4.31`. Then run:

```bash
npm version 1.4.32 --no-git-tag-version
```

If the current version differs, stop; do not reuse `1.4.32` or build a Kit with a stale minimum.

- [ ] **Step 3: Add the newest changelog entry**

Add this customer-visible entry above `v1.4.31`:

```markdown
## v1.4.32 — 2026-08-23

- **Channel Kits can include several exact Visual Styles.** The first listed Style is the default; the remaining installed Styles stay available as alternatives.
- **Applying a Kit is explicit and atomic.** Formula, Topics, Recipe, Style, and exact Content Pack pins change together, or nothing changes.
- **Older Story Studio builds refuse these Kits clearly.** They must update before installation; no partial closure is activated.
```

- [ ] **Step 4: Run compatibility and release gates**

```bash
npx tsx --test \
  electron/server/__tests__/content-pack-archive.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/content-pack-recovery.test.ts \
  electron/server/__tests__/content-store-delivery-transaction.test.ts \
  electron/server/__tests__/content-store-paid-bundle.test.ts
npm run check:changelog
npm run typecheck:electron
npm run check:security
npm run check:model-drift
```

Review must confirm checkout source files are unchanged; only compatibility fixtures may change. Commit:

```bash
git add electron/server/__tests__/content-pack-archive.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/content-pack-recovery.test.ts \
  electron/server/__tests__/content-store-delivery-transaction.test.ts \
  electron/server/__tests__/content-store-paid-bundle.test.ts \
  package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): prepare multi-style kit support"
```

No deploy/tag/push follows. Record `app-release-not-deployed` as a Kit stocking blocker.

---

### Task 4: Atomically Reserve Formula and Kit Successors

**Files:**
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/reservation-requests/formula-and-kit-v1.0.1.json`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/human-behavior-explained-v1.0.1.json`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/symbolic-psychology-studio-v1.0.1.json`
- Modify: `content-packs/authoring-registry.json`

**Interfaces:**
- Consumes: validated revision `16`/`74` or the newly observed serialized revision.
- Produces: one exact new receipt binding both successor records.

- [ ] **Step 1: Validate and write one two-record request**

```bash
npm run content-pack:registry -- validate
```

The request uses `expected_revision` from that output and coordinator `{ "task": "symbolic-psychology-studio-unblock", "branch": "codex/content-expansion-portfolio" }`.

Formula proposal:

```json
{
  "pack_id": "com.storystudio.pack.formula.human-behavior-explained",
  "item_id": "com.storystudio.formula.human-behavior-explained",
  "version": "1.0.1",
  "publisher_id": "com.storystudio",
  "min_app_version": "{{MIN_APP_VERSION}}",
  "min_app_version_status": "release-bound",
  "kind": "series-formula",
  "source_path": "content-packs/free-starters/formula/human-behavior-explained-v1.0.1",
  "status": "reserved",
  "dependencies": [],
  "stocking_proposal": {
    "family": { "id": "com.storystudio.family.formula.human-behavior-explained", "status": "proposed" },
    "sku": { "id": "com.storystudio.sku.formula.human-behavior-explained", "status": "proposed" }
  }
}
```

Kit proposal uses stable Kit pack/bundle/family/SKU, version `1.0.1`, the versioned source path, and these exact ordered dependencies:

```json
[
  { "pack_id": "com.storystudio.pack.formula.human-behavior-explained", "version": "1.0.1" },
  { "pack_id": "com.storystudio.pack.topic.human-behavior-social-dynamics", "version": "1.0.0" },
  { "pack_id": "com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split", "version": "1.0.0" },
  { "pack_id": "com.storystudio.pack.style.pastel-surreal-psychological-collage", "version": "1.0.0" },
  { "pack_id": "com.storystudio.pack.style.impasto-psychological-animals", "version": "1.0.0" },
  { "pack_id": "com.storystudio.pack.style.oil-painting-classical", "version": "1.0.0" }
]
```

- [ ] **Step 2: Reserve once, then verify both exact records**

Run one `reserve` call. Copy each returned record minus `receipt_ref` into its expected identity file; do not hand-edit receipt-derived fields. Resolve the just-written batch by its exact coordinator task and verify both records against that batch:

```bash
UNBLOCK_RECEIPT="$(jq -r '[.batches[] | select(.request.coordinator.task == "symbolic-psychology-studio-unblock")][-1].receipt_ref' content-packs/authoring-registry.json)"
UNBLOCK_RESERVATION_REVISION="$(jq -r '[.batches[] | select(.request.coordinator.task == "symbolic-psychology-studio-unblock")][-1].revision' content-packs/authoring-registry.json)"
test "$UNBLOCK_RECEIPT" != "null" && test "$UNBLOCK_RESERVATION_REVISION" != "null"
npm run content-pack:registry -- verify-receipt --revision "$UNBLOCK_RESERVATION_REVISION" --receipt "$UNBLOCK_RECEIPT" --expected-identity .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/human-behavior-explained-v1.0.1.json
npm run content-pack:registry -- verify-receipt --revision "$UNBLOCK_RESERVATION_REVISION" --receipt "$UNBLOCK_RECEIPT" --expected-identity .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/symbolic-psychology-studio-v1.0.1.json
```

If either verification fails, author no source.

- [ ] **Step 3: Validate and commit reservation evidence**

```bash
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
git add content-packs/authoring-registry.json \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/reservation-requests \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities
git commit -m "chore(content-packs): reserve symbolic successors"
```

---

### Task 5: Author the Immutable Human Behavior Formula Successor

**Files:**
- Create: `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/pack.json`
- Create: `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/content/series-formula.json`
- Modify: `electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
- Modify: `scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/promotions/human-behavior-explained-v1.0.1.json`
- Modify: `content-packs/authoring-registry.json`

**Interfaces:**
- Consumes: verified Formula successor receipt record.
- Produces: exact `series-formula` `1.0.1` source with non-diagnostic language and no mutation to `1.0.0`.

- [ ] **Step 1: Pin immutable-source RED tests**

Before creating the successor, record SHA-256 for both `1.0.0` files in test constants. Assert they never change. Then require successor parity after normalizing only manifest version/changelog and the one mood token:

```ts
assert.equal(v100.vocabulary.mood.includes('diagnostic-but-warm'), true)
assert.equal(v101.vocabulary.mood.includes('diagnostic-but-warm'), false)
assert.equal(v101.vocabulary.mood.includes('non-diagnostic-and-warm'), true)
assert.equal(v101.vocabulary.mood.length, v100.vocabulary.mood.length)
```

Also assert every existing non-diagnosis rule remains, `1.0.1` item ID is unchanged, source has no new dependency, and registry still retains both version records/receipts.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
```

Expected: missing `1.0.1` source.

- [ ] **Step 3: Author only from receipt and exact predecessor copy**

Copy `1.0.0` into the versioned directory, change manifest version to `1.0.1`, add changelog `Replaces diagnostic tone vocabulary with explicitly non-diagnostic, evidence-aware language.`, and replace only `diagnostic-but-warm` with `non-diagnostic-and-warm` in the document. Keep pack/item/family/SKU and all other document values exact.

- [ ] **Step 4: GREEN, then one serialized transition**

Run the source tests and registry validation. Create a transition request bound to the exact receipt, current reported revision, pack/version, coordinator task/branch, and only `{ "status": "authored" }`. Apply it, use the returned next revision, and re-run both `verify-receipt` and registry validation.

- [ ] **Step 5: Safety review and commit**

Independent review must compare normalized JSON and prove no other vocabulary/prompt/clinical safety change. Commit:

```bash
git add content-packs/free-starters/formula/human-behavior-explained-v1.0.1 \
  content-packs/authoring-registry.json \
  electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts \
  scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/promotions/human-behavior-explained-v1.0.1.json
git commit -m "fix(content-packs): issue non-diagnostic behavior formula"
```

---

### Task 6: Author and Build the Immutable Kit Successor

**Files:**
- Create: `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1/pack.json`
- Modify: `electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
- Modify: `scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/promotions/symbolic-psychology-studio-v1.0.1.json`
- Modify: `content-packs/authoring-registry.json`
- Create: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/build-evidence/`
- Create: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/blocked-candidates/`

**Interfaces:**
- Consumes: verified Kit receipt, Formula `1.0.1`, Task 2 publisher support, Task 3 app version.
- Produces: exact bundle-only Kit `1.0.1`, two equal keyless builds, and a blocked local candidate—not a stocking handoff.

- [ ] **Step 1: Write RED successor/immutability tests**

Pin the existing Kit `1.0.0` pack SHA and exact blocked closure. Require `1.0.1` root entries equal `['pack.json']`, with the exact six dependencies/components from Global Constraints. Assert:

```js
assert.deepEqual(successor.bundles[0].components
  .filter(component => component.kind === 'visual-style')
  .map(component => component.item_id), [
    'com.storystudio.style.pastel-surreal-psychological-collage',
    'com.storystudio.style.impasto-psychological-animals',
    'com.storystudio.style.oil-painting-classical',
  ])
```

Require Formula dependency/component version `1.0.1`, all other versions `1.0.0`, dependencies equal component pack/version pairs in order, and no `component_summary` anywhere in source/registry.

- [ ] **Step 2: Author from the exact receipt**

Create only `pack.json`, with version `1.0.1`, stable Kit identity/entitlement lineage, changelog `Uses the non-diagnostic Human Behavior Formula successor and preserves three ordered compatible visual styles.`, exact six-node closure, and tokenized key/minimum fields. Do not edit `1.0.0` or add content/assets.

- [ ] **Step 3: GREEN, then serialize the Kit transition**

After source/contract tests pass, transition only Kit `1.0.1` from reserved to authored using the exact receipt and revision returned after Formula transition. Re-verify receipt and registry.

- [ ] **Step 4: Build Formula and Kit twice with truthful floors**

Fail if the fresh external artifact root already exists. Build Formula `1.0.1` twice with `--min-app-version 1.0.843`. Build Kit `1.0.1` twice with `--min-app-version 1.4.32` (or the exact recomputed Task 3 release if version changed before execution):

```bash
npm run content-pack:build -- content-packs/free-starters/formula/human-behavior-explained-v1.0.1 --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.0.843 --output /build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/build-evidence/human-behavior-explained-v1.0.1-a.sspack
npm run content-pack:build -- content-packs/free-starters/formula/human-behavior-explained-v1.0.1 --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.0.843 --output /build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/build-evidence/human-behavior-explained-v1.0.1-b.sspack
npm run content-pack:build -- content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1 --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.4.32 --output /build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/build-evidence/symbolic-psychology-studio-v1.0.1-a.sspack
npm run content-pack:build -- content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1 --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.4.32 --output /build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/build-evidence/symbolic-psychology-studio-v1.0.1-b.sspack
```

Validate each matching profile, assert each pair's bytes/SHA are equal, inspect ZIP entries/permissions, and prove absence of `key_id`, `signature.ed25519`, executable/URL/credential/provider/model/price/wire fields. Retain one Formula candidate and one Kit candidate under `blocked-candidates/`; the Kit is blocked by app release not deployed, Recipe review, Pastel review, and final independent closure review.

- [ ] **Step 5: Commit repository source only**

```bash
git add content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1 \
  content-packs/authoring-registry.json \
  electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts \
  scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/promotions/symbolic-psychology-studio-v1.0.1.json
git commit -m "feat(content-packs): issue symbolic psychology kit successor"
```

Record external build hashes/paths in progress, but do not commit machine-local archives.

---

### Task 7: Qualify Owner-Returned Recipe and Pastel Preview Bytes

**Files:**
- Consume: `/build/Developer/_handoffs/2026-08-23_symbolic-psychology-recipe-preview-draft-prompt-batch.json`
- Consume: `/build/Developer/_handoffs/2026-08-23_to-gpt-studiofleet_from-gpt-storystudio_symbolic-psychology-{recipe,pastel}-preview-replacement.md`
- Modify only after complete returned evidence: `content-packs/psychology-editorial/PREVIEW-PROVENANCE.md`
- Modify only after complete returned evidence: Recipe/Pastel exact `1.0.0` source assets and preview arrays
- Modify: applicable source/evidence tests
- Modify: fresh external build evidence and blocked-candidate inventory

**Interfaces:**
- Consumes: untouched returned rasters plus exact prompt batch, prompt hash, quote, owner approval, job/request ID, provider/model as published, timestamp, seed if published, cost receipt, license/rights basis, no-reference declaration, SHA, dimensions, type, byte size, decode result.
- Produces: qualified Recipe/Pastel source bytes and fresh twice-built candidates only if all evidence and reviews pass.

- [ ] **Step 1: Stop unless authority is complete**

Recipe requires owner approval of exact draft batch SHA `ceb4cee15331105d657ef5a7aea66a4e2e87877f32c5efe0a8022b48732c3c3b` and the exact returned quote before Studio Hub execution. Pastel requires a literal prompt batch and its hash, exact quote, and explicit owner job authority; the current capability-only request is insufficient. If any record is absent, mark Task 7 blocked and perform no generation/submission/source edit.

- [ ] **Step 2: Verify returned evidence before touching source**

Hash the untouched raster and compare it to the returned receipt; decode with `sharp(..., { failOn: 'error' })`; confirm type/dimensions/bytes; match job ID, submitted prompt/hash, authority, quote/cost, provider/model, rights, timestamp, seed, and no-reference/no-compositing declarations. Reject any mismatch, malformed text, clipped headline, copied/rejected preview #4 bytes, wrong medium, logo/watermark/UI, or missing provenance.

- [ ] **Step 3: Apply only a deterministic whole-image conversion**

If returned bytes are already a qualifying `1672x941` WebP, byte-copy them. Otherwise use `sharp` for a full-frame deterministic resize/crop to `1672x941` and WebP encoding with fixed options recorded verbatim in provenance. No masking, inpainting, text overlay, compositing, selective edit, or reference-image repair is permitted.

- [ ] **Step 4: Update evidence and run visual TDD**

For Recipe, require the exact one-line `HIDDEN MOTIVES` headline, far-right three-quarter-profile medium-long subject, and material side/angle/distance diversity across the full gallery. For Pastel, require matte mixed-media collage with the approved low-saturation palette and no heavy/wet impasto. Record original/converted hashes, dimensions, bytes, transformation, rights, and source receipt.

- [ ] **Step 5: Rebuild each leaf twice and review independently**

Use keyless profile/minimum `1.0.843`, validate twice, compare bytes/SHA, then obtain fresh originality/provenance, prompt-equivalence, visual, and Recipe thumbnail reviews. A reviewer must inspect decoded pixels. Keep failed candidates under blocked quarantine and leave active archive identities null.

- [ ] **Step 6: Commit only after clean leaf reviews**

Commit source, provenance, and tests; never commit external receipts containing secrets. No receiver handoff is assembled yet.

---

### Task 8: Final Review, Release Handoff, and Stocking Block

**Files:**
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/final-review.md`
- Create after a clean rereview: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/release-handoff.json`
- Create after a clean rereview: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/receiver-handoff.json`
- Modify: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/progress.md`

**Interfaces:**
- Consumes: all prior task commits/reviews, exact receipts, deterministic hashes, preview qualifications, and application release state.
- Produces: local-only final handoffs. It never sends, uploads, publishes, deploys, tags, or pushes them.

- [ ] **Step 1: Run the complete verification matrix**

```bash
npm run content-pack:registry -- validate
node --test \
  scripts/content-packs/__tests__/authoring-registry.test.mjs \
  scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs \
  scripts/content-packs/__tests__/publisher-tools.test.mjs
npx tsx --test \
  electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-archive.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/content-pack-recovery.test.ts \
  electron/server/__tests__/content-pack-project-pins.test.ts \
  electron/server/__tests__/content-pack-routes.test.ts \
  electron/server/__tests__/content-store-delivery-transaction.test.ts \
  electron/server/__tests__/content-store-paid-bundle.test.ts
npm run typecheck
npm run check:changelog
npm run check:security
npm run check:model-drift
git diff --check
```

Also re-run the opt-in Wave 1 external evidence audit and validate every retained candidate by exact profile/hash.

- [ ] **Step 2: Independent whole-wave review**

Require clean schema, identity/receipt, immutability, dependency/order, install/recovery/application, safety, originality/provenance, prompt-equivalence, visual/thumbnail, copy, component-summary, security, model-drift, and commercial-boundary results. Reviewers must confirm no historical `1.0.0` source/archive/closure was rewritten and no commerce code/mutation occurred.

- [ ] **Step 3: Write `component_summary` only in release handoff**

Formula successor:

```json
{
  "schema_version": 1,
  "kind": "series-formula",
  "summary": "Evidence-aware, non-diagnostic explanations of recognizable human behavior.",
  "slots": { "series-formula": 1 }
}
```

Kit successor:

```json
{
  "schema_version": 1,
  "kind": "channel-kit",
  "summary": "Evidence-aware symbolic psychology with three compatible visual styles.",
  "slots": {
    "series-formula": 1,
    "topic-pack": 1,
    "visual-style": 3,
    "thumbnail-recipe": 1
  }
}
```

Assert `component_summary` appears nowhere else.

- [ ] **Step 4: Assemble but do not deliver the receiver handoff**

The local handoff may list Oil as candidate-ready and the successor Kit as technically validated only if every review passes. Overall status remains blocked until all of these are true:

1. Recipe replacement qualified and reviewed;
2. Pastel replacement qualified and reviewed;
3. Formula `1.0.1` and Kit `1.0.1` receipts/source/candidates reviewed;
4. multi-Style application release is actually deployed to customers at the exact Kit minimum;
5. clean evidence reconciliation rereview exists;
6. owner separately authorizes the eventual receiver/stocking action.

Because this plan forbids deploy and external delivery, record `app-release-not-deployed` and `receiver-delivery-not-authorized` unless independent external evidence proves otherwise. Do not change that blocker based on a local version bump.

- [ ] **Step 5: Final repository commit, no external mutation**

```bash
git add .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock
git commit -m "docs(content-packs): record symbolic unblock qualification"
git status --short --branch
```

Do not run `git push`, create a tag, deploy, upload an archive, or call any GenStudio commerce/publication endpoint.

## Plan Self-Review

**Spec coverage:** External review truth is reconciled first; Oil readiness is preserved without receiver delivery; publisher/application/install/recovery/checkout compatibility is TDD-covered; ordered Style default semantics use current structures; Formula and Kit successors are receipt-bound and immutable; `1.0.0` evidence remains unchanged; candidates are deterministic/keyless; Recipe/Pastel stay owner/Studio Hub gated; final handoff is local-only and stocking remains blocked.

**Identity consistency:** Stable pack/item/bundle/family/SKU lineages are reused only as proposed reservation inputs until a new receipt verifies. Formula and Kit successors use distinct versioned source paths and exact `1.0.1` records. Kit closure uses Formula `1.0.1` plus Topic, Recipe, Pastel, Impasto, Oil `1.0.0` in exact order.

**Type consistency:** Bundle application consumes `ProjectContentBundleApplicationRequest` and returns `ProjectContentBundleApplicationResult`; first Style is `default_style_id`, later Styles are `alternative_style_ids`; no manifest `default_style_id` or fifth creative kind exists.

**Minimum-version consistency:** Formula may use `1.0.843`; Kit uses the application release that introduces multi-Style acceptance, expected `1.4.32`. Older binaries receive a tested update-required refusal before activation. A local version bump is not treated as deployment evidence.

**Placeholder scan:** Future receipt values and returned preview hashes are never guessed; steps consume exact CLI/Studio Hub outputs and stop if they are absent or inconsistent. No unresolved value is represented as an identity or pass.

**Mutation boundary:** No production generation, upload, product/release draft, pricing, purchase, grant, signing, publication, deploy, tag, push, or GenStudio mutation is included.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-08-23-symbolic-psychology-studio-unblock.md`. Execute with fresh task workers and two-stage reviews; stop at Task 7 if exact owner prompt/quote/job authority or returned bytes are absent.
