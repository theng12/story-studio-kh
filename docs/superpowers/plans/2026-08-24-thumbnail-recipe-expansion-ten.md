# Ten-Recipe Thumbnail Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify ten independently reusable Story Studio Thumbnail Recipe Content Packs, each with three original preview choices, deterministic candidate archives, and a local stock-ready handoff.

**Architecture:** Reserve all ten Story identities atomically, then author one immutable thirty-image Studio Hub prompt batch. After a separately quoted and owner-authorized fleet return, qualify the recipes in five disjoint two-recipe source tasks, serialize registry transitions, build deterministic keyless candidates, and stage an evidence-backed local handoff. The current application schema and Store runtime remain unchanged.

**Tech Stack:** JSON Content Pack schemas, registry compare-and-swap receipts, Node.js `node:test`, TypeScript/TSX tests, Sharp WebP decoding, deterministic `.sspack` builder/validator, and the existing hardened external-staging helper.

**Spec:** `docs/superpowers/specs/2026-08-24-thumbnail-recipe-expansion-ten-design.md`

## Global Constraints

- Scope is exactly ten standalone `thumbnail-recipe` components; create no Formula, Topic Pack, Visual Style, Channel Kit, schema kind, application UI, or runtime behavior.
- Use one atomic ten-record registry reservation. Proposal fields become authoritative only after the persisted receipt verifies each exact record.
- Every recipe uses `version: "1.0.0"`, `kind: "thumbnail-recipe"`, `publisher_id: "com.storystudio"`, `min_app_version: "{{MIN_APP_VERSION}}"`, `min_app_version_status: "release-bound"`, `status: "reserved"`, and `dependencies: []` at reservation.
- Each recipe uses the current strict schema with `aspect_ratio: "16:9"`, `title_mode: "ai"`, `headline_mode: "episode-title"`, a complete in-image headline, and no post-render overlay/compositing path.
- Each recipe requires exactly three original `1672x941` WebP previews with exact line counts 1, 2, and 3 plus material diversity across subject, side/angle/distance, setting, and palette/symbol.
- Preview examples are gallery choices/range evidence. Do not create an A/B-testing feature, analytics state, automatic winner, or sub-recipe schema.
- No source is authored before its receipt verifies and all three returned preview rows pass provenance, rights, decode, exact-title, line-count, originality, and visual review.
- Preview generation runs only through Studio Hub on a named fleet worker after an exact quote and separate owner approval of the batch hash, quote, maximum spend, and job authority. This Mac never generates.
- Candidate profile is keyless `genstudio-store-receipt-v1`; no archive `key_id`, no `signature.ed25519`, no private key, and maximum size `52_428_800` bytes.
- Component products remain draft/non-purchasable. Customer reachability requires a separate later active Channel Kit successor that pins an exact recipe release.
- `component_summary` exists only in the final release/receiver/stocking handoff entry. Its `summary` is the exact recipe-specific string in the Exact Component Summary Matrix; the other fields are always `{"schema_version":1,"kind":"thumbnail-recipe","slots":{"thumbnail-recipe":1}}`. It never enters registry/source/provenance/archive/build JSON.
- Preserve package versions, changelog, application/runtime/checkout code, existing Content Pack sources, historical registry records, existing archives, GenStudio state, and all customer data.
- No upload, publication, component activation, Kit mutation, price/discount change, purchase/grant/charge/refund, deploy, tag, or push is included.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `docs/superpowers/specs/2026-08-24-thumbnail-recipe-expansion-ten-design.md` | Approved composition contracts and thirty exact preview briefs. |
| `content-packs/authoring-registry.json` | One ten-record reservation receipt and later status-only transitions. |
| `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-{request,result}.json` | Ignored coordinator request/result working evidence. |
| `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/expected-identities/*.json` | Ignored exact receipt-verification inputs. |
| `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/preview-batch.json` | Ignored immutable thirty-job prompt batch after receipt verification. |
| `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/returned-evidence.json` | Ignored Studio Hub return ledger; contains no secrets and is absent before authorized execution. |
| `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/` | Independent per-recipe spec and quality/visual reviews. |
| The ten exact source paths in the Exact Reservation Proposal Matrix, each ending in `pack.json` | Receipt-bound source manifests. |
| Each exact source path plus `content/thumbnail-recipe.json` | Reusable composition grammars. |
| Each exact source path plus `assets/`, containing files named from that row's slug with suffixes `-1.webp`, `-2.webp`, and `-3.webp` | Three qualified preview choices per recipe. |
| `content-packs/thumbnail-recipe-expansion-ten/PREVIEW-PROVENANCE.md` | Immutable row-level preview provenance, rights, hashes, sizes, dimensions, transforms, and receipts. |
| `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts` | Receipt/source/schema/distinctness/title/provenance/runtime-adapter tests. |
| `scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs` | Deterministic candidate, validation, profile, size, summary-scope, and partial-qualification tests. |
| `/build/Developer/_handoffs/2026-08-24_to-gpt-studiofleet_from-gpt-storystudio_thumbnail-expansion-ten-preview-quote.md` | Quote-only Studio Hub handoff created after the batch hash exists. |
| `/build/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24/` | Fresh external candidate archives, ledger, release handoff, and blocked rows. |
| `/build/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json` | Local receiver handoff, created only after staging completes; it grants no mutation authority. |

