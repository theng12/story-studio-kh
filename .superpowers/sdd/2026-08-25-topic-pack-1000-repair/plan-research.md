# Topic Pack 1,000-Idea Repair — Implementation Plan Research

**Research status:** read-only planning input based on commit `40ec920e59c4c77ef2a125f40be6d746cd6b2d08`. No product source, registry, archive, handoff, or Git state was changed.

**Decision baseline:** [owner-decision-groundwork.md](./owner-decision-groundwork.md). This plan implements its approved minimum repair: every existing Topic Pack receives a `1.0.1` successor with capacity for 1,000 lifetime structural assignments, without changing the Topic schema, production adapter, Formula sources, or `planIdeaAssignments()`.

## Non-negotiable scope

- Preserve every existing `1.0.0` source directory byte-for-byte. A successor is a new sibling directory ending in `-v1.0.1`, never an in-place edit.
- Preserve the exact `pack_id`, `item_id`, `publisher_id`, entitlement family/SKU, `min_app_version`/status, compatibility lists, and empty dependency closure. Change the Story content version to `1.0.1`, source path, source content, and a truthful manifest `changelog` only.
- Retain the ten Starter Topic Packs as `coverage_profiles`, with exactly one profile per subject and 20 complete tuple records per profile. Do not replace them with generic axes or coverage groups.
- Retain Audience Question Seeder and five Archival Ledger Topic Packs as independent axes only while every axis value is coherent for every subject. A value that is not universal belongs in a reviewed narrower group/profile, not a vague shared list.
- No product changes belong in `electron/server/content-packs/schemas.ts`, `electron/server/content-packs/legacy-adapters.ts`, or `electron/server/services/idea-campaign-planner.ts`; they are verification dependencies only.
- The current schema already permits the target: up to 1,000 subjects, `max_siblings_per_subject <= 20`, and 2–50 tuples per profile. The planner already fails closed for exhausted profile material and enforces distinct episode-object/mechanism material siblings.

## Exact source and test file groups

### New `1.0.1` successor sources (16 roots, 32 files)

| Group | Successor root | Content document |
|---|---|---|
| Starter profile ×10 | `content-packs/free-starters/topic/ancient-humans-survival-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/economics-businesses-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/everyday-calm-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/habits-momentum-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/natural-world-animals-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/night-journeys-v1.0.1` | `content/topic-pack.json` |
| | `content-packs/free-starters/topic/pov-historical-occupations-v1.0.1` | `content/topic-pack.json` |
| Independent reusable ×1 | `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1` | `content/topic-pack.json` |
| Independent Archival Ledger ×5 | `content-packs/paid/archival-ledger/topic/empires-trade-extraction-v1.0.1` | `content/topic-empires-trade-extraction.json` |
| | `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power-v1.0.1` | `content/topic-infrastructure-commodities-corporate-power.json` |
| | `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions-v1.0.1` | `content/topic-money-debt-financial-institutions.json` |
| | `content-packs/paid/archival-ledger/topic/states-revolutions-collapse-v1.0.1` | `content/topic-states-revolutions-collapse.json` |
| | `content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.1` | `content/topic-wars-treaties-world-order.json` |

For each root create `pack.json` and the stated content JSON. Follow the committed successor pattern in `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/pack.json`: same identity/family/SKU, `version: "1.0.1"`, and a concise truthful changelog. Unlike Kit successors, these leaf Topic successors have `dependencies: []` (or omit the field precisely as their `1.0.0` predecessor does); do not create Kit successors in this workstream.

### Tests and coordinating files

