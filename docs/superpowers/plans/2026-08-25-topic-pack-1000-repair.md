# Topic Pack 1,000-Idea Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author and qualify exactly sixteen receipt-bound `1.0.1` Topic Pack source successors for GenStudio publication, each providing 1,000 deterministic, structurally unique lifetime assignments without changing runtime behavior.

**Architecture:** The repository already has strict Topic Pack schema/refinement, production adapters, a duplicate-resistant planner, immutable source archives, and authoring-registry CAS receipts. A coordinator reserves all successor identities once, then each leaf task adds its reviewed row to a shared capacity test before authoring one isolated successor source; this makes every leaf change set independently red then green. The coordinator alone owns registry transitions and the all-or-nothing candidate handoff.

**Tech Stack:** JSON Content Pack sources; TypeScript schema/adapters/planner tests via `tsx`; Node MJS publisher/archive tests; Content Pack registry CAS; keyless `genstudio-store-receipt-v1` archive builder/validator.

**Spec:** `docs/superpowers/specs/2026-08-25-topic-pack-1000-repair-design.md`

## Global Constraints

- Include all 16 canonical Content Store Topic Pack identities and no runtime-only Topic JSON; the exact boundary is in `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/catalog-inventory.md`.
- Keep current `1.0.0` source directories byte-identical; successors are exact `-v1.0.1` sibling roots with the same pack/item/publisher/family/SKU/min-app/compatibility/dependency identity.
- Use one coordinator-owned atomic reservation and one returned receipt before authoring any source. Leaf tasks never write `content-packs/authoring-registry.json`.
- Preserve ten profile packs as 50 subjects × 20 complete coherent tuples per subject; preserve six independent packs as 50 subjects × 20 universal values in every material axis; set cap 20.
- Do not modify Formula sources, schemas, planner, adapters, Kits, desktop app version, `package.json`, `package-lock.json`, or `CHANGELOG.md`. Source-only archives are independent of the desktop binary.
- Preserve existing commerce, including Audience Question Seeder’s GenStudio draft/unreachable state. Story does not activate, price, stock, pin, upload, release, publish, grant, or otherwise mutate GenStudio; the final complete handoff asks GenStudio to act only after all Story gates pass.
- Candidate archives use `genstudio-store-receipt-v1`, `min_app_version: 1.0.843`, two fresh paths per leaf, byte/SHA equality, validation, and a maximum of 52,428,800 bytes.
- No partial GenStudio handoff: it is emitted only after all 16 candidates, reviews, and serialized registry transitions are clean.

---

## Shared test interface

Create `electron/server/__tests__/topic-pack-1000-successors.test.ts`. It owns one `REVIEWED_ROWS` constant; every leaf task appends exactly one complete row before creating that leaf’s source. This TypeScript source/planner test uses direct TypeScript imports and runs only through `npx tsx --test`; it does not claim plain `node --test` can import the repository’s TypeScript modules. Candidate build/staging checks belong in the separate MJS test specified in Task 19. Use this exact shape for a profile row:

```js
{
  slug: 'natural-world-animals',
  class: 'profile',
  predecessorRoot: 'content-packs/free-starters/topic/natural-world-animals',
  successorRoot: 'content-packs/free-starters/topic/natural-world-animals-v1.0.1',
  document: 'content/topic-pack.json',
  packId: 'com.storystudio.pack.topic.natural-world-animals',
  itemId: 'com.storystudio.topic.natural-world-animals',
  formulaRoot: 'content-packs/free-starters/formula/natural-world-explained',
  subjects: 50,
  siblings: 20,
  tupleAdditions: 980,
  reviewPath: '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/natural-world-animals-semantic-review.md',
}
```

Independent rows use `class: 'independent'`, `tupleAdditions: 0`, `reviewPath`, and `universalMatrixPath`. The latter is `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/<slug>-universal-matrix.json`, containing one list of 50 subjects, one list of 20 approved values for each material axis, a reviewer verdict for every subject×axis applicability, and the SHA-256 of the exact successor content JSON. The test verifies source cardinality/structure and the artifact path/hash binding; semantic universality remains an independent human-review gate, not a gigantic duplicated matrix in test code.

