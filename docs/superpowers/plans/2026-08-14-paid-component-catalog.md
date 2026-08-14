# Paid Component Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Archival Ledger into the first componentized paid Channel Kit and establish testable grandfathering, immutable-version, standalone-expansion, and owned-component-discount boundaries for later paid catalog waves.

**Architecture:** Reuse the independently reviewed Archival Ledger source content as eight separately signed component source trees plus one bundle-only coordination source. Keep commercial price/discount/ownership in GenStudio, preserve legacy HMH behavior and access in Story, and qualify future paid shapes through generic source/commercial-boundary tests rather than pre-publishing guessed products.

**Tech Stack:** Existing Content Pack schema/publisher/runtime, Node `node:test`, TypeScript legacy adapters and idea planner, mock GenStudio commerce/delivery service, ephemeral Ed25519 test keys.

## Global Constraints

- Execute after Free Starter plan Task 1 supplies bundle-only coordination manifests and after approved Archival Ledger commit `18e6bbe02f382ee7dcd1868da7052296e24222d8` is available as source material.
- Archival Ledger launches at exactly 2,000 GenStudio credits, but Story runtime never hardcodes or derives that price; only GenStudio catalog/quote fixtures may carry it.
- Final Archival Ledger shape is eight independent `1.0.0` component packs plus `com.storystudio.pack.kit.archival-ledger` coordination pack. The self-contained `com.storystudio.pack.archival-ledger` candidate is never stocked.
- Preserve 125 named subjects and prove at least 500 materially distinct assignments: four siblings per subject with distinct episode object, time/place, and mechanism.
- Unchanged legacy built-ins remain usable and cannot be resold. Paid products require material net-new structured coverage, a distinct Formula contract, or an original production look.
- Ownership and discount are by entitlement family. Shared components already owned through any product receive the same server-calculated value; Story displays only exact quote facts.
- Every byte change creates a new exact content version. Existing project pins never move automatically; withdrawal preserves owner access; recall is terminal for that version.
- Prices for every paid product except Archival Ledger remain undecided. This plan creates no guessed price, SKU publication, live product, or release.
- No production key/artifact, purchase, publication, deploy, generation, fleet work, version bump, merge, push, install, or restart is authorized.

## Dependencies and execution order

1. Task 1 imports the reviewed Archival source/runtime changes without accepting the monolithic commercial shape.
2. Task 2 splits and qualifies eight components.
3. Task 3 adds the coordination release and 500+ closure proof.
4. Task 4 establishes legacy grandfathering and immutable lifecycle tests.
5. Task 5 waits for GenStudio's exact bundle/discount contract, then validates mock quotes/grants.
6. Task 6 records independently reviewable boundaries for later paid waves.
7. Task 7 is the independent final compliance/code-quality gate.

---

### Task 1: Integrate reviewed Archival content and generic planner support

**Files:**
- Integrate from `codex/archival-ledger-pack`: `electron/server/content-packs/schemas.ts`
- Integrate from `codex/archival-ledger-pack`: `electron/server/content-packs/legacy-adapters.ts`
- Integrate from `codex/archival-ledger-pack`: `electron/server/models/types.ts`
- Integrate from `codex/archival-ledger-pack`: `electron/server/services/idea-campaign-planner.ts`
- Integrate from `codex/archival-ledger-pack`: related focused tests
- Source only: `content-packs/archival-ledger/`
- Report: `.superpowers/sdd/2026-08-14-archival-ledger-pack/task-report.md`

**Interfaces:**
- Consumes: commit `18e6bbe0` and its reviewed Topic planning dimensions, recipe composition rules, release-bound minimum version, and deterministic publisher changes.
- Produces: generic planner support for pack-owned `episode_objects`, `time_place_scopes`, `mechanisms`, `evidence_lenses`, and `max_siblings_per_subject`.

- [ ] **Step 1: Apply the reviewed commit in an isolated integration branch**

