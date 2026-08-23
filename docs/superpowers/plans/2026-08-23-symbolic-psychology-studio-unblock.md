# Symbolic Psychology Studio Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely unblock the reviewed multi-Style Symbolic Psychology Studio contract, issue immutable Formula, Recipe, Pastel, and Kit successors, qualify local deterministic candidates, and leave stocking blocked until external preview, independent-review, and deployed-app gates are all true.

**Architecture:** Preserve every issued `1.0.0` identity, source, archive, and review artifact as historical evidence. Extend the existing bundle-only manifest validator from exactly one Style to one-or-more ordered Styles, then add one explicit bundle-application transaction: the first ordered Style becomes the project's active default and every remaining exact Style is retained as a project-pinned alternative. Selection uses a two-stage resolver: an existing owner pin resolves first by exact owner/version/hash and fails closed; without a pin, current signed-catalog discovery may resolve and create an exact pin; only a signed-catalog miss returns `null` to preserve the current legacy/local no-pin write. Reserve receipt-bound `1.0.1` Formula, Recipe, and Pastel successors first; author Formula immediately, but keep Recipe/Pastel reserved until exact returned preview evidence passes review. Only then reserve and author a `1.0.1` Kit whose final closure pins all three qualified successors, build keyless candidates locally, and assemble—but never send—a receiver handoff.

**Tech Stack:** TypeScript, Zod, Node test runner, Content Pack archive/publisher tools, authoring-registry CAS/receipt CLI, SHA-256, sharp, GenStudio Store receipt-attested install fixtures.

**Spec:** `docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md`

## Global Constraints

- Coordinator branch is exactly `codex/content-expansion-portfolio`; do not reserve or transition registry records from another branch.
- Registry baseline observed while writing this plan is revision `16` with `74` records. Validate before every mutation, use the revision returned by the immediately preceding serialized registry operation, and stop on stale CAS state.
- Proposed values are not identities. Stable Formula, Recipe, Pastel, and Kit lineages and proposed `1.0.1` versions may appear in reservation requests, but no successor source may be called issued until its exact receipt verifies; no Recipe/Pastel successor may transition to authored until returned preview evidence and independent review pass.
- Never edit, regenerate, or replace any issued/authored `1.0.0` Formula, Recipe, Pastel, or Kit source byte. Pin their current source-file SHA-256 values in tests before successor work. Their registry rows, receipt history, archives/quarantine, review findings, and Kit `1.0.0` closure remain immutable evidence.
- Formula successor is expected at version `1.0.1`, in `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/`, with the same pack/item/family/SKU lineage as `1.0.0`. Its only editorial change is replacing vocabulary mood `diagnostic-but-warm` with exact text `non-diagnostic-and-warm`; all existing explicit non-diagnosis safeguards remain.
- Recipe successor is expected at version `1.0.1`, in `content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split-v1.0.1/`, with the same pack/item/family/SKU lineage as `1.0.0`; it incorporates only the independently qualified replacement preview/gallery evidence.
- Pastel successor is expected at version `1.0.1`, in `content-packs/psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.1/`, with the same pack/item/family/SKU lineage as `1.0.0`; it incorporates only the independently qualified truthful matte-collage replacement preview.
- Leaf successor reservation is one atomic Formula/Recipe/Pastel batch. Formula may transition after its source/safety tests pass. Recipe and Pastel remain `reserved` with non-discoverable scaffolding until exact returned bytes, prompt/quote/authority evidence, provenance, and review all pass; only then are their versioned source trees created and their transitions serialized.
- Kit reservation is a later, separate CAS event. It may occur only after all three leaf successor receipts verify, Recipe/Pastel are authored and qualified, and the closure is final. Kit successor is expected at version `1.0.1`, in `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1/`, with this exact ordered closure: Formula `1.0.1`, Topic `1.0.0`, Recipe `1.0.1`, Pastel `1.0.1`, Impasto `1.0.0`, Oil `1.0.0`.
- Bundle-only Channel Kits require exactly one Formula, at least one Topic, one-or-more Styles, and exactly one Recipe. Preserve exact component/dependency equality, order, unique component references, unique item IDs, external-only components, exact dependency use, namespace, archive, and signature/delivery safeguards.
- Ordered Style semantics are structural: the first `visual-style` component is the active project default; the remaining exact Style components are installed and project-pinned alternatives. Persist every alternative's item owner and version, resolve that immutable installed version to its verified archive hash, and search these project pins before active discovery. Do not add `default_style_id`, copy Style documents into the Kit, or introduce a fifth creative schema.
- Pin-first is two-stage. An existing `content_pack_items` owner pin invokes exact pack/version/hash resolution; a missing, recalled, corrupt, owner-mismatched, version-mismatched, or hash-mismatched pinned archive is an error and never falls through. With no owner pin, retain current signed-catalog discovery: a qualified signed Formula, Topic, Style, or Recipe resolves to its active exact ref and the normal write creates that pin. Return `null` only when discovery finds no signed catalog entry, so legacy/local config/meta writes continue without a Content Pack pin. Preserve the existing conflict guard: changing a pinned pack version requires the explicit upgrade workflow.
- Install/restore/checkout behavior remains exact-closure and fail-closed. A Kit apply is an explicit project action, never an install side effect, and it never silently upgrades an existing project pin.
- Current application version is `1.4.31`. Multi-Style bundle-only archives must use the application release that first contains this support as their minimum version, expected `1.4.32`; a false `1.0.843` floor is forbidden because a `1.0.843` binary rejects this manifest. Formula `1.0.1`, whose schema is unchanged, may retain the truthful `1.0.843` floor.
- Mandatory application release integrity: bump `package.json` and `package-lock.json` together, add the newest-first matching `CHANGELOG.md` entry, and pass `npm run check:changelog`. If the branch version is no longer `1.4.31` at execution time, stop and recompute the next patch and Kit minimum before building.
- Keyless candidates use `genstudio-store-receipt-v1`, have no `key_id` or `signature.ed25519`, contain only strict JSON/permitted rasters, and remain at or below `52,428,800` bytes.
- For this unblock wave, `component_summary` v1 is absent from every newly authored successor source/manifest, registry request/record, archive, build/candidate record, and structured review record; among fresh artifacts it appears only in the final local `release-handoff.json`. Grandfather the already-audited entries in the untouched Wave 1 historical `evidence-ledger.json`; do not remove, relocate, reinterpret, or backfill them. Fresh-artifact scans exclude the entire Wave 1 historical evidence root and separately prove that ledger's hash is unchanged.
- Recipe and Pastel replacement generation remains Studio Hub/owner work. This control Mac may create reservation/expected-identity/test scaffolding that is not a discoverable Content Pack source, then checksum, decode, inspect, deterministically convert whole returned images, build, and validate after evidence returns. It may not copy replacement bytes into `1.0.0`, create incomplete `pack.json` source trees, generate, edit, submit, reserve capacity, spend, or infer missing prompt/quote/authority evidence.
- No upload, product/release draft, product/release/account/wire identity, price/discount decision, purchase, grant, production signing, publication, deploy, tag, push, or GenStudio commerce mutation is authorized.
- Oil remains independently candidate-ready. Do not deliver its receiver handoff until the evidence wording is reconciled and a fresh independent reviewer records a clean result.