| File | Responsibility |
|---|---|
| `scripts/content-packs/__tests__/topic-pack-1000-successors.test.mjs` (new) | Exact successor inventory, identity/predecessor integrity, source parse, authored semantics, 1,000-capacity planner proof, keyless deterministic archive and delivery-profile validation. Keep all 16 source facts in this one purpose-built authored-source test rather than mutating unrelated historical wave tests. |
| `scripts/content-packs/__tests__/authoring-registry.test.mjs` (existing) | Reuse its CAS reservation/receipt fixture behavior; add only a narrow 16-record successor lifecycle regression if the new test cannot exercise a copied temporary registry safely. |
| `content-packs/authoring-registry.json` | Coordinator-only atomic reservation and later one-record-at-a-time `reserved -> authored` lifecycle events; never leaf-authored concurrently. |
| `.sdd/topic-pack-1000-reservation-request.json` (temporary, ignored) | Exact 16-record reservation input, generated only after the red admission test passes and a fresh registry validation succeeds; remove before commit. |
| `.sdd/topic-pack-1000-expected-identities/*.json` (temporary, ignored) | 16 coordinator-issued records without `receipt_ref`, one consumed by `verify-receipt` per leaf; remove before commit. |
| `.sdd/topic-pack-1000-transition-*.json` (temporary, ignored) | One serialized lifecycle request per clean leaf; remove before commit. |
| `scripts/content-packs/stage-handoff-artifacts.mjs` (read-only dependency) | Use its `genstudio-store-receipt-v1` receipt-bound staging contract; do not generalize or repurpose the currently fixed Wave 2 payload. |
| `<owner-home>/Developer/_handoffs/artifacts/topic-pack-1000-repair-2026-08-25/` (new external artifact root) | Fresh retained candidate archives, immutable evidence ledger, and GenStudio receiver handoff. This is created only after all 16 candidates validate; it is not repository source. |

## Tests to add first (deliberately red before reservation/source creation)

Create `scripts/content-packs/__tests__/topic-pack-1000-successors.test.mjs` before any registry mutation. Its static `SUCCESSORS` table must contain these 16 exact predecessor/successor mappings and no other leaf:

```js
const SUCCESSORS = [
  ['content-packs/free-starters/topic/ancient-humans-survival', 'content-packs/free-starters/topic/ancient-humans-survival-v1.0.1'],
  ['content-packs/free-starters/topic/deep-time-earth-systems', 'content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1'],
  ['content-packs/free-starters/topic/economics-businesses', 'content-packs/free-starters/topic/economics-businesses-v1.0.1'],
  ['content-packs/free-starters/topic/everyday-calm', 'content-packs/free-starters/topic/everyday-calm-v1.0.1'],
  ['content-packs/free-starters/topic/habits-momentum', 'content-packs/free-starters/topic/habits-momentum-v1.0.1'],
  ['content-packs/free-starters/topic/historical-wars-treaties-world-order', 'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1'],
  ['content-packs/free-starters/topic/human-behavior-social-dynamics', 'content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1'],
  ['content-packs/free-starters/topic/natural-world-animals', 'content-packs/free-starters/topic/natural-world-animals-v1.0.1'],
  ['content-packs/free-starters/topic/night-journeys', 'content-packs/free-starters/topic/night-journeys-v1.0.1'],
  ['content-packs/free-starters/topic/pov-historical-occupations', 'content-packs/free-starters/topic/pov-historical-occupations-v1.0.1'],
  ['content-packs/reusable-primitives/topic/audience-question-seeder', 'content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1'],
  ['content-packs/paid/archival-ledger/topic/empires-trade-extraction', 'content-packs/paid/archival-ledger/topic/empires-trade-extraction-v1.0.1'],
  ['content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power', 'content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power-v1.0.1'],
  ['content-packs/paid/archival-ledger/topic/money-debt-financial-institutions', 'content-packs/paid/archival-ledger/topic/money-debt-financial-institutions-v1.0.1'],
  ['content-packs/paid/archival-ledger/topic/states-revolutions-collapse', 'content-packs/paid/archival-ledger/topic/states-revolutions-collapse-v1.0.1'],
  ['content-packs/paid/archival-ledger/topic/wars-treaties-world-order', 'content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.1'],
]
```

Add these named tests, in this order.

1. `topic-pack 1.0.1 successors are the complete, receipt-bound 16-leaf inventory`
   - Initially fails because no successor sources or registry records exist.
   - For every pair, assert the predecessor directory tree digest is unchanged from a test-local baseline, successor manifest is `1.0.1`, all identity/family/SKU/min-version/dependencies fields equal the predecessor, source path equals successor directory, and the registry has exactly one record matching `pack_id@1.0.1` with `status: 'reserved'` or later `authored`.
   - Assert the 16 records share exactly one `authoring:<sha256>` receipt; reject `baseline:` receipt, a mixed receipt, duplicate successor roots, a changed item id/family/SKU, or a new dependency.

