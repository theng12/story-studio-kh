# Wave 2 Reusable Content Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify exactly five independently reusable Wave 2 Content Pack components: Question Ladder Formula, Audience Question Seeder Topic Pack, Before/After Timeline Formula, Object Hero + Question Thumbnail Recipe, and Route Map + One Promise Thumbnail Recipe.

**Architecture:** Add two `series-formula` leaves, one `topic-pack` leaf, and two `thumbnail-recipe` leaves under `content-packs/reusable-primitives/`; do not create a kit, style, coordinator source, runtime schema, or kit-specific fork. One coordinator owns the single cross-wave registry mutation lane shared with the Symbolic Psychology plan: every reservation/transition revalidates the registry, reads the then-current revision, and executes serially through the registry's existing lock plus compare-and-swap. Source authoring may proceed independently after reservation, but registry and shared-test integration commits may not overlap. Recipe preview work is a Studio Hub control-plane handoff to an explicitly named worker, or owner-supplied original bytes; no generation runs on this control Mac.

**Tech Stack:** JSON Content Pack schemas and handoffs, Node.js `node:test`, TypeScript/TSX tests, Sharp WebP decoding, existing deterministic `.sspack` builder/validator, and keyless `genstudio-store-receipt-v1` candidate validation.

**Spec:** `docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md`; `content-packs/authoring-registry.json`; `/build/.codex/skills/story-studio-channel-kit-authoring/references/component-handoff-contract.md`.

## Global Constraints

- Scope is exactly the five standalone components named in the goal. Do not author a Channel Kit, Visual Style, fifth creative schema, runtime catalog entry, or kit-specific copy.
- The exact proposal matrix below is owner-approved input to the registry, not pre-reserved state. Its values become authoritative only if one atomic five-record reservation succeeds and the persisted receipt verifies them exactly. Leaves must not create source before receipt verification and must never repair, renumber, reserve, or transition their own record.
- At plan amendment time the registry is valid at revision `18`; this is evidence, not an `expected_revision` constant. Task 1 and every Task 7 transition must re-run validation and populate `expected_revision` from the immediately current persisted revision. A stale revision, `.lock` collision, changed bytes, or competing Symbolic mutation fails fast; revalidate and reconstruct the request from current state rather than retrying stale JSON.
- There is exactly one cross-wave registry mutation lane for this Wave 2 plan and `2026-08-23-symbolic-psychology-studio-unblock.md`. Only the active coordinator may enter it. Reservation and transition calls are serialized one at a time; after each call the coordinator validates the returned revision before the next call. Source-only work on disjoint roots may run in parallel after Task 1, but no two workers may concurrently edit/commit `content-packs/authoring-registry.json`, `scripts/content-packs/__tests__/authoring-registry.test.mjs`, or `electron/server/__tests__/reusable-content-primitives-source.test.ts`.
- Every Formula/Topic pair declares explicit two-way compatibility, coverage, diversity axes, incompatible combinations, a duplicate/recency guard, evidence boundaries, and no medical/legal certainty, coercion, diagnosis, fabricated causality, or one-size-fits-all directives.
- Both recipes use `layout: "hero"`, `aspect_ratio: "16:9"`, `title_mode: "ai"`, `headline_mode: "episode-title"`, and require the selected image model to render the complete exact episode title inside the title-safe band. Do not create a text-free, overlay, masking, or post-render compositing path; scene and thumbnail generation remain separate.
- Each recipe needs exactly three original, materially distinct `1672x941` WebP preview bytes in this wave. They must vary subject, side/angle/distance, setting, palette/symbol, and 1/2/3-line headline arrangement while retaining the recipe hierarchy. A merely 16:9, resized-without-ledger, palette-only, or near-duplicate variation does not count.
- The control/development Mac must not make a production or paid generation request, upload, purchase, publish, deploy, push, sign with a production key, use production keys, create GenStudio product/release/account/wire data, select a price/discount, or change checkout/Store transport. Studio Hub is only the control plane for a preview handoff: it may dispatch the exact approved batch to a named worker only after the exact quote and explicit owner job authority are recorded. Alternatively, the owner may supply original bytes with the same provenance/rights evidence. Neither route authorizes this Mac to generate.
- Every leaf candidate uses the keyless `genstudio-store-receipt-v1` delivery profile with exact resolved `min_app_version: "1.0.843"`: no archive `key_id`, no `signature.ed25519`, no private key, exact deterministic bytes, dependency closure `[]`, and at most 52,428,800 bytes. Build twice in a test/candidate `mkdtemp()` root and validate both; only successful leaves may later be copied by the separate real external-staging step. No blocked leaf receives an external archive. A test-only signed lane is out of scope.
- Every leaf authoring handoff has exactly `status`, `component`, `reservation`, `identity`, `stocking_proposal`, `source`, `intent`, `compatibility`, `dependencies`, `originality_provenance`, `evidence`, `review_requests`, and `blocked_by`. It does **not** contain `component_summary`. The evidence object has `schema`, `coverage_uniqueness`, `golden_prompt_parity`, `decoded_previews`, `tests`, and `deterministic_build`, each with a concrete pass, inapplicable reason, or blocker.
- `component_summary` appears only in the final `release-handoff.json`, the external receiver handoff, and each successful leaf's final stocking handoff. Its exact v1 shape is `{"schema_version":1,"kind":"<canonical kind>","summary":"<short prose>","slots":{"series-formula":N,"topic-pack":N,"visual-style":N,"thumbnail-recipe":N}}`; omit every zero slot. Each leaf has exactly one own-kind slot with count `1`, and the object duplicates no ID, version, hash, dependency, or closure. A semantic recursive key scan over parsed fresh JSON and archive JSON must prove that registry, source, preview ledger, candidate/build evidence, and archive manifests contain no `component_summary`; do not use a raw text grep and do not backfill historical handoffs.
- Partial qualification is explicit. Task 7 computes `eligibleLeaves` from the five fixed slugs; a leaf enters only when receipt, source, focused tests, deterministic build, applicable evidence, and every named independent review pass. A recipe with missing preview evidence remains `reserved`, source/archive/stocking-free, and absent from `eligibleLeaves`; it does not block the three text leaves. After staging, the wave-level candidate status is recomputed as `candidate-validated` iff all five fixed leaves are eligible, authored, and delivered, `blocked_leaves` is empty, and staging is `complete`; every other outcome is `blocked` while successful leaf entries remain truthfully listed.
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
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}.json` | Ignored canonical leaf authoring handoff; no `component_summary`; committed tests prove durable source/registry facts only. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/wave-2-candidate.json` | Ignored candidate/blocked wave handoff listing exact `eligibleLeaves` plus per-leaf blockers; no `component_summary` and no coordinator pack. |
| `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}-stocking.json` | Ignored final `ready-for-owner-stocking` handoff for each delivered leaf; this is one of only three permitted `component_summary` locations. |
| `content-packs/reusable-primitives/formula/question-ladder/{pack.json,content/series-formula.json}` | Receipt-bound Question Ladder Formula source. |
| `content-packs/reusable-primitives/topic/audience-question-seeder/{pack.json,content/topic-pack.json}` | Receipt-bound Audience Question Seeder Topic Pack source. |
| `content-packs/reusable-primitives/formula/before-after-timeline/{pack.json,content/series-formula.json}` | Receipt-bound Before/After Timeline Formula source. |
| `content-packs/reusable-primitives/thumbnail/object-hero-question/{pack.json,content/thumbnail-recipe.json,assets/*.webp}` | Receipt-bound Object Hero + Question Recipe and only its declared returned preview bytes. |
| `content-packs/reusable-primitives/thumbnail/route-map-one-promise/{pack.json,content/thumbnail-recipe.json,assets/*.webp}` | Receipt-bound Route Map + One Promise Recipe and only its declared returned preview bytes. |
| `content-packs/reusable-primitives/PREVIEW-PROVENANCE.md` | Immutable ledger for qualifying returned preview bytes only: provenance/rights, returned source, WebP decode data, byte size, and SHA-256. Blocked/no-byte evidence stays only in the ignored leaf handoff and never creates or changes this file. |
| `scripts/content-packs/stage-handoff-artifacts.mjs` | Dependency-free external-staging helper with no-follow reads, physical containment checks, exclusive writes, staged-copy validation, explicit cleanup, and truthful phase outcomes. |
| `electron/server/__tests__/reusable-content-primitives-source.test.ts` | Source schemas, Formula/Topic/Recipe compatibility, diversity, safety, exact-title, provenance, and no-runtime-secret regression tests. |
| `scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs` | Deterministic keyless candidate archive, size, closure, and delivery-profile tests. |
| `scripts/content-packs/__tests__/authoring-registry.test.mjs` | Five-record atomic receipt and receipt verification regression coverage. |
| `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}.sspack` | One retained verified canonical candidate per successful leaf only; this fresh external root fails closed if it already exists. |
| `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/ledger.json` | Machine ledger with absolute archive path, SHA-256, byte count, `min_app_version`, profile, original receipt, and reviews for each delivered leaf; no `component_summary`. |
| `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/release-handoff.json` | Final release handoff for delivered leaves; first permitted `component_summary` location. |
| `/build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.json` | Exact non-mutating receiver handoff; second permitted `component_summary` location; absent when no leaf is delivered. |

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