The TypeScript test imports existing `parseContentPackDocument`, `contentPackDocumentToNiche`, `contentPackDocumentToTopicPack`, and `planIdeaAssignments`. Its `assertRowCapacity(row)` verifies strict parse; predecessor digest; registry receipt identity; profile/independent shape; review report binding; a real 1,000 assignment run; unique fingerprints and idea keys; equal-seed determinism; and 500 + 500 reserved non-overlap. `scripts/content-packs/__tests__/topic-pack-1000-successors-pack.test.mjs` owns the two keyless candidate builds, staging, and archive checks.

Every leaf task has the same red/green interface: append only its full row, run the named-row test and observe the missing-source red result, author only its successor root, then re-run the named-row test green. A leaf’s future commit is permitted only after its row is green.

The shared test names each case `capacity: <row slug>`. Every task’s red and green command uses the literal slug named in that task, once after the row and once after the successor source. The expected first result is a missing `pack.json` or content-document failure; the expected second result is pass.

```bash
npx tsx --test --test-name-pattern "capacity: natural-world-animals" electron/server/__tests__/topic-pack-1000-successors.test.ts
```

Every leaf task’s first action is receipt preflight; it is never delegated away or postponed:

```bash
npm run content-pack:registry -- verify-receipt --revision "$TOPIC1000_REVISION" --receipt "$TOPIC1000_RECEIPT" --expected-identity .superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/natural-world-animals.json
```

The coordinator keeps every exact expected-identity file through Task 19. Each profile task also creates its task-specific `-semantic-review.md` file listed below; it records predecessor and successor content SHA-256, reviewer, review date, all 50 subjects, per-subject 20-tuple verdict, duplicate/placeholder scan result, and signed verdicts for coherence, exclusions, evidence posture, compatibility, originality, safety, factual basis, and copy. Each independent task creates that same report plus its task-specific `-universal-matrix.json` file listed below with this exact interface:

```json
{
  "schema_version": 1,
  "pack_id": "com.storystudio.pack.topic.example",
  "version": "1.0.1",
  "source_document_sha256": "64 lowercase hexadecimal characters",
  "subjects": ["50 exact declared subjects"],
  "material_axes": {
    "episode_objects": ["20 exact universal values"],
    "time_place_scopes": ["20 exact universal values"],
    "mechanisms": ["20 exact universal values"]
  },
  "verdicts": [
    { "subject": "one declared subject", "axis": "episode_objects", "verdict": "accepted", "rationale": "why all listed values fit this subject" }
  ],
  "reviewer": "named reviewer",
  "reviewed_at": "ISO-8601 timestamp"
}
```

The independent matrix has exactly 150 verdicts: one accepted or rejected verdict for every 50-subject × 3-axis pair. A rejected verdict blocks that leaf; it must narrow the source with existing schema before its row can go green. The TypeScript test binds `pack_id`, version, subject and material-axis lists, and `source_document_sha256`; it does not pretend that automated cardinality validates semantic universality.

## Task 1: Coordinator reservation durability and shared capacity harness

