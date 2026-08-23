# Wave 2 Reusable Content Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify exactly five independently reusable Wave 2 Content Pack components: Question Ladder Formula, Audience Question Seeder Topic Pack, Before/After Timeline Formula, Object Hero + Question Thumbnail Recipe, and Route Map + One Promise Thumbnail Recipe.

**Architecture:** Add two `series-formula` leaves, one `topic-pack` leaf, and two `thumbnail-recipe` leaves under `content-packs/reusable-primitives/`; do not create a kit, style, coordinator source, runtime schema, or kit-specific fork. The coordinator prepares the complete exact five-record Story proposal required by the registry schema, submits it atomically at the current `expected_revision`, and the successful receipt makes those submitted values authoritative; leaves only consume and verify the persisted result. Recipe preview bytes are returned by Studio Hub or supplied by the owner, locally decoded and ledgered, never generated on this control Mac.

**Tech Stack:** JSON Content Pack schemas, Node.js `node:test`, TypeScript/TSX tests, Sharp WebP decoding, existing deterministic `.sspack` builder/validator, keyless `genstudio-store-receipt-v1` candidate validation, and Markdown handoffs.

**Spec:** `docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md`; `content-packs/authoring-registry.json`; `/build/.codex/skills/story-studio-channel-kit-authoring/references/component-handoff-contract.md`.

## Global Constraints

- Scope is exactly the five standalone components named in the goal. Do not author a Channel Kit, Visual Style, fifth creative schema, runtime catalog entry, or kit-specific copy.
- This plan refers only to the proposed human names/slugs before reservation. At execution time the coordinator prepares the complete exact proposed Story records required by `scripts/content-packs/authoring-registry.mjs`; those proposed identities are non-authoritative until the atomic reservation succeeds. Leaves must not derive, write, or consume a Story `pack_id`, `item_id`, `version`, family, or SKU before they verify the persisted receipt.
- The coordinator alone validates, reserves, and lifecycle-transitions the complete five-record batch. Each leaf verifies its exact receipt before creating its source, and never reserves, repairs, renumbers, or transitions a registry record.
- Every Formula/Topic pair declares explicit two-way compatibility, coverage, diversity axes, incompatible combinations, a duplicate/recency guard, evidence boundaries, and no medical/legal certainty, coercion, diagnosis, fabricated causality, or one-size-fits-all directives.
- Both recipes use `layout: "hero"`, `aspect_ratio: "16:9"`, `title_mode: "ai"`, `headline_mode: "episode-title"`, and require the selected image model to render the complete exact episode title inside the title-safe band. Do not create a text-free, overlay, masking, or post-render compositing path; scene and thumbnail generation remain separate.
- Each recipe needs three to five original, materially distinct 16:9 WebP preview bytes. They must vary subject, side/angle/distance, setting, palette/symbol, and 1/2/3-line headline arrangement while retaining the recipe hierarchy. A palette-only or near-duplicate variation does not count.
- The control/development Mac must not make a production or paid generation request, upload, purchase, publish, sign with a production key, use production keys, create GenStudio product/release/account/wire data, select a price/discount, or change checkout/Store transport. Preview production is only a Studio Hub handoff or owner-supplied original bytes; a paid Studio Hub request requires an exact quote and explicit owner authorization.
- Recipe archive candidates use the keyless `genstudio-store-receipt-v1` delivery profile: no archive `key_id`, no `signature.ed25519`, no private key, exact deterministic bytes, an exact dependency closure of `[]`, and at most 52,428,800 bytes. Build twice in a temporary directory; only after byte equality, validation, completed independent reviews, and coordinator transition, retain one canonical verified `.sspack` per successful leaf under `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/`. The root must not already exist, and no blocked leaf receives an archive. A test-only signed validation, if ever added, uses ephemeral material in `mkdtemp()` and removes it; it never replaces or contaminates the keyless candidate.
- Every leaf handoff has exactly `status`, `component`, `component_summary`, `reservation`, `identity`, `stocking_proposal`, `source`, `intent`, `compatibility`, `dependencies`, `originality_provenance`, `evidence`, `review_requests`, and `blocked_by`. The evidence object has `schema`, `coverage_uniqueness`, `golden_prompt_parity`, `decoded_previews`, `tests`, and `deterministic_build`, each with a concrete pass, inapplicable reason, or blocker.
- Every future release handoff includes `component_summary` as an object, never prose. Its exact v1 shape is `{"schema_version":1,"kind":"<canonical kind>","summary":"<short prose>","slots":{"series-formula":N,"topic-pack":N,"visual-style":N,"thumbnail-recipe":N}}`; omit each zero slot key. Each leaf has exactly one slot: its own canonical kind maps to `1`. The object must not duplicate IDs, versions, hashes, dependencies, or closure data, and no historical handoff is backfilled.
- `component_summary` is a release-handoff field only. Do not add it to `pack.json` or a `series-formula`, `topic-pack`, or `thumbnail-recipe` document: each installed source schema is strict and would reject that unknown field.
- Required independent reviews are schema, originality/provenance, compatibility, prompt-equivalence/exact-title, visual/thumbnail for recipes, safety, copy, and commercial-boundary. A missing applicable review or preview is a blocker, not an assumed pass.
- Preserve `package.json`, `package-lock.json`, `CHANGELOG.md`, existing component sources, registry histories, Store network routes, GenStudio transport, and runtime checkout behavior. This authoring wave does not release or publish.

## File Structure