## Architectural Finding: No New Default-Style Manifest Field

The current architecture supports the required semantics with one small application API, not a new manifest field:

1. `ContentPackBundleSchema.components` is ordered and already carries exact `pack_id`, `version`, `item_id`, and `kind` references.
2. `content-store-delivery.ts` binds signed receipt positions to manifest dependency positions, recursively installs every exact dependency, verifies the whole immutable closure, and activates it atomically.
3. `ProjectMeta` and config already represent one active `visual-style`; `content_pack_items` records item owner/kind and `content_pack_versions` records the exact owner version. Because same-version archive replacement is forbidden, resolving that owner/version from verified installed state supplies the immutable archive hash.
4. The registry already searches `options.pins` before active discovery, but the project selection writers currently call `resolveCatalogItem(..., undefined, options)` before loading an existing project pin. That gap would let a newer active Style win when selecting a Kit alternative. The existing unpinned call is still required: it discovers a newly selected signed catalog item and supplies the exact ref that the current write pins; a bare legacy ID returns no signed entry.
5. No production code currently consumes `manifest.bundles`; only schema/tests/publisher tooling do. Therefore the smallest missing application surface is one explicit project bundle-apply transaction plus one nullable two-stage item resolver. Bundle apply exact-pins all creative components (including alternative Styles), selects the first Style, and reports the later ordered Styles as alternatives. Subsequent selection first verifies an existing project pin; with no pin it performs current signed discovery and creates a pin on success, or returns to the unchanged legacy/local write path only on a catalog miss.

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
| `electron/server/content-packs/project-pins.ts` | Exact bundle application plus project-pin-first owner/version/hash item resolution |
| `electron/server/content-packs/runtime-types.ts` | Strict bundle-application request/result types only if route-local types cannot express the boundary cleanly |
| `electron/server/routes/content-packs.ts` | Explicit project bundle-apply endpoint; no Store purchase/install side effect |
| `electron/server/__tests__/content-pack-contract.test.ts` | Multi-Style manifest acceptance and retained negative safeguards |
| `scripts/content-packs/__tests__/publisher-tools.test.mjs` | Deterministic multi-Style bundle-only build/validate contract |
| `electron/server/__tests__/content-pack-project-pins.test.ts` | Default Style, exact alternative pins, newer-active isolation, fail-closed conflicts, new signed-item pinning, and unchanged legacy/local no-pin writes |
| `electron/server/__tests__/content-pack-installer.test.ts` | Exact dependency installation and minimum-app refusal |
| `electron/server/__tests__/content-pack-recovery.test.ts` | Multi-Style recovery/boot verification |
| `electron/server/__tests__/content-store-delivery-transaction.test.ts` | Receipt-position closure install/activation and failure rollback |
| `electron/server/__tests__/content-pack-routes.test.ts` | Bundle apply route validation and safe 409 responses |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | Application release containing multi-Style support |
| `content-packs/authoring-registry.json` | First serialized Formula/Recipe/Pastel reservation/transitions, then later Kit reservation/transition |
| `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/` | Immutable non-diagnostic Formula successor |
| `content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split-v1.0.1/` | Receipt-bound Recipe successor, created only after returned evidence qualifies |
| `content-packs/psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.1/` | Receipt-bound Pastel successor, created only after returned evidence qualifies |
| `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1/pack.json` | Immutable six-node bundle-only Kit successor |
| `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/source-scaffolds/` | Non-discoverable receipt-derived Recipe/Pastel source checklists; contains no `pack.json` or creative bytes |
| `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/` | Historical root excluded from fresh-summary scans; wording is reconciled in two named JSON files while `evidence-ledger.json` and its audited summaries remain byte-identical |
| `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/` | Fresh successor build evidence, blocked candidates, reviews, and final local-only receiver handoff |