**Files:**
- Create: `electron/server/__tests__/topic-pack-1000-successors.test.ts`
- Modify after root coordinator reserves: `content-packs/authoring-registry.json`
- Create and retain through Task 19: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reservation-request.json`
- Create and retain through Task 19: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reservation-result.json`
- Create and retain through Task 19: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/`

**Interfaces:** Consumes exact mapping in `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/registry-mapping.md`. Produces empty `REVIEWED_ROWS`, one persisted 16-record receipt batch, and 16 verified identity files.

The exact expected-identity files are `ancient-humans-survival.json`, `deep-time-earth-systems.json`, `economics-businesses.json`, `everyday-calm.json`, `habits-momentum.json`, `historical-wars-treaties-world-order.json`, `human-behavior-social-dynamics.json`, `natural-world-animals.json`, `night-journeys.json`, `pov-historical-occupations.json`, `audience-question-seeder.json`, `empires-trade-extraction.json`, `infrastructure-commodities-corporate-power.json`, `money-debt-financial-institutions.json`, `states-revolutions-collapse.json`, and `wars-treaties-world-order.json` under `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/`.

- [ ] Add `readTopicSource`, `assertImmutablePredecessor`, `assertIdentity`, `assertProfileShape`, `assertIndependentShape`, and `assertPlannerCapacity` helpers. Keyless candidate assertions remain exclusively in Task 19’s MJS archive test.
- [ ] Add the all-16 identity test; assert every mapped `pack_id@1.0.1` is missing initially and run red:

```bash
npx tsx --test electron/server/__tests__/topic-pack-1000-successors.test.ts
```

- [ ] Validate the live registry, use its printed revision in a request with exactly the 16 mapping-report records, then reserve once:

```bash
npm run content-pack:registry -- validate
npm run content-pack:registry -- reserve --request .superpowers/sdd/2026-08-25-topic-pack-1000-repair/reservation-request.json
```

- [ ] Persist the returned `{ revision, receipt_ref }` in `reservation-result.json`; write the returned record fields minus `receipt_ref` into all 16 expected-identity files and verify each against the one returned revision/receipt:

```bash
npm run content-pack:registry -- verify-receipt --revision "$TOPIC1000_REVISION" --receipt "$TOPIC1000_RECEIPT" --expected-identity .superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/natural-world-animals.json
```

- [ ] Make the identity test assert exactly 16 reserved records share `$TOPIC1000_RECEIPT`, then run green. Keep the reservation request/result and all expected identity files through Task 19 so every leaf and the final candidate gate can verify its exact receipt-bound identity:

```bash
npx tsx --test electron/server/__tests__/topic-pack-1000-successors.test.ts
npm run content-pack:registry -- validate
```

## Profile leaf tasks

Each task below modifies only the shared test plus the two named successor files. It consumes the Task 1 receipt identity and produces one reviewed 50-subject, cap-20 profile source. It preserves inherited exclusions, compatibility, evidence posture, and prompt/vocabulary facts that remain truthful.

### Task 2: Natural World Animals

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/natural-world-animals-semantic-review.md`; `content-packs/free-starters/topic/natural-world-animals-v1.0.1/pack.json`; `content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/natural-world-animals.json`; stop on any mismatch.
- [ ] Add only the `natural-world-animals` reviewed profile row (`tupleAdditions: 980`) and run its pattern test red.
- [ ] Author same-identity `1.0.1` manifest and 50 × 20 concrete animal tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: natural-world-animals" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 3: Human Behavior Social Dynamics

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/human-behavior-social-dynamics-semantic-review.md`; `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1/pack.json`; `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/human-behavior-social-dynamics.json`; stop on any mismatch.
- [ ] Add only the `human-behavior-social-dynamics` reviewed row (`tupleAdditions: 980`) and run red.
- [ ] Author same-identity 50 × 20 subject-specific social-dynamics tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: human-behavior-social-dynamics" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 4: Night Journeys

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/night-journeys-semantic-review.md`; `content-packs/free-starters/topic/night-journeys-v1.0.1/pack.json`; `content-packs/free-starters/topic/night-journeys-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/night-journeys.json`; stop on any mismatch.
- [ ] Add only the `night-journeys` reviewed row (`tupleAdditions: 970`) and run red.
- [ ] Author 50 × 20 non-alarming, safe sleep-story tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: night-journeys" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 5: Habits and Momentum

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/habits-momentum-semantic-review.md`; `content-packs/free-starters/topic/habits-momentum-v1.0.1/pack.json`; `content-packs/free-starters/topic/habits-momentum-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/habits-momentum.json`; stop on any mismatch.
- [ ] Add only the `habits-momentum` reviewed row (`tupleAdditions: 970`) and run red.
- [ ] Author 50 × 20 concrete practice tuples; retain only the existing documented `a water bottle|cue design` exception if current tests still permit it.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: habits-momentum" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 6: Everyday Calm

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/everyday-calm-semantic-review.md`; `content-packs/free-starters/topic/everyday-calm-v1.0.1/pack.json`; `content-packs/free-starters/topic/everyday-calm-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/everyday-calm.json`; stop on any mismatch.
- [ ] Add only the `everyday-calm` reviewed row (`tupleAdditions: 970`) and run red.
- [ ] Author 50 × 20 concrete calm-practice tuples without therapeutic certainty.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: everyday-calm" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 7: Ancient Humans Survival

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/ancient-humans-survival-semantic-review.md`; `content-packs/free-starters/topic/ancient-humans-survival-v1.0.1/pack.json`; `content-packs/free-starters/topic/ancient-humans-survival-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/ancient-humans-survival.json`; stop on any mismatch.
- [ ] Add only the `ancient-humans-survival` reviewed row (`tupleAdditions: 960`) and run red.
- [ ] Author 50 × 20 concrete archaeological/evidence-aware tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: ancient-humans-survival" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 8: Historical Wars, Treaties, and World Order

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/historical-wars-treaties-world-order-semantic-review.md`; `content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1/pack.json`; `content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/historical-wars-treaties-world-order.json`; stop on any mismatch.
- [ ] Add only the `historical-wars-treaties-world-order` reviewed row (`tupleAdditions: 950`) and run red.
- [ ] Author the History-cut successor without changing the distinct Archival Ledger wars identity.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: historical-wars-treaties-world-order" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 9: Historical Occupations

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/pov-historical-occupations-semantic-review.md`; `content-packs/free-starters/topic/pov-historical-occupations-v1.0.1/pack.json`; `content-packs/free-starters/topic/pov-historical-occupations-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/pov-historical-occupations.json`; stop on any mismatch.
- [ ] Add only the `pov-historical-occupations` reviewed row (`tupleAdditions: 950`) and run red.
- [ ] Author 50 specific occupations with 20 non-repeated filmable tuples each.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: pov-historical-occupations" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 10: Deep Time Earth Systems

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/deep-time-earth-systems-semantic-review.md`; `content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1/pack.json`; `content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/deep-time-earth-systems.json`; stop on any mismatch.
- [ ] Add only the `deep-time-earth-systems` reviewed row (`tupleAdditions: 940`) and run red.
- [ ] Author 50 × 20 bounded evidence-aware Earth-system tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: deep-time-earth-systems" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