Every qualifying returned preview must already decode as WebP at exactly `1672x941`; this wave does not resize, crop, re-encode, overlay, or otherwise normalize a return into compliance. Each prompt and returned-evidence row uses the exact sample title and requested line arrangement below. A line break may arrange the exact words but may not change, omit, duplicate, or add text or punctuation.

| Preview | Exact sample episode title | Required headline arrangement | Distinct visual brief |
| --- | --- | --- | --- |
| `object-hero-question-1.webp` | `WHY DOES THIS WRENCH MATTER?` | exactly 1 line | repair wrench, three-quarter side, medium distance, workshop, copper/blue |
| `object-hero-question-2.webp` | `WHAT DOES THIS ENERGY METER CHANGE?` | exactly 2 lines | household energy meter, frontal close view, utility setting, amber/charcoal |
| `object-hero-question-3.webp` | `CAN A FIELD NOTEBOOK WORK?` | exactly 3 lines | field notebook, top-left angle, medium distance, outdoor table, green/cream |
| `route-map-one-promise-1.webp` | `A BETTER WAY TO WALK THE PARK LOOP` | exactly 1 line | symbolic park loop, high three-quarter angle, curved start/end line, leaf-green/cream |
| `route-map-one-promise-2.webp` | `THE SIMPLE ROUTE TO A NEIGHBORHOOD WALK` | exactly 2 lines | symbolic neighborhood sequence, medium distance, dotted line/landmark icon, brick/sky-blue |
| `route-map-one-promise-3.webp` | `ONE REALISTIC WAY TO LEARN A NEW SKILL` | exactly 3 lines | symbolic learning path, close top-down view, three unlabeled stations, violet/sand |

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

Only the final `release-handoff.json`, external receiver handoff, and successful per-leaf stocking handoffs add this release-only field. Authoring and candidate handoffs do not:

```json
{
  "schema_version": 1,
  "kind": "series-formula",
  "summary": "A reusable evidence-aware answer ladder from concrete question to bounded conclusion.",
  "slots": { "series-formula": 1 }
}
```

For Audience Question Seeder, use `kind: "topic-pack"` and `slots: { "topic-pack": 1 }`. For Object Hero + Question and Route Map + One Promise, use `kind: "thumbnail-recipe"` and `slots: { "thumbnail-recipe": 1 }`. Before/After Timeline uses the same `series-formula` slot shape as Question Ladder with a short baseline/change/timeline summary. Do not add a `visual-style` zero key, any identifier/version/digest, or a five-component aggregate summary; each release is independently summarized and no pre-existing handoff changes.

## Exact Five-Record Reservation Proposal

These are the exact five request records Task 1 submits together. `{{MIN_APP_VERSION}}` is the literal registry token and each `min_app_version_status` is `release-bound`; it resolves to the separate candidate floor `1.0.843` only during Task 7 builds.

| Human name / kind | Canonical `pack_id` / `item_id` | Release fields | `source_path` | Lifecycle / dependencies | Stocking proposal |
| --- | --- | --- | --- | --- | --- |
| Question Ladder / `series-formula` | `com.storystudio.pack.formula.question-ladder` / `com.storystudio.formula.question-ladder` | `version: 1.0.0`; `publisher_id: com.storystudio`; `min_app_version: {{MIN_APP_VERSION}}`; `min_app_version_status: release-bound` | `content-packs/reusable-primitives/formula/question-ladder` | `status: reserved`; `dependencies: []` | family `com.storystudio.family.formula.question-ladder` `proposed`; SKU `com.storystudio.sku.formula.question-ladder` `proposed` |
| Audience Question Seeder / `topic-pack` | `com.storystudio.pack.topic.audience-question-seeder` / `com.storystudio.topic.audience-question-seeder` | `version: 1.0.0`; `publisher_id: com.storystudio`; `min_app_version: {{MIN_APP_VERSION}}`; `min_app_version_status: release-bound` | `content-packs/reusable-primitives/topic/audience-question-seeder` | `status: reserved`; `dependencies: []` | family `com.storystudio.family.topic.audience-question-seeder` `proposed`; SKU `com.storystudio.sku.topic.audience-question-seeder` `proposed` |
| Before/After Timeline / `series-formula` | `com.storystudio.pack.formula.before-after-timeline` / `com.storystudio.formula.before-after-timeline` | `version: 1.0.0`; `publisher_id: com.storystudio`; `min_app_version: {{MIN_APP_VERSION}}`; `min_app_version_status: release-bound` | `content-packs/reusable-primitives/formula/before-after-timeline` | `status: reserved`; `dependencies: []` | family `com.storystudio.family.formula.before-after-timeline` `proposed`; SKU `com.storystudio.sku.formula.before-after-timeline` `proposed` |
| Object Hero + Question / `thumbnail-recipe` | `com.storystudio.pack.thumbnail.object-hero-question` / `com.storystudio.thumbnail.object-hero-question` | `version: 1.0.0`; `publisher_id: com.storystudio`; `min_app_version: {{MIN_APP_VERSION}}`; `min_app_version_status: release-bound` | `content-packs/reusable-primitives/thumbnail/object-hero-question` | `status: reserved`; `dependencies: []` | family `com.storystudio.family.thumbnail.object-hero-question` `proposed`; SKU `com.storystudio.sku.thumbnail.object-hero-question` `proposed` |
| Route Map + One Promise / `thumbnail-recipe` | `com.storystudio.pack.thumbnail.route-map-one-promise` / `com.storystudio.thumbnail.route-map-one-promise` | `version: 1.0.0`; `publisher_id: com.storystudio`; `min_app_version: {{MIN_APP_VERSION}}`; `min_app_version_status: release-bound` | `content-packs/reusable-primitives/thumbnail/route-map-one-promise` | `status: reserved`; `dependencies: []` | family `com.storystudio.family.thumbnail.route-map-one-promise` `proposed`; SKU `com.storystudio.sku.thumbnail.route-map-one-promise` `proposed` |

### Task 1: Reserve and verify one exact coordinator batch; commit only passing reservation coverage

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