---

### Task 1: Reconcile External Review Truth Before Any New Work

**Files:**
- Modify: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/candidate-handoffs.json`
- Modify: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/review-requests.json`
- Read and preserve byte-for-byte: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/evidence-ledger.json`
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

Do not change hashes, archive paths, identities, counts, review results, Formula/Kit blockers, or the Oil readiness result. Do not edit `evidence-ledger.json`: its existing audited `component_summary` entries are historical evidence, not violations by this successor wave.

- [ ] **Step 4: Run both portability lanes**

```bash
env -u STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT=/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23 \
  node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
```

Expected: no-env lane explicitly skips external assertions; explicit lane passes every assertion.

- [ ] **Step 5: Independent evidence review and commit**

Have a fresh reviewer compare both modified JSON files, `receiver-handoff.json`, the untouched `evidence-ledger.json`, final rereview, and test assertions. Record `passed` only if every status and prose field agrees and the evidence-ledger SHA-256 is identical before and after reconciliation. Do not send or copy the Oil receiver handoff.

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
- Consumes: ordered `ContentPackBundleSchema.components`, project item-owner/version pins, and exact verified installed `ContentPackVersionRef` values.
- Produces: nullable two-stage `resolveProjectPreferredSelection(project, selection, options)`, `applyProjectContentBundle(slug, request, options)`, and a strict POST route that atomically pins Formula, Topics, every Style, and Recipe while activating only the first Style. Existing pins resolve exact; unpinned signed catalog selections still resolve and create pins; only a signed-catalog miss returns `null` for the caller's legacy/local write.

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
- exact component pack versions/items, including every alternative Style, are pinned atomically;
- a missing, recalled, disabled, hash-mismatched, wrong-kind, duplicate, or conflicting-version component makes the whole operation fail with no config/project mutation;
- an existing pin at a different version yields a clear 409 and is never silently upgraded;
- bundle order, not name or current catalog default, determines the Style default.
- after applying the Kit, installing/activating Style `1.0.2` does not change an alternative pinned at `1.0.1`: selection resolves the pinned owner/version to its original verified SHA and keeps `1.0.1`;
- if pinned Style `1.0.1` becomes missing, recalled, corrupt, owner-mismatched, or hash-mismatched while `1.0.2` is active, selection fails with 409 and no project/config mutation; it never falls through to `1.0.2`.
- with no existing owner pin, newly selected signed Style, Formula, and Topic entries still resolve through active signed-catalog discovery, the current write persists their exact pack/version pins, and a later newer active version cannot change those pins;
- cover Recipe through the same unpinned signed-discovery regression because config Style and Recipe selections share `resolveSignedSelections`; assert kind validation and exact Recipe pin creation too;
- for each existing config, niche, and topic selection path, a bare legacy/local item ID with no owner pin and no signed catalog entry makes the resolver return `null`, the current config/meta value is still written, and neither `content_pack_items` nor `content_pack_versions` gains a pin;
- prove the `null` path is a confirmed signed-catalog miss rather than an early return: spy/stub evidence shows `resolveCatalogItem(selection.id, undefined, options)` ran once before the legacy/local write.

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
  style_refs: Array<{ item_id: string; ref: ContentPackVersionRef }>
  thumbnail_recipe_id: string
  content_pack_versions: Record<string, string>
}
```