### Task 11: Businesses and Companies

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/economics-businesses-semantic-review.md`; `content-packs/free-starters/topic/economics-businesses-v1.0.1/pack.json`; `content-packs/free-starters/topic/economics-businesses-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/economics-businesses.json`; stop on any mismatch.
- [ ] Add only the `economics-businesses` reviewed row (`tupleAdditions: 920`) and run red.
- [ ] Author 50 actual business/company subjects with 20 concrete, non-generic operating/economic tuples each.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: economics-businesses" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

## Independent-axis leaf tasks

Each task below modifies the shared test and its two named successor files. It adds one complete reviewed universal matrix before authoring, then passes the same 1,000 / 500+500 / deterministic archive proof. Tasks 13–17 additionally evolve the paid Archival source inventory one successor at a time: `content-packs/paid/archival-ledger/registry.mjs` contains both immutable `1.0.0` rows and each newly authored `1.0.1` source row, while `scripts/content-packs/__tests__/archival-ledger-components.test.mjs` keeps its reviewed eight-component `1.0.0` content/hash/125-subject baseline separate from the growing successor inventory.

### Task 12: Audience Question Seeder

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/audience-question-seeder-semantic-review.md`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/audience-question-seeder-universal-matrix.json`; `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1/pack.json`; `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/audience-question-seeder.json`; stop on any mismatch.
- [ ] Add only `audience-question-seeder` with review report plus complete 50-subject universal-matrix artifact and run red.
- [ ] Author cap-20 50-subject source with at least 20 universal values per material axis; make no Kit or commerce change, preserving its GenStudio draft/unreachable state.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: audience-question-seeder" electron/server/__tests__/topic-pack-1000-successors.test.ts
node --test scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
```