**Interfaces:**
- Consumes: `reserveAuthoringBatch({ registryPath, repositoryRoot, request }) -> Promise<{ revision: number; receipt_ref: string }>` and `verifyAuthoringReceipt({ registryPath, repositoryRoot, revision, receiptRef, expectedIdentity }) -> Promise<{ revision: number; receipt_ref: string; identity: AuthoringRecord }>` from `scripts/content-packs/authoring-registry.mjs`.
- Produces: one committed exact five-record reservation at one revision, one `authoring:<sha256>` receipt, passing durable registry coverage, and ignored coordinator/leaf working notes for receipt verification. It produces no source test and commits no RED state.

- [ ] **Step 1: Enter the single mutation lane, revalidate current state, and materialize the exact matrix.**

Confirm no Symbolic coordinator is currently mutating the registry, run `npm run content-pack:registry -- validate`, and read the current persisted revision (revision `18` was only the planning baseline). Create ignored `component-briefs.json`, then construct `reservation-request.json` from the exact five rows above with coordinator `{ "task": "reusable-content-primitives-wave-2", "branch": "codex/content-expansion-portfolio" }` and `proposal_ref: "docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md"`. Immediately re-read/validate the registry before invoking reserve. If validation fails, the revision changed, `.lock` exists, a record collides, or any exact row differs, exit the lane and record this blocker; create no source, manifest, candidate archive, stocking handoff, or GenStudio record:

```text
status: blocked
blocker: Registry task required
needed: coordinator-owned authoring catalog registry with collision-safe reservation
requested_records: series-formula Question Ladder; topic-pack Audience Question Seeder; series-formula Before/After Timeline; thumbnail-recipe Object Hero + Question; thumbnail-recipe Route Map + One Promise
do_not_create: Story content IDs, family/SKU proposals, manifests, candidate archives, GenStudio records
```

- [ ] **Step 2: Submit the exact batch atomically with fail-fast CAS.**

Reserve once and capture only its machine output:

```bash
npm run content-pack:registry -- reserve \
  --request .superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-request.json \
  > .superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/reservation-result.json
```

Expected: exactly one JSON result `{ "revision": <previous + 1>, "receipt_ref": "authoring:<64 lowercase hex>" }`. Do not automatically retry a stale-CAS or lock failure. Revalidate the current registry, reconcile the competing Symbolic event, reconstruct `expected_revision`, and re-enter the lane only after the earlier mutation is committed and green.

- [ ] **Step 3: Materialize and verify each exact returned identity without hand-derived values.**

Read committed `content-packs/authoring-registry.json`, select only the five records whose `receipt_ref` equals `reservation-result.json.receipt_ref`, remove `receipt_ref`, and write them to the ignored corresponding expected-identity files by matching the approved human `source_path`. Each record must have exactly the coordinator-submitted value; receipt verification must prove the persisted registry, receipt, and expected record agree:

```bash
node --input-type=module - <<'NODE'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyAuthoringReceipt } from './scripts/content-packs/authoring-registry.mjs'

const handoff = '.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2'
const receipt = JSON.parse(await readFile(join(handoff, 'reservation-result.json'), 'utf8'))
const registry = JSON.parse(await readFile('content-packs/authoring-registry.json', 'utf8'))
const sourceToName = new Map([
  ['content-packs/reusable-primitives/formula/question-ladder', 'question-ladder.json'],
  ['content-packs/reusable-primitives/topic/audience-question-seeder', 'audience-question-seeder.json'],
  ['content-packs/reusable-primitives/formula/before-after-timeline', 'before-after-timeline.json'],
  ['content-packs/reusable-primitives/thumbnail/object-hero-question', 'object-hero-question.json'],
  ['content-packs/reusable-primitives/thumbnail/route-map-one-promise', 'route-map-one-promise.json'],
])
const records = registry.records.filter(record => record.receipt_ref === receipt.receipt_ref)
if (records.length !== sourceToName.size) throw new Error(`expected 5 receipt records, got ${records.length}`)
await mkdir(join(handoff, 'expected-identities'), { recursive: true })
for (const record of records) {
  const name = sourceToName.get(record.source_path)
  if (!name) throw new Error(`unexpected receipt source ${record.source_path}`)
  const { receipt_ref: _receiptRef, ...expectedIdentity } = record
  await writeFile(join(handoff, 'expected-identities', name), `${JSON.stringify(expectedIdentity, null, 2)}\n`, { flag: 'wx' })
  const verified = await verifyAuthoringReceipt({ revision: receipt.revision, receiptRef: receipt.receipt_ref, expectedIdentity })
  console.log(`${name}: ${verified.identity.pack_id}@${verified.identity.version}`)
}
NODE
```

Expected: exactly five printed receipt-authorized releases. A mismatch, missing expected file, or nonzero command is a fail-closed blocker for that leaf. The ignored expected identity is a verification input only; the committed registry is the durable source of truth.

- [ ] **Step 4: Write only durable passing reservation tests after receipt verification.**

Add one test in `scripts/content-packs/__tests__/authoring-registry.test.mjs` that reads only committed `content-packs/authoring-registry.json`, selects the exact five source paths, and deep-compares every persisted request field to the proposal matrix. Assert exactly five records share one new receipt/batch revision and coordinator, all are `reserved`, all dependencies are `[]`, all family/SKU statuses are `proposed`, and `verifyAuthoringReceipt` succeeds for all five exact expected identities. Do not import/read `.superpowers/sdd`, do not require absent sources, and do not create the Wave 2 source test yet.

- [ ] **Step 5: Run the passing reservation gate and commit GREEN.**

Run:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npm run content-pack:registry -- validate
git diff --check
```

Expected: every command passes with five new `reserved` records sharing one receipt. Commit only durable green files; `.superpowers/sdd` stays ignored and is never added:

```bash
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/authoring-registry.test.mjs
git commit -m "chore(content-packs): reserve reusable primitive identities"
```

Release the cross-wave registry lane only after the commit is green. Task 1 never commits a failing test.

### Task 2: Author the receipt-bound Question Ladder Formula

**Files:**
- Create: `content-packs/reusable-primitives/formula/question-ladder/pack.json`
- Create: `content-packs/reusable-primitives/formula/question-ladder/content/series-formula.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/question-ladder.json`
- Create: `electron/server/__tests__/reusable-content-primitives-source.test.ts`

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

Write ignored `handoffs/question-ladder.json` with exactly the Component Handoff Contract authoring fields and no `component_summary`. Set `dependencies: []`; list the Topic and Recipe as compatibility facts, not pack dependencies. Evidence marks schema/coverage-uniqueness/golden-prompt-parity/tests with their named check results, `decoded_previews` as `not_applicable` because a Formula has no preview asset, and `deterministic_build` as `not_applicable` until Task 7. Review requests name every required independent review and mark visual/thumbnail `not_applicable` with `Formula has no preview asset`.

- [ ] **Step 4: Run the Formula test and commit.**

Run: `npx tsx --test --test-name-pattern "Question Ladder" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: the entire newly created Wave 2 source test passes; it contains only Question Ladder coverage at this task boundary. Run `git diff --check`, then commit the GREEN leaf and its test. Never pre-add failing tests for later leaves:

```bash
git add content-packs/reusable-primitives/formula/question-ladder electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add question ladder formula"
```

### Task 3: Author the receipt-bound Audience Question Seeder Topic Pack

**Files:**
- Create: `content-packs/reusable-primitives/topic/audience-question-seeder/pack.json`
- Create: `content-packs/reusable-primitives/topic/audience-question-seeder/content/topic-pack.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/audience-question-seeder.json`
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