- [ ] **Step 4: Implement the two-stage project-preferred item resolver**

Add one helper with this contract:

```ts
async function resolveProjectPreferredSelection(
  project: ProjectMeta,
  selection: { id: string; kind: ContentPackItemKind },
  options: ContentPackProjectPinOptions,
): Promise<SignedSelection | null>
```

Resolution order is exact:

1. inspect `project.content_pack_items[selection.id]` for a pinned owner;
2. if an owner pin exists, require its kind to match and read the owner's version from `project.content_pack_versions`; a pinned owner without a version is corrupt project state and fails 409;
3. for that pinned branch, resolve the exact pack/version from verified installed/recovery state to obtain `archive_sha256`, then call `resolveCatalogItem(selection.id, exactRef, { ...options, pins: [exactRef, ...(options.pins ?? [])] })`;
4. require the returned signed entry's owner, version, kind, and archive hash to equal the exact ref; if any pinned fact cannot verify, throw `ContentPackMissingError`/409 and never try active discovery;
5. if no owner pin exists, call the current `resolveCatalogItem(selection.id, undefined, options)` signed-catalog discovery;
6. when discovery returns an entry with `pack`, require its kind to match and return `{ id: selection.id, kind: selection.kind, ref: entry.pack }`, so the normal write creates the exact owner/version pin;
7. only when discovery returns no signed entry/pack, return `null` for the existing legacy/local branch.

Use this helper before the existing config, niche, and topic selection writes, including the shared config Style/Recipe path. Every non-null `SignedSelection` goes through current exact pack-pin behavior whether it came from the existing-pin branch or new signed discovery. A `null` result runs the current legacy/local branch unchanged: write the selected local ID/config metadata but add no pack owner/version pin. Do not use the nullable result to weaken bundle application: the explicit bundle path resolves exact manifest component refs from the verified installed closure and pins every component. Keep the existing different-version conflict check in `applyContentSelections` unchanged.

- [ ] **Step 5: Implement exact bundle resolution and one atomic project write**

Inside the content-pack coordination lock:

1. resolve `request.root` by pack/version/SHA;
2. require exactly one matching bundle-only manifest and `bundle_id`;
3. call `verifyInstalledContentPackClosure` on the root;
4. resolve every component's exact pack/version and confirm the item ID and kind exist;
5. derive `styles = components.filter(kind === 'visual-style')`, `default = styles[0]`, alternatives `styles.slice(1)`;
6. update config and project metadata consistently, persisting item-owner/version pins for every component including alternative Styles, but setting only the first Style active;
7. return each Style's exact `ContentPackVersionRef` (including archive SHA) in the reviewed result or evidence so later selection can prove it did not drift.

Use existing `applyContentSelections`/consistent project mutation primitives. Add no persisted `default_style_id`, no auto-upgrade, and no install/purchase side effect.

- [ ] **Step 6: Add strict route validation**

Add `POST /content-packs/projects/:slug/bundles/apply` with a body containing only `root` and `bundle_id`. Reject unknown keys, invalid slugs/IDs, non-bundle roots, absent projects, and pin conflicts with safe 400/404/409 responses. The endpoint performs no network, quote, purchase, or install.

- [ ] **Step 7: GREEN and focused review**

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

- **Channel Kits can include several exact Visual Styles.** The first listed Style is the default; the remaining exact project-pinned Styles stay available as alternatives even when newer versions are installed.
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

### Task 4: Atomically Reserve Formula, Recipe, and Pastel Successors

**Files:**
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/reservation-requests/formula-recipe-pastel-v1.0.1.json`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/{human-behavior-explained,editorial-psychology-symbolic-split,pastel-surreal-psychological-collage}-v1.0.1.json`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/source-scaffolds/{editorial-psychology-symbolic-split,pastel-surreal-psychological-collage}-v1.0.1.json`
- Modify: `electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
- Modify: `content-packs/authoring-registry.json`

**Interfaces:**
- Consumes: validated revision `16`/`74` or the newly observed serialized revision and immutable `1.0.0` lineage facts.
- Produces: one exact new receipt binding three leaf successor records; no Kit record and no authored Recipe/Pastel source.

- [ ] **Step 1: Pin `1.0.0` immutability before reservation**

Add source tests with exact current SHA-256 values for Recipe `1.0.0` `pack.json`, content JSON, every preview asset, provenance rows, and Pastel `1.0.0` `pack.json`, content JSON, preview asset, and provenance row. These hashes remain unchanged through every later task.

- [ ] **Step 2: Validate and write one three-record request**