2. `each profile successor has 50 subjects and 20 complete, subject-specific tuples`
   - The ten profile successors must parse via `parseContentPackDocument('topic-pack', raw)`.
   - Assert `coverage_groups === undefined`, `subjects.length === 50`, `coverage_profiles.length === 50`, each declared subject has exactly one profile, each profile has exactly 20 tuples, and `max_siblings_per_subject === 20`.
   - Assert every tuple axis belongs to the declared document list; 20 objects and 20 mechanisms per profile are case-normalized unique; no full tuple or `episode_object|mechanism` pair occurs in two subjects; current placeholder and abstract-object bans from `electron/server/__tests__/free-starter-signed-source-golden.test.ts` remain active for successor corpus too.

3. `each independent-axis successor has 50 subjects and 20 coherent material values per axis`
   - For Audience Question Seeder and every Archival Ledger successor, assert no profiles/groups unless a value failed universality and was intentionally narrowed; assert exactly 50 unique subjects, cap 20, and at least 20 case-normalized unique values in each of `episode_objects`, `time_place_scopes`, and `mechanisms`.
   - Require an explicit reviewed coherence matrix in the test fixture, keyed by successor slug and subject, whose values are the 20 accepted material values for each material axis. The test must reject a source value absent from any subject’s matrix. This is the proof that independent axes stay universally applicable instead of merely having enough strings.

4. `each successor independently plans 1,000 deterministic, structurally unique assignments`
   - Pair each Topic successor with its committed compatible Formula source; parse through the real schema and `contentPackDocumentToNiche()` / `contentPackDocumentToTopicPack()` adapters; call the unchanged `planIdeaAssignments({ niche, count: 1000, seed })`.
   - Assert exactly 1,000 returned records, 1,000 fingerprints, 1,000 `idea_key`s, and deep equality for a second invocation with the same seed.
   - For profiles, assert every returned material quadruple is an authored complete tuple for that exact subject; every subject has 20 assignments and 20 distinct material values for all three material dimensions. For independent axes, assert every subject receives 20 assignments, values are drawn from the declared axes, and each subject has 20 distinct values in every material dimension.

5. `each successor reserves 500 then 500 with no structural overlap and exhausts safely`
   - Request 500, feed its fingerprints to an independent `count: 500` request, then assert a 1,000-size union with no repeated fingerprint, `idea_key`, same-subject episode object, or same-subject mechanism. Verify the profiles’ next request fails closed once all 1,000 are used. For independent packs, require an empty/non-repeating result rather than permitting a repeated material sibling.

6. `each 1.0.1 successor builds twice as a bounded keyless Store candidate`
   - Use `buildContentPack()` / `validateContentPack()` as in `scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs`, with `deliveryProfile: 'genstudio-store-receipt-v1'` and a single agreed release `minAppVersion` (not `1.0.843` copied blindly; coordinator supplies the actual release floor).
   - Assert byte equality/SHA equality for two source-identical builds, `<= 52_428_800` bytes, structural validation, no `key_id`/signature/private key, exact `pack_id@1.0.1`, and no URL/provider/model/price/credential fields. Use temporary output only; never write `.sspack` under a source root.

First red command:

```bash
node --test scripts/content-packs/__tests__/topic-pack-1000-successors.test.mjs
```

Expected initial failure: missing 16 `-v1.0.1` source roots and no one-batch reservation receipt. Do not reserve merely to turn this test green until its assertion fixture is reviewed.

## Registry reservation: exact records and receipt procedure

At current commit the registry is revision `33`; this number is only a planning observation. The coordinator must run a fresh validation and read its current revision immediately before writing the request. Do not pre-fill a stale `expected_revision`.

The reservation request contains exactly 16 `topic-pack` records. For each current `1.0.0` registry record, clone the following fields exactly: `pack_id`, `item_id`, `publisher_id`, `min_app_version`, `min_app_version_status`, `kind`, `dependencies: []`, and `stocking_proposal` including current family/SKU IDs/status. Set only:

```json
{
  "version": "1.0.1",
  "source_path": "<the matching successor root from the inventory above>",
  "status": "reserved"
}
```

Request envelope:

```json
{
  "expected_revision": "<fresh numeric registry revision>",
  "coordinator": {
    "task": "topic-pack-1000-repair",
    "branch": "codex/content-expansion-portfolio"
  },
  "proposal_ref": ".superpowers/sdd/2026-08-25-topic-pack-1000-repair/owner-decision-groundwork.md",
  "records": ["<all 16 exact records, in canonical source-path order>"]
}
```

Coordinator sequence (the only registry writer):

```bash
npm run content-pack:registry -- validate
npm run content-pack:registry -- reserve --request .sdd/topic-pack-1000-reservation-request.json
# Record the returned { revision, receipt_ref } in the task evidence, then create one expected identity file per record.
npm run content-pack:registry -- verify-receipt --revision "$TOPIC1000_REVISION" --receipt "$TOPIC1000_RECEIPT" --expected-identity .sdd/topic-pack-1000-expected-identities/ancient-humans-survival.json
```

Repeat the last command for all 16 records. A receipt mismatch, collision, stale revision, registry lock, missing predecessor, changed family/SKU, or source-path collision fails the complete batch. Revalidate/rebase/re-request as one whole batch; do not repair individual identities or permit leaf workers to reserve.

After each leaf meets all source, semantic, planner, archive, and editorial gates, serialize (never parallelize) its transition:

```bash
npm run content-pack:registry -- transition --request .sdd/topic-pack-1000-transition-ancient-humans-survival.json
npm run content-pack:registry -- validate
```

Each transition request uses the then-current revision, the one original receipt, exact `pack_id`, exact `version: "1.0.1"`, and `changes: { "status": "authored" }`. Do not transition a partially reviewed leaf and do not invent price, Store release, entitlement, upgrade, or publication state.

## Sequential SDD task partition

The proposed task order keeps shared registry/test state serialized and makes the 16 large authoring leaves independently reviewable after the single receipt barrier. It describes future delegation; this research task did not dispatch anyone.

### Task 1 — Admission test and immutable baseline (coordinator)

- Add the new successor test file and the full `SUCCESSORS` inventory.
- Capture test-local SHA-256 trees for every `1.0.0` source; do not write a mutable baseline into source directories.
- Run the red test, current registry validation, existing planner/golden tests, and exact successor/source discovery.
- Gate: test is red only for absent successors/reservation; no unrelated pre-existing failure; no schema/planner/adapter edit proposed.

### Task 2 — One 16-record CAS reservation and receipt fan-out (coordinator)

- Write the ignored temporary request only after Task 1 review passes; reserve once; persist the coordinator result as task evidence outside committed product content.
- Generate exact expected-identity files and prove all 16 with `verify-receipt`.
- Gate: all 16 records share one returned authoring receipt and remain `reserved`; fresh `validate` passes. A failed reservation returns to Task 1 without leaf work.

### Task 3 — Starter profile authoring, batch A (four isolated leaf tasks)

- Leaves: `natural-world-animals` (+980 tuples), `human-behavior-social-dynamics` (+980), `night-journeys` (+970), `habits-momentum` (+970).
- Every leaf receives only its receipt-verified identity file, predecessor root, target successor root, authoring test contract, and an editorial review checklist.
- Each leaf writes its two successor JSON files and runs its isolated test selection. It never touches registry, shared test fixture beyond its own table row, archive ledger, Formula, schema, or planner.
- Gate per leaf: profile 50×20 proof, tuple semantic review, planner 1,000/500+500 proof, parse; then coordinator reviews the diff.

### Task 4 — Starter profile authoring, batch B (three isolated leaf tasks)

- Leaves: `everyday-calm` (+970), `ancient-humans-survival` (+960), `historical-wars-treaties-world-order` (+950).
- Same leaf boundaries/gates as Task 3. Start only after Task 3 diffs are accepted so any improved authoring lint is applied consistently.

### Task 5 — Starter profile authoring, batch C (three isolated leaf tasks)

- Leaves: `pov-historical-occupations` (+950), `deep-time-earth-systems` (+940), `economics-businesses` (+920).
- Same gates; this completes all **9,590** new profile tuples. Do not split a single pack’s tuple corpus among multiple workers because cross-profile semantic uniqueness is an in-pack proof obligation.

### Task 6 — Independent-axis authoring (two sequential review batches)