Write the ignored canonical authoring handoff with no `component_summary`, `dependencies: []`, exact Question Ladder compatibility, source path, safety/originality boundary, and evidence. `golden_prompt_parity` is `not_applicable` because this pack does not make a Formula continuity claim; `decoded_previews` and visual/thumbnail review are `not_applicable` because it has no raster asset. Do not add a future Formula ID merely because the prose says it could later be compatible.

- [ ] **Step 4: Run the source test and commit.**

Run: `npx tsx --test --test-name-pattern "Question Ladder|Audience Question Seeder" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: the complete current Wave 2 source file passes both committed leaf subtests, including deterministic duplicate rejection. Run `git diff --check`, then commit GREEN; no later-leaf RED is present:

```bash
git add content-packs/reusable-primitives/topic/audience-question-seeder electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add audience question seeder"
```

### Task 4: Author the receipt-bound Before/After Timeline Formula

**Files:**
- Create: `content-packs/reusable-primitives/formula/before-after-timeline/pack.json`
- Create: `content-packs/reusable-primitives/formula/before-after-timeline/content/series-formula.json`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/before-after-timeline.json`
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

Set `channel_promise` to `Baseline → Change → Evidence Boundary`; require named baseline, intervention/change, time window, measurements/observations, confounders, and bounded result in every episode. Set `compatible_topic_pack_ids: []` and `default_topic_pack_ids: []`: Challenge & Progress and Case Study work are future compatibility reviews, not pack dependencies or identities in this wave. Recommend the committed receipt-authorized Object Hero + Question recipe without making it a default. The ignored authoring handoff contains no `component_summary`; it has `dependencies: []`, `golden_prompt_parity` against the six-stage timeline prompt fixture, preview evidence and visual review inapplicable, and the commercial-boundary review required.

- [ ] **Step 4: Run the source test and commit.**

Run: `npx tsx --test --test-name-pattern "Question Ladder|Audience Question Seeder|Before/After Timeline" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: the complete current Wave 2 source file passes all three text-leaf subtests. Run `git diff --check`, then commit GREEN with no recipe RED present:

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
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/object-hero-question.json`
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

For every preview assert WebP decode succeeds and `width === 1672`, `height === 941`; compare the OCR/manual visual-review transcription to the exact sample title; and require the ledger's SHA-256, byte size, rights basis, named worker or owner-supplied source, prompt hash, quote/authority reference where worker-executed, subject, side/angle, distance, setting, palette/symbol, and line count. Require line counts `[1, 2, 3]` and no two records sharing all six diversity fields.

- [ ] **Step 2: Run the source test and confirm it fails.**

Run: `npx tsx --test --test-name-pattern "Object Hero + Question" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: FAIL because neither declared source nor returned preview evidence exists.

- [ ] **Step 3: Prepare one Studio Hub control-plane request for both recipes; do not dispatch without authority.**

Write `preview-batch.json` with the six exact rows above, one literal prompt per row, exact `1672x941` WebP output, and the exact title/line arrangement embedded in that row's prompt. Every Object prompt says: render that complete exact title in the upper-third band, no extra text, overlay, logo, copied asset, or second hero.

Studio Hub receives this only as a control-plane brief. Before any execution it must return an exact quote and the owner must give explicit authority for that quote and job; only then may Studio Hub assign the batch to a named worker and record that worker in the return. Do not name/select a provider/model or claim Studio Hub itself rendered bytes. The alternative is owner-supplied original bytes. Either return must include original bytes, exact prompt and batch hash, source/provenance, rights/license basis, SHA-256, decoded `1672x941` dimensions, byte size, exact-title transcription, and line-count/variation inventory. This Mac sends no production/paid request.

If bytes are missing, malformed, not original, have no rights basis, fail decode, omit the AI-rendered complete headline, are clipped/misspelled/UI-contaminated/copied/near-duplicate, or do not meet the diversity matrix, write this exact blocker only to the ignored recipe handoff, omit the recipe source/candidate archive, do not create or modify `PREVIEW-PROVENANCE.md`, and stop this recipe task:

```text
BLOCKED: Returned Object Hero + Question previews are missing qualified original WebP evidence. Needed: all three exact 1672x941 WebPs with the exact sample titles and 1/2/3-line arrangements, named-worker quote/owner authority or owner-supplied origin, provenance/rights basis, byte size, SHA-256, and six-axis diversity coverage. No production or paid generation request is authorized on this control Mac.
```

On this blocker, keep the registry record `reserved`; create no recipe source, asset, archive, external artifact, or stocking handoff. Record the blocker only in ignored `handoffs/object-hero-question.json`; do not create/modify committed `PREVIEW-PROVENANCE.md`. Remove the local Object-specific RED test hunk, rerun the committed source suite GREEN, and continue to Task 6/Task 7 so the three text leaves are not blocked. Re-add the RED hunk when complete bytes arrive.

- [ ] **Step 4: Verify returned assets locally and author the recipe only when all three qualify.**

Use Sharp to decode the exact returned bytes and `createHash('sha256')` to record actual dimensions/digests; reject rather than transform any byte stream not already `1672x941`. Create the source with the strict exact-title contract above, `headline_formats` listed in Exact Recipe Title Contracts, `compatible_formula_ids` containing only the two committed receipt-authorized Formula identities, and no hard-coded visual medium/palette contract beyond neutral readability. Write the ignored authoring handoff with no `component_summary`, actual decoded-preview evidence, and all independent review requests.

- [ ] **Step 5: Run the recipe source test and commit.**

Run: `npx tsx --test --test-name-pattern "Object Hero + Question" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: the complete committed Wave 2 source suite passes only with three qualifying returned previews and a complete ledger. Run `git diff --check`, then commit GREEN; never commit the recipe RED by itself:

```bash
git add content-packs/reusable-primitives/thumbnail/object-hero-question content-packs/reusable-primitives/PREVIEW-PROVENANCE.md electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add object hero question recipe"
```

### Task 6: Author Route Map + One Promise only after its returned preview bytes qualify

**Files:**
- Create: `content-packs/reusable-primitives/thumbnail/route-map-one-promise/pack.json`
- Create: `content-packs/reusable-primitives/thumbnail/route-map-one-promise/content/thumbnail-recipe.json`
- Create: `content-packs/reusable-primitives/thumbnail/route-map-one-promise/assets/route-map-one-promise-{1,2,3}.webp`
- Create or modify only with qualifying returned bytes: `content-packs/reusable-primitives/PREVIEW-PROVENANCE.md`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/route-map-one-promise.json`
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

For all three assets also assert exact `1672x941` WebP decode, exact sample title transcription, line arrangements `[1, 2, 3]`, six-axis diversity, and complete named-worker/owner provenance evidence. The empty Formula list is deliberate: Weekend Guides does not exist in this wave. The recipe describes its intended bounded route/activity compatibility in the handoff, but does not invent a Formula identity.

- [ ] **Step 2: Run the source test and confirm it fails.**

Run: `npx tsx --test --test-name-pattern "Route Map + One Promise" electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: FAIL because the route source and qualified returned bytes are absent.

- [ ] **Step 3: Complete the Route Map portion of the same preview batch and enforce the returned-byte blocker.**

Use the three exact Route rows already written into `preview-batch.json`; do not edit their exact titles, `1672x941` output rule, or 1/2/3-line arrangements after quote/authority. Every prompt says the route is symbolic only, with no factual map/scale/boundary/business claim, logo, endorsement, extra text, or post-render text. The same Studio Hub control-plane gate applies: exact quote, explicit owner job authority, then named-worker execution, or owner-supplied originals.

If any required return evidence is absent or the output violates the safety/title/diversity checks, record this exact blocker, do not create the source or archive, and return the leaf handoff as blocked:

```text
BLOCKED: Returned Route Map + One Promise previews are missing qualified original WebP evidence. Needed: all three exact 1672x941 WebPs with the exact sample titles and 1/2/3-line arrangements, named-worker quote/owner authority or owner-supplied origin, provenance/rights basis, byte size, SHA-256, and six-axis diversity coverage. No production or paid generation request is authorized on this control Mac.
```

On this blocker, keep the record `reserved`; create no recipe source, asset, archive, external artifact, or stocking handoff. Record only the ignored leaf blocker, remove the local Route-specific RED hunk, prove the committed suite remains GREEN, and continue to Task 7 with the exact text-leaf `eligibleLeaves` subset.

- [ ] **Step 4: Verify qualifying bytes, implement the source, and write the canonical recipe handoff.**

Only after local decode/hash verification proves each returned byte stream is already exact `1672x941`, write the receipt-bound source with `compatible_formula_ids: []`, the three headline formats specified above, and explicit symbolic/non-navigational restrictions. The ignored authoring handoff has no `component_summary`; it records `dependencies: []`, future bounded route/activity compatibility as a non-identity prose condition, actual preview evidence, and all independent review requests. It must not list Weekend Guides by guessed ID.

- [ ] **Step 5: Run the recipe test and commit.**

Run: `npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts`

Expected: PASS for every source leaf actually committed. If Object Hero is blocked, its test/source remain absent and Route may still pass independently; if Route is blocked, no Route RED is committed. Run `git diff --check`, then commit GREEN only when this Route leaf itself qualifies:

```bash
git add content-packs/reusable-primitives/thumbnail/route-map-one-promise content-packs/reusable-primitives/PREVIEW-PROVENANCE.md electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "feat(content-packs): add route map promise recipe"
```

### Task 7: Qualify an explicit partial set, serialize transitions, and stage external handoffs truthfully