```bash
git cherry-pick 18e6bbe02f382ee7dcd1868da7052296e24222d8
```

Expected: the source candidate and reviewed runtime/planner tests apply without version/changelog changes.

- [ ] **Step 2: Run the Archival and neighboring tests**

```bash
node --test scripts/content-packs/__tests__/archival-ledger-pack.test.mjs \
  scripts/content-packs/__tests__/publisher-tools.test.mjs
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-legacy-adapters.test.ts \
  electron/server/__tests__/idea-campaign-planner.test.ts \
  electron/server/__tests__/thumbnail-prompt-simplification.test.ts
```

Expected: all focused reviewed tests pass.

- [ ] **Step 3: Add a regression that forbids stocking the monolithic identity**

```js
test('the reviewed monolith is source material, not the paid release registry', () => {
  assert.notEqual(sourceManifest.pack_id, 'com.storystudio.pack.kit.archival-ledger')
  assert.equal(paidRegistry.some(row => row.packId === 'com.storystudio.pack.archival-ledger'), false)
})
```

Run the new test RED before Task 2 creates the component registry.

- [ ] **Step 4: Commit the integration boundary**

```bash
git add electron/server content-packs/archival-ledger scripts/content-packs
git commit -m "feat: integrate Archival Ledger planning source"
```

If cherry-pick already created the exact commit, do not manufacture an empty commit; record `18e6bbe0` as the integration checkpoint.

- [ ] **Step 5: Obtain independent integration review**

Reject lost HMH parity, hardcoded price, production key/artifact, guessed `min_app_version`, or treating the monolith as publishable.

### Task 2: Split Archival Ledger into eight independent component sources

**Files:**
- Create: `content-packs/paid/archival-ledger/formula/archival-ledger/`
- Create: `content-packs/paid/archival-ledger/topic/{states-revolutions-collapse,money-debt-financial-institutions,empires-trade-extraction,wars-treaties-world-order,infrastructure-commodities-corporate-power}/`
- Create: `content-packs/paid/archival-ledger/style/archival-documentary-reconstruction/`
- Create: `content-packs/paid/archival-ledger/thumbnail/archival-map-investigation/`
- Create: `scripts/content-packs/__tests__/archival-ledger-components.test.mjs`

**Interfaces:**
- Consumes: the eight reviewed documents/previews from `content-packs/archival-ledger/`.
- Produces exact design identities:

```text
com.storystudio.pack.formula.archival-ledger
com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse
com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions
com.storystudio.pack.topic.archival-ledger.empires-trade-extraction
com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order
com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power
com.storystudio.pack.style.archival-documentary-reconstruction
com.storystudio.pack.thumbnail.archival-map-investigation
```

- [ ] **Step 1: Write failing exact split/parity tests**

```js
assert.equal(componentSources.length, 8)
assert.equal(componentSources.every(source => source.manifest.version === '1.0.0'), true)
assert.equal(componentSources.every(source => source.documents.length === 1), true)
assert.equal(topicSources.reduce((sum, source) => sum + source.document.subjects.length, 0), 125)
assert.equal(canonicalHash(splitDocuments), canonicalHash(reviewedMonolithDocuments))
```

Permit only identity/compatibility-reference changes required by the split; compare prompt, subject, axes, style, recipe, and preview hashes exactly.

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs
```

Expected: FAIL because independent component source trees do not exist.

- [ ] **Step 3: Create one strict source pack per component**

Use one item and only its declared preview assets. Use family/SKU patterns from approved design section 5; set source minimum to `${STORY_STUDIO_RELEASE_VERSION}` and omit all price/showcase/license/purchase fields.

- [ ] **Step 4: Build/validate deterministically with ephemeral keys**

Build every component twice in a temporary directory, compare bytes, validate with the temporary public key, assert archive entries, then remove all keys/archives.

- [ ] **Step 5: Run GREEN and commit**

```bash
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs \
  scripts/content-packs/__tests__/publisher-tools.test.mjs
