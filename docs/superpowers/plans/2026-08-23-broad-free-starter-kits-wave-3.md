# Broad Free Starter Kits — Wave 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Author five broad free Starter Channel Kit source closures using only two new Formulae, five new Topics, and exact qualified existing/Wave 2 style/recipe releases.

**Architecture:** This is an authoring wave, not a commerce/runtime/archive-delivery change. One coordinator atomically reserves all new records and distributes the receipt; a leaf verifies its one issued record before writing its sole Formula/Topic source. Five bundle-only coordinators have no creative bytes and express exact qualified closures only.

**Tech Stack:** Content Pack JSON/adapters, authoring-registry CAS receipts, Node node:test, planIdeaAssignments, keyless genstudio-store-receipt-v1 validation.

**Spec:** docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md; docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md; docs/superpowers/specs/2026-08-15-content-pack-authoring-registry-design.md.

## Global Constraints

- Start only when committed registry/source/provenance facts show authored Wave 2 Question Ladder and Route Map + One Promise exact releases. Before reservation, obtain a fresh compatibility review against the intended Wave 3 closure; external Wave 2 handoffs may support human review but are never a clean-checkout test input. Otherwise stop; do not substitute another Formula/Recipe.
- All new names here are proposed slugs, not Story identities. Do not derive/write a new pack_id, item_id, bundle_id, family, or sku before a successful one-batch reservation and exact verify-receipt.
- Reserve exactly 12 new records: two series-formula, five topic-pack, five channel-kit; no Style/Recipe record. New leaves have no dependencies. Each coordinator has exactly one Formula, Topic, Style, and Recipe dependency.
- Existing/Wave 2 styles and recipes are reused by registry-resolved exact pack_id@version; do not copy, fork, rename, re-preview, or re-author them. This wave creates no Style/Recipe, so no preview request is permitted.
- Every source binds only receipt-issued Story fields, a release-bound {{MIN_APP_VERSION}}, and a registry-returned proposed stocking proposal. No GenStudio ID, price, product/release/account field, model/provider routing, commerce state, or publication state is allowed.
- component_summary is release-handoff metadata only: never add it to strict pack.json or creative documents. Candidate-ledger/handoff fixtures use schema_version 1, canonical kind, short prose summary, and slots; Formula/Topic leaves have only their own slot at 1 and kits have 1/1/1/1. It never duplicates IDs, versions, hashes, dependencies, or closure metadata.
- Keyless candidates are stock-ready external artifacts: build twice with genstudio-store-receipt-v1 and min app 1.0.843; require equal bytes/digest and at most 52,428,800 bytes, validate both, retain one verified stream in a fresh external root with an evidence ledger and a non-mutating GenStudio candidate handoff. No key_id, signature.ed25519, private key, upload, product/release creation, price, purchase, grant, or publication.
- No runtime/checkout/version/changelog change; no provider generation/paid action/upload/purchase/grant/production signing/publish/push/deploy.

## Proposed slugs and exact closure choices

| Kit proposed slug | New Formula proposed slug | New Topic proposed slug | Formula | Style | Recipe |
| --- | --- | --- | --- | --- | --- |
| everyday-explainers | none | everyday-systems-decisions | Wave 2 Question Ladder | existing Minimal Stick-Figure Explainer | existing Centered Hero Headline |
| personal-story-lessons | personal-story-lessons | life-changes-choices | new Personal Story Lessons | existing Watercolor Storybook | existing Portrait + Right Title Block |
| practical-home-routine | none | home-routine-systems | existing Practical Motivation | existing Hand-Drawn Editorial Diagram | existing Annotated Business Board |
| family-discovery | none | family-discovery | Wave 2 Question Ladder | existing Waxy Outline Cartoon | existing Curiosity Question Cartoon |
| weekend-guides | weekend-guides | weekend-routes-activities | new Weekend Guides | existing Cinematic Photoreal | Wave 2 Route Map + One Promise |

Audience Question Seeder is not an implicit sixth Topic dependency; it remains a standalone Wave 2 component until a later explicit compatibility decision.

## Files and responsibilities