### Task 13: Archival Ledger Empires, Trade, and Extraction

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `scripts/content-packs/__tests__/archival-ledger-components.test.mjs`; `content-packs/paid/archival-ledger/registry.mjs`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/empires-trade-extraction-semantic-review.md`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/empires-trade-extraction-universal-matrix.json`; `content-packs/paid/archival-ledger/topic/empires-trade-extraction-v1.0.1/pack.json`; `content-packs/paid/archival-ledger/topic/empires-trade-extraction-v1.0.1/content/topic-empires-trade-extraction.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/empires-trade-extraction.json`; stop on any mismatch.
- [ ] Refactor the Archival test’s existing `COMPONENTS` constant to `BASELINE_COMPONENTS` without changing its eight-row `1.0.0` exact-content/hash/125-subject assertions. Add an initially one-row `SUCCESSOR_TOPICS` inventory for `empires-trade-extraction-v1.0.1`, append the matching exact row to `paidComponentRegistry`, add only the `empires-trade-extraction` shared-capacity row plus complete review/matrix artifacts, and run both focused tests red because the successor source root is still absent.
- [ ] Author 50-subject cap-20 successor under `content-packs/paid/archival-ledger`, never the retired monolith.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: empires-trade-extraction" electron/server/__tests__/topic-pack-1000-successors.test.ts
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs
```

### Task 14: Archival Ledger Infrastructure, Commodities, and Corporate Power

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `scripts/content-packs/__tests__/archival-ledger-components.test.mjs`; `content-packs/paid/archival-ledger/registry.mjs`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/infrastructure-commodities-corporate-power-semantic-review.md`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/infrastructure-commodities-corporate-power-universal-matrix.json`; `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power-v1.0.1/pack.json`; `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power-v1.0.1/content/topic-infrastructure-commodities-corporate-power.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/infrastructure-commodities-corporate-power.json`; stop on any mismatch.
- [ ] Append only the exact `infrastructure-commodities-corporate-power-v1.0.1` successor row to `SUCCESSOR_TOPICS` and `paidComponentRegistry`, add its shared-capacity row plus complete review/matrix artifacts, and run both focused tests red because the successor source root is still absent.
- [ ] Author the 50-subject cap-20 successor with every matrix-approved material axis.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: infrastructure-commodities-corporate-power" electron/server/__tests__/topic-pack-1000-successors.test.ts
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs
```

### Task 15: Archival Ledger Money, Debt, and Financial Institutions

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `scripts/content-packs/__tests__/archival-ledger-components.test.mjs`; `content-packs/paid/archival-ledger/registry.mjs`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/money-debt-financial-institutions-semantic-review.md`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/money-debt-financial-institutions-universal-matrix.json`; `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions-v1.0.1/pack.json`; `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions-v1.0.1/content/topic-money-debt-financial-institutions.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/money-debt-financial-institutions.json`; stop on any mismatch.
- [ ] Append only the exact `money-debt-financial-institutions-v1.0.1` successor row to `SUCCESSOR_TOPICS` and `paidComponentRegistry`, add its shared-capacity row plus complete review/matrix artifacts, and run both focused tests red because the successor source root is still absent.
- [ ] Author the 50-subject cap-20 successor without financial advice/certainty outside inherited exclusions.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: money-debt-financial-institutions" electron/server/__tests__/topic-pack-1000-successors.test.ts
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs
```

### Task 16: Archival Ledger States, Revolutions, and Collapse

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `scripts/content-packs/__tests__/archival-ledger-components.test.mjs`; `content-packs/paid/archival-ledger/registry.mjs`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/states-revolutions-collapse-semantic-review.md`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/states-revolutions-collapse-universal-matrix.json`; `content-packs/paid/archival-ledger/topic/states-revolutions-collapse-v1.0.1/pack.json`; `content-packs/paid/archival-ledger/topic/states-revolutions-collapse-v1.0.1/content/topic-states-revolutions-collapse.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/states-revolutions-collapse.json`; stop on any mismatch.
- [ ] Append only the exact `states-revolutions-collapse-v1.0.1` successor row to `SUCCESSOR_TOPICS` and `paidComponentRegistry`, add its shared-capacity row plus complete review/matrix artifacts, and run both focused tests red because the successor source root is still absent.
- [ ] Author the 50-subject cap-20 successor with all universally coherent material values.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: states-revolutions-collapse" electron/server/__tests__/topic-pack-1000-successors.test.ts
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs
```