## Exact Reservation Proposal Matrix

All rows use version `1.0.0`, publisher `com.storystudio`, release-bound minimum token, kind `thumbnail-recipe`, status `reserved`, and empty dependencies.

| Slug | Proposed pack ID | Proposed item ID | Proposed family | Proposed SKU | Source path |
| --- | --- | --- | --- | --- | --- |
| `before-after-proof-panel` | `com.storystudio.pack.thumbnail.before-after-proof-panel` | `com.storystudio.thumbnail.before-after-proof-panel` | `com.storystudio.family.thumbnail.before-after-proof-panel` | `com.storystudio.sku.thumbnail.before-after-proof-panel` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel` |
| `two-option-criteria-split` | `com.storystudio.pack.thumbnail.two-option-criteria-split` | `com.storystudio.thumbnail.two-option-criteria-split` | `com.storystudio.family.thumbnail.two-option-criteria-split` | `com.storystudio.sku.thumbnail.two-option-criteria-split` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/two-option-criteria-split` |
| `reaction-evidence-inset` | `com.storystudio.pack.thumbnail.reaction-evidence-inset` | `com.storystudio.thumbnail.reaction-evidence-inset` | `com.storystudio.family.thumbnail.reaction-evidence-inset` | `com.storystudio.sku.thumbnail.reaction-evidence-inset` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/reaction-evidence-inset` |
| `cutaway-exploded-object` | `com.storystudio.pack.thumbnail.cutaway-exploded-object` | `com.storystudio.thumbnail.cutaway-exploded-object` | `com.storystudio.family.thumbnail.cutaway-exploded-object` | `com.storystudio.sku.thumbnail.cutaway-exploded-object` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/cutaway-exploded-object` |
| `hero-payoff-companion` | `com.storystudio.pack.thumbnail.hero-payoff-companion` | `com.storystudio.thumbnail.hero-payoff-companion` | `com.storystudio.family.thumbnail.hero-payoff-companion` | `com.storystudio.sku.thumbnail.hero-payoff-companion` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hero-payoff-companion` |
| `iconic-result-closeup` | `com.storystudio.pack.thumbnail.iconic-result-closeup` | `com.storystudio.thumbnail.iconic-result-closeup` | `com.storystudio.family.thumbnail.iconic-result-closeup` | `com.storystudio.sku.thumbnail.iconic-result-closeup` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/iconic-result-closeup` |
| `scale-journey` | `com.storystudio.pack.thumbnail.scale-journey` | `com.storystudio.thumbnail.scale-journey` | `com.storystudio.family.thumbnail.scale-journey` | `com.storystudio.sku.thumbnail.scale-journey` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/scale-journey` |
| `numbered-lineup` | `com.storystudio.pack.thumbnail.numbered-lineup` | `com.storystudio.thumbnail.numbered-lineup` | `com.storystudio.family.thumbnail.numbered-lineup` | `com.storystudio.sku.thumbnail.numbered-lineup` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/numbered-lineup` |
| `macro-mystery-detail` | `com.storystudio.pack.thumbnail.macro-mystery-detail` | `com.storystudio.thumbnail.macro-mystery-detail` | `com.storystudio.family.thumbnail.macro-mystery-detail` | `com.storystudio.sku.thumbnail.macro-mystery-detail` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/macro-mystery-detail` |
| `hands-on-pov-moment` | `com.storystudio.pack.thumbnail.hands-on-pov-moment` | `com.storystudio.thumbnail.hands-on-pov-moment` | `com.storystudio.family.thumbnail.hands-on-pov-moment` | `com.storystudio.sku.thumbnail.hands-on-pov-moment` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hands-on-pov-moment` |