- Batch A: `audience-question-seeder` (50 subjects; +14 each material axis; cap 20), then review its full cross-subject coherence matrix.
- Batch B: five Archival Ledger leaves, each 50 subjects; +12 episode objects, +16 time/place scopes, +12 mechanisms; cap 20. Assign one leaf per worker only after the shared test matrix API is already settled.
- Gate: each independent axis value is explicitly reviewed as coherent with all 50 subjects. If not, stop the leaf and author a narrower existing-schema grouping/profile after review; never fake universality.

### Task 7 — Integrated quality, deterministic archive candidates, and lifecycle transitions (coordinator)

- Run all 16 against real schema/adapters/planner, predecessor byte proofs, source safety, registry verification, and two keyless Store builds each.
- Build one archive per leaf into a fresh temporary candidate root; validate; compare bytes/SHA; then stage only completed leaves into the external artifact root with an evidence ledger and receiver handoff.
- Obtain independent editorial/factual review (coherence, exclusions, evidence posture, compatibility, originality, safety, copy) for all leaves; record review status in external handoff evidence, not inside the content documents unless schema permits it.
- Only then transition clean leaves serially from `reserved` to `authored`. A failed leaf stays reserved and is explicitly blocked; it never gets an archive/handoff entry claiming completion.

## Semantic uniqueness proof for the 9,590 authored profile tuples

The principal risk is treating “20 strings per subject” as equivalent to 20 semantically distinct, filmable treatments. The existing schema can prove membership and duplicate structure, but cannot establish factual coherence or originality by itself. Do not propose a schema/planner change as a shortcut.

Prove the result without code/schema changes using layered evidence:

1. **Atomic source records:** profiles remain whole `episode_object`, `time_place_scope`, `mechanism`, `evidence_lens` tuples. The planner already selects them atomically and excludes coherent material axes supplied by the Formula.
2. **Mechanical corpus audit in the new test:** normalized unique subject labels; one profile each; 20 tuple keys/profile; 20 normalized episode objects and mechanisms/profile; globally unique profile tuple keys and core `episode_object|mechanism` pairs; values declared in their document’s lists; no old placeholder/abstract vocabulary; no unchanged predecessor digest.
3. **Planner evidence, not a combinatorics claim:** for every real Formula/Topic pair use the production parser and adapters; prove 1,000 unique fingerprints/idea keys, deterministic same seed, 20 structural siblings per subject, and a 500 + 500 reservation split. Test full material dimensions, not title wording or Formula coverage angles.
4. **Human semantic matrix:** per profile subject, review 20 rows for concrete object, distinct causal/process mechanism, time/place relevance, evidence lens, filmability, exclusions, safety, factual plausibility, and non-overlap with every other subject’s core pair. This is the only defensible proof against synonymous or cosmetically rephrased duplicates.
5. **Independent review:** a second reviewer samples the beginning/middle/end of every subject’s 20 rows plus all flagged near-duplicate clusters. Escalate a weak or generic tuple to rewrite; do not waive it because the fingerprint differs.
6. **Fresh reservation replay:** retain the exact seed, source SHA-256, parser/planner test output, two 500-item fingerprint sets, review signoff, and archive SHA-256 in the external evidence ledger. The preserved `1.0.0` bytes and new `1.0.1` bytes make the claim reproducible later.

Near-duplicate detection may use normalized token/phrase overlap only as an editorial triage signal; it is not an automatic semantic pass. The authoritative acceptance decision remains the whole-tuple review, because a distinct noun can still describe the same episode treatment and a shared vocabulary word can be legitimate.

## Verification, archive, and handoff gates

### Focused gates per leaf

```bash
node --test scripts/content-packs/__tests__/topic-pack-1000-successors.test.mjs
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npm run content-pack:registry -- validate
```

For the ten Starter profile successors, also run the existing protection against weakening profiles:

```bash
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
node --test scripts/content-packs/__tests__/free-starter-inventory.test.mjs
```

For Archival Ledger and reusable primitive successors, retain their source contract coverage:

```bash
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
```

### Integrated repository gates

```bash
npx tsx --test electron/server/__tests__/idea-campaign-planner.test.ts electron/server/__tests__/free-starter-signed-source-golden.test.ts
npm run typecheck:electron
npm run lint
npm run test:backend
npm run check:security
npm run check:model-drift
npm run check:changelog
```