### Task 17: Archival Ledger Wars, Treaties, and World Order

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `scripts/content-packs/__tests__/archival-ledger-components.test.mjs`; `content-packs/paid/archival-ledger/registry.mjs`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/wars-treaties-world-order-semantic-review.md`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/wars-treaties-world-order-universal-matrix.json`; `content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.1/pack.json`; `content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.1/content/topic-wars-treaties-world-order.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/wars-treaties-world-order.json`; stop on any mismatch.
- [ ] Append only the exact `wars-treaties-world-order-v1.0.1` successor row to `SUCCESSOR_TOPICS` and `paidComponentRegistry`, add its `archival-ledger.wars-treaties-world-order` shared-capacity row plus complete review/matrix artifacts, and run both focused tests red because the successor source root is still absent.
- [ ] Author the Archival successor without changing Task 8’s History-cut successor or either Kit dependency.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: archival-ledger.wars-treaties-world-order" electron/server/__tests__/topic-pack-1000-successors.test.ts
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs
```

## Task 18: Integrated review and serialized lifecycle transitions

**Files:**
- Modify: `content-packs/authoring-registry.json` (coordinator only)
- Modify: `electron/server/__tests__/topic-pack-1000-successors.test.ts`
- Modify: `scripts/content-packs/__tests__/free-starter-inventory.test.mjs`
- Create and retain through Task 19: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/transitions/`

**Interfaces:** Consumes 16 green reviewed rows, all successor roots, and Task 1’s receipt. Produces 16 serialized `status: authored` lifecycle events.

The exact transition filenames are `ancient-humans-survival.json`, `deep-time-earth-systems.json`, `economics-businesses.json`, `everyday-calm.json`, `habits-momentum.json`, `historical-wars-treaties-world-order.json`, `human-behavior-social-dynamics.json`, `natural-world-animals.json`, `night-journeys.json`, `pov-historical-occupations.json`, `audience-question-seeder.json`, `empires-trade-extraction.json`, `infrastructure-commodities-corporate-power.json`, `money-debt-financial-institutions.json`, `states-revolutions-collapse.json`, and `wars-treaties-world-order.json` under `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/transitions/`.

- [ ] Run every row together and independently review all 16 sources for concrete treatment, coherence, exclusions, evidence posture, compatibility, originality, safety, and copy. Return a weak leaf to its own task; do not transition it.

```bash
npx tsx --test electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/idea-campaign-planner.test.ts electron/server/__tests__/free-starter-signed-source-golden.test.ts
npm run content-pack:registry -- validate
```

- [ ] Run the stale baseline first and observe its current red failure at the `55` source-count assertion and omitted `content-packs/free-starters/formula/human-behavior-explained-v1.0.1/pack.json` successor list entry:

```bash
node --test scripts/content-packs/__tests__/free-starter-inventory.test.mjs
```

- [ ] Update that test’s exact inventory after all ten Free Starter Topic successors exist: source count `66`; stable pack lineage count `46`; successor list exactly contains the existing human-behavior Formula successor, five Kit successors, four Thumbnail successors, and the ten `content-packs/free-starters/topic/*-v1.0.1/pack.json` paths. Run the corrected inventory test green before any registry transition.

- [ ] In canonical table order, write one current-revision transition request bound to `$TOPIC1000_RECEIPT`, run it, and revalidate before preparing the next request:

```bash
npm run content-pack:registry -- transition --request .superpowers/sdd/2026-08-25-topic-pack-1000-repair/transitions/ancient-humans-survival.json
npm run content-pack:registry -- validate
```

- [ ] After all sixteen serialized transitions succeed, change `EXPECTED_RECEIPT_STATUS` in `electron/server/__tests__/topic-pack-1000-successors.test.ts` from `'reserved'` to `'authored'`; do not change it during a partial batch. Assert all and only the 16 `$TOPIC1000_RECEIPT` records are authored, retain the transition, expected-identity, request, and receipt-result evidence through Task 19, and re-run the shared capacity and final inventory tests green.

## Task 19: Deterministic candidates, all-or-nothing staging, complete handoff, and broad verification