## Exact Component Summary Matrix

These strings are literal handoff metadata. They do not enter registry, source, provenance, archive, or build JSON.

| Slug | Exact `component_summary.summary` |
| --- | --- |
| `before-after-proof-panel` | `Matched before-and-after states show one subject changing across a truthful temporal seam.` |
| `two-option-criteria-split` | `Two present-time alternatives receive equal visual weight for an honest criteria-based comparison.` |
| `reaction-evidence-inset` | `A reaction subject directs attention to one original in-scene evidence detail.` |
| `cutaway-exploded-object` | `One object opens into an ordered, readable view of its meaningful internal layers.` |
| `hero-payoff-companion` | `A generic hero visibly interacts with a separate, tangible result object.` |
| `iconic-result-closeup` | `One truthful finished outcome dominates the frame at a detail-revealing angle.` |
| `scale-journey` | `Three related forms progress through continuous depth to communicate scale or magnitude.` |
| `numbered-lineup` | `Three to five equal-status entries form a precise lineup with matching native numerals.` |
| `macro-mystery-detail` | `An extreme close detail creates bounded curiosity while a small honest clue preserves context.` |
| `hands-on-pov-moment` | `First-person or over-shoulder hands perform one clear, safe action in task context.` |

### Task 1: Atomically Reserve and Verify All Ten Identities

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Modify: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-request.json`
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-result.json`
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/expected-identities/*.json`

**Interfaces:**
- Consumes: the exact ten-row proposal matrix and the immediately current valid registry revision.
- Produces: one returned `{ revision, receipt_ref }`, ten persisted `reserved` records sharing that receipt, and ten successful exact receipt verifications.

- [ ] **Step 1: Establish the reservation baseline**

Run:

```bash
git status --short --branch
npm run content-pack:registry -- validate
test ! -e content-packs/authoring-registry.json.lock
```

Expected: clean worktree; valid registry; no lock. Search all current records for collisions in pack ID, item ID, source path, family, and SKU. Any collision stops the complete batch; do not rename automatically.

- [ ] **Step 2: Write the exact request against the live revision**

Create the ignored request as a complete JSON object. Set `expected_revision` to the numeric revision returned by the immediately preceding validation; set coordinator task to `thumbnail-recipe-expansion-ten`; set coordinator branch to `codex/content-expansion-portfolio`; set `proposal_ref` to `docs/superpowers/specs/2026-08-24-thumbnail-recipe-expansion-ten-design.md`; and materialize exactly the ten rows from the Exact Reservation Proposal Matrix with every fixed field from Global Constraints. Before calling reserve, parse the file and assert that `records.length === 10`, all ten slugs are unique, and no required value is empty.

- [ ] **Step 3: Submit once and verify every receipt identity**

Run:

```bash
npm run content-pack:registry -- reserve \
  --request .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-request.json \
  > .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-result.json
```

Select the ten records carrying the returned receipt, remove only `receipt_ref`, write one expected-identity JSON per slug, and invoke `verify-receipt` separately for all ten. A stale-CAS, lock, mismatch, unexpected eleventh record, or missing row is a hard stop; reconstruct the entire request from current state rather than reserving subsets.

- [ ] **Step 4: Add durable reservation assertions**

Extend the registry test to assert exactly ten fixed source paths share one receipt and batch revision, every proposal field matches the matrix, all statuses are `reserved`, all dependencies are `[]`, and every family/SKU state is `proposed`. The test reads only committed registry data, not ignored SDD files.

- [ ] **Step 5: Verify and commit**

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npm run content-pack:registry -- validate
git diff --check
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/authoring-registry.test.mjs
git commit -m "chore(content-packs): reserve ten thumbnail recipes"
```

### Task 2: Author the Immutable Thirty-Preview Prompt Batch

**Files:**
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/preview-batch.json`
- Create: `/build/Developer/_handoffs/2026-08-24_to-gpt-studiofleet_from-gpt-storystudio_thumbnail-expansion-ten-preview-quote.md`

**Interfaces:**
- Consumes: ten verified receipt records and the exact thirty preview rows in Spec section 5.
- Produces: one hash-addressed text-only/no-reference-image batch and one quote-only Studio Hub handoff. It produces no request/job or raster.

- [ ] **Step 1: Materialize exact target paths and batch authority**

Create one JSON object with `batch_format: "story-studio-preview-draft-prompt-batch-v1"`, `status: "draft-owner-approval-required"`, the exact reservation revision/receipt, and exactly thirty jobs in fixed recipe order. Each job includes:

```json
{
  "draft_job_id": "before-after-proof-panel-01",
  "pack_id": "com.storystudio.pack.thumbnail.before-after-proof-panel",
  "version": "1.0.0",
  "target_source_asset": "content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel/assets/before-after-proof-panel-1.webp",
  "aspect_ratio": "16:9",
  "target_dimensions": { "width": 1672, "height": 941, "unit": "px" },
  "reference_images": [],
  "headline": "FROM SEED TO SPROUT",
  "headline_line_count": 1,
  "prompt": "Create one completely original 1672x941 16:9 full-frame thumbnail render using the approved Before/After Proof Panel grammar and the exact Spec 5.1 preview-one visual brief. Render the exact complete headline FROM SEED TO SPROUT on one unbroken line inside the one reserved title-safe band. The headline must be native to the image, never a post-render overlay or title plate.",
  "negative_prompt": "No extra words, malformed or clipped text, fabricated measurement, false causality, unrelated subject, generic left-right title split, logo, trademark, creator likeness, UI, watermark, reference image, masking, compositing, or post-render typography."
}
```

Write the remaining 29 jobs by substituting the exact approved slug, asset index, headline text, required line count, defining grammar, preview brief, and exclusions from Spec sections 5.1–5.10. Every prompt must say `completely original`, `full-frame`, `exact complete headline`, `native to the image`, and `no post-render overlay or title plate`.

- [ ] **Step 2: Validate batch cardinality and semantic uniqueness**

Run a Node validation script that parses the batch and asserts:

```js
assert.equal(batch.jobs.length, 30)
assert.equal(new Set(batch.jobs.map(job => job.draft_job_id)).size, 30)
assert.equal(new Set(batch.jobs.map(job => job.target_source_asset)).size, 30)
for (const slug of approvedSlugs) {
  const jobs = batch.jobs.filter(job => job.draft_job_id.startsWith(`${slug}-`))
  assert.deepEqual(jobs.map(job => job.headline_line_count), [1, 2, 3])
  assert.ok(jobs.every(job => job.reference_images.length === 0))
}
```

Also reject creator/channel names, logos, trademarks, provider/model/route values, quote/cost values, and any authority flag set true.

- [ ] **Step 3: Hash the batch and write the quote-only handoff**

Record exact SHA-256 and bytes. The handoff requests receiver/controller, published provider/model or unavailable, count 30, exact unit credit cost, exact maximum credit/currency spend including overhead, text-only/no-reference capability, exact `1672x941` WebP capability, rights basis, and capacity. It explicitly prohibits queue, generation, job creation, worker selection, spend, repository change, stocking, upload, publication, deploy, tag, or push.

- [ ] **Step 4: Verify no execution occurred**

Assert batch authority is exactly:

```json
{
  "prompt_approved": false,
  "quote_approved": false,
  "job_submission_authorized": false,
  "generation_authorized": false
}
```

The repository remains clean because SDD working files are ignored and the handoff is external.

### Task 3: Stop for Exact Quote and Owner Job Authority

**Files:**
- Consume: Studio Hub quote response matching the exact batch SHA-256.
- Modify only after approval: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/preview-batch.json` authority evidence or a separate immutable approval record.

**Interfaces:**
- Consumes: exact capability/quote response.
- Produces: either a blocked record or an owner-approved execution authority naming the batch hash, route/model/provider, count, maximum spend, and quote reference.

- [ ] **Step 1: Verify the quote without inference**

Require exact batch hash, receiver/controller, provider, model, count `30`, unit cost, maximum cost, currency cost, rights basis, capability, and capacity. `unavailable` is a valid returned value and blocks execution; it is not replaced with a guessed route.

- [ ] **Step 2: Present one smallest owner decision**

Recommend approve or reject based on exact total, rights, and capability. Do not split or submit jobs before the owner names the exact quote and maximum spend.

- [ ] **Step 3: Stop unless authority is explicit**

Without explicit authority, finish the current batch as blocked with all ten registry records still reserved, no source roots, no raster bytes, no job IDs, and no Kit reservation.

### Task 4: Intake and Qualify Returned Preview Evidence

**Files:**
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/returned-evidence.json`
- Create: `content-packs/thumbnail-recipe-expansion-ten/PREVIEW-PROVENANCE.md`
- Create: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: thirty untouched returned rasters and complete job/provenance/cost/rightsholder evidence from the separately authorized batch.
- Produces: a fixed accepted/quarantined inventory and RED source expectations for eligible recipes.

- [ ] **Step 1: Verify the execution envelope**

Hash-match the original batch and approval, then require every return row to contain job/request ID, named worker, submitted prompt and hash, provider/model, timestamp, seed or explicit unavailable, cost receipt, published rights basis, no-reference/no-compositing attestation, returned-byte SHA-256, bytes, type, dimensions, decode result, exact-title transcription, and line count.

- [ ] **Step 2: Decode and review every untouched raster**

Use Sharp with `failOn: 'error'`; require WebP `1672x941`, byte count greater than `20_000`, exact title and line count, one title-safe area, recipe invariant, and material within-recipe diversity. Reject malformed anatomy, bad numerals, false claims, pasted-looking inset/title, logo, watermark, UI, creator likeness, copied trade dress, or near duplicate.

- [ ] **Step 3: Create a fail-closed inventory**

For each slug set status `eligible` only when all three rows pass. A single failed row makes that recipe `blocked`; preserve rejected bytes under an external quarantine path and do not create its source directory. Record exact reasons, hashes, and recoverability.

- [ ] **Step 4: Write provenance and RED source tests**

Write one immutable provenance row per accepted raster. The test pins the accepted hashes, dimensions, bytes, title text, line count, prompt hash, rights basis, and receipt. Add one source test per eligible slug that fails because its receipt-authorized source does not yet exist; blocked slugs assert source absence and reserved registry status.

- [ ] **Step 5: Commit only durable intake tests/provenance**

```bash
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

Expected: RED only for eligible missing source paths. Do not commit a globally failing test; continue immediately through Tasks 5–9 and commit each GREEN pair with its tests/provenance rows.

### Task 5: Author Before/After Proof Panel and Two-Option Criteria Split

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/two-option-criteria-split/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: verified receipts, accepted assets/provenance, Spec sections 5.1–5.2, and reviewed Formula compatibility candidates.
- Produces: two complete source roots or explicit blocked absences.

- [ ] **Step 1: Confirm RED is limited to these eligible sources**

Run:

```bash
npx tsx --test --test-name-pattern "Before/After Proof Panel|Two-Option Criteria Split" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author minimal receipt-bound documents**

Before/After must require the same subject in matched temporal states, baseline/outcome truth, one upper title band, and no false causality. Comparison must require two contemporaneous equal-weight options, shared criteria, one upper title band, and no implied winner. Each uses three exact `preview_assets` paths named `assets/before-after-proof-panel-1.webp` through `assets/before-after-proof-panel-3.webp` or `assets/two-option-criteria-split-1.webp` through `assets/two-option-criteria-split-3.webp`, respectively; title line flexibility is 1/2/3, active Style remains authoritative, and compatibility IDs are limited to those supported by a fresh review.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Before/After Proof Panel|Two-Option Criteria Split" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add transformation and comparison recipes"
```

### Task 6: Author Reaction Evidence Inset and Cutaway Exploded Object

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/reaction-evidence-inset/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/cutaway-exploded-object/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.3–5.4.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Reaction Evidence Inset|Cutaway Exploded Object" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Reaction requires one generic/rights-cleared reaction subject, one natively rendered evidence window, gaze/gesture connection, no copied screenshot/UI/private data, and no creator likeness. Cutaway requires one object, ordered internal depth, few readable layers, no surrounding callout cloud, and no safety-critical invented internals. Preserve one title band, direct in-image title, and Style independence.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Reaction Evidence Inset|Cutaway Exploded Object" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add evidence and cutaway recipes"
```

### Task 7: Author Hero Payoff Companion and Iconic Result Close-Up

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hero-payoff-companion/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/iconic-result-closeup/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.5–5.6.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Hero Payoff Companion|Iconic Result Close-Up" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Hero Payoff requires one generic/rights-cleared host plus one separate tangible result object connected by contact/gaze/posture; no branded product or exaggerated outcome. Iconic Result requires one truthful finished outcome dominating the frame, minimal context, no required host, and no generic single-subject documentary fallback. Preserve one title band and direct in-image title.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Hero Payoff Companion|Iconic Result Close-Up" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add payoff and result recipes"
```

### Task 8: Author Scale Journey and Numbered Lineup

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/scale-journey/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/numbered-lineup/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.7–5.8.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Scale Journey|Numbered Lineup" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Scale Journey requires exactly three related forms through continuous depth/scale, no factual route, no numerals, and no equal-size lineup. Numbered Lineup requires three to five equal-status entries, correct native numerals/count agreement, no tiny labels, and no implied ranking without evidence. Numbered preview/title correctness is fail-closed.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Scale Journey|Numbered Lineup" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add scale and lineup recipes"
```

### Task 9: Author Macro Mystery Detail and Hands-On POV Moment

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/macro-mystery-detail/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hands-on-pov-moment/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.9–5.10.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Macro Mystery Detail|Hands-On POV Moment" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Macro Mystery requires one ambiguous macro detail plus one honest edge clue, no reaction host, separate inset, or false reveal. Hands-On POV requires first-person/over-shoulder hands performing one legible non-harmful action, one task context, no portrait/result-only fallback, extra/malformed hands, or unsafe instruction.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Macro Mystery Detail|Hands-On POV Moment" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add macro and POV recipes"
```

### Task 10: Independent Reviews and Serialized Lifecycle Transitions

**Files:**
- Create: one `spec.md` and one `quality.md` review file per recipe under `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/`, with each filename prefixed by its exact slug.
- Create: one request and one result JSON per recipe under `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/lifecycle-requests/` and `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/lifecycle-results/`, with each filename equal to its exact slug plus `.json`.
- Modify: `content-packs/authoring-registry.json`
- Modify: `scripts/content-packs/__tests__/authoring-registry.test.mjs`

**Interfaces:**
- Consumes: source-complete eligible recipes and independent review results.
- Produces: zero to ten authored registry records; failed recipes remain reserved.

- [ ] **Step 1: Run two-stage review per recipe**

Spec review checks exact receipt identity, composition invariant, collision boundary, three exact preview rows, title modes, and exclusions. Quality review decodes pixels and checks originality/provenance, exact title/line count, material diversity, mobile readability, malformed anatomy/numerals, safety/copy, and commercial boundary. Any Important/Critical finding blocks that recipe.

- [ ] **Step 2: Transition clean recipes one at a time**

For each clean slug in fixed proposal order, revalidate registry, use the current reported revision, exact common receipt, coordinator task/branch, and one change `{ "status": "authored" }`. Apply one transition, capture returned revision, verify the original receipt, and validate before the next. Never submit a multi-recipe transition or stale revision.

- [ ] **Step 3: Prove partial truth and commit**

Registry tests assert source-complete/review-clean recipes are authored and blocked/absent recipes remain reserved. Run:

```bash
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/authoring-registry.test.mjs
git commit -m "chore(content-packs): qualify ten thumbnail recipes"
```

### Task 11: Deterministic Candidates, External Staging, and Local Receiver Handoff

**Files:**
- Create: `scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs`
- Consume: `scripts/content-packs/stage-handoff-artifacts.mjs`
- Create: `/build/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24/{*.sspack,ledger.json,release-handoff.json}`
- Create: `/build/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json`

**Interfaces:**
- Consumes: fixed ten-record registry set, only authored/review-clean source roots, exact receipt, and per-recipe reviews.
- Produces: deterministic candidates for eligible recipes, exact blocked rows for the complement, and a non-mutating local receiver handoff.

- [ ] **Step 1: Write deterministic candidate tests**

For every authored source, call `buildContentPack({ sourceDirectory, outputPath, deliveryProfile: 'genstudio-store-receipt-v1', minAppVersion: '1.0.843' })` twice in a test-owned `mkdtemp()`. Compare bytes and SHA, validate both, enforce size, inspect entries/permissions, require dependencies `[]`, and reject keys/signatures/executables/URLs/credentials/provider/model/price fields and recursive `component_summary`.

- [ ] **Step 2: Test partial staging with the existing hardened helper**

Use isolated temp roots. Require unique `allowedSlugs` equal to all ten; `eligibleSlugs` equal exactly authored plus clean review; entries equal eligible; blocked entries equal the exact complement. Assert no overwrite, symlink following, repository destination, unknown/duplicate/omitted slug, partial success claim, or unvalidated archive.

- [ ] **Step 3: Run candidate tests**

```bash
node --test scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs
```

- [ ] **Step 4: Build real candidates in a fresh temporary root**

Re-verify every eligible receipt, build twice at `1.0.843`, validate both, compare bytes/hashes, and collect review facts. Use the staging helper to create the absent external artifact root and absent receiver path exclusively. Do not overwrite or reuse a prior root.

- [ ] **Step 5: Write exact release metadata**

Each delivered entry carries Story identity, exact archive path/hash/bytes/profile/minimum/receipt/reviews and a `component_summary` object. That object has `schema_version: 1`, `kind: "thumbnail-recipe"`, the exact summary literal for the entry's slug from the Exact Component Summary Matrix, and `slots: { "thumbnail-recipe": 1 }`; it has no other fields. The summary contains no identity/version/hash/closure data. The receiver status is `ready-for-owner-stocking` only when all ten deliver; otherwise `partial-ready-blocked` with exact blocked rows. It grants no GenStudio mutation authority.

- [ ] **Step 6: Commit durable tests only**

```bash
git add scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs
git commit -m "test(content-packs): qualify thumbnail expansion candidates"
```

### Task 12: Whole-Wave Verification and Handoff Review

**Files:**
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/final-review.md`
- Modify: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/progress.md`

**Interfaces:**
- Consumes: all source commits, registry transitions, candidates, external ledger, and receiver handoff.
- Produces: final verified local status and the smallest owner action needed next.

- [ ] **Step 1: Run the complete matrix**

```bash
npm run content-pack:registry -- validate
node --test \
  scripts/content-packs/__tests__/authoring-registry.test.mjs \
  scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
npm run typecheck:electron
npm run check:security
npm run check:model-drift
git diff --check
```

- [ ] **Step 2: Re-open and validate every external artifact**

Rehash/recount every archive, validate exact profile, parse all JSON, compare allowed/eligible/blocked equations, and run a semantic recursive key scan proving `component_summary` occurs only in delivered release/receiver/stocking entries.

- [ ] **Step 3: Independent whole-wave review**

Review registry/receipt consistency, source identity, distinctness, title contracts, preview pixels, provenance/rights, deterministic builds, staging safety, partial truth, summary scope, and commercial boundary. Confirm no application/checkout/version/changelog code, generation on this Mac, GenStudio mutation, Kit mutation, price, customer data, deploy, tag, or push occurred.

- [ ] **Step 4: Record final state**

If all ten are delivered, report the exact local receiver handoff and request one separate owner authorization for GenStudio draft-only stocking. If any are blocked, report only the smallest remaining evidence/authority set and do not submit a partial stocking request unless the owner explicitly chooses partial delivery.

## Plan Self-Review

**Spec coverage:** Tasks cover all ten proposed slugs, atomic reservation, thirty exact preview choices, no A/B feature, quote/authority stop, returned evidence, source authoring, two-stage reviews, serialized transitions, deterministic candidates, draft-component handoff, and separate later Kit reachability.

**Placeholder scan:** No unresolved identity, route, price, provider, model, quote, raster hash, receipt, or registry revision is represented as a fact. Runtime values are consumed from registry/Studio Hub outputs and blocked when absent.

**Type consistency:** Every recipe uses the existing `thumbnail-recipe` schema and canonical kind string. Reservation, source, registry, archive, component-summary, and handoff kinds remain `thumbnail-recipe`; no `thumbnail_recipe` alias is introduced.

**Scope consistency:** The plan changes only Content Pack registry/source/tests plus local/external evidence. Kit reachability is explicitly a later plan. App code, schema, UI, Store transport, commerce, release version, and changelog remain untouched.

**Authority consistency:** Task 2 requests a quote only; Task 3 is the hard owner-approval stop. No later task can run without exact return evidence from an authorized fleet job. Final receiver handoff is local/non-mutating until a separate owner stocking authorization.

## Execution Handoff

Execute with `superpowers:subagent-driven-development`. Task 1 is the single registry lane. Task 2 may begin only after Task 1 receipt verification. Task 3 is a hard external stop. After authorized bytes return and Task 4 fixes the eligible set, Tasks 5–9 may use disjoint source workers, but registry/shared provenance/shared test commits remain coordinator-owned. Tasks 10–12 serialize integration, review, staging, and completion.