| Path | Responsibility |
| --- | --- |
| content-packs/authoring-registry.json | One Wave 3 reservation receipt and later status-only transitions. |
| .sdd/wave-3-free-reservation-request.json | Ignored coordinator request; remove before commit. |
| .sdd/wave-3-free-expected-identities/*.json | Ignored receipt inputs; remove before commit. |
| content-packs/free-broad-starters/formula/{personal-story-lessons,weekend-guides}/{pack.json,content/series-formula.json} | Two receipt-bound Formula leaves. |
| content-packs/free-broad-starters/topic/{everyday-systems-decisions,life-changes-choices,home-routine-systems,family-discovery,weekend-routes-activities}/{pack.json,content/topic-pack.json} | Five receipt-bound Topic leaves. |
| content-packs/free-broad-starters/kit/{everyday-explainers,personal-story-lessons,practical-home-routine,family-discovery,weekend-guides}/pack.json | Five bundle-only coordinator closures. |
| scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs | Receipt, closure, test-local handoff-summary, safety, coverage, candidate and review tests. |
| /build/Developer/_handoffs/artifacts/story-wave-3-broad-free-candidates-2026-08-23/ | Fresh retained candidate archives and exact evidence ledger; fail if it already exists. |
| /build/Developer/_handoffs/2026-08-23_to-genstudio_wave-3-broad-free-candidates.md | Non-mutating candidate/stocking handoff. |

### Task 1: Gate Wave 3 on qualified primitives and exact reusable releases

**Files:**
- Create: scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
- Read: committed registry, committed Wave 2 sources/provenance, and selected existing component sources.

**Interfaces:**
- Consumes: validateAuthoringRegistry() and committed source/provenance facts.
- Produces: requiredClosureRecords(registry), returning exact single records for Question Ladder, Route Map + One Promise, and all selected existing releases; it throws Wave 2 primitive required: name for missing, ambiguous, non-authored, or provenance-invalid inputs. The same test file defines summaryFixtureFor(source) as a test-local handoff object with exactly schema_version, kind, summary, and slots keys.

- [ ] **Step 1: Write the failing prerequisite test**

~~~
test('Wave 3 requires qualified primitives and exact reusable releases', async () => {
  const closure = requiredClosureRecords(await validateAuthoringRegistry())
  assert.equal(closure.questionLadder.status, 'authored')
  assert.equal(closure.routeMapPromise.status, 'authored')
  assert.equal(closure.existing.length, 10)
  assert.ok(closure.existing.every(record => record.status === 'authored'))
})
~~~

Require committed Question Ladder source/schema/coverage facts and committed Route Map provenance/decoded-preview facts. Reconcile all ten existing records through registry/source manifests rather than looking up a default; record fresh compatibility review requests separately from durable tests.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

Expected: FAIL until both committed Wave 2 records/sources/provenance facts exist.

- [ ] **Step 3: Implement only the read-only resolver**

Use test-local JSON/registry readers. Do not create a Wave 3 source, ID, reservation request, fallback Formula, or fallback Recipe.

- [ ] **Step 4: Run GREEN and commit**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

~~~bash
git add scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
git commit -m "test: gate broad free kits on qualified primitives"
~~~

### Task 2: Reserve the complete 12-record wave atomically

**Files:**
- Modify: content-packs/authoring-registry.json
- Create then remove: .sdd/wave-3-free-reservation-request.json
- Create then remove: .sdd/wave-3-free-expected-identities/*.json
- Modify: scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

**Interfaces:**
- Consumes: Task 1 resolver and live registry revision.
- Produces: one returned { revision, receipt_ref }, 12 reserved records, and 12 exact receipt-verification replies.

- [ ] **Step 1: Write the failing atomic-batch test**

~~~
const batch = findBatchForProposal(registry, '2026-08-23-broad-free-starter-kits-wave-3')
assert.equal(batch.request.records.length, 12)
assert.deepEqual(countBy(batch.request.records, 'kind'), {
  'series-formula': 2, 'topic-pack': 5, 'channel-kit': 5,
})
assert.ok(batch.request.records.every(record => record.status === 'reserved'))
~~~

Assert all 12 source paths are exactly the paths above; leaves have [] dependencies; each coordinator uses the four table choices in order; no Style/Recipe/GenStudio/unknown field enters the batch.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

Expected: FAIL because no Wave 3 receipt exists.

- [ ] **Step 3: Submit one coordinator-owned request**

After fresh validation, create the complete request with live expected_revision, task wave-3-broad-free-starters, branch codex/content-expansion-portfolio, proposal ref docs/superpowers/specs/2026-08-23-modular-content-expansion-portfolio-design.md#42-broad-free-starter-proposals, all 12 source paths, release-bound minimum status, and proposed stocking states. Candidate identity fields exist only inside this registry request.

Run: npm run content-pack:registry -- reserve --request .sdd/wave-3-free-reservation-request.json

On stale/collision: delete the request, revalidate, rebuild the entire batch against the current revision, and retry. Never reserve leaves separately.

- [ ] **Step 4: Verify each issued record before any source exists**

Write each returned record without receipt_ref to a uniquely named formula-*, topic-*, or kit-* JSON file, then run:

~~~bash
npm run content-pack:registry -- verify-receipt --revision "$WAVE3_REVISION" --receipt "$WAVE3_RECEIPT" --expected-identity .sdd/wave-3-free-expected-identities/formula-personal-story-lessons.json
~~~

Repeat with the actual unique filename for all 12 records. Abort authoring if one result is not the exact accepted identity.

- [ ] **Step 5: Run GREEN and commit reservation evidence**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

Remove .sdd/wave-3-free-* then commit:

~~~bash
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
git commit -m "chore: reserve broad free starter kit wave"
~~~

### Task 3: Author the two new Formula contracts

**Files:**
- Create: content-packs/free-broad-starters/formula/personal-story-lessons/{pack.json,content/series-formula.json}
- Create: content-packs/free-broad-starters/formula/weekend-guides/{pack.json,content/series-formula.json}
- Modify: scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

**Interfaces:**
- Consumes: verified Formula/Topic receipt records.
- Produces: receipt-bound one-document series-formula sources.

- [ ] **Step 1: Write failing Formula/summary tests**

~~~
assert.match(personal.channel_promise, /fact-respecting retrospective narrative/i)
assert.match(text(personal.script_structure), /source attribution|claim attribution|bounded lesson/i)
assert.match(text(personal.exclusions), /invented first-person|clinical advice|anonymous accusation/i)
assert.match(weekend.channel_promise, /bounded local-style outing|skill experience/i)
assert.match(text(weekend.script_structure), /route|constraints|time|cost|honest promise/i)
assert.deepEqual(summaryFixtureFor(personal).slots, { 'series-formula': 1 })
~~~

For each test-local candidate-handoff fixture assert schema_version 1, kind series-formula, non-empty short summary, only series-formula: 1 in slots, and no identity/version/dependency/hash data in summary. Assert pack.json and creative documents have no component_summary. Assert only the matching Topic is compatible; Personal Story cannot use therapy-adjacent authority and Weekend cannot act as navigation/location verification.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

Expected: FAIL because both sources are absent.

- [ ] **Step 3: Implement minimal receipt-bound contracts**

Personal Story: attributable source → fact/inference separation → change/choice → constraint/turning point → one bounded lesson. Weekend: route/experience intent → access/time/cost constraint → realistic sequence → research uncertainty → non-guaranteed promise. Keep styles, recipes, headline geometry, and provider settings out.

- [ ] **Step 4: Run GREEN and commit**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

~~~bash
git add content-packs/free-broad-starters/formula scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
git commit -m "feat: author broad free starter formula contracts"
~~~

### Task 4: Author five duplicate-resistant Topic Packs

**Files:**
- Create: content-packs/free-broad-starters/topic/everyday-systems-decisions/{pack.json,content/topic-pack.json}
- Create: content-packs/free-broad-starters/topic/life-changes-choices/{pack.json,content/topic-pack.json}
- Create: content-packs/free-broad-starters/topic/home-routine-systems/{pack.json,content/topic-pack.json}
- Create: content-packs/free-broad-starters/topic/family-discovery/{pack.json,content/topic-pack.json}
- Create: content-packs/free-broad-starters/topic/weekend-routes-activities/{pack.json,content/topic-pack.json}
- Modify: scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

**Interfaces:**
- Consumes: receipt-issued Topics and Formula compatibility IDs.
- Produces: Topic documents with non-empty subjects, episode_objects, time_place_scopes, mechanisms, evidence_lenses, exclusions, compatibility_rules, five ordered axes, positive sibling limit, and prompt_context length at most 4,000.

- [ ] **Step 1: Write failing structure/safety/summary tests**

~~~
for (const topic of topics) {
  for (const key of ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses', 'exclusions', 'compatibility_rules']) assert.ok(topic[key].length)
  assert.deepEqual(topic.idea_axes.map(axis => axis.id), ['subject', 'episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'])
  assert.deepEqual(summaryFixtureFor(topic).slots, { 'topic-pack': 1 })
  assert.ok(topic.prompt_context.length <= 4000)
}
~~~

Require Formula links only: Everyday/Family → Question Ladder; Life Changes → Personal Story; Home/Routine → Practical Motivation; Weekend Routes → Weekend Guides. Reject personal testimony/local travel advice; invented testimony/diagnosis/anonymous accusation; medical/legal/safety-critical instruction; fear bait/unsafe experiments/child-data collection; and location hours/bookings/guarantees respectively.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

Expected: FAIL because all five Topic sources are absent.

- [ ] **Step 3: Implement non-interchangeable axes**

| Topic | Required differentiating axes |
| --- | --- |
| Everyday Systems & Decisions | audience context, question intent, constraint, evidence type, actionability |
| Life Changes & Choices | attributable source type, transition, decision tension, reflection lens, bounded lesson |
| Home & Routine Systems | setting, routine friction, resource constraint, observable practice, maintenance signal |
| Family Discovery | subject domain, observation scale, setting, safe activity boundary, curiosity mechanism |
| Weekend Routes & Activities | experience type, route shape, access/time/cost constraint, seasonal uncertainty, qualified promise |

Encode incompatible combinations in data; local facts are generation-time research needs, not Topic facts.

- [ ] **Step 4: Prove deterministic offline coverage**

Adapt every Formula/Topic with contentPackDocumentToNiche()/contentPackDocumentToTopicPack(). Run planIdeaAssignments({ niche, count: topic.subjects.length, seed: 'wave-3-' + slug }) twice. Assert equal arrays, unique fingerprints, all five axes populated, and siblings varying both episode-object and mechanism.

- [ ] **Step 5: Run GREEN and commit**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

~~~bash
git add content-packs/free-broad-starters/topic scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
git commit -m "feat: add broad free starter topic coverage"
~~~

### Task 5: Write five bundle-only coordinators and transition authored records

**Files:**
- Create: content-packs/free-broad-starters/kit/{everyday-explainers,personal-story-lessons,practical-home-routine,family-discovery,weekend-guides}/pack.json
- Modify: content-packs/authoring-registry.json
- Modify: scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

**Interfaces:**
- Consumes: 12 receipt-issued records and exact Task 1 closure records.
- Produces: five channel-kit manifests and 12 status-only reserved → authored transitions.

- [ ] **Step 1: Write failing closure/summary tests**

~~~
for (const kit of kits) {
  const components = kit.manifest.bundles[0].components
  assert.equal(components.filter(row => row.kind === 'series-formula').length, 1)
  assert.ok(components.some(row => row.kind === 'topic-pack'))
  assert.ok(components.some(row => row.kind === 'visual-style'))
  assert.ok(components.some(row => row.kind === 'thumbnail-recipe'))
  assert.deepEqual(kit.manifest.dependencies, components.map(({ pack_id, version }) => ({ pack_id, version })))
  assert.deepEqual(summaryFixtureFor(kit.manifest).slots, {
    'series-formula': 1, 'topic-pack': 1, 'visual-style': 1, 'thumbnail-recipe': 1,
  })
}
~~~

Require the test-local handoff fixture to be schema_version 1/kind channel-kit with short outcome summary, no zero slot, and no ID/version/hash/closure duplication; assert the strict manifest has no component_summary and no coordinator content/assets. Reject latest, copied visual/recipe sources, undeclared dependency, fifth kind, and commerce/catalog fields.

- [ ] **Step 2: Run RED**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

Expected: FAIL because no coordinator manifests exist.

- [ ] **Step 3: Implement the five exact closures**

Use only coordinator verify-receipt replies plus the Task 1 registry resolver, in table order. Changelogs state outcome/closure only; never free entitlement, ownership, installation, live availability, price, or publication. Add no content/assets.

- [ ] **Step 4: Advance only fully tested records**

After source tests pass, submit one status-only CAS transition to authored for each 12 records, using the common receipt/current revision; validate registry after every returned revision. A failed transition blocks its kit.

- [ ] **Step 5: Run GREEN and commit**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

~~~bash
git add content-packs/authoring-registry.json content-packs/free-broad-starters/kit scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
git commit -m "feat: compose broad free starter kits"
~~~

### Task 6: Build retained keyless candidates, evidence ledger, and non-mutating handoff

**Files:**
- Modify: scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
- Create externally: /build/Developer/_handoffs/artifacts/story-wave-3-broad-free-candidates-2026-08-23/archives/*.sspack
- Create externally: /build/Developer/_handoffs/artifacts/story-wave-3-broad-free-candidates-2026-08-23/evidence-ledger.json
- Create externally: /build/Developer/_handoffs/2026-08-23_to-genstudio_wave-3-broad-free-candidates.md

**Interfaces:**
- Consumes: 12 authored sources and keyless builder/validator.
- Produces: one retained verified candidate per authored source, exact evidence ledger, and blocked-or-ready non-mutating GenStudio handoff; no GenStudio mutation.

- [ ] **Step 1: Write the failing keyless candidate test**

~~~
const first = await buildContentPack({ sourceDirectory, outputPath: firstPath, deliveryProfile: 'genstudio-store-receipt-v1', minAppVersion: '1.0.843' })
const second = await buildContentPack({ sourceDirectory, outputPath: secondPath, deliveryProfile: 'genstudio-store-receipt-v1', minAppVersion: '1.0.843' })
assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
assert.ok((await stat(firstPath)).size <= 52_428_800)
assert.equal(zip.file('signature.ed25519'), null)
assert.equal(Object.hasOwn(manifest, 'key_id'), false)
~~~

Validate every source with that profile; a kit ZIP contains only manifest.json, and a leaf contains only manifest plus declared JSON/permitted rasters. Test summaryFixtureFor(source) with Object.keys exactly [kind, schema_version, slots, summary] (sorted), schema_version 1, canonical kind, short prose, and required leaf/kit slots, while asserting no source manifest/document contains component_summary.

- [ ] **Step 2: Run RED then create one immutable artifact root**

Run: node --test scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs

Expected: RED before all sources qualify. Use temporary two-build outputs only at this step; do not create the external artifact root until Step 3 identifies at least one independently qualified source/kit.

- [ ] **Step 3: Write evidence ledger and candidate handoff only after reviews**

For Formula/Topic leaves request schema, originality/coverage, compatibility, prompt-equivalence, safety, copy, and commercial-boundary review. For reused Style/Recipe request fresh compatibility plus visual/thumbnail review; record not_applicable: exact qualified existing/Wave 2 component reused; no new preview generation. Missing/rejected review blocks only that candidate. If at least one source/kit independently passes every applicable gate, fail if the stated fresh artifact root exists, rerun its two-build comparison, and copy only that accepted stream into archives/. Write evidence-ledger.json and the receiver handoff with ready-for-owner-stocking entries for every retained candidate plus exact blocked entries (identity, source, failed/missing gate, and no archive path) for every sibling. Each retained entry records source commit/path, receipt/revision, issued Story identity, digest, bytes, min app 1.0.843, keyless profile, validator result, exact dependencies, component_summary v1, and provenance/review evidence. If none pass, create no artifact root and issue only the blocked report. The handoff requests field-exact GenStudio stocking inputs but contains no product/release ID, price, discount, quote, upload, or publication instruction.

- [ ] **Step 4: Final checks and commit**

Run: npm run content-pack:registry -- validate && node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/free-starter-*.test.mjs scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs && npm run typecheck:electron && git diff --check

~~~bash
git add scripts/content-packs/__tests__/broad-free-starter-wave-three.test.mjs
git commit -m "test: qualify broad free starter kit boundaries"
~~~

## Dependencies and blockers

- Missing/unqualified Wave 2 Question Ladder or Route Map + One Promise blocks the entire reservation.
- A missing reuse record, receipt mismatch, incompatibility, duplicate fingerprint, safety failure, status transition failure, or missing/rejected review blocks that kit only; no sibling kit changes closure.
- Retained candidates/handoff are stock-ready only with every applicable passed review; they never authorize GenStudio product/release creation, commerce terms, claim/install, checkout, upload, or publication.

## Plan Self-Review

**Spec coverage:** all five free proposals, exactly two new Formulae/five Topics, exact reuse, compatibility, coverage/uniqueness, safety, five coordinators, registry receipts, component summaries, review gates, and keyless candidate boundary are covered.

**Placeholder scan:** paths, proposed slugs, closure choices, counts, tests, commands, and blockers are concrete. New Story identities are receipt-issued authority values, not unspecified work.

**Type consistency:** leaves are series-formula/topic-pack; coordinators are channel-kit; every issued closure resolves exact pack_id@version; component summaries carry only canonical kind/count information.