**Files:**
- Create: `scripts/content-packs/stage-handoff-artifacts.mjs`
- Create: `scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs`
- Modify: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Modify: `content-packs/authoring-registry.json`
- Modify: `electron/server/__tests__/reusable-content-primitives-source.test.ts`
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/wave-2-candidate.json` (ignored)
- Create: `.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs/{question-ladder,audience-question-seeder,before-after-timeline,object-hero-question,route-map-one-promise}-stocking.json` for delivered leaves only (ignored)
- Create only after at least one leaf is delivered: `/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/{*.sspack,ledger.json,release-handoff.json}`
- Create only after at least one leaf is delivered: `/build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.json`

**Interfaces:**
- Consumes: the fixed five registry records, only source roots that actually exist, ignored authoring/review evidence, `buildContentPack({ sourceDirectory, outputPath, deliveryProfile, minAppVersion })`, and `validateContentPack({ archivePath, deliveryProfile })` from `scripts/content-packs/lib.mjs`.
- Produces: `eligibleLeaves: WaveLeaf[]`, where a leaf is included only after all of its applicable gates pass; serialized coordinator transitions for that set; and `stageHandoffArtifacts({ repositoryRoot, candidateRoot, artifactRoot, receiverHandoffPath, allowedSlugs, eligibleSlugs, entries, blockedEntries }, { afterPhase? } = {}) -> Promise<{ phase: 'complete'; archivePaths: string[]; ledgerPath: string; releaseHandoffPath: string; receiverHandoffPath: string }>` for successfully transitioned leaves. `allowedSlugs` is the exact unique fixed five-slug wave set; `eligibleSlugs` is the exact unique authored∩eligible set. `entries` carry the final summary only so the helper can write the allowed final release/receiver surfaces; `blockedEntries` are exact `{ slug, blocker }` records with no archive metadata. The optional phase hook is a test-only failure-injection seam and the real coordinator never supplies it.

- [ ] **Step 1: Write local RED tests for independent qualification, secure staging, and summary placement.**

Create the pack test with the fixed leaf order:

```js
const waveLeaves = [
  ['question-ladder', 'formula/question-ladder'],
  ['audience-question-seeder', 'topic/audience-question-seeder'],
  ['before-after-timeline', 'formula/before-after-timeline'],
  ['object-hero-question', 'thumbnail/object-hero-question'],
  ['route-map-one-promise', 'thumbnail/route-map-one-promise'],
]
```

Require all three text source roots to exist. For each existing source, build twice in a test-owned `mkdtemp(join(tmpdir(), 'story-wave-two-pack-test-'))`, compare exact bytes and SHA-256, enforce `<= 52_428_800`, and call `validateContentPack` on **both** archives with `deliveryProfile: 'genstudio-store-receipt-v1'`. Inspect archive JSON and assert `min_app_version: '1.0.843'`, `dependencies: []`, no `key_id`, no `signature.ed25519`, and no recursive JSON key named `component_summary`. Only either Recipe root may be absent; in that case require its matching committed registry record to remain `reserved`. Thus a preview blocker is an allowed leaf-local outcome but cannot hide a missing text deliverable.

Evolve the Task 1 durable test in `scripts/content-packs/__tests__/authoring-registry.test.mjs`; do not leave its initial current-record `all reserved` assertion in place after transitions. Select the one persisted Wave 2 batch by its exact coordinator and receipt. Deep-compare `batch.request.records` to the five original proposal rows and prove those historical request records remain byte-for-field `status: 'reserved'`, `dependencies: []`, exact identities/version/publisher/token/source, and proposed family/SKU. Assert the batch receipt remains the immutable `receipt_ref` on all five current records and `verifyAuthoringReceipt` still verifies every original request identity.

Then derive the exact Wave 2 transition set from persisted transition events with this coordinator. Require transition targets to be unique. For each of the five current records:

- current `status: 'authored'` iff exactly one Wave 2 transition targets its original receipt/`pack_id`/version;
- that one transition satisfies `transition.revision === transition.request.expected_revision + 1`, has the exact coordinator and original receipt/identity, and has `changes` deep-equal to `{ status: 'authored' }` with no stocking-proposal or other mutation;
- every authored target has an exact registered source that passes source reconciliation and focused qualification tests;
- a current `reserved` record has no Wave 2 status transition; in particular, every preview-blocked Recipe with no source remains `reserved`.

Finally assert the current authored source-path set equals the exact unique transitioned source-qualified set and the current reserved set equals its fixed-wave complement. This preserves the original reservation proposal/receipt as history while proving current lifecycle state solely from one exact `reserved` → `authored` event per transitioned leaf. The durable test reads no ignored review/handoff file.

Write staging tests with a **different** `mkdtemp(join(tmpdir(), 'story-wave-two-stage-test-'))`. Its `candidateRoot` contains verified fixture candidates; its `artifactRoot` is a non-existent child; and its `receiverHandoffPath` is a different non-existent child. Never point tests at `/build/Developer/_handoffs/`. Use explicit `allowedSlugs` equal to the fixed five-slug wave set and `eligibleSlugs` equal to a two-slug authored∩eligible subset. Require all four slug collections to be unique and enforce these exact equations before any filesystem write:

```js
assert.deepEqual(new Set(entries.map(entry => entry.slug)), new Set(eligibleSlugs))
assert.deepEqual(new Set(blockedEntries.map(entry => entry.slug)), new Set(allowedSlugs.filter(slug => !eligibleSlugs.includes(slug))))
```

The helper must independently reject duplicate `allowedSlugs`, duplicate `eligibleSlugs`, duplicate entry slugs, duplicate blocked slugs, an eligible slug outside `allowedSlugs`, an entry outside or omitted from `eligibleSlugs`, a blocked slug outside `allowedSlugs`, any eligible/blocked overlap, and any fixed-wave slug omitted from both entry and blocked sets. Also reject either destination if it already exists, any relative destination, either destination inside the repository, symlinked candidate/destination ancestry, a source whose physical `realpath` escapes `candidateRoot`, changed source bytes, wrong digest/size/floor/profile, or incomplete reviews.

Also evolve the candidate-handoff fixture assertions so `candidate.evidence.staging.status` is exactly one of `complete | preflight-failed | failed-after-root | skipped-empty`. Only `complete` may have non-empty `delivered_leaves`; every other status requires `delivered_leaves: []`. `failed-after-root` alone permits/requires an artifact root plus `failure.json`; `preflight-failed` and `skipped-empty` require both external destinations to remain absent. No non-`complete` status may default to the eligible/authored set. Assert the top-level status is `candidate-validated` iff all five unique allowed slugs are present in each of `eligible_leaves`, `authored_leaves`, and `delivered_leaves`, `blocked_leaves` is empty, and staging is `complete`; otherwise it is exactly `blocked`.

Assert the successful fixture copy is byte-identical and revalidated by `validateContentPack`; ledger keys are exactly `absolute_path`, `bytes`, `delivery_profile`, `min_app_version`, `receipt_ref`, `reviews`, `sha256`, and `slug`; `release-handoff.json` and the receiver handoff contain the exact summary; and ledger/source/archive JSON do not. The three generated top-level shapes are exact:

```js
assert.deepEqual(Object.keys(ledger).sort(), ['entries', 'schema_version'])
assert.deepEqual(Object.keys(releaseHandoff).sort(), ['entries', 'schema_version'])
assert.deepEqual(Object.keys(receiver).sort(), [
  'artifact_root', 'blocked_entries', 'explicitly_not_done', 'ledger_path', 'schema_version', 'successful_entries',
])
assert.equal(ledger.schema_version, 1)
assert.equal(releaseHandoff.schema_version, 1)
assert.equal(receiver.schema_version, 1)
```

Each release/receiver successful entry contains the exact ledger facts plus `component_summary`; each blocked entry is exactly `{ slug, blocker }`. Assert the successful-entry slugs equal `eligibleSlugs` and blocked-entry slugs equal the exact unique `allowedSlugs \ eligibleSlugs` complement, with no unknown, overlap, duplicate, or omission. A semantic recursive key walker over parsed JSON—not raw grep—allows `component_summary` only under each delivered entry in `release-handoff.json`, receiver handoff, and stocking-handoff fixtures. It rejects the key in registry, source, authoring handoff, candidate handoff, preview data, ledger, build evidence, or archive JSON.

- [ ] **Step 2: Run RED and prove it is caused only by the missing helper/new qualification implementation.**

```bash
node --test scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts
```

Expected: the source suite remains GREEN for every committed leaf; the new pack test fails because `stage-handoff-artifacts.mjs`/its behavior is absent, not because a preview-blocked recipe source is absent. Do not commit this RED state.

- [ ] **Step 3: Implement the minimum secure helper and return the test suite to GREEN.**

Use only Node standard-library file/path/crypto APIs plus the existing `validateContentPack`. Before any filesystem write, validate the four slug collections: unique `allowedSlugs`; unique `eligibleSlugs` and `eligibleSlugs ⊆ allowedSlugs`; unique `entries[].slug` exactly equal to `eligibleSlugs`; unique `blockedEntries[].slug` exactly equal to `allowedSlugs \ eligibleSlugs`; and no unknown, overlap, duplicate, or omission. Then preflight both absent destinations. Resolve the physical repository, `candidateRoot`, artifact parent, and receiver parent; walk relevant existing ancestors with `lstat`; reject symlinks/non-directories and require both destination parents to resolve outside the repository. For every source, require a regular non-symlink file physically contained by `candidateRoot`; open it with `constants.O_RDONLY | constants.O_NOFOLLOW`, compare pre/post `fstat` identity/size/timestamps, and reject replacement or mutation.

Create `artifactRoot` and `.staging` non-recursively. Open every staged archive, final archive, and JSON/handoff output with exclusive `wx` (mode `0o600` for JSON/handoffs); never use an overwriting write or overwriting rename. Copy from the no-follow source handle into staging, hash/count the copied bytes, compare declared evidence, then call `validateContentPack({ archivePath: stagedPath, deliveryProfile: 'genstudio-store-receipt-v1' })`. Validate **all** staged copies before finalizing any archive. For each final archive, open the absent final path with `wx`, copy the already verified staged bytes through stable handles, hash/count/revalidate the final file, then unlink only its staged copy. After every final archive verifies, write `ledger.json`, `release-handoff.json`, and finally the external receiver handoff. Re-open and revalidate final archives and parse all three handoff files before returning `phase: 'complete'`.

Do not claim filesystem-wide atomicity. The truthful phase model is:

- preflight/validation failure: no destination was written;
- caught failure after root creation but before a final archive is created: remove `.staging`, remove only files created by this invocation, leave `failure.json` in the new root, receiver absent;
- caught failure after one or more final archives are created: attempt to remove exactly those new archives plus new ledger/release/receiver files, remove `.staging`, and list any cleanup failure/remaining path in `failure.json`; no stocking handoff is issued;
- process/host crash: cleanup may not run, so the root can contain `.staging`, a subset of final archives, ledger/release, or a partial receiver file. On restart, the required-absent preflight fails closed. Inventory/hash/validate what exists, report the exact phase evidence, and obtain an owner-directed new destination or cleanup decision; never describe this as all-or-nothing and never auto-delete/retry.

The test suite must exercise pre-finalization cleanup by throwing from `afterPhase('staged-and-validated')`, and a controlled post-first-final-file failure by throwing from the first `afterPhase('archive-finalized', { path })`. Assert the reported phase and exact remaining-path inventory; the hook is never consulted when absent. Then run:

```bash
node --test scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts
git diff --check
```

Expected: all commands pass. The test temporary roots are removed explicitly in `t.after`; no real handoff destination exists yet.

- [ ] **Step 4: Build real candidates separately, compute `eligibleLeaves`, and serialize lifecycle CAS.**

Create a fresh coordinator-owned `candidateRoot = await mkdtemp(join(tmpdir(), 'story-wave-two-candidates-'))`; do not reuse any test temp bytes. For each source-complete leaf, verify the original reservation receipt, build twice at exact floor `1.0.843`, validate both candidates, compare bytes/digests, and collect the required independent review results. Define `eligibleLeaves` in fixed wave order by this exact predicate:

```text
receipt verified AND registered source exact AND focused source tests pass
AND two keyless builds are byte-identical AND both validate at 1.0.843
AND schema/originality-provenance/compatibility/prompt-equivalence/safety/copy/commercial-boundary reviews pass
AND, for recipes only, exact 1672x941 preview decode/title/diversity plus visual and thumbnail reviews pass
```

Write ignored `wave-2-candidate.json` with exact keys `status`, `eligible_leaves`, `authored_leaves`, `delivered_leaves`, `blocked_leaves`, and `evidence`; it contains no `component_summary`. Before staging, keep top-level `status: "blocked"`; eligibility alone never earns the final status. Independently, `evidence.staging.status` has the closed enum `complete | preflight-failed | failed-after-root | skipped-empty`: initialize it to `skipped-empty` only when there are no authored eligible leaves, record `preflight-failed` only when staging stops before creating the artifact root, record `failed-after-root` only when the root exists and `failure.json` inventories the failure, and record `complete` only after the helper's complete result and post-write verification. Missing recipe previews do not block the three text leaves.

Enter the single cross-wave registry lane. For each `eligibleLeaves` entry, in fixed order, re-run registry validation, verify the immutable original receipt, read the current revision, create one request with exact coordinator `{ "task": "reusable-content-primitives-wave-2", "branch": "codex/content-expansion-portfolio" }` and only `changes: { "status": "authored" }`, then invoke one transition. Validate the returned next revision before processing another leaf. A lock/stale-CAS/changed-registry failure stops immediately; do not replay stale JSON. Previously successful transitions remain truthfully `authored`; add the failed/unattempted eligible leaves to `blocked_leaves` with their exact transition blocker while they remain `reserved`, and record the exact `authored_leaves` split. Release the lane before external staging. This serialization lets the plan execute safely before or after the Symbolic plan's currently blocked Task 6 without assuming revision `18` remains current.

- [ ] **Step 5: Perform real external staging only for the authored eligible subset.**

Set `authoredLeaves` to the intersection of `eligibleLeaves` and exact committed Wave 2 registry records now at `authored`. If empty, create neither real destination and skip stocking. Otherwise, before calling the helper, require both of these exact destinations to be absent:

```text
/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23/
/build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.json
```

Pass only `authoredLeaves`, their first verified **real candidateRoot** archive, actual digest/bytes, floor/profile/receipt/reviews, and these exact release summaries:

```js
const summaries = {
  'question-ladder': { schema_version: 1, kind: 'series-formula', summary: 'A reusable evidence-aware answer ladder from concrete question to bounded conclusion.', slots: { 'series-formula': 1 } },
  'audience-question-seeder': { schema_version: 1, kind: 'topic-pack', summary: 'A duplicate-resistant audience-question domain pack with bounded evidence and actionability axes.', slots: { 'topic-pack': 1 } },
  'before-after-timeline': { schema_version: 1, kind: 'series-formula', summary: 'A reusable baseline-to-result timeline that keeps confounders and causal limits visible.', slots: { 'series-formula': 1 } },
  'object-hero-question': { schema_version: 1, kind: 'thumbnail-recipe', summary: 'A single-object thumbnail grammar with an exact AI-rendered episode-title question.', slots: { 'thumbnail-recipe': 1 } },
  'route-map-one-promise': { schema_version: 1, kind: 'thumbnail-recipe', summary: 'A symbolic route-and-promise thumbnail grammar with an exact AI-rendered episode title.', slots: { 'thumbnail-recipe': 1 } },
}
```

Before the call, set `allowedSlugs` to the exact fixed five-slug wave order and `eligibleSlugs` to the unique `authoredLeaves` (the authored∩eligible set). Build `entries` with exactly one row per `eligibleSlugs` value and `blockedEntries` as the exact unique `allowedSlugs \ eligibleSlugs` complement, using the existing qualification/transition blocker for each. Pass all four collections explicitly; never let the helper infer eligibility from source/archive presence. If `authoredLeaves` is empty, make no helper call, record `evidence.staging.status: 'skipped-empty'`, keep `deliveredLeaves: []`, and require both real destinations absent. A preflight rejection before root creation records `preflight-failed`, keeps `deliveredLeaves: []`, and requires both destinations absent. A caught failure after root creation records `failed-after-root`, keeps `deliveredLeaves: []`, requires the receiver absent, and leaves only the truthful root/`failure.json` inventory. Only after `phase: 'complete'` and post-write verification record `complete`, set `deliveredLeaves` from the helper's verified archive paths, assert they equal `eligibleSlugs`, update the ignored candidate handoff, and create one `-stocking.json` only for each delivered leaf. Each stocking handoff contains Story identity/version/publisher, proposed family/SKU state, `dependencies: []`, floor/digest/size/absolute archive/profile/receipt/reviews, its exact `component_summary`, and `explicitly_not_done: [upload, product-or-release-draft-creation, price-or-discount-decision, purchase, grant, publication, production-signing, deploy, push]`. The receiver includes successful entries with summaries plus `blockedEntries` without archive/digest/size fields. A caught staging failure adds every undelivered authored leaf to `blocked_leaves` with its exact phase; no helper failure/crash produces a stocking handoff. After every staging outcome and blocker update, recompute the top-level status from persisted evidence: set `candidate-validated` iff `eligibleLeaves`, `authoredLeaves`, and `deliveredLeaves` each equal the exact five-slug allowed set, `blockedLeaves` is empty, and `evidence.staging.status === 'complete'`; otherwise set it to `blocked`.

In a `finally` block, delete the real `candidateRoot` only after `phase: 'complete'` has been reverified or after a caught pre-commit failure has recorded its evidence. Never delete the external artifact root or receiver path automatically. No source, archive, key, or signature is left in the repository.

- [ ] **Step 6: Run focused gates and exact partial-success external checks.**

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
npx tsx --test electron/server/__tests__/reusable-content-primitives-source.test.ts electron/server/__tests__/content-pack-contract.test.ts electron/server/__tests__/content-pack-archive.test.ts electron/server/__tests__/content-pack-legacy-adapters.test.ts
npm run content-pack:registry -- validate
npm run typecheck:electron
npm run lint
npm run check:security
npm run check:model-drift
git diff --check
find content-packs/reusable-primitives -type f -name '*.sspack' -print
```