| Path | Responsibility |
| --- | --- |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/component-briefs.json` | Ignored coordinator working note for proposed human names/slugs, kinds, source roots, compatibility, contract text, diversity axes, and preview requirements; tests never load it. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-request.json` | Ignored coordinator working note containing the exact five-record proposal submitted to the registry; it is not a source of truth after reservation. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-result.json` | Ignored machine capture of `{ revision, receipt_ref }`; durable tests obtain the same facts from committed `content-packs/authoring-registry.json`. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/expected-identities/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}.json` | Ignored leaf verification working notes; committed tests read the matching persisted registry record instead. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/lifecycle-{requests,results}/` | Ignored coordinator-only serial `reserved` → `authored` request/result pairs for qualified leaves; no leaf task writes or invokes them. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/preview-batch.json` | Ignored Studio Hub request containing both recipe prompt sets and return-ledger requirements; no provider/model route, paid request, or generated bytes. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}.yaml` | Ignored canonical leaf authoring handoff for each component; reviewers consume them, but committed tests prove durable source/registry facts only. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/wave-2-candidate.yaml` | Ignored candidate or blocked wave-level handoff with five independent closures, no coordinator pack. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}-stocking.yaml` | Ignored `ready-for-owner-stocking` handoff for each independently qualified and coordinator-authored leaf; no upload or GenStudio mutation. |
| `content-packs/reusable-primitives/formula/question-ladder/{pack.json,content/series-formula.json}` | Receipt-bound Question Ladder Formula source. |
| `content-packs/reusable-primitives/topic/audience-question-seeder/{pack.json,content/topic-pack.json}` | Receipt-bound Audience Question Seeder Topic Pack source. |
| `content-packs/reusable-primitives/formula/before-after-timeline/{pack.json,content/series-formula.json}` | Receipt-bound Before/After Timeline Formula source. |
| `content-packs/reusable-primitives/thumbnail/object-hero-question/{pack.json,content/thumbnail-recipe.json,assets/*.webp}` | Receipt-bound Object Hero + Question Recipe and only its declared returned preview bytes. |
| `content-packs/reusable-primitives/thumbnail/route-map-one-promise/{pack.json,content/thumbnail-recipe.json,assets/*.webp}` | Receipt-bound Route Map + One Promise Recipe and only its declared returned preview bytes. |
| `content-packs/reusable-primitives/PREVIEW-PROVENANCE.md` | Immutable preview ledger: original-byte provenance/rights, returned source, WebP decode data, byte size, SHA-256, and rejected candidates. |
| `scripts/content-packs/stage-handoff-artifacts.mjs` | Dependency-free staging helper that refuses an existing target root, copies only verified canonical candidate bytes outside the repository, and writes the artifact ledger plus receiver handoff. |
| `electron/server/__tests__/reusable-content-primitives-source.test.ts` | Source schemas, Formula/Topic/Recipe compatibility, diversity, safety, exact-title, provenance, and no-runtime-secret regression tests. |
| `scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs` | Deterministic keyless candidate archive, size, closure, and delivery-profile tests. |
| `scripts/content-packs/__tests__/authoring-registry.test.mjs` | Five-record atomic receipt and receipt verification regression coverage. |
| `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}.sspack` | One retained verified canonical candidate per successful leaf only; this fresh external root fails closed if it already exists. |
| `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/ledger.json` | Receiver ledger with absolute archive path, SHA-256, byte count, `min_app_version`, delivery profile, original receipt, completed review evidence, and exact `component_summary` for each successful leaf. |
| `/build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.md` | Exact non-mutating receiver handoff linking only retained successful-leaf artifacts and their ledger; absent when every leaf is blocked. |

## Component Contract Matrix

| Proposed human name / source slug | Kind | Reuse contract | Explicit incompatibilities |
| --- | --- | --- | --- |
| Question Ladder / `question-ladder` | Formula | Concrete audience question → mechanism → trade-off → exception → bounded conclusion. Compatible with Audience Question Seeder and later explanatory Topic Packs that declare this Formula after their own compatibility review. | No personal testimony, diagnosis, medical/legal certainty, bait, or one-size-fits-all directive. |
| Audience Question Seeder / `audience-question-seeder` | Topic Pack | Audience-context question subjects with `audience-context`, `question-intent`, `constraint`, `evidence-type`, and `actionability` axes. Supports Question Ladder and a later explanatory Formula only when that Formula record is explicitly listed after a separate review. | Does not own answer structure, UI seeding, local listings, clinical advice, legal advice, or a claim of individualized guidance. |
| Before/After Timeline / `before-after-timeline` | Formula | Stated baseline → intervention/change → time window → measurements/observations → confounders → bounded result. Compatible with later Topic Packs that explicitly support it; intended for Challenge & Progress and selected Case Study work, not a fork of either. | No transformation promise, causal claim beyond evidence, hidden baseline, fabricated measurement, or universal outcome. |
| Object Hero + Question / `object-hero-question` | Recipe | One concrete object/artifact hero plus an exact AI-rendered episode-title question in a dominant title-safe band; visual medium/palette remains project style authority. Test first with Question Ladder and Before/After Timeline, then may serve Comparison Lab, Case Study Breakdown, and Everyday Explainers only through declared Formula compatibility. | No object collage, branded product/logo, copied trade dress, title overlay, text-free output, or unsupported efficacy claim. |
| Route Map + One Promise / `route-map-one-promise` | Recipe | One route/wayfinding visual anchor plus one qualified exact AI-rendered episode-title promise; visual medium/palette remains project style authority. Test first with a bounded route/activity Formula fixture; Weekend Guides attaches only after its own Formula is qualified. | Never factual navigation, verified map, endorsement, logo, local booking/hours claim, location guarantee, overlay, or post-render title. |

## Shared Data Models and Diversity Rules

The new leaves use the installed strict schemas in `electron/server/content-packs/schemas.ts`; no schema change is planned. Formula documents use `series-formula`; the Topic document uses `topic-pack`; Recipe documents use `thumbnail-recipe` fields exactly as declared there.

`Audience Question Seeder` must persist these five independent axes in both dedicated lists and `idea_axes`, with at least six values per axis and `max_siblings_per_subject: 1`:

```text
audience-context: first-time learner | busy caregiver | budget-conscious household | small-team operator | hobby beginner | returning learner
question-intent: understand a mechanism | compare options | plan a bounded next step | identify a trade-off | check an exception | evaluate an observation
constraint: time | budget | access | safety | uncertainty | competing priorities
evidence-type: primary source | measurement log | official guidance | controlled comparison | expert explanation | lived observation labelled as anecdotal
actionability: observe | ask a professional | compare criteria | run a reversible low-risk experiment | defer pending evidence | choose among stated options
```

Reject a candidate when its normalized question duplicates an existing episode or in-batch candidate, when `(subject, audience-context, question-intent, constraint)` repeats, when the question asks for a diagnosis/legal conclusion/medical treatment, or when `evidence-type: lived observation labelled as anecdotal` is paired with a causal or universal conclusion. Store the rejection reason with the candidate fingerprint so a retry remains deterministic.

`Question Ladder` must persist `question-intent`, `mechanism-depth`, `trade-off`, `exception-class`, and `conclusion-boundary` as Formula idea axes. Its script chapters are exactly: `concrete question`, `scope and definitions`, `mechanism`, `trade-off`, `exception`, `bounded conclusion`. It must require a claim/evidence/uncertainty distinction and a recency guard before a candidate is queued.

`Before/After Timeline` must persist `baseline`, `change`, `time-window`, `measurement-or-observation`, `confounder`, and `result-boundary` as Formula idea axes. Its script chapters are exactly: `starting baseline`, `change introduced`, `timeline checkpoints`, `measurements or observations`, `confounders and alternatives`, `bounded result`. Reject candidates without a stated baseline and time window, or that use before/after evidence to assert causation.

Recipe preview diversity is a six-axis matrix: `subject`, `subject-side-or-angle`, `camera-distance`, `setting`, `palette-or-symbol`, and `headline-line-count`. The three required examples per recipe must cover at least three distinct values for the first five axes and exactly headline line counts `1`, `2`, and `3`. The source content carries only reusable grammar; provenance records the specific returned examples and never promotes their text to a reusable title.

## Exact Recipe Title Contracts

Both Recipe documents must state all of the following in `composition_rules`, `required_elements`, `avoid_elements`, and `headline_guidance`, and tests must assert them as exact behavioral requirements:

```text
title_mode: ai
headline_mode: episode-title
exact-title rule: Render the complete exact episode title supplied for this thumbnail inside the declared title-safe band. Preserve all title words; do not paraphrase, shorten, substitute a hook, omit words, add a second headline, or add post-render typography.
```

`Object Hero + Question` uses a dominant upper-third title-safe band and one lower-two-thirds concrete object/artifact silhouette. Its `headline_formats` are `WHY DOES {SUBJECT} MATTER?`, `WHAT DOES {SUBJECT} CHANGE?`, and `CAN {SUBJECT} WORK?`; the selected model still receives and renders the actual complete episode title, not a literal unresolved `{SUBJECT}` template. Its supporting marks are limited to one nonverbal comparison cue when it clarifies the object; the object, not a collage or a person, remains the hero.

`Route Map + One Promise` uses a dominant upper-third title-safe band, one simplified route/wayfinding anchor, a start/end relationship, and exactly one promise framed as bounded and conditional. Its `headline_formats` are `A BETTER WAY TO {SUBJECT}`, `THE SIMPLE ROUTE TO {SUBJECT}`, and `ONE REALISTIC WAY TO {SUBJECT}`; again, the model renders the actual complete episode title. It must say the diagram is symbolic and must not be used for navigation, distances, boundaries, business facts, or endorsements.

## Release Component Summary Contract

Each Wave 2 leaf handoff adds this release-only field next to its other canonical handoff fields:

```json
{
  "schema_version": 1,
  "kind": "series-formula",
  "summary": "A reusable evidence-aware answer ladder from concrete question to bounded conclusion.",
  "slots": { "series-formula": 1 }
}
```

For Audience Question Seeder, use `kind: "topic-pack"` and `slots: { "topic-pack": 1 }`. For Object Hero + Question and Route Map + One Promise, use `kind: "thumbnail-recipe"` and `slots: { "thumbnail-recipe": 1 }`. Before/After Timeline uses the same `series-formula` slot shape as Question Ladder with a short baseline/change/timeline summary. Do not add a `visual-style` zero key, any identifier/version/digest, or a five-component aggregate summary; each release is independently summarized and no pre-existing handoff changes.

### Task 1: Reserve one exact coordinator batch, verify it, then add durable RED tests

**Files:**
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/component-briefs.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-request.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-result.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/expected-identities/question-ladder.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/expected-identities/audience-question-seeder.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/expected-identities/before-after-timeline.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/expected-identities/object-hero-question.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/expected-identities/route-map-one-promise.json`
- Modify: `content-packs/authoring-registry.json`
- Modify: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Create: `electron/server/__tests__/reusable-content-primitives-source.test.ts`

**Interfaces:**
- Consumes: `reserveAuthoringBatch({ registryPath, repositoryRoot, request }) -> Promise<{ revision: number; receipt_ref: string }>` and `verifyAuthoringReceipt({ registryPath, repositoryRoot, revision, receiptRef, expectedIdentity }) -> Promise<{ revision: number; receipt_ref: string; identity: AuthoringRecord }>` from `scripts/content-packs/authoring-registry.mjs`.
- Produces: one committed exact five-record reservation at one revision, one `authoring:<sha256>` receipt, durable registry records that tests can inspect in a clean checkout, and ignored coordinator/leaf working notes for receipt verification.

- [ ] **Step 1: Validate the authority and prepare the complete exact coordinator proposal before reservation.**

Run `npm run content-pack:registry -- validate`. If it fails, if the observed revision changes before reservation, if a record collides, or if the coordinator cannot prepare all five complete schema-valid Story records in one request, stop and record this exact working-note handoff; create no source, pack manifest, candidate archive, stocking proposal, or GenStudio record:

```text
status: blocked
blocker: Registry task required
needed: coordinator-owned authoring catalog registry with collision-safe reservation
requested_records: series-formula Question Ladder; topic-pack Audience Question Seeder; series-formula Before/After Timeline; thumbnail-recipe Object Hero + Question; thumbnail-recipe Route Map + One Promise
do_not_create: Story content IDs, family/SKU proposals, manifests, candidate archives, GenStudio records
```

Before the command, create ignored `component-briefs.json` containing only the five proposed human names/slugs and source roots. The coordinator then creates ignored `reservation-request.json` with the current `expected_revision`, coordinator `{ "task": "reusable-content-primitives-wave-2", "branch": "codex/content-expansion-portfolio" }`, the approved portfolio spec path as `proposal_ref`, and all five complete exact proposed records required by the registry schema: exact proposed `pack_id`, kind-constrained `item_id`, version, publisher, minimum-app-version fields, status, source path, empty dependency list, and proposed family/SKU records. These are coordinator proposals, not returned/authoritative values; the registry receipt makes precisely the submitted five values authoritative if and only if reservation succeeds.

- [ ] **Step 2: Submit the exact batch atomically and verify every leaf receipt.**

Reserve once and capture only its machine output:

```bash
npm run content-pack:registry -- reserve \
  --request .superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-request.json \
  > .superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-result.json
```

- [ ] **Step 3: Materialize and verify each exact returned identity without hand-derived values.**

Read committed `content-packs/authoring-registry.json`, select only the five records whose `receipt_ref` equals `reservation-result.json.receipt_ref`, remove `receipt_ref`, and write them to the ignored corresponding expected-identity files by matching the approved human `source_path`. Each record must have exactly the coordinator-submitted value; receipt verification must prove the persisted registry, receipt, and expected record agree:

```bash
node --input-type=module - <<'NODE'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyAuthoringReceipt } from './scripts/content-packs/authoring-registry.mjs'

const handoff = '.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2'
const receipt = JSON.parse(await readFile(join(handoff, 'reservation-result.json'), 'utf8'))
for (const name of (await readdir(join(handoff, 'expected-identities'))).sort()) {
  const expectedIdentity = JSON.parse(await readFile(join(handoff, 'expected-identities', name), 'utf8'))
  const verified = await verifyAuthoringReceipt({ revision: receipt.revision, receiptRef: receipt.receipt_ref, expectedIdentity })
  console.log(`${name}: ${verified.identity.pack_id}@${verified.identity.version}`)
}
NODE
```

Expected: exactly five printed receipt-authorized releases. A mismatch, missing expected file, or nonzero command is a fail-closed blocker for that leaf. The ignored expected identity is a verification input only; the committed registry is the durable source of truth.

- [ ] **Step 4: Write durable RED registry/source tests after receipt verification.**

Add a test in `scripts/content-packs/__tests__/authoring-registry.test.mjs` that reads only committed `content-packs/authoring-registry.json`; select records by the five durable source paths and assert five records share a single receipt, `status: 'reserved'`, and `dependencies: []`. Do not import or read `.superpowers/sdd`.

Add `electron/server/__tests__/reusable-content-primitives-source.test.ts` with a helper that reads each source only from `content-packs/reusable-primitives/**`, finds its registry record by the same committed source path, and expects the source manifest/document identity to equal that registry record. Make source absence a failure:

```ts
const record = registry.records.find(candidate => candidate.source_path === sourcePath)
assert.ok(record, `missing committed registry record for ${sourcePath}`)
const manifest = await readJson(join(sourcePath, 'pack.json'))
assert.equal(manifest.pack_id, record.pack_id)
assert.equal(manifest.version, record.version)
assert.equal(manifest.publisher_id, record.publisher_id)
assert.equal(document.id, record.item_id)
```

The tests are deliberately RED because Task 1 creates no component source or source manifest.

- [ ] **Step 5: Run the durable RED tests and confirm the expected failure.**

Run:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts
```

Expected: registry test PASS for the committed atomic batch; source test FAIL only because the five receipt-authorized source roots do not yet exist. Do not convert the source test to read ignored component briefs, reservation results, expected identities, or handoffs.

- [ ] **Step 6: Commit the durable coordinator gate and RED source test.**

Run:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npm run content-pack:registry -- validate
```

Expected: registry validation passes with five new `reserved` records sharing one receipt. The committed source test remains RED until Task 2 begins. Commit only durable files; `.superpowers/sdd` stays ignored and is never added:

```bash
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/authoring-registry.test.mjs electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "chore(content-packs): reserve reusable primitive identities"
```

### Task 2: Author the receipt-bound Question Ladder Formula

**Files:**
- Create: `content-packs/reusable-primitives/formula/question-ladder/pack.json`
- Create: `content-packs/reusable-primitives/formula/question-ladder/content/series-formula.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/question-ladder.yaml`
- Modify: `electron/server/__tests__/reusable-content-primitives-source.test.ts`

**Interfaces:**
- Consumes: the committed receipt-authorized Question Ladder and Audience Question Seeder records selected from `content-packs/authoring-registry.json` by their exact source paths.
- Produces: a `series-formula` document whose `compatible_topic_pack_ids` includes only the receipt-authorized Audience Question Seeder ID at this wave; future Formula/Topic compatibility remains an explicit later release decision.

- [ ] **Step 1: Write the failing Formula contract test.**

Assert the document identity agrees with the committed receipt-authorized registry record, its six chapter labels and five formula axes are present, it rejects medical/legal certainty and bait, and it declares the Topic Pack only after reading that Topic record from the committed registry:

```ts
assert.deepEqual(formula.script_structure.pacing_arc, [
  'Concrete question.', 'Scope and definitions.', 'Mechanism.', 'Trade-off.', 'Exception.', 'Bounded conclusion.',
])
assert.deepEqual(formula.idea_axes.map(axis => axis.id), [
  'question-intent', 'mechanism-depth', 'trade-off', 'exception-class', 'conclusion-boundary',
])
assert.match(formula.evidence_expectations.join(' '), /claim.*evidence.*uncertainty/i)
assert.match(formula.title_rules.join(' '), /medical.*legal.*certainty|one-size-fits-all/i)
assert.deepEqual(formula.compatible_topic_pack_ids, [audienceQuestionSeeder.item_id])
```

- [ ] **Step 2: Run the source test and confirm it fails.**

Run: `npx tsx --test --test-name-pattern "Question Ladder" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: FAIL because the receipt-authorized Formula source does not yet exist.

- [ ] **Step 3: Implement the minimal receipt-bound Formula source and canonical handoff.**

Use the exact receipt-authorized registry `pack_id`, `item_id`, version, publisher, `min_app_version`, family, and SKU only where the established source manifest/contract requires them. Set `channel_promise` to `Question → Mechanism → Boundary`; use an evidence-aware non-diagnostic narrator policy; require a concrete question, a mechanism, a trade-off, an exception, and a bounded conclusion. Make `recommended_thumbnail_recipe_ids` contain the receipt-authorized Object Hero + Question ID, while `default_thumbnail_recipe_id` remains unset so no recipe becomes a universal default.

Write ignored `handoffs/question-ladder.yaml` with the exact Component Handoff Contract fields plus `component_summary: { schema_version: 1, kind: "series-formula", summary: "A reusable evidence-aware answer ladder from concrete question to bounded conclusion.", slots: { "series-formula": 1 } }`. Set `dependencies: []`; list the Topic and Recipe as compatibility facts, not pack dependencies. Evidence marks schema/coverage-uniqueness/golden-prompt-parity/tests with their named check results, `decoded_previews` as `not_applicable` because a Formula has no preview asset, and `deterministic_build` as `not_applicable` until Task 7. Review requests name every required independent review and mark visual/thumbnail `not_applicable` with `Formula has no preview asset`.

- [ ] **Step 4: Run the Formula test and commit.**

Run: `npx tsx --test --test-name-pattern "Question Ladder" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: PASS for the Question Ladder subtest while source tests for later leaves remain red. Commit:

```bash
git add content-packs/reusable-primitives/formula/question-ladder electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add question ladder formula"
```

### Task 3: Author the receipt-bound Audience Question Seeder Topic Pack

**Files:**
- Create: `content-packs/reusable-primitives/topic/audience-question-seeder/pack.json`
- Create: `content-packs/reusable-primitives/topic/audience-question-seeder/content/topic-pack.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/audience-question-seeder.yaml`
- Modify: `electron/server/__tests__/reusable-content-primitives-source.test.ts`

**Interfaces:**
- Consumes: committed receipt-authorized Audience Question Seeder and Question Ladder registry records selected by their exact source paths.
- Produces: a `topic-pack` with one exact compatible Formula at this wave, explicit diversity axes, deterministic duplicate rejection data, and a canonical leaf handoff.

- [ ] **Step 1: Add the failing Topic data-model and duplicate-guard assertions.**

```ts
const axisIds = topic.idea_axes.map(axis => axis.id)
assert.deepEqual(axisIds, ['audience-context', 'question-intent', 'constraint', 'evidence-type', 'actionability'])
assert.equal(topic.max_siblings_per_subject, 1)
for (const list of [topic.subjects, topic.episode_objects, topic.time_place_scopes, topic.mechanisms, topic.evidence_lenses]) {
  assert.ok(list.length >= 6)
  assert.equal(new Set(list.map(value => value.toLowerCase())).size, list.length)
}
assert.deepEqual(topic.compatible_formula_ids, [questionLadder.item_id])
assert.match(topic.exclusions.join(' '), /diagnosis|medical|legal|individualized|causal|universal/i)
```

Add a deterministic planner fixture that produces the same ordered fingerprints for the same seed and rejects repeated `(subject, audience-context, question-intent, constraint)` combinations.

- [ ] **Step 2: Run the source test and confirm it fails.**

Run: `npx tsx --test --test-name-pattern "Audience Question Seeder" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: FAIL because the Topic source and its exact diversity model are absent.

- [ ] **Step 3: Implement the Topic source and handoff.**

Populate `subjects`, `episode_objects`, `time_place_scopes`, `mechanisms`, and `evidence_lenses` with the five data-model axes described in Shared Data Models; map `question-intent` to `subjects`, `audience-context` to `episode_objects`, `constraint` to `time_place_scopes`, `evidence-type` to `evidence_lenses`, and `actionability` to `mechanisms`. Set `prompt_context` to ask one bounded question without treating the pack as a UI feature or live directory. Include the exact incompatible-combination and fingerprint rejection rules from Shared Data Models in `compatibility_rules`.

Write the ignored canonical handoff using the committed registry identity, `component_summary: { schema_version: 1, kind: "topic-pack", summary: "A duplicate-resistant audience-question domain pack with bounded evidence and actionability axes.", slots: { "topic-pack": 1 } }`, `dependencies: []`, exact Question Ladder compatibility, source path, safety/originality boundary, and evidence. `golden_prompt_parity` is `not_applicable` because this pack does not make a Formula continuity claim; `decoded_previews` and visual/thumbnail review are `not_applicable` because it has no raster asset. Do not add a future Formula ID merely because the prose says it could later be compatible.

- [ ] **Step 4: Run the source test and commit.**

Run: `npx tsx --test --test-name-pattern "Question Ladder|Audience Question Seeder" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: PASS for the two selected source subtests, including deterministic duplicate rejection. Commit:

```bash
git add content-packs/reusable-primitives/topic/audience-question-seeder electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add audience question seeder"
```

### Task 4: Author the receipt-bound Before/After Timeline Formula

**Files:**
- Create: `content-packs/reusable-primitives/formula/before-after-timeline/pack.json`
- Create: `content-packs/reusable-primitives/formula/before-after-timeline/content/series-formula.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/before-after-timeline.yaml`
- Modify: `electron/server/__tests__/reusable-content-primitives-source.test.ts`

**Interfaces:**
- Consumes: its committed receipt-authorized registry record and the committed Object Hero + Question record for a recommendation only.
- Produces: a no-causality `series-formula` with no Topic dependency at this wave and a complete handoff.

- [ ] **Step 1: Add the failing timeline Formula test.**

```ts
assert.deepEqual(formula.script_structure.pacing_arc, [
  'Starting baseline.', 'Change introduced.', 'Timeline checkpoints.', 'Measurements or observations.', 'Confounders and alternatives.', 'Bounded result.',
])
assert.deepEqual(formula.idea_axes.map(axis => axis.id), [
  'baseline', 'change', 'time-window', 'measurement-or-observation', 'confounder', 'result-boundary',
])
assert.equal(formula.compatible_topic_pack_ids.length, 0)
assert.match(formula.narrative_rules.join(' '), /baseline.*time window.*confounder/i)
assert.match(formula.title_rules.join(' '), /no transformation promise|no causal claim/i)
```

- [ ] **Step 2: Run the source test and confirm it fails.**

Run: `npx tsx --test --test-name-pattern "Before/After Timeline" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: FAIL because the receipt-authorized Formula source does not exist.

- [ ] **Step 3: Implement the minimal timeline Formula and handoff.**

Set `channel_promise` to `Baseline → Change → Evidence Boundary`; require named baseline, intervention/change, time window, measurements/observations, confounders, and bounded result in every episode. Set `compatible_topic_pack_ids: []` and `default_topic_pack_ids: []`: Challenge & Progress and Case Study work are future compatibility reviews, not pack dependencies or identities in this wave. Recommend the committed receipt-authorized Object Hero + Question recipe without making it a default. The ignored handoff has `component_summary: { schema_version: 1, kind: "series-formula", summary: "A reusable baseline-to-result timeline that keeps confounders and causal limits visible.", slots: { "series-formula": 1 } }`, `dependencies: []`, `golden_prompt_parity` against the six-stage timeline prompt fixture, preview evidence and visual review inapplicable, and the commercial boundary review required.

- [ ] **Step 4: Run the source test and commit.**

Run: `npx tsx --test --test-name-pattern "Question Ladder|Audience Question Seeder|Before/After Timeline" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: PASS for the three selected text-component subtests. Commit:

```bash
git add content-packs/reusable-primitives/formula/before-after-timeline electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add before after timeline"
```

### Task 5: Batch the preview brief, then author Object Hero + Question only after returned bytes qualify

**Files:**
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/preview-batch.json`
- Create: `content-packs/reusable-primitives/thumbnail/object-hero-question/pack.json`
- Create: `content-packs/reusable-primitives/thumbnail/object-hero-question/content/thumbnail-recipe.json`
- Create: `content-packs/reusable-primitives/thumbnail/object-hero-question/assets/object-hero-question-{1,2,3}.webp`
- Create: `content-packs/reusable-primitives/PREVIEW-PROVENANCE.md`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/object-hero-question.yaml`
- Modify: `electron/server/__tests__/reusable-content-primitives-source.test.ts`

**Interfaces:**
- Consumes: the committed receipt-authorized Object Hero + Question and Formula registry records, plus a Studio Hub or owner return containing actual original WebP bytes plus provenance/rights metadata.
- Produces: a three-preview `thumbnail-recipe`, byte-level provenance ledger, exact-title prompt contract, and recipe handoff; no runtime catalog mutation.

- [ ] **Step 1: Add the failing exact-title, originality, and preview-diversity test.**

```ts
assert.equal(recipe.layout, 'hero')
assert.equal(recipe.aspect_ratio, '16:9')
assert.equal(recipe.title_mode, 'ai')
assert.equal(recipe.headline_mode, 'episode-title')
assert.match(recipe.headline_guidance, /complete exact episode title.*do not paraphrase.*post-render/i)
assert.match(recipe.composition_rules.join(' '), /upper third.*title-safe|lower two-thirds.*object/i)
assert.match(recipe.required_elements.join(' '), /one concrete object|complete exact episode title/i)
assert.match(recipe.avoid_elements.join(' '), /collage|logo|watermark|post-render|illegible/i)
assert.equal(recipe.preview_assets.length, 3)
assert.ok(recipe.compatible_formula_ids.includes(questionLadder.item_id))
assert.ok(recipe.compatible_formula_ids.includes(beforeAfterTimeline.item_id))
```

For every preview assert WebP decode succeeds, width/height is 16:9, the ledger has SHA-256, byte size, rights basis, source/provenance, subject, side/angle, distance, setting, palette/symbol, and line count; require the three ledger entries to cover headline line counts `[1, 2, 3]` and no two records share all six diversity fields.

- [ ] **Step 2: Run the source test and confirm it fails.**

Run: `npx tsx --test --test-name-pattern "Object Hero + Question" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: FAIL because neither declared source nor returned preview evidence exists.

- [ ] **Step 3: Prepare one parallel Studio Hub preview request for both recipes, without generating locally.**

Write `preview-batch.json` with two recipe briefs and exactly three original 16:9 output prompts each. For Object Hero + Question, vary: a repair tool seen three-quarter side at medium distance in a workshop with copper/blue accents and one title line; a household energy meter seen frontal-close in a home utility setting with amber/charcoal accents and two title lines; a field notebook seen top-left at medium distance on an outdoor table with green/cream accents and three title lines. Every prompt says: render the complete exact supplied episode title in the upper-third band, no extra text, no overlay, no logo, no copied asset, and the object is the only hero.

The handoff requests returned original bytes, component brief, approved prompt text, source/provenance, rights/license basis, SHA-256, decoded dimensions, byte size, and line-count/variation inventory. Route a single parallel batch to Studio Hub or await owner-supplied originals. Do not select a provider/model, send a paid request, or invoke a production endpoint on this Mac.

If bytes are missing, malformed, not original, have no rights basis, fail decode, omit the AI-rendered complete headline, are clipped/misspelled/UI-contaminated/copied/near-duplicate, or do not meet the diversity matrix, write this exact blocker to the recipe handoff and `PREVIEW-PROVENANCE.md`, omit the recipe source and candidate archive, and stop this recipe task:

```text
BLOCKED: Returned Object Hero + Question previews are missing qualified original WebP evidence. Needed: three Studio Hub or owner-supplied 16:9 originals with complete AI-rendered titles, provenance/rights basis, decoded dimensions, byte size, SHA-256, and six-axis diversity coverage. No production or paid generation request is authorized on this control Mac.
```

- [ ] **Step 4: Verify returned assets locally and author the recipe only when all three qualify.**

Use Sharp to decode the exact returned bytes and `createHash('sha256')` to record their actual digests; do not infer values from prompt text. Create the source with the strict exact-title contract above, `headline_formats` listed in Exact Recipe Title Contracts, `compatible_formula_ids` containing only the two committed receipt-authorized Formula identities, and no hard-coded visual medium/palette contract beyond a neutral readability instruction. Write the ignored canonical handoff with `component_summary: { schema_version: 1, kind: "thumbnail-recipe", summary: "A single-object thumbnail grammar with an exact AI-rendered episode-title question.", slots: { "thumbnail-recipe": 1 } }`, actual `decoded_previews` evidence, and all independent review requests.

- [ ] **Step 5: Run the recipe source test and commit.**

Run: `npx tsx --test --test-name-pattern "Object Hero + Question" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: PASS only with three qualifying returned previews and a complete ledger. Commit:

```bash
git add content-packs/reusable-primitives/thumbnail/object-hero-question content-packs/reusable-primitives/PREVIEW-PROVENANCE.md electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add object hero question recipe"
```

### Task 6: Author Route Map + One Promise only after its returned preview bytes qualify

**Files:**
- Create: `content-packs/reusable-primitives/thumbnail/route-map-one-promise/pack.json`
- Create: `content-packs/reusable-primitives/thumbnail/route-map-one-promise/content/thumbnail-recipe.json`
- Create: `content-packs/reusable-primitives/thumbnail/route-map-one-promise/assets/route-map-one-promise-{1,2,3}.webp`
- Modify: `content-packs/reusable-primitives/PREVIEW-PROVENANCE.md`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/route-map-one-promise.yaml`
- Modify: `electron/server/__tests__/reusable-content-primitives-source.test.ts`

**Interfaces:**
- Consumes: the committed receipt-authorized Route Map + One Promise registry record and its three returned preview records from ignored `preview-batch.json`.
- Produces: a standalone thumbnail recipe that remains symbolic and non-navigational, not a Weekend Guides kit asset.

- [ ] **Step 1: Add the failing non-navigation exact-title recipe test.**

```ts
assert.equal(recipe.layout, 'hero')
assert.equal(recipe.title_mode, 'ai')
assert.equal(recipe.headline_mode, 'episode-title')
assert.match(recipe.composition_guidance, /symbolic.*route|wayfinding.*anchor|start.*end/i)
assert.match(recipe.headline_guidance, /complete exact episode title.*do not paraphrase.*post-render/i)
assert.match(recipe.required_elements.join(' '), /one route.*anchor|start.*end|qualified promise/i)
assert.match(recipe.avoid_elements.join(' '), /navigation|distance|boundary|endorsement|logo|booking|hours|post-render/i)
assert.equal(recipe.preview_assets.length, 3)
assert.equal(recipe.compatible_formula_ids.length, 0)
```

The last assertion is deliberate: Weekend Guides does not exist in this wave. The recipe describes its intended bounded route/activity compatibility in the handoff, but does not invent a Formula identity.

- [ ] **Step 2: Run the source test and confirm it fails.**

Run: `npx tsx --test --test-name-pattern "Route Map + One Promise" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: FAIL because the route source and qualified returned bytes are absent.

- [ ] **Step 3: Complete the Route Map portion of the same preview batch and enforce the returned-byte blocker.**

Use three prompts in `preview-batch.json`: a symbolic park loop with a curved line/start/end at high three-quarter angle, leaf-green/cream palette, and one title line; a neighborhood walking sequence with a dotted line and landmark icon at medium distance, brick/sky-blue palette, and two title lines; a skill-learning path with three unlabeled abstract stations at close top-down distance, violet/sand palette, and three title lines. Every prompt says the route is symbolic only, no factual map/scale/boundary/business claim, no logo, no endorsement, render the complete exact supplied episode title in the upper-third band, and no extra or post-render text.

If any required return evidence is absent or the output violates the safety/title/diversity checks, record this exact blocker, do not create the source or archive, and return the leaf handoff as blocked:

```text
BLOCKED: Returned Route Map + One Promise previews are missing qualified original WebP evidence. Needed: three Studio Hub or owner-supplied 16:9 originals with complete AI-rendered titles, provenance/rights basis, decoded dimensions, byte size, SHA-256, and six-axis diversity coverage. No production or paid generation request is authorized on this control Mac.
```

- [ ] **Step 4: Verify qualifying bytes, implement the source, and write the canonical recipe handoff.**

Only after local decode/hash verification, write the receipt-bound source with `compatible_formula_ids: []`, the three headline formats specified above, and explicit symbolic/non-navigational restrictions. The ignored handoff records `component_summary: { schema_version: 1, kind: "thumbnail-recipe", summary: "A symbolic route-and-promise thumbnail grammar with an exact AI-rendered episode title.", slots: { "thumbnail-recipe": 1 } }`, `dependencies: []`, intended compatibility with a future qualified bounded route/activity Formula as a non-identity prose condition, actual preview evidence, and all independent review requests. It must not list Weekend Guides by guessed ID.

- [ ] **Step 5: Run the recipe test and commit.**

Run: `npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: PASS only if all five leaves are source-complete and each Recipe ledger row is concrete. Commit:

```bash
git add content-packs/reusable-primitives/thumbnail/route-map-one-promise content-packs/reusable-primitives/PREVIEW-PROVENANCE.md electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add route map promise recipe"
```

### Task 7: Qualify candidates, coordinator-transition successful leaves, and issue non-mutating stocking handoffs

**Files:**
- Create: `scripts/content-packs/stage-handoff-artifacts.mjs`
- Create: `scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs`
- Modify: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Modify: `content-packs/authoring-registry.json`
- Modify: `electron/server/__tests__/reusable-content-primitives-source.test.ts`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}.yaml` (ignored review inputs; no committed test reads them)
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/wave-2-candidate.yaml` (ignored review input; no committed test reads it)
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}-stocking.yaml` for successful leaves only (ignored owner-review inputs; no committed test reads them)
- Create only after successful qualification: `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/`
- Create only after at least one successful qualification: `/build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.md`

**Interfaces:**
- Consumes: all five committed receipt-authorized source roots, ignored canonical leaf handoffs for human review only, `buildContentPack({ sourceDirectory, outputPath, deliveryProfile, minAppVersion })`, `validateContentPack({ archivePath, deliveryProfile })` from `scripts/content-packs/lib.mjs`, and `stageHandoffArtifacts({ artifactRoot, receiverHandoffPath, temporaryRoot, entries }) -> Promise<{ ledgerPath: string; archivePaths: string[]; receiverHandoffPath: string }>` from `scripts/content-packs/stage-handoff-artifacts.mjs`.
- Produces: five independent deterministic local candidates or precise blockers; the coordinator advances each independently qualified leaf from `reserved` to `authored` serially, retains exactly one verified canonical external `.sspack` per successful leaf with a non-mutating receiver handoff, and issues owner-stocking handoffs. No bundle coordinator, source-repository archive/key, live catalog state, upload, product, price, or publication mutation is allowed.

- [ ] **Step 1: Write the failing independent-candidate and review-completeness test.**

```js
const sources = [
  'formula/question-ladder',
  'topic/audience-question-seeder',
  'formula/before-after-timeline',
  'thumbnail/object-hero-question',
  'thumbnail/route-map-one-promise',
]
for (const source of sources) {
  const first = join(temporary, `${source.replace('/', '-')}-first.sspack`)
  const second = join(temporary, `${source.replace('/', '-')}-second.sspack`)
  await buildContentPack({ sourceDirectory: resolveSource(source), outputPath: first, deliveryProfile: 'genstudio-store-receipt-v1', minAppVersion: '1.0.843' })
  await buildContentPack({ sourceDirectory: resolveSource(source), outputPath: second, deliveryProfile: 'genstudio-store-receipt-v1', minAppVersion: '1.0.843' })
  assert.deepEqual(await readFile(first), await readFile(second))
  assert.ok((await stat(first)).size <= 52_428_800)
  await validateContentPack({ archivePath: first, deliveryProfile: 'genstudio-store-receipt-v1' })
}
```

Add a staging-helper test using a fresh `mkdtemp(join(tmpdir(), 'story-wave-two-handoff-root-'))` parent and a non-existent child root. Supply only one successful fixture archive after its two temporary builds compare equal. Assert `stageHandoffArtifacts` creates exactly the canonical child `.sspack`, `ledger.json`, and a receiver handoff outside the repository; copies the first verified bytes byte-for-byte; reports the same SHA-256/byte count/`1.0.843`/`genstudio-store-receipt-v1`/original receipt/reviews/component summary; and includes the absolute artifact path in both ledger and receiver handoff. Then assert a second call with the same root rejects with `artifact root already exists`, and a blocked fixture entry creates neither an archive nor ledger row. The test tears down only its `mkdtemp()` parent; it never touches `/build/Developer/_handoffs/`.

```js
await assert.rejects(
  stageHandoffArtifacts({ artifactRoot, receiverHandoffPath, temporaryRoot, entries: [successfulEntry] }),
  /artifact root already exists/i,
)
assert.deepEqual(await readFile(join(artifactRoot, 'question-ladder.sspack')), await readFile(successfulEntry.canonicalArchivePath))
assert.deepEqual(Object.keys(ledger.entries[0]).sort(), [
  'absolute_path', 'bytes', 'component_summary', 'delivery_profile', 'min_app_version', 'receipt_ref', 'reviews', 'sha256', 'slug',
])
assert.equal(ledger.entries.some(entry => entry.slug === 'blocked-leaf'), false)
```

The helper must reject an artifact root located inside the repository, reject a non-absolute receiver handoff path, and write no private key, `key_id`, signature, product/release/account/wire field, quote, price, or upload instruction. It uses only Node.js standard-library file APIs and never calls a network endpoint.

Implement `stageHandoffArtifacts` with `access`, `mkdir`, `copyFile`, `rename`, `readFile`, `writeFile`, `stat`, `createHash`, and path containment checks only. Require an absolute artifact root and receiver path; reject an existing root before `mkdir(artifactRoot, { recursive: false })`; reject every entry whose canonical archive is outside its provided temporary directory, whose `bytes`/SHA-256 disagrees with the source, whose profile/minimum version differs from the exact values above, or whose review evidence is incomplete. Copy entries first into the fresh root's `.staging/`, hash and validate every copied byte there, then rename all verified `.staging/<slug>.sspack` files to `<artifactRoot>/<slug>.sspack` before writing the ledger and receiver handoff. On any failure, remove only the newly created `.staging/` directory, write a non-archive diagnostic in the fresh root, and leave no final `.sspack`, ledger, or receiver handoff; never delete an existing target root because one is rejected before any write.

Add a committed test-local release-summary fixture for the five future leaves and validate its exact v1 contract without reading ignored handoffs:

```js
const componentSummaries = [
  ['formula/question-ladder', { schema_version: 1, kind: 'series-formula', summary: 'A reusable evidence-aware answer ladder from concrete question to bounded conclusion.', slots: { 'series-formula': 1 } }],
  ['topic/audience-question-seeder', { schema_version: 1, kind: 'topic-pack', summary: 'A duplicate-resistant audience-question domain pack with bounded evidence and actionability axes.', slots: { 'topic-pack': 1 } }],
  ['formula/before-after-timeline', { schema_version: 1, kind: 'series-formula', summary: 'A reusable baseline-to-result timeline that keeps confounders and causal limits visible.', slots: { 'series-formula': 1 } }],
  ['thumbnail/object-hero-question', { schema_version: 1, kind: 'thumbnail-recipe', summary: 'A single-object thumbnail grammar with an exact AI-rendered episode-title question.', slots: { 'thumbnail-recipe': 1 } }],
  ['thumbnail/route-map-one-promise', { schema_version: 1, kind: 'thumbnail-recipe', summary: 'A symbolic route-and-promise thumbnail grammar with an exact AI-rendered episode title.', slots: { 'thumbnail-recipe': 1 } }],
]
for (const [source, componentSummary] of componentSummaries) {
  assert.deepEqual(Object.keys(componentSummary).sort(), ['kind', 'schema_version', 'slots', 'summary'])
  assert.equal(componentSummary.schema_version, 1)
  assert.equal(componentSummary.slots[componentSummary.kind], 1)
  assert.equal(Object.keys(componentSummary.slots).length, 1)
  assert.equal(Object.hasOwn(componentSummary, 'pack_id'), false)
  assert.equal(Object.hasOwn(componentSummary, 'item_id'), false)
  assert.equal(Object.hasOwn(componentSummary, 'version'), false)
  assert.equal(Object.hasOwn(componentSummary, 'sha256'), false)
  assert.equal(Object.hasOwn(componentSummary, 'digest'), false)
  assert.equal(Object.hasOwn(componentSummary, 'dependencies'), false)
  assert.equal(Object.hasOwn(componentSummary, 'closure'), false)
  assert.equal(componentSummary.kind, registryRecordFor(source).kind)
}
```

Add lifecycle tests in `scripts/content-packs/__tests__/authoring-registry.test.mjs` for this exact source-path set: a coordinator may transition one receipt-bound, source-complete, independently reviewed, deterministic candidate with `changes: { status: 'authored' }`; the original receipt remains verifiable; each success consumes the current revision and increments it once; a blocked leaf is not transitioned and remains `reserved`; and every Wave 2 transition event has coordinator `{ task: 'reusable-content-primitives-wave-2', branch: 'codex/content-expansion-portfolio' }`. The leaf Tasks 2–6 contain no lifecycle-transition command, and only this coordinator Task 7 may invoke `transition`. The test must inspect committed registry transition events and source paths only, never ignored review notes.

Assert each archive `manifest.json` has no `key_id`, has `min_app_version: '1.0.843'`, each ZIP has no `signature.ed25519`, every component has `dependencies: []`, and the persisted registry has five independent leaves rather than an invented kit record. Do not make committed tests read ignored handoffs or candidate notes.

- [ ] **Step 2: Run the qualification tests and confirm the exact missing gate fails.**

Run:

```bash
node --test scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts
```

Expected: FAIL until every source, receipt, preview ledger, and required independent review result is concrete. A missing review or returned preview must name its specific leaf and blocker; that leaf remains `reserved` and no candidate may be called validated for it.

- [ ] **Step 3: Build only in a temporary directory, validate keyless delivery, and record actual candidate evidence.**

Use `mkdtemp(join(tmpdir(), 'story-wave-two-primitives-'))` and `t.after(() => rm(temporary, { recursive: true, force: true }))`. Build each source twice under `genstudio-store-receipt-v1` with `minAppVersion: '1.0.843'`, compare bytes and SHA-256, validate each archive with the same profile, and record actual digest/size/min-app-version in its ignored leaf handoff. Keep the first byte-identical archive path as that leaf's canonical staging input; delete the second with the temporary directory. No private key, archive, `key_id`, or signature may exist in the repository or outside the temporary directory at this point.

For each independently qualified leaf, the coordinator creates the ignored `lifecycle-requests/` and `lifecycle-results/` directories, reads the current committed registry revision immediately before that leaf's transition, writes an ignored lifecycle request with the original `receipt_ref`, exact receipt-authorized `pack_id` and version, coordinator `{ "task": "reusable-content-primitives-wave-2", "branch": "codex/content-expansion-portfolio" }`, and exactly `changes: { "status": "authored" }`, then runs the transition serially:

```bash
find .superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/lifecycle-requests \
  -maxdepth 1 -type f -name '*.json' -print | sort | while IFS= read -r wave_request; do
  wave_leaf="${wave_request##*/}"
  wave_leaf="${wave_leaf%.json}"
  node --input-type=module - "$wave_request" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises'