The project release integrity rule requires a package version and `CHANGELOG.md` change for a shipped Story Studio change. Before making either, the coordinator must decide whether source-only `1.0.1` Content Pack successors ship inside a desktop release. If yes, update `package.json`, `package-lock.json`, and newest-first `CHANGELOG.md` in the same approved release change, then run `npm run check:changelog` and the full `npm run build`; if no, record why the app runtime is not shipping and do not fabricate a desktop version bump. This owner/release decision cannot be inferred from source-pack authoring alone.

### Archive candidate gate (all 16 only)

Use a fresh outside-repository candidate directory and a real resolved Story release version:

```bash
mkdir -p <owner-home>/Developer/_handoffs/artifacts/topic-pack-1000-repair-2026-08-25/candidates
npm run content-pack:build -- ./content-packs/free-starters/topic/ancient-humans-survival-v1.0.1 --delivery-profile genstudio-store-receipt-v1 --min-app-version "$FINAL_STORY_STUDIO_RELEASE_VERSION" --output <owner-home>/Developer/_handoffs/artifacts/topic-pack-1000-repair-2026-08-25/candidates/ancient-humans-survival-1.0.1-a.sspack
npm run content-pack:validate -- <owner-home>/Developer/_handoffs/artifacts/topic-pack-1000-repair-2026-08-25/candidates/ancient-humans-survival-1.0.1-a.sspack --delivery-profile genstudio-store-receipt-v1
```

Repeat twice per leaf into distinct non-existing output paths and compare byte equality/SHA. Do not use `content-packs/archival-ledger` (the retired monolith is explicitly unbuildable); build the five roots under `content-packs/paid/archival-ledger/topic/`.

Archive acceptance for every leaf:

- source parses strictly, source layout contains only `pack.json` and permitted `content/` JSON;
- registry receipt is the one verified 16-record reservation and record is authored only after all proof;
- two keyless `genstudio-store-receipt-v1` outputs are byte/SHA-identical, structurally validate, are at most 52,428,800 bytes, and contain no publisher signature/key or prohibited sensitive/provider/price material;
- manifest identity/version/family/SKU/minimum Story version and empty dependency closure match receipt-issued identity;
- external ledger records absolute archive path, bytes, SHA-256, delivery profile, resolved minimum app version, receipt ref, and all review statuses;
- receiver handoff lists only complete archives and separately names every blocked leaf and exact blocker. It requests no release, price, product, stocking, entitlement, upload, or publication action.

## Known risks and stop conditions

- **Exact-lifetime capacity:** `50 × 20 = 1,000` has no headroom. If the owner means 1,000 *additional* assignments after existing reservations, stop for a product decision on the documented 60×20 alternative; do not silently ship a different promise.
- **Profile volume:** 9,590 new rows make accidental copied/generic tuples likely. Keep one owner per source root, require editorial evidence before transition, and do not compress authoring into a shared-axis workaround.
- **Independent-axis universality:** an axis value that fits only some subjects invalidates the independent model even if cardinality is 20. Stop and narrow the source rather than claiming universal coherence.
- **Shared mutable state:** registry, request/receipt evidence, `topic-pack-1000-successors.test.mjs`, and external artifact ledger are coordinator-owned. Leaf workers must not write them concurrently.
- **Successor scope creep:** existing Formula and Kit `1.0.0` references stay as-is. A Kit successor would be a separate release/dependency-closure task; this Topic source repair must not alter kit dependencies autonomously.
- **Store authority:** Story’s registry records proposed Story family/SKU facts only. GenStudio confirms deployed release, 300-credit price preservation, entitlement/upgrade behavior, and stocking in its own completion response. No Story task assumes or mutates any of those states.

## Research self-check

- All 16 current source layouts, source schemas/refinements, production adapters, planner behavior, registry CAS/receipt contract, build/validate scripts, existing source/golden tests, archival keyless build examples, and `1.0.1` successor examples were inspected.
- The plan calls for source-only successors and explicitly preserves schema/planner/Formula behavior.
- The plan defines red tests before reservation, exact identity record requirements, sequential worker boundaries, mechanical plus human uniqueness evidence, and archive/handoff gates.
- No content, registry, archive, build output, handoff artifact, commit, or push was created by this research pass.