**Files:**
- Modify: `scripts/content-packs/stage-handoff-artifacts.mjs`
- Create: `scripts/content-packs/__tests__/topic-pack-1000-successors-pack.test.mjs`
- Read: `scripts/content-packs/build-pack.mjs`, `scripts/content-packs/validate-pack.mjs`
- Create outside repository: `/build/Developer/_handoffs/candidates/topic-pack-1000-repair-2026-08-25/`
- Create outside repository: `/build/Developer/_handoffs/artifacts/topic-pack-1000-repair-2026-08-25/`
- Create outside repository: `/build/Developer/_handoffs/2026-08-25_to-claude-genstudio_from-gpt-storystudio_topic-pack-1000-repair-candidates.json`
- Do not modify: desktop package/changelog, GenStudio, Kit, Formula, schema, adapter, or planner files

**Interfaces:** Consumes 16 authored receipt-bound successors. Produces 32 temporary candidates, 16 retained final archives, one validated evidence ledger, and one receiver handoff only when all leaves pass.

The new wave uses a strict entry contract without changing either existing wave contract. Every Topic repair entry has exactly these fields: `slug`, `pack_id`, `item_id`, `version`, `publisher_id`, `kind`, `source_path`, `source_document_sha256`, `dependencies`, `candidate_a_path`, `candidate_b_path`, `bytes`, `sha256`, `delivery_profile`, `min_app_version`, `receipt_ref`, `component_summary`, `reviews`, and `review_evidence`. Both candidate paths are absolute children of `candidateRoot`; each file must independently match the entry bytes/SHA and receipt-bound archive identity before candidate A may be copied. The final ledger records `candidate_pair: { builds: [{ label: "a", bytes, sha256 }, { label: "b", bytes, sha256 }], equal: true }` and never depends on temporary candidate paths.

Every entry’s `component_summary` is exactly `{ "schema_version": 1, "kind": "topic-pack", "summary": "50 subjects × 20 material siblings = 1,000 deterministic lifetime assignments.", "slots": { "topic-pack": 1 } }`. `reviews` retains the existing required passed review names. `review_evidence` is an exact ordered array of objects with fields `kind`, `source_path`, `artifact_relative_path`, and `sha256`: profile entries contain one `semantic-review`; independent entries contain `semantic-review` followed by `universal-matrix`. Evidence `source_path` values are repository-relative paths under `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/` and must resolve inside `repositoryRoot`; retained paths are exactly `reviews/<slug>-semantic-review.md` and, when applicable, `reviews/<slug>-universal-matrix.json`. The contract computes the actual content-document SHA-256 from the immutable per-slug document path in its binding, requires it to equal `source_document_sha256`, requires the semantic report to bind that same hash, parses independent matrices and requires their `source_document_sha256` to match, verifies every evidence-file SHA-256, copies evidence into the artifact root before writing the ledger, and rejects missing, extra, duplicate, escaping, or mismatched evidence.

- [ ] Write the MJS test first. Add a named `topic-pack-1000-repair` wave fixture with all 16 immutable bindings including each exact content-document relative path, the exact returned Task 1 receipt, `deliveryProfile: 'genstudio-store-receipt-v1'`, `minAppVersion: '1.0.843'`, and explicit 16-slug allowed/eligible/entry partition. Assert `stageHandoffArtifacts` rejects a missing leaf, wrong receipt, wrong identity, partial eligible list, non-empty blocked list, absent candidate A or B, unequal candidate bytes/SHA, a candidate outside `candidateRoot`, a source-content hash mismatch, or missing/extra/wrong-hash/unbound review evidence.
- [ ] Run the staging test red because `scripts/content-packs/stage-handoff-artifacts.mjs` has no named `topic-pack-1000-repair` wave contract:

```bash
node --test scripts/content-packs/__tests__/topic-pack-1000-successors-pack.test.mjs
```

- [ ] Add the narrowly scoped immutable `topic-pack-1000-repair` contract and entry/evidence branch to `stage-handoff-artifacts.mjs`. It must require all sixteen canonical slugs in order, exact Task 1 receipt binding, no blocked leaves, both candidate paths and their independently verified equality, the exact standardized Topic summary, exact per-class review evidence, `genstudio-store-receipt-v1`, min app `1.0.843`, and all-or-nothing staging; it must not weaken or alter the accepted entry shapes, ledgers, or behavior of the existing Wave 2 or thumbnail contracts.
- [ ] Re-run the MJS staging test green before building real candidates:

```bash
node --test scripts/content-packs/__tests__/topic-pack-1000-successors-pack.test.mjs
```