const requestPath = process.argv[2]
const [registry, request] = await Promise.all([
  readFile('content-packs/authoring-registry.json', 'utf8').then(JSON.parse),
  readFile(requestPath, 'utf8').then(JSON.parse),
])
request.expected_revision = registry.revision
request.coordinator = { task: 'reusable-content-primitives-wave-2', branch: 'codex/content-expansion-portfolio' }
request.changes = { status: 'authored' }
await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8')
NODE
  npm run content-pack:registry -- transition \
    --request "$wave_request" \
    > ".superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/lifecycle-results/${wave_leaf}.json"
  npm run content-pack:registry -- validate
done
```

After each success, rerun `npm run content-pack:registry -- validate`, read the next observed revision before the next request, and retain the original reservation receipt in all leaf evidence. Do not transition a leaf until its source test, deterministic keyless candidate, all applicable evidence, and all required independent reviews pass. A missing preview/review or failed candidate leaves that exact leaf `reserved`; it does not block independent successful leaves and never receives an invented transition.

After all eligible coordinator transitions have succeeded, stage only those successful leaves. First require that `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/` does not exist; if it exists, stop without deleting, reusing, overwriting, or adding any archive. Call `stageHandoffArtifacts` once with that absolute fresh root, the absolute receiver handoff path `/build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.md`, the exact `mkdtemp()` root holding the first verified candidates as `temporaryRoot`, and entries only for leaves whose committed registry status is `authored`. Each entry supplies its exact slug, first verified temporary archive path, actual SHA-256, bytes, `min_app_version: "1.0.843"`, `delivery_profile: "genstudio-store-receipt-v1"`, immutable original `receipt_ref`, completed independent-review evidence, and exact `component_summary`.

The helper must copy, not move, the first verified archive through the fresh root's `.staging/` directory, hash/decode every copied byte, then rename only verified bytes to the fresh external root before writing `ledger.json`. It writes one JSON ledger entry per successful leaf with exactly `slug`, `absolute_path`, `sha256`, `bytes`, `min_app_version`, `delivery_profile`, `receipt_ref`, `reviews`, and `component_summary`. It writes the receiver handoff only after every staged entry matches the ledger. The receiver handoff names the external root and ledger, lists only successfully authored leaves with their absolute archive paths/digests/sizes/min-app/profile/receipt/reviews/component summaries, and states exactly that it does **not** authorize upload, product or release draft creation, quote, price/discount decision, purchase, grant, publication, or production signing. A blocked leaf appears only as its exact blocker in the receiver handoff and has no archive path, ledger entry, digest, or size.

If no leaf is successful, do not create the external artifact root, ledger, or receiver handoff. If any copy/hash/ledger/receiver-handoff verification fails, preserve the fresh external root with its non-archive diagnostic, mark every affected leaf blocked, remove the new `.staging/` bytes, leave no final archive/ledger/receiver handoff for them, create no stocking handoff for those leaves, and do not retry into a different root without a new owner-directed delivery decision.

Create `wave-2-candidate.yaml` with `status: candidate-validated` only for the successful authored leaves, or `status: blocked` with only the successful leaves plus each exact remaining reserved-leaf blocker. Check each ignored leaf handoff's `component_summary` against the same exact test-local object above: schema version 1, canonical kind matching the committed registry record, short summary, exactly one own-kind slot with count 1, and no ID/version/hash/dependency/closure duplication. Its `content_identities` are copied only from committed receipt-authorized registry identities; successful entries have `dependencies: []`; it has no `kit` object, no price, no product/release/account/wire field, and no signature/private key. Do not backfill `component_summary` into any historical handoff.

For each successful `authored` leaf, issue its corresponding named `-stocking.yaml` file from the File Structure table as `status: ready-for-owner-stocking`, including only its Story identity/version/publisher/min-app-version/digest/size, absolute external archive path, the proposed family/SKU state from the committed registry, `dependencies: []`, completed review evidence, exact `component_summary`, and the deployed delivery-attestation profile. It must state `explicitly_not_done: upload, product or release draft creation, price or discount decision, purchase, grant, publication, production signing`. A blocked leaf gets no stocking handoff; its exact blocker remains in `wave-2-candidate.yaml` and the external receiver handoff.

- [ ] **Step 4: Run all focused gates and repository safety checks.**

Run:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts electron/server/__tests__/content-pack-contract.test.ts electron/server/__tests__/content-pack-archive.test.ts electron/server/__tests__/content-pack-legacy-adapters.test.ts
npm run content-pack:registry -- validate
npm run typecheck:electron
npm run lint
npm run check:security
npm run check:model-drift
find content-packs/reusable-primitives -type f -name '*.sspack' -print
test -f /build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/ledger.json
test -f /build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.md
```