git diff --check
git add content-packs/paid/archival-ledger scripts/content-packs/__tests__/archival-ledger-components.test.mjs
git commit -m "feat: componentize Archival Ledger"
```

- [ ] **Step 6: Obtain independent content/schema/visual review**

Compare all eight sources against the reviewed monolith and approved identities. Critical/Important differences require RED/GREEN corrections.

### Task 3: Create the Archival coordination release and prove 500+ distinct assignments

**Files:**
- Create: `content-packs/paid/archival-ledger/kit/archival-ledger/pack.json`
- Create: `scripts/content-packs/__tests__/archival-ledger-coordination.test.mjs`
- Modify: `electron/server/__tests__/idea-campaign-planner.test.ts`

**Interfaces:**
- Consumes: Task 2's eight exact `1.0.0` packs and Free Starter plan's bundle-only schema.
- Produces coordination pack `com.storystudio.pack.kit.archival-ledger`, bundle `com.storystudio.bundle.archival-ledger`, family `com.storystudio.family.kit.archival-ledger`.

- [ ] **Step 1: Write failing coordination and coverage tests**

```js
assert.equal(coordination.items.length, 0)
assert.equal(coordination.files.length, 0)
assert.equal(coordination.dependencies.length, 8)
assert.deepEqual(coordination.bundles[0].components.map(row => row.pack_id), expectedPackIds)
```

```ts
assert.equal(assignments.length, 500)
for (const group of assignmentsBySubject.values()) {
  assert.equal(group.length, 4)
  assert.equal(new Set(group.map(row => row.dimensions['episode-object'])).size, 4)
  assert.equal(new Set(group.map(row => row.dimensions['time-place-scope'])).size, 4)
  assert.equal(new Set(group.map(row => row.dimensions.mechanism)).size, 4)
}
```

- [ ] **Step 2: Run RED, author coordination, and run GREEN**

```bash
node --test scripts/content-packs/__tests__/archival-ledger-coordination.test.mjs
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/idea-campaign-planner.test.ts
```

Expected first run: FAIL on absent coordination source. After authoring, both pass with zero paid LLM calls.

- [ ] **Step 3: Commit**

```bash
git add content-packs/paid/archival-ledger/kit/archival-ledger/pack.json \
  scripts/content-packs/__tests__/archival-ledger-coordination.test.mjs \
  electron/server/__tests__/idea-campaign-planner.test.ts
git commit -m "feat: coordinate Archival Ledger Channel Kit"
```

- [ ] **Step 4: Obtain independent claim/content review**

Sample beginning/middle/end coverage and each Topic lane. Reject label-only siblings, duplicate subjects, non-exact dependencies, or a “500+” promise unsupported by deterministic signed-source facts.

### Task 4: Prove legacy grandfathering and immutable version lifecycle

**Files:**
- Modify: `electron/server/__tests__/content-pack-migration-golden.test.ts`
- Modify: `electron/server/__tests__/content-pack-project-pins.test.ts`
- Modify: `electron/server/__tests__/content-pack-lifecycle.test.ts`
- Create: `electron/server/__tests__/paid-content-grandfathering.test.ts`

**Interfaces:**
- Consumes: legacy HMH IDs/files, exact signed component IDs, local lifecycle and project pins.
- Produces: explicit migration plan only; no automatic project mutation.

- [ ] **Step 1: Write grandfathering and immutability tests**

```ts
test('claim and install do not rewrite an HMH project', async () => {
  const before = await readProjectMeta(projectSlug)
  await installComponentizedArchivalFixture()
  assert.deepEqual(await readProjectMeta(projectSlug), before)
})

test('different bytes under 1.0.0 are refused', async () => {
  await installContentPack(firstArchive)
  await assert.rejects(installContentPack(mutatedSameVersion), /immutable|hash/i)
})
```

Also prove legacy IDs resolve, user forks retain precedence, explicit migration yields exact pins, rollback uses installed exact version, withdrawn remains installable to owner, and recalled exact version blocks generation without rewriting pins.

- [ ] **Step 2: Run and verify RED**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/paid-content-grandfathering.test.ts \
  electron/server/__tests__/content-pack-project-pins.test.ts \
  electron/server/__tests__/content-pack-lifecycle.test.ts
```