Expected: every command passes and `find` prints nothing. Then run this partial-success audit using ignored `wave-2-candidate.json` as the execution record:

```bash
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { validateContentPack } from './scripts/content-packs/lib.mjs'

const working = '.superpowers/sdd/2026-08-23-reusable-content-primitives-wave-2/handoffs'
const artifactRoot = '/build/Developer/_handoffs/artifacts/story-reusable-primitives-wave-2-2026-08-23'
const receiverPath = '/build/Developer/_handoffs/2026-08-23_to-genstudio_from-storystudio_reusable-primitives-wave-2.json'
const candidate = JSON.parse(await readFile(join(working, 'wave-2-candidate.json'), 'utf8'))
const allowed = [
  'question-ladder', 'audience-question-seeder', 'before-after-timeline',
  'object-hero-question', 'route-map-one-promise',
]
const delivered = [...candidate.delivered_leaves].sort()
const stagingStatus = candidate.evidence.staging?.status
const expectedDelivered = stagingStatus === 'complete'
  ? candidate.eligible_leaves.filter(slug => candidate.authored_leaves.includes(slug)).sort()
  : []
const blocked = candidate.blocked_leaves.map(entry => entry.slug).sort()
const unique = values => new Set(values).size === values.length
const absent = async path => access(path).then(() => false, () => true)
const allowedSorted = [...allowed].sort()
assert.equal(unique(allowed), true)
assert.equal(unique(candidate.eligible_leaves), true)
assert.equal(unique(candidate.authored_leaves), true)
assert.equal(unique(delivered), true)
assert.equal(unique(blocked), true)
assert.ok(candidate.eligible_leaves.every(slug => allowed.includes(slug)))
assert.ok(candidate.authored_leaves.every(slug => candidate.eligible_leaves.includes(slug)))
assert.deepEqual(delivered, expectedDelivered)
assert.deepEqual(blocked, allowed.filter(slug => !delivered.includes(slug)).sort())
assert.equal(delivered.some(slug => blocked.includes(slug)), false)
const isFullyValidated = stagingStatus === 'complete'
  && blocked.length === 0
  && [candidate.eligible_leaves, candidate.authored_leaves, delivered]
    .every(slugs => unique(slugs) && slugs.length === allowed.length
      && JSON.stringify([...slugs].sort()) === JSON.stringify(allowedSorted))
assert.equal(candidate.status, isFullyValidated ? 'candidate-validated' : 'blocked')

if (stagingStatus === 'complete') {
  assert.ok(delivered.length > 0)
  const ledger = JSON.parse(await readFile(join(artifactRoot, 'ledger.json'), 'utf8'))
  const release = JSON.parse(await readFile(join(artifactRoot, 'release-handoff.json'), 'utf8'))
  const receiver = JSON.parse(await readFile(receiverPath, 'utf8'))
  assert.deepEqual(ledger.entries.map(entry => entry.slug).sort(), delivered)
  assert.deepEqual(release.entries.map(entry => entry.slug).sort(), delivered)
  assert.deepEqual(receiver.successful_entries.map(entry => entry.slug).sort(), delivered)
  assert.deepEqual(receiver.blocked_entries.map(entry => entry.slug).sort(), blocked)
  for (const entry of ledger.entries) {
    const archivePath = join(artifactRoot, `${entry.slug}.sspack`)
    const bytes = await readFile(archivePath)
    assert.equal((await stat(archivePath)).size, entry.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256)
    assert.equal(entry.min_app_version, '1.0.843')
    assert.equal(entry.delivery_profile, 'genstudio-store-receipt-v1')
    await validateContentPack({ archivePath, deliveryProfile: 'genstudio-store-receipt-v1' })
    const stocking = JSON.parse(await readFile(join(working, `${entry.slug}-stocking.json`), 'utf8'))
    assert.equal(stocking.status, 'ready-for-owner-stocking')
    assert.deepEqual(stocking.dependencies, [])
  }
  for (const { slug } of candidate.blocked_leaves) {
    assert.equal(await absent(join(artifactRoot, `${slug}.sspack`)), true)
    assert.equal(await absent(join(working, `${slug}-stocking.json`)), true)
  }
} else {
  assert.deepEqual(delivered, [])
  assert.equal(await absent(receiverPath), true)
  assert.deepEqual((await readdir(working)).filter(name => name.endsWith('-stocking.json')), [])
  if (stagingStatus === 'failed-after-root') {
    assert.equal(await absent(artifactRoot), false)
    assert.equal(await absent(join(artifactRoot, 'failure.json')), false)
  } else {
    // Defined and unexpected no-root outcomes get no delivery credit; unexpected values then fail the enum.
    assert.equal(await absent(artifactRoot), true)
    assert.ok(['preflight-failed', 'skipped-empty'].includes(stagingStatus))
  }
}
NODE
```