Expected: all tests pass; `find` prints no repository `.sspack`; every successful leaf has one externally retained, ledgered, verified keyless archive; blocked leaves have none; and no runtime, release, checkout, GenStudio, or production-generation mutation is present. If every leaf is blocked, replace the last two `test -f` checks with `test ! -e` for the artifact root and receiver handoff.

- [ ] **Step 5: Commit qualification and coordinator lifecycle material; do not mutate GenStudio.**

```bash
git add content-packs/authoring-registry.json scripts/content-packs/stage-handoff-artifacts.mjs scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "test(content-packs): qualify reusable primitives"
```

Only the coordinator transitions independently qualified leaves to `authored`; leaves remain unable to transition themselves. Do not change family/SKU status, upload candidates, create a GenStudio product/release draft, choose price/discount, purchase, grant, publish, production-sign, release, or make any GenStudio/checkout mutation. The owner/GenStudio may consume a successful `ready-for-owner-stocking` handoff, but that handoff does not authorize any external mutation.

## Plan Self-Review

**Spec coverage:** Tasks 1–7 implement exactly the approved Wave 2 five leaves; separate Formula/Topic/Recipe boundaries; atomic receipt authority; data diversity and duplicate guards; exact-title-only recipe rendering; 3–5 original recipe previews; Studio Hub-only preview flow; explicit returned-preview blockers; independent reviews; deterministic keyless candidate validation; coordinator-only serial `reserved` → `authored` transitions; one retained verified external candidate per successful leaf; and non-mutating owner-stocking/receiver handoffs. No task creates a kit-specific fork, style, coordinator source, fifth schema, price, GenStudio record, checkout change, release, upload, product/release draft, or publication.