Expected: new grandfathering fixture fails until explicit componentized migration evidence is represented.

- [ ] **Step 3: Implement only explicit migration mapping/guards**

Add no startup rewrite. Preserve legacy lookup until inventory proves no persisted consumer. Migration preview names Formula/Topics/Style/Recipe exact targets and applies only after explicit project action.

- [ ] **Step 4: Run GREEN and commit**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/paid-content-grandfathering.test.ts \
  electron/server/__tests__/content-pack-migration-golden.test.ts \
  electron/server/__tests__/content-pack-project-pins.test.ts \
  electron/server/__tests__/content-pack-lifecycle.test.ts
git diff --check
git add electron/server/__tests__ electron/server/content-packs
git commit -m "test: protect paid content grandfathering"
```

- [ ] **Step 5: Obtain independent migration review**

Reject deleted legacy files, implicit upgrades, pin rewriting, paid rebilling of unchanged bytes, or recall handling that erases project evidence.

### Task 5: Adopt exact owned-component discount and bundle grant semantics

**Files:**
- Modify: `electron/server/__tests__/fixtures/mock-genstudio-service.ts`
- Create: `electron/server/__tests__/content-store-paid-bundle.test.ts`
- Modify only after exact live contract: `electron/server/lib/genstudio-content-store.ts`
- Modify only after exact live contract: `electron/server/services/content-store.ts`

**Interfaces:**
- Consumes: field-exact live GenStudio contract for atomic kit/component grants, bundle release composition, entitlement-family discounts, and zero/paid bundle quotes.
- Produces acceptance of the existing signed `entitlement_families`, `owned_components`, `discount_credits`, and exact release evidence without client-side calculation.

- [ ] **Step 1: Enforce the external contract gate**

```bash
test -s /build/Developer/_handoffs/2026-08-14_to-gpt-storystudio_from-claude-genstudio_content-bundles-live.md
```

Expected before GenStudio delivery: fail and stop production client edits. The handoff must answer approved-design section 21 items 1–4 with exact fields and deployed tests.

- [ ] **Step 2: Write paid-bundle mock acceptance tests**

```ts
test('uses GenStudio quote discount facts without client calculation', async () => {
  const quote = await quoteArchivalLedger({ ownedFamilies: [FORMULA_FAMILY] })
  assert.equal(quote.base_credit_price, 2_000)
  assert.equal(quote.discount_credits, mock.publishedDiscount)
  assert.deepEqual(quote.owned_components, [FORMULA_FAMILY])
})
```

Also prove atomic nine-family grant, already-owned deduplication, shared-family discount from another kit, exact 2,000 live fixture only, one purchase POST, replayed idempotency, and no client price/discount calculation.

- [ ] **Step 3: Run RED, apply only exact contract changes, and run GREEN**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-store-paid-bundle.test.ts \
  electron/server/__tests__/content-store-commerce-state.test.ts \
  electron/server/__tests__/genstudio-content-store-client.test.ts
```

Expected first run: FAIL on missing mock/contract evidence. Production parser changes are allowed only if exact live fields differ from current reviewed fields.

- [ ] **Step 4: Commit and independently review financial behavior**

```bash
git add electron/server/__tests__/content-store-paid-bundle.test.ts \
  electron/server/__tests__/fixtures/mock-genstudio-service.ts \
  electron/server/lib/genstudio-content-store.ts electron/server/services/content-store.ts
git commit -m "test: qualify paid component bundle commerce"
```

Reviewer rejects client-calculated discount, hardcoded runtime price, duplicate debit/grant, generic POST retry, or unsigned ownership inference.