The audit derives expected delivery only for `complete`. `failed-after-root` is the sole root-present failure branch and requires the truthful diagnostic, no receiver, no stocking handoffs, and no claim of delivery. `preflight-failed`, `skipped-empty`, and any other no-root outcome require both destinations absent and no stocking handoffs; no non-complete outcome falls through to the authored/eligible delivery set.

Finally run the semantic recursive JSON-key scan across all fresh repository source/registry/test fixtures, ignored Wave 2 authoring/candidate evidence, archive JSON, external ledger/build evidence, release handoff, receiver, and stocking handoffs. Require `component_summary` only in delivered entries of `release-handoff.json`, receiver, and matching stocking handoffs, with exact summaries above. Markdown prose may mention the term but is not counted as structured data.

- [ ] **Step 7: Commit only the final GREEN registry/test/helper batch; do not perform any GenStudio mutation.**

```bash
git add content-packs/authoring-registry.json scripts/content-packs/stage-handoff-artifacts.mjs scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs electron/server/__tests__/reusable-content-primitives-source.test.ts
git commit -m "test(content-packs): qualify reusable primitives"
```

Commit only after Step 6 passes; no RED test crosses a commit boundary. External artifacts and ignored handoffs are not added. Do not change family/SKU status, generate/spend, upload, create a GenStudio product/release draft, choose price/discount, purchase, grant, publish, production-sign, release, deploy, push, or mutate checkout/GenStudio. A `ready-for-owner-stocking` handoff is evidence for a later owner/GenStudio decision, not authority to act.

## Plan Self-Review

**Spec coverage:** Tasks 1–7 cover exactly the five approved reusable leaves, the four existing creative schemas, explicit Formula/Topic boundaries, exact-title Recipes, the exact six `1672x941` sample-title previews, independent review, deterministic keyless validation at `1.0.843`, partial success, and non-mutating final handoffs. They create no kit fork, Style, fifth schema, runtime catalog entry, price, GenStudio record, checkout change, upload, publication, deployment, or push.

**Registry and commit discipline:** Task 1 contains only passing reservation coverage. Every leaf adds its RED test locally and commits only after that leaf is GREEN. The exact five proposal rows are explicit but become authoritative only through the successful receipt. Task 7 evolves the durable registry test so the persisted batch request/receipt keeps all five original reserved proposals byte-for-field, while current records are authored exactly for the unique transitioned source-qualified subset and reserved for its complement; each authored state has one exact status-only `reserved` → `authored` event. All registry operations across this and the Symbolic plan use one serialized lane, current revalidation/revision, existing lock/CAS, fail-fast stale handling, and post-mutation validation; source work may be parallel but registry/shared-test commits may not.

**Partial qualification:** `eligibleLeaves`, `authoredLeaves`, and `deliveredLeaves` are distinct exact sets. Missing Recipe previews leave those records reserved and source/archive/stocking-free while the three text leaves continue. After staging, `candidate-validated` is recomputed iff all three sets equal the exact five fixed leaves, `blockedLeaves` is empty, and staging is `complete`; every other outcome is `blocked`. A partially successful wave preserves precise successful-leaf evidence but is never mislabeled five-of-five complete.

**Preview/Studio Hub safety:** Studio Hub is control plane only. Named-worker bytes require an exact quote plus explicit owner job authority; owner-supplied originals are the alternative. Each of six previews must already be an original exact `1672x941` WebP with its exact sample title/line arrangement and complete provenance. `PREVIEW-PROVENANCE.md` is created/changed only for qualifying returned bytes; blocked/no-byte evidence exists only in the ignored leaf handoff. No local generation, paid request, transform, upload, production key, model/provider choice, or fabricated evidence occurs.

**External staging truthfulness:** Automated staging tests use isolated temp destinations; real candidates and real handoff destinations are separate. Both real destinations must be absent. The helper receives explicit unique `allowedSlugs` and `eligibleSlugs`; entries equal the authored∩eligible set, blocked rows equal the exact fixed-wave complement, and tests reject every unknown, overlap, duplicate, or omission. Candidate staging records exactly `complete | preflight-failed | failed-after-root | skipped-empty`; delivery is derived only from `complete`, only `failed-after-root` permits a root/`failure.json`, and every no-root outcome requires both destinations absent. No-follow/stable reads, physical containment, exclusive writes, staged `validateContentPack`, explicit caught-failure cleanup, post-write revalidation, and crash-phase inventory prevent overwrite and traversal. The plan does not promise cross-filesystem or crash atomicity; partial crash residue blocks retry and stocking until an owner-directed decision.

**Summary and schema placement:** `component_summary` exists only in final release, receiver, and delivered-leaf stocking handoffs. A semantic parsed-JSON scan—not raw grep—proves it is absent from strict source, registry, preview, candidate/build evidence, machine ledger, and archive JSON. Source schemas remain unchanged; every dependency list is `[]`; Route Map invents no future Formula identity.

**Placeholder scan:** No identity, title, dimension, floor, profile, path, status transition, required review, or blocker is left as TBD/TODO. Digests, byte counts, receipts, quotes, worker IDs, and review results are deliberately runtime evidence and must be recorded from actual outputs rather than invented by this plan.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-23-reusable-content-primitives-wave-2.md`. Execute Task 1 first inside the single cross-wave registry lane. After its green commit, Tasks 2–6 may author disjoint source leaves, but their shared-test integrations/commits remain serialized. Task 7 alone transitions `eligibleLeaves`; blocked Recipe leaves remain reserved and do not prevent qualified text-leaf delivery. Task 7 recomputes the final top-level candidate status only after staging: all five eligible/authored/delivered plus no blockers and `complete` staging means `candidate-validated`; otherwise it remains `blocked`. No generation, spend, deployment, or push is authorized.