```bash
npm run content-pack:registry -- validate
```

The request uses the reported revision and coordinator `{ "task": "symbolic-psychology-studio-unblock-leaf-successors", "branch": "codex/content-expansion-portfolio" }`. Its three exact proposed records are:

```json
[
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
  },
  {
    "pack_id": "com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split",
    "item_id": "com.storystudio.thumbnail.editorial-psychology-symbolic-split",
    "version": "1.0.1",
    "publisher_id": "com.storystudio",
    "min_app_version": "{{MIN_APP_VERSION}}",
    "min_app_version_status": "release-bound",
    "source_path": "content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split-v1.0.1",
    "kind": "thumbnail-recipe",
    "status": "reserved",
    "dependencies": [],
    "stocking_proposal": {
      "family": { "id": "com.storystudio.family.thumbnail.editorial-psychology-symbolic-split", "status": "proposed" },
      "sku": { "id": "com.storystudio.sku.thumbnail.editorial-psychology-symbolic-split", "status": "proposed" }
    }
  },
  {
    "pack_id": "com.storystudio.pack.style.pastel-surreal-psychological-collage",
    "item_id": "com.storystudio.style.pastel-surreal-psychological-collage",
    "version": "1.0.1",
    "publisher_id": "com.storystudio",
    "min_app_version": "{{MIN_APP_VERSION}}",
    "min_app_version_status": "release-bound",
    "source_path": "content-packs/psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.1",
    "kind": "visual-style",
    "status": "reserved",
    "dependencies": [],
    "stocking_proposal": {
      "family": { "id": "com.storystudio.family.style.pastel-surreal-psychological-collage", "status": "proposed" },
      "sku": { "id": "com.storystudio.sku.style.pastel-surreal-psychological-collage", "status": "proposed" }
    }
  }
]
```

- [ ] **Step 3: Reserve once and verify all three exact records**

Resolve the written batch only by coordinator task `symbolic-psychology-studio-unblock-leaf-successors`, then run `verify-receipt` separately for Formula, Recipe, and Pastel expected identities. If any verification fails, create no successor source and reserve no Kit.

- [ ] **Step 4: Create non-discoverable source scaffolds**

Each SDD scaffold records the verified receipt/ref, exact future source path, immutable predecessor hashes, required returned-evidence fields, exact preview acceptance contract, and the rule `registry_transition_allowed: false`. It contains no `pack.json`, asset, future hash, invented prompt/quote, or creative bytes, and therefore cannot be discovered as authored source.

- [ ] **Step 5: Validate and commit reservation evidence**

```bash
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
git add content-packs/authoring-registry.json \
  electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/reservation-requests \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities \
  .superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/source-scaffolds
git commit -m "chore(content-packs): reserve symbolic leaf successors"
```

Review must confirm Recipe/Pastel remain `reserved`, their versioned `content-packs/...-v1.0.1` directories do not exist, and Kit `1.0.1` is not reserved.

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

### Task 6: Qualify and Author Recipe and Pastel Successors