### Task 6: Define later paid-wave admission boundaries without pre-selling legacy files

**Files:**
- Create: `docs/product/content-store-paid-wave-boundaries.md`
- Create: `scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs`

**Interfaces:**
- Consumes: approved expansion lanes in design section 11.3.
- Produces review gates for standalone Topics/Styles/Recipes, specialist Formulas/Kits, and premium collections; no new product IDs or prices.

- [ ] **Step 1: Write the failing policy-document test**

```js
for (const heading of [
  'Net-new outcome', 'Material content', 'No legacy rebilling',
  'Independent identity', 'Proofable claim', 'Complete use', 'Transparent dependency',
]) assert.match(policy, new RegExp(`## ${heading}`))
assert.doesNotMatch(policy, /recommended price|credit price: [0-9]/i)
```

Require the ten approved free-foundation expansion lanes, a proposal-before-authoring gate, owner price decision after GenStudio recommendation, independent wave review, and no automatic publication.

- [ ] **Step 2: Run RED, write the boundary document, and run GREEN**

```bash
node --test scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs
git diff --check
git add docs/product/content-store-paid-wave-boundaries.md \
  scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs
git commit -m "docs: define paid Content Store waves"
```

- [ ] **Step 3: Obtain independent commercial-boundary review**

Reject any promise to sell unchanged legacy content, guessed identity/price, orphan component, unproved numerical claim, or automatic grant/publication.

### Task 7: Run independent paid-catalog spec/compliance and code-quality gates

**Files:**
- Review: Tasks 1–6 changes
- Review: `docs/product/archival-ledger-opening-pack-proposal.md`
- Review: `docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md`

**Interfaces:**
- Consumes: componentized Archival source, lifecycle/grandfathering/commerce evidence, and later-wave boundaries.
- Produces: GO/NO-GO before release/publishing may rely on this work.

- [ ] **Step 1: Run complete offline paid-catalog suites**

```bash
node --test scripts/content-packs/__tests__/archival-ledger-components.test.mjs \
  scripts/content-packs/__tests__/archival-ledger-coordination.test.mjs \
  scripts/content-packs/__tests__/paid-catalog-boundary.test.mjs \
  scripts/content-packs/__tests__/publisher-tools.test.mjs
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/idea-campaign-planner.test.ts \
  electron/server/__tests__/paid-content-grandfathering.test.ts \
  electron/server/__tests__/content-store-paid-bundle.test.ts \
  electron/server/__tests__/content-pack-project-pins.test.ts \
  electron/server/__tests__/content-store-commerce-state.test.ts
npm run typecheck
git diff --check
```

Expected: all pass and no temporary archive/key remains.

- [ ] **Step 2: Run independent specification/content/commercial review**

Map design sections 11, 12, 18, 19, and 23 to evidence. Confirm 125 subjects, 500+ diversity, eight components plus coordination, 2,000 only in GenStudio fixture/spec, and unchanged legacy access.

- [ ] **Step 3: Run independent code-quality/security/financial review**

Inspect exact IDs/versions, source isolation, deterministic builds, one-attempt commerce, signed evidence, owned-family discounts, grant deduplication, withdrawal/recall, and explicit migration. Resolve Critical/Important findings with RED/GREEN commits.

- [ ] **Step 4: Record the accepted source-only boundary**

```bash
find content-packs/paid -type f \( -name '*.sspack' -o -name '*.pem' \)
git status --short
```

Expected: no production artifacts/keys, clean reviewed worktree, and no version/changelog/external mutation. Production signing and stocking belong to the release plan.

## Self-review

- Spec coverage: eight-component Ledger split, coordination, 500+ gate, grandfathering, immutable versioning, exact discount contract, standalone/specialist/premium boundaries, and future waves are covered.
- Placeholder scan: later paid products deliberately receive no guessed IDs or prices; their approved admission process is complete and executable.
- Type consistency: component/family identities and exact `1.0.0` dependencies match the approved design throughout.