- [ ] Build every root twice to fresh paths with the required profile; example for the first leaf:

```bash
npm run content-pack:build -- ./content-packs/free-starters/topic/ancient-humans-survival-v1.0.1 --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.0.843 --output /build/Developer/_handoffs/candidates/topic-pack-1000-repair-2026-08-25/ancient-humans-survival-a.sspack
npm run content-pack:build -- ./content-packs/free-starters/topic/ancient-humans-survival-v1.0.1 --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.0.843 --output /build/Developer/_handoffs/candidates/topic-pack-1000-repair-2026-08-25/ancient-humans-survival-b.sspack
npm run content-pack:validate -- /build/Developer/_handoffs/candidates/topic-pack-1000-repair-2026-08-25/ancient-humans-survival-a.sspack --delivery-profile genstudio-store-receipt-v1
```

- [ ] Verify byte/SHA equality, receipt identity, prohibited-material absence, source/review hash bindings, evidence-file digests, and size ceiling for all 16. A single failure blocks every archive and evidence-file staging and produces no receiver handoff.
- [ ] Stage all 16 only after all candidate pairs and evidence bindings pass using `waveId: 'topic-pack-1000-repair'`. Revalidate final copied archives and review evidence; require the ledger and release handoff to contain the two-build equality proof plus retained evidence relative paths and hashes; and write `/build/Developer/_handoffs/2026-08-25_to-claude-genstudio_from-gpt-storystudio_topic-pack-1000-repair-candidates.json` with all 16 and no blocked/missing leaf. No retained ledger or handoff field may reference the temporary SDD review paths or candidate paths.
- [ ] Send the complete receiver handoff to GenStudio requesting that it add and publish the sixteen `1.0.1` releases under the same existing products and identities; preserve current prices, commerce, and Kit disposition; keep Audience Question Seeder’s product draft/unreachable; and return exact product ID, release ID, entitlement family/SKU, owner-upgrade behavior, and customer reachability evidence for every release. The handoff must explicitly forbid new products, repricing, product activation, Kit mutation, and publication of the Audience product. Story sends evidence only and does not perform any GenStudio mutation.
- [ ] Run broad verification:

```bash
npx tsx --test electron/server/__tests__/topic-pack-1000-successors.test.ts
node --test scripts/content-packs/__tests__/topic-pack-1000-successors-pack.test.mjs scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/free-starter-inventory.test.mjs scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs scripts/content-packs/__tests__/archival-ledger-components.test.mjs
npx tsx --test electron/server/__tests__/idea-campaign-planner.test.ts electron/server/__tests__/free-starter-signed-source-golden.test.ts
npm run typecheck:electron
npm run lint
npm run test:backend
npm run check:security
npm run check:model-drift
npm run content-pack:registry -- validate
```

- [ ] Require zero failures from all listed gates. Diagnose and repair any failure, including an inventory-count regression; do not waive a Topic successor, registry, archive, planner, or formerly unrelated baseline failure. Do not send a partial or provisional GenStudio handoff.

## Final plan self-check

- [ ] Ten profile tasks, one Audience task, and five Archival tasks each have exactly one reviewed-row RED → source → GREEN boundary.
- [ ] All 16 canonical packs are included; 15 runtime-only JSONs are excluded into a future conversion wave.
- [ ] Audience Question Seeder remains in scope but commerce-draft/unreachable; no Kit activation is planned.
- [ ] The TypeScript source/planner test runs through `npx tsx --test`; the MJS candidate/staging test runs through `node --test`; no command claims Node imports repository TypeScript directly.
- [ ] Every leaf begins with exact expected-identity receipt verification and creates a semantic review report; six independent leaves create separate hash-bound universal-matrix artifacts rather than test-constant matrices.
- [ ] The Free Starter inventory test first repairs the existing Formula-successor omission and ends with exact count 66 and all ten Topic successors; every final gate has zero failures.
- [ ] Registry reservation is atomic; transitions are serialized; only complete all-16 staging/handoff is allowed.
- [ ] No Formula/schema/planner/Kit successor/app-version/changelog change or desktop release work is part of this plan. The complete handoff asks GenStudio, not Story, to publish under existing products and confirm same-family upgrades without inventing their behavior.