**Files:**
- Consume: `/build/Developer/_handoffs/2026-08-23_symbolic-psychology-recipe-preview-draft-prompt-batch.json`
- Consume: `/build/Developer/_handoffs/2026-08-23_to-gpt-studiofleet_from-gpt-storystudio_symbolic-psychology-{recipe,pastel}-preview-replacement.md`
- Create only after complete returned evidence: `content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split-v1.0.1/{pack.json,content/thumbnail-recipe.json,assets/...}`
- Create only after complete returned evidence: `content-packs/psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.1/{pack.json,content/visual-style.json,assets/...}`
- Modify: `content-packs/psychology-editorial/PREVIEW-PROVENANCE.md` by adding successor rows; never edit/remove `1.0.0` rows
- Modify: applicable source/evidence tests and `content-packs/authoring-registry.json`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/promotions/{editorial-psychology-symbolic-split,pastel-surreal-psychological-collage}-v1.0.1.json`
- Modify: fresh external build evidence and blocked-candidate inventory

**Interfaces:**
- Consumes: verified Recipe/Pastel successor receipts plus untouched returned rasters, exact prompt batch/hash, quote, owner approval, job/request ID, published provider/model, timestamp, seed if published, cost receipt, rights, no-reference declaration, SHA, dimensions, type, bytes, decode result.
- Produces: authored Recipe/Pastel `1.0.1` source/candidates and serialized transitions only if all evidence and reviews pass; `1.0.0` remains byte-identical.

- [ ] **Step 1: Stop unless authority is complete**

Recipe requires owner approval of exact draft batch SHA `ceb4cee15331105d657ef5a7aea66a4e2e87877f32c5efe0a8022b48732c3c3b` and the exact returned quote before Studio Hub execution. Pastel requires a literal prompt batch and its hash, exact quote, and explicit owner job authority; the current capability-only request is insufficient. If any record is absent, leave both registry records `reserved`, leave the versioned source directories absent, mark Task 6 blocked, and reserve no Kit.

- [ ] **Step 2: Verify returned evidence before touching source**

Hash the untouched raster and compare it to the returned receipt; decode with `sharp(..., { failOn: 'error' })`; confirm type/dimensions/bytes; match job ID, submitted prompt/hash, authority, quote/cost, provider/model, rights, timestamp, seed, and no-reference/no-compositing declarations. Reject any mismatch, malformed text, clipped headline, copied/rejected preview #4 bytes, wrong medium, logo/watermark/UI, or missing provenance.

- [ ] **Step 3: Apply only a deterministic whole-image conversion**

If returned bytes are already a qualifying `1672x941` WebP, byte-copy them. Otherwise use `sharp` for a full-frame deterministic resize/crop to `1672x941` and WebP encoding with fixed options recorded verbatim in provenance. No masking, inpainting, text overlay, compositing, selective edit, or reference-image repair is permitted.

- [ ] **Step 4: Write successor RED tests and author only versioned sources**

First assert every pinned Recipe/Pastel `1.0.0` hash still matches. Then require missing `1.0.1` sources. Create the versioned sources from their verified receipt identities and unchanged creative JSON semantics, adding only qualified successor preview paths/evidence and manifest version/changelog. Recipe must prove exact one-line `HIDDEN MOTIVES`, far-right three-quarter-profile medium-long subject, and material gallery diversity. Pastel must prove matte mixed-media collage with the approved low-saturation palette and no heavy/wet impasto. Add new provenance rows with original/converted hashes, dimensions, bytes, transform, rights, and receipt; do not rewrite `1.0.0` rows.

- [ ] **Step 5: Build each successor twice and review independently**

Use keyless profile/minimum `1.0.843`, validate twice, compare bytes/SHA, then obtain fresh schema, originality/provenance, compatibility, prompt-equivalence, visual, safety/copy, and Recipe thumbnail reviews. A reviewer must inspect decoded pixels. Keep failed candidates under blocked quarantine, leave registry status `reserved`, leave active archive identities null, and reserve no Kit.

- [ ] **Step 6: Serialize authored transitions only after clean reviews**

Transition Recipe first and Pastel second, each using the current revision returned by the preceding operation and the exact shared leaf-successor receipt. Re-run all three leaf receipt verifications and registry validation after each transition. If either transition/review fails, Kit reservation remains forbidden.

- [ ] **Step 7: Commit immutable successor sources**

Commit only versioned `1.0.1` source, appended provenance, tests, transitions, and review reports; never commit external receipts containing secrets. Assert Recipe/Pastel `1.0.0` hashes again. No Kit or receiver handoff is assembled yet.

---

### Task 7: Reserve, Author, and Build the Immutable Kit Successor

**Files:**
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/reservation-requests/symbolic-psychology-studio-v1.0.1.json`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/symbolic-psychology-studio-v1.0.1.json`
- Create: `content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1/pack.json`
- Create: `.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/promotions/symbolic-psychology-studio-v1.0.1.json`
- Modify: source/registry tests and `content-packs/authoring-registry.json`
- Create: `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/{build-evidence,blocked-candidates}/`

**Interfaces:**
- Consumes: authored/receipt-verified Formula, Recipe, and Pastel `1.0.1`; Topic, Impasto, Oil `1.0.0`; Task 2 support; Task 3 app version.
- Produces: a separately receipt-bound exact Kit `1.0.1`, two equal keyless builds, and a blocked local candidate—not a stocking handoff.

- [ ] **Step 1: Prove the closure is final before reservation**

Validate the registry. Verify Formula, Recipe, and Pastel successor receipts again; require all three `status: authored`; require every source/review/candidate gate clean; require immutable Topic/Impasto/Oil records; and assert no Kit `1.0.1` record exists yet. The exact closure is:

```json
[
  { "pack_id": "com.storystudio.pack.formula.human-behavior-explained", "version": "1.0.1" },
  { "pack_id": "com.storystudio.pack.topic.human-behavior-social-dynamics", "version": "1.0.0" },
  { "pack_id": "com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split", "version": "1.0.1" },
  { "pack_id": "com.storystudio.pack.style.pastel-surreal-psychological-collage", "version": "1.0.1" },
  { "pack_id": "com.storystudio.pack.style.impasto-psychological-animals", "version": "1.0.0" },
  { "pack_id": "com.storystudio.pack.style.oil-painting-classical", "version": "1.0.0" }
]
```

- [ ] **Step 2: Reserve Kit in one later CAS event and verify its receipt**

Use coordinator `{ "task": "symbolic-psychology-studio-unblock-kit-successor", "branch": "codex/content-expansion-portfolio" }`, the current revision, and this exact proposed record (with the six dependencies copied from Step 1 in that order):

```json
{
  "pack_id": "com.storystudio.pack.kit.symbolic-psychology-studio",
  "bundle_id": "com.storystudio.bundle.symbolic-psychology-studio",
  "version": "1.0.1",
  "publisher_id": "com.storystudio",
  "min_app_version": "{{MIN_APP_VERSION}}",
  "min_app_version_status": "release-bound",
  "kind": "channel-kit",
  "source_path": "content-packs/symbolic-psychology-studio/kit/symbolic-psychology-studio-v1.0.1",
  "status": "reserved",
  "dependencies": [
    { "pack_id": "com.storystudio.pack.formula.human-behavior-explained", "version": "1.0.1" },
    { "pack_id": "com.storystudio.pack.topic.human-behavior-social-dynamics", "version": "1.0.0" },
    { "pack_id": "com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split", "version": "1.0.1" },
    { "pack_id": "com.storystudio.pack.style.pastel-surreal-psychological-collage", "version": "1.0.1" },
    { "pack_id": "com.storystudio.pack.style.impasto-psychological-animals", "version": "1.0.0" },
    { "pack_id": "com.storystudio.pack.style.oil-painting-classical", "version": "1.0.0" }
  ],
  "stocking_proposal": {
    "family": { "id": "com.storystudio.family.kit.symbolic-psychology-studio", "status": "proposed" },
    "sku": { "id": "com.storystudio.sku.kit.symbolic-psychology-studio", "status": "proposed" }
  }
}
```

Run one reserve call, copy the exact record minus receipt into expected identity, and verify it against this separate receipt. Do not reuse the leaf receipt.

- [ ] **Step 3: Write RED successor/immutability tests**

Pin existing Kit `1.0.0` SHA/closure. Require `1.0.1` root entries `['pack.json']`, exact ordered dependencies/components, Formula/Recipe/Pastel `1.0.1`, remaining nodes `1.0.0`, Pastel first among Styles, dependency/component pair equality, and no `component_summary` in any newly authored successor source or registry record. Do not inspect the grandfathered Wave 1 evidence root as though it were new successor output.

- [ ] **Step 4: Author from the exact Kit receipt and transition once**

Create only `pack.json` with stable Kit lineage, version `1.0.1`, changelog `Uses qualified Formula, Recipe, and Pastel successors while preserving three ordered compatible visual styles.`, exact closure, and tokenized key/minimum fields. After tests pass, transition only Kit from reserved to authored using its own receipt/current revision; re-verify receipt and registry.

- [ ] **Step 5: Build all four successors twice with truthful floors**

Build Formula, Recipe, and Pastel `1.0.1` twice under keyless profile/minimum `1.0.843`. Build Kit `1.0.1` twice under keyless profile/minimum `1.4.32` (or the recomputed Task 3 release). Validate each build, assert pairwise byte/SHA equality, inspect entries/permissions, and prove absence of key/signature/executable/URL/credential/provider/model/price/wire fields.

- [ ] **Step 6: Retain blocked local candidates and commit**

Retain reviewed leaf candidates and one Kit candidate under the fresh external root. Kit remains blocked by application release not deployed and final independent closure review. Commit Kit reservation/source/transition, tests, and SDD reports; record external hashes but do not commit archives.

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

Also re-run the opt-in Wave 1 external evidence audit and validate every retained candidate by exact profile/hash. The audit may read the historical root, but the fresh `component_summary` prohibition scan must exclude exactly `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/`.

- [ ] **Step 2: Independent whole-wave review**

Require clean schema, identity/receipt, immutability, dependency/order, install/recovery/application, safety, originality/provenance, prompt-equivalence, visual/thumbnail, copy, component-summary, security, model-drift, and commercial-boundary results. Reviewers must confirm no historical `1.0.0` source/archive/closure was rewritten, the grandfathered Wave 1 `evidence-ledger.json` hash did not change, and no commerce code/mutation occurred.

- [ ] **Step 3: Write fresh `component_summary` only in the new release handoff**

Formula successor:

```json
{
  "schema_version": 1,
  "kind": "series-formula",
  "summary": "Evidence-aware, non-diagnostic explanations of recognizable human behavior.",
  "slots": { "series-formula": 1 }
}
```

Recipe successor:

```json
{
  "schema_version": 1,
  "kind": "thumbnail-recipe",
  "summary": "Sparse symbolic-psychology thumbnail composition with one concise AI-rendered title.",
  "slots": { "thumbnail-recipe": 1 }
}
```

Pastel successor:

```json
{
  "schema_version": 1,
  "kind": "visual-style",
  "summary": "Matte mixed-media psychological collage with restrained, low-saturation figure-ground contrast.",
  "slots": { "visual-style": 1 }
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

Run a semantic recursive JSON-key scan, not a raw text search, over all newly authored successor source directories, successor reservation/expected-identity/promotion records, the four new registry records, fresh archive/build/candidate records, structured fresh review records, and `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-unblock-2026-08-23/`. Exclude the entire historical Wave 1 evidence root named in Step 1. Require exactly the four `component_summary` keys above, all under the new `release-handoff.json`, and zero in every other fresh JSON/artifact. Markdown reviewers may discuss the field name but may not embed a structured summary object. Separately re-hash the excluded Wave 1 `evidence-ledger.json` and require its audited historical summary entries to remain byte-identical.

- [ ] **Step 4: Assemble but do not deliver the receiver handoff**

The local handoff may list Oil as candidate-ready and the successor Kit as technically validated only if every review passes. Overall status remains blocked until all of these are true:

1. Recipe `1.0.1` replacement qualified, receipt-verified, authored, and reviewed without changing Recipe `1.0.0` bytes;
2. Pastel `1.0.1` replacement qualified, receipt-verified, authored, and reviewed without changing Pastel `1.0.0` bytes;
3. Formula, Recipe, Pastel, and Kit `1.0.1` receipts, versioned sources, deterministic candidates, exact hashes, and independent reviews all agree;
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

**Spec coverage:** External review truth is reconciled first; Oil readiness is preserved without receiver delivery; publisher/application/install/recovery/checkout compatibility is TDD-covered; ordered Style default semantics and two-stage project-preferred resolution use current structures, preserving both new unpinned signed-item pinning and legacy/local catalog-miss no-pin behavior; Formula, Recipe, Pastel, and Kit successors are receipt-bound and immutable; every corresponding `1.0.0` source/hash/closure remains unchanged; candidates are deterministic/keyless; Recipe/Pastel stay owner/Studio Hub gated until exact returned evidence passes review; final handoff is local-only and stocking remains blocked.

**Identity consistency:** Stable pack/item/bundle/family/SKU lineages are reused only as proposed reservation inputs until a new receipt verifies. Formula, Recipe, Pastel, and Kit successors use distinct versioned source paths and exact `1.0.1` records; Recipe/Pastel source authoring waits for returned evidence, and Kit reservation waits for all three leaf receipts plus final qualification. The Kit closure is exactly Formula `1.0.1`, Topic `1.0.0`, Recipe `1.0.1`, Pastel `1.0.1`, Impasto `1.0.0`, Oil `1.0.0`, in that order.

**Type consistency:** Bundle application consumes `ProjectContentBundleApplicationRequest` and returns `ProjectContentBundleApplicationResult`; first Style is `default_style_id`, later Styles are `alternative_style_ids`, and `style_refs` carries their exact installed owner/version/hash references for verification. `resolveProjectPreferredSelection` returns `Promise<SignedSelection | null>`: an existing owner pin resolves exact and fails closed on missing, recalled, corrupt, owner/version/hash mismatch; without a pin it performs current signed discovery, returns `SignedSelection` for exact Formula/Topic/Style/Recipe pinning, and returns `null` only on catalog miss so the legacy/local config/meta write adds no pack metadata. The existing different-version conflict guard remains; no manifest `default_style_id` or fifth creative kind exists.

**Summary-scope consistency:** Newly authored Formula, Recipe, Pastel, and Kit source/registry/archive/build/review artifacts contain no `component_summary`; the four fresh summaries exist only in the new release handoff. The historical Wave 1 root is excluded from that fresh scan, and its already-audited `evidence-ledger.json` summaries are explicitly grandfathered and hash-preserved rather than deleted or backfilled.

**Minimum-version consistency:** Schema-compatible Formula, Recipe, and Pastel successors may use their truthful existing `1.0.843` floor; Kit uses the application release that introduces multi-Style acceptance, expected `1.4.32`. Older binaries receive a tested update-required refusal before activation. A local version bump is not treated as deployment evidence.

**Placeholder scan:** Future receipt values and returned preview hashes are never guessed; steps consume exact CLI/Studio Hub outputs and stop if they are absent or inconsistent. No unresolved value is represented as an identity or pass.

**Mutation boundary:** No production generation, upload, product/release draft, pricing, purchase, grant, signing, publication, deploy, tag, push, or GenStudio mutation is included.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-08-23-symbolic-psychology-studio-unblock.md`. Execute with fresh task workers and two-stage reviews; stop in Task 6 with Recipe/Pastel still `reserved`, their successor source directories absent, and Kit unreserved if exact owner prompt/quote/job authority, returned bytes, or clean review evidence is absent.