**Receipt and identity safety:** The plan names only human names/slugs before reservation. The registry result, not this document, is the sole source of actual Story identities, versions, and family/SKU proposals. Every leaf is blocked without a successful exact receipt verification. After qualification, only coordinator metadata `{ task: "reusable-content-primitives-wave-2", branch: "codex/content-expansion-portfolio" }` may appear in a Wave 2 transition; each successful transition retains its immutable original receipt and uses the current observed revision, while blocked leaves remain `reserved`.

**Preview and delivery safety:** Task 5 sends one batched Studio Hub brief for both Recipes, but does not execute production generation. Each Recipe has an exact missing-return blocker and cannot be authored/archived without actual original WebP evidence. Local work is decode/hash/review only. Task 7 retains only verified successful candidate bytes in the one fresh external root, with absolute-path/hash/byte/min-app/profile/receipt/review/component-summary ledger evidence and a non-mutating receiver handoff; repository sources, keys, and blocked leaves remain archive-free.

**Placeholder scan:** The plan contains no future component identity, no invented preview byte/provenance/digest, no unbounded `appropriate` validation step, and no implied paid authorization. The only symbolic shape is the explicitly supplied release `component_summary` contract; every leaf uses its concrete `kind`, summary, and one-slot object. All creation, test, handoff, source, and archive paths are explicit.

**Type consistency and strict schemas:** Source documents use the installed strict `series-formula`, `topic-pack`, and `thumbnail-recipe` schemas; `component_summary` is tested and recorded only in the release handoff, never source JSON. Formula/Topic compatibility and every nonempty Recipe compatibility list use committed receipt-authorized leaf `item_id`s only; Route Map + One Promise remains empty until its future bounded route/activity Formula is qualified. Candidate manifests use release-parameterized source manifests, `genstudio-store-receipt-v1`, and exact `min_app_version: '1.0.843'`; they contain neither `key_id` nor `signature.ed25519`. Lifecycle transition requests use the registry's strict `expected_revision`, original `receipt_ref`, exact `pack_id`, exact version, fixed coordinator shape, and sole `status: authored` change; they do not mutate family/SKU.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-23-reusable-content-primitives-wave-2.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.

2. **Inline Execution** — execute tasks in this session using executing-plans, with receipt and preview gates as stop points.

Begin with Task 1 only. Do not author any leaf before all five receipt verifications succeed; do not author either Recipe without its qualifying returned previews and completed independent reviews. Task 7 alone advances a qualified leaf to `authored`; a blocked leaf remains `reserved` and has no owner-stocking handoff.
