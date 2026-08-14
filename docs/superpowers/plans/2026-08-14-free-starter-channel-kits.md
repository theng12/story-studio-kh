# Free Starter Channel Kits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author and locally qualify the ten owner-approved permanently free componentized Starter Channel Kits as signed-schema source trees without publishing, stocking, or using generation providers.

**Architecture:** Extend the existing Content Pack contract with one narrow bundle-only coordination case, then author each Formula, Topic Pack, Style, Recipe, and Kit as an independent `1.0.0` source pack. Deterministic offline catalog tests enforce exact IDs, counts, component reuse, legacy prompt parity, coverage diversity, preview validity, and free-grant expectations while production pricing/ownership remain GenStudio facts.

**Tech Stack:** Zod Content Pack schemas, deterministic `.sspack` publisher tools, Node `node:test`, TypeScript loaders/adapters/planner, Sharp raster decoding, ephemeral Ed25519 test keys.

## Global Constraints

- Publisher namespace is exactly `com.storystudio`; every component and coordination release starts at `1.0.0`.
- The ten kits, promise lines, exact component IDs, counts, and reuse mappings are fixed by approved-design sections 7–10.
- Each kit contains exactly one Formula, one full Topic Pack, one Style, and one Thumbnail Recipe. Shared components keep one pack/item/family/SKU identity.
- Bundle-only coordination archives contain only `manifest.json` and `signature.ed25519`, exactly one `channel-kit`, empty `items/files`, and exact external dependencies. Normal component packs retain non-empty `items/files`.
- Seven migrated Topics must be enriched with meaningful episode objects, time/place scopes, mechanisms, evidence lenses, exclusions, compatibility rules, sibling limits, and bounded prompt context. Everyday Calm, Habits & Momentum, and Night Journeys each contain exactly 15 reviewed subjects.
- Existing generated built-in style previews may be migrated and decoded. Prehistoric Discovery and Dreamscape Story Window require owner-supplied original preview assets or a separately approved non-provider asset source; no substitute image ships.
- Do not call image, chat, voice, video, or other generation providers. Do not retain ephemeral test keys or `.sspack` candidates after tests.
- `min_app_version` is `${STORY_STUDIO_RELEASE_VERSION}` and `key_id` is `${STORY_STUDIO_CONTENT_KEY_ID}` in source; the publisher must require explicit `--min-app-version` and `--key-id` values, then validate the substituted manifest. The release plan binds both owner-controlled values.
- No production signing key, production archive, GenStudio draft, purchase, publication, version bump, merge, push, install, or restart is authorized here.

## Dependencies and execution order

1. Task 1 lands the coordination schema/publisher support.
2. Task 2 freezes legacy behavior and validates owner-supplied preview inputs.
3. Tasks 3–5 author reviewed kit waves; each wave can be independently rejected.
4. Task 6 builds all coordination sources and proves shared-component ownership semantics with a mock GenStudio contract.
5. Task 7 is the independent catalog-wide content/compliance/code-quality gate.

## Exact launch registry

Every pack below is `1.0.0`; each item/family/SKU uses the same approved slug and kind prefix from design section 5.

| Kit coordination pack | Formula pack | Topic pack (subjects) | Style pack | Thumbnail pack |
| --- | --- | --- | --- | --- |
| `com.storystudio.pack.kit.wild-worlds` | `com.storystudio.pack.formula.natural-world-explained` | `com.storystudio.pack.topic.natural-world-animals` (10) | `com.storystudio.pack.style.waxy-outline-cartoon` | `com.storystudio.pack.thumbnail.curiosity-question-cartoon` |
| `com.storystudio.pack.kit.first-humans` | `com.storystudio.pack.formula.ancient-humans` | `com.storystudio.pack.topic.ancient-humans-survival` (20) | `com.storystudio.pack.style.prehistoric-stick-cartoon` | `com.storystudio.pack.thumbnail.prehistoric-discovery` |
| `com.storystudio.pack.kit.deep-time` | `com.storystudio.pack.formula.deep-time-documentary` | `com.storystudio.pack.topic.deep-time-earth-systems` (30) | `com.storystudio.pack.style.paleo-documentary-tableau` | `com.storystudio.pack.thumbnail.documentary-label-tableau` |
| `com.storystudio.pack.kit.business-explained` | `com.storystudio.pack.formula.economics-of` | `com.storystudio.pack.topic.economics-businesses` (40) | `com.storystudio.pack.style.hand-drawn-editorial-diagram` | `com.storystudio.pack.thumbnail.annotated-business-board` |
| `com.storystudio.pack.kit.human-behavior` | `com.storystudio.pack.formula.human-behavior-explained` | `com.storystudio.pack.topic.human-behavior-social-dynamics` (10) | `com.storystudio.pack.style.minimal-stick-figure-explainer` | `com.storystudio.pack.thumbnail.centered-hero-headline` |
| `com.storystudio.pack.kit.history-explained` | `com.storystudio.pack.formula.history-explained` | `com.storystudio.pack.topic.historical-wars-treaties-world-order` (25) | `com.storystudio.pack.style.sepia-ink-wash` | `com.storystudio.pack.thumbnail.documentary-label-tableau` |
| `com.storystudio.pack.kit.a-life-as` | `com.storystudio.pack.formula.pov-your-life-as` | `com.storystudio.pack.topic.pov-historical-occupations` (25) | `com.storystudio.pack.style.cinematic-photoreal` | `com.storystudio.pack.thumbnail.portrait-block-right` |
| `com.storystudio.pack.kit.calm-mind` | `com.storystudio.pack.formula.guided-mindfulness` | `com.storystudio.pack.topic.everyday-calm` (15) | `com.storystudio.pack.style.watercolor-storybook` | `com.storystudio.pack.thumbnail.centered-hero-headline` |
| `com.storystudio.pack.kit.build-momentum` | `com.storystudio.pack.formula.practical-motivation` | `com.storystudio.pack.topic.habits-momentum` (15) | `com.storystudio.pack.style.flat-vector-explainer` | `com.storystudio.pack.thumbnail.annotated-business-board` |
| `com.storystudio.pack.kit.sleep-journeys` | `com.storystudio.pack.formula.sleep-story` | `com.storystudio.pack.topic.night-journeys` (15) | `com.storystudio.pack.style.watercolor-storybook` | `com.storystudio.pack.thumbnail.dreamscape-story-window` |

---

### Task 1: Add the narrow bundle-only coordination contract

**Files:**
- Modify: `electron/server/content-packs/schemas.ts`
- Modify: `electron/server/content-packs/archive.ts`
- Modify: `scripts/content-packs/lib.mjs`
- Modify: `scripts/content-packs/README.md`
- Modify: `electron/server/__tests__/content-pack-contract.test.ts`
- Modify: `electron/server/__tests__/content-pack-archive.test.ts`
- Modify: `scripts/content-packs/__tests__/publisher-tools.test.mjs`

**Interfaces:**
- Consumes: existing `ContentPackBundleSchema`, exact dependencies, canonical manifest signing, and archive verification.
- Produces:

```ts
export function isBundleOnlyCoordinationManifest(manifest: ContentPackManifest): boolean
```

The publisher also accepts explicit release inputs without logging key material:

```js
buildContentPack({ sourceDirectory, privateKeyPath, outputPath, minAppVersion, keyId })
```

with this invariant:

```ts
const bundleOnly = manifest.items.length === 0 && manifest.files.length === 0
// bundleOnly => bundles.length === 1, all components external, every component has
// an exact dependency, and the kinds are Formula + Topic + Style + Thumbnail.
```

- [ ] **Step 1: Write strict failing schema/archive tests**

```ts
test('accepts only one empty coordination bundle with a complete external closure', () => {
  const parsed = parseContentPackManifest(bundleOnlyManifest)
  assert.equal(parsed.items.length, 0)
  assert.deepEqual(new Set(parsed.bundles[0]!.components.map(row => row.kind)),
    new Set(['series-formula', 'topic-pack', 'visual-style', 'thumbnail-recipe']))
})
```

Reject empty normal packs, no bundle, two bundles, same-pack components, missing dependency, unused dependency, duplicate item/family reference, missing Style/Recipe, undeclared archive entries, and content/assets in a bundle-only archive. Assert the publisher refuses unresolved release/key tokens, rejects a `keyId` outside `com.storystudio`, and binds the exact supplied public key identity before signing.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-archive.test.ts
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs
```

Expected: FAIL on current `items.min(1)`, `files.min(1)`, and publisher content-file requirement.

- [ ] **Step 3: Implement the smallest schema/publisher exception**

Change `items/files` to `.max(...)` and enforce non-empty through `superRefine` unless `isBundleOnlyCoordinationManifest()` is true. In `collectSourceFiles()`, allow no `content/` only when `pack.json` validates as the coordination shape after derived empty arrays are supplied. Substitute only the two exact whole-value tokens through explicit arguments before schema validation; never perform general template expansion. The archive remains signed and contains no unlisted entry.

- [ ] **Step 4: Run GREEN and commit**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-archive.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs
git diff --check
git add electron/server/content-packs/schemas.ts electron/server/content-packs/archive.ts \
  scripts/content-packs/lib.mjs scripts/content-packs/README.md \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-archive.test.ts \
  scripts/content-packs/__tests__/publisher-tools.test.mjs
git commit -m "feat: support componentized Channel Kit manifests"
```

- [ ] **Step 5: Obtain independent contract/security review**

Reject any broader empty-pack allowance, in-pack creative bytes, missing exact dependency, weakened namespace/signature/archive rule, or publisher path escape.

### Task 2: Freeze legacy source behavior and preview provenance

**Files:**
- Create: `scripts/content-packs/__tests__/free-starter-inventory.test.mjs`
- Create: `content-packs/free-starters/ASSET-PROVENANCE.md`
- Modify: `electron/server/__tests__/content-pack-migration-golden.test.ts`
- Test sources: `electron/server/niches/*.json`
- Test sources: `electron/server/topic-packs/*.json`
- Test sources: `frontend/composables/useBuiltInStyles.ts`
- Test sources: `frontend/public/builtin-style-previews/*.webp`
- Test sources: `electron/server/thumbnail-templates/*.json`

**Interfaces:**
- Consumes: 21 legacy Formula configs, 26 Topics, 17 styles, 6 recipes, effective `niche-loader.ts` decoration, and approved registry identities.
- Produces a fixed test registry with 10 formulas, 10 topics, 9 styles, 7 recipes, and 10 kits.

- [ ] **Step 1: Write the inventory/provenance test**

```js
assert.equal(registry.formulas.length, 10)
assert.equal(registry.topics.length, 10)
assert.equal(registry.styles.length, 9)
assert.equal(registry.recipes.length, 7)
assert.equal(registry.kits.length, 10)
assert.equal(new Set(registry.styles.map(row => row.packId)).size, 9)
assert.equal(new Set(registry.recipes.map(row => row.packId)).size, 7)
```

Assert source files exist for every migrated component, preview hashes are recorded for existing assets, and `ASSET-PROVENANCE.md` names either `migrated-approved-built-in` or `owner-supplied-original`. Explicitly mark Prehistoric Discovery and Dreamscape Story Window as blocked until their original raster paths and SHA-256 records exist; do not create a fake image.

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/content-packs/__tests__/free-starter-inventory.test.mjs
```

Expected: FAIL because the free-starter source registry/provenance file does not exist.

- [ ] **Step 3: Extend legacy prompt/recipe/style goldens**

Add effective facts for all ten source Formulas and seven migrated Topics to `content-pack-migration-golden.test.ts`. Record hashes of prompt-relevant fields, selected defaults, style bible/negative prompt, and recipe behavior—never filesystem timestamps or paths.

- [ ] **Step 4: Run GREEN and commit**

```bash
node --test scripts/content-packs/__tests__/free-starter-inventory.test.mjs
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-migration-golden.test.ts
git diff --check
git add scripts/content-packs/__tests__/free-starter-inventory.test.mjs \
  content-packs/free-starters/ASSET-PROVENANCE.md \
  electron/server/__tests__/content-pack-migration-golden.test.ts \
  electron/server/__tests__/fixtures/content-packs/current-catalog-golden.json
git commit -m "test: freeze Starter Kit source behavior"
```

- [ ] **Step 5: Obtain independent inventory review**

Verify every exact design-registry identity and source mapping; reject missing provenance, changed legacy behavior without an explicit authored rationale, or assets generated through an unapproved provider.

### Task 3: Author free kit wave one—Wild Worlds, First Humans, Deep Time

**Files:**
- Create: `content-packs/free-starters/formula/{natural-world-explained,ancient-humans,deep-time-documentary}/`
- Create: `content-packs/free-starters/topic/{natural-world-animals,ancient-humans-survival,deep-time-earth-systems}/`
- Create: `content-packs/free-starters/style/{waxy-outline-cartoon,prehistoric-stick-cartoon,paleo-documentary-tableau}/`
- Create: `content-packs/free-starters/thumbnail/{curiosity-question-cartoon,prehistoric-discovery,documentary-label-tableau}/`
- Create: `content-packs/free-starters/kit/{wild-worlds,first-humans,deep-time}/pack.json`
- Create: `scripts/content-packs/__tests__/free-starter-wave-one.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–2 schemas, exact design IDs, legacy sources, approved/migrated previews, and owner-supplied Prehistoric Discovery preview.
- Produces: 3 Formula + 3 Topic + 3 Style + 3 Recipe + 3 coordination source packs, all `1.0.0`.

- [ ] **Step 1: Write failing source/count/coverage tests**

```js
assert.deepEqual(subjectCounts, {
  'com.storystudio.topic.natural-world-animals': 10,
  'com.storystudio.topic.ancient-humans-survival': 20,
  'com.storystudio.topic.deep-time-earth-systems': 30,
})
for (const topic of topics) {
  assert.ok(topic.episode_objects.length > 0)
  assert.ok(topic.time_place_scopes.length > 0)
  assert.ok(topic.mechanisms.length > 0)
  assert.ok(topic.evidence_lenses.length > 0)
}
```

Assert each kit's exact four dependencies/items and promises: `10 starting subjects / Instinct → Ecosystem`, `20 survival problems / Constraint → Adaptation`, and `30 Earth systems / Planet → Transformation`.

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/content-packs/__tests__/free-starter-wave-one.test.mjs
```

Expected: FAIL because wave-one source packs do not exist.

- [ ] **Step 3: Author and enrich the wave**

Absorb effective loader decoration into each Formula. Enrich Topics with subject-specific, meaningful planning dimensions and compatibility rules. Copy approved style/recipe preview bytes with recorded hashes; require the owner-supplied Prehistoric Discovery preview before First Humans can pass.

- [ ] **Step 4: Prove deterministic coverage and ephemeral builds**

Use `planIdeaAssignments()` offline to meet each advertised count with unique subject + episode object + time/place + mechanism fingerprints. Build every source twice with one temporary Ed25519 key, compare bytes, validate, then remove the temporary directory.

- [ ] **Step 5: Run GREEN and commit**

```bash
node --test scripts/content-packs/__tests__/free-starter-wave-one.test.mjs \
  scripts/content-packs/__tests__/publisher-tools.test.mjs
git diff --check
git add content-packs/free-starters scripts/content-packs/__tests__/free-starter-wave-one.test.mjs
git commit -m "feat: author first Starter Kit wave"
```

- [ ] **Step 6: Obtain independent wave review**

Require content/editorial, schema/security, prompt-parity, coverage, visual, thumbnail, and commercial-boundary reviews. A single rejected kit blocks only this wave, not unrelated waves.

### Task 4: Author free kit wave two—Business, Human Behavior, History, A Life As

**Files:**
- Create: `content-packs/free-starters/formula/{economics-of,human-behavior-explained,history-explained,pov-your-life-as}/`
- Create: `content-packs/free-starters/topic/{economics-businesses,human-behavior-social-dynamics,historical-wars-treaties-world-order,pov-historical-occupations}/`
- Create: `content-packs/free-starters/style/{hand-drawn-editorial-diagram,minimal-stick-figure-explainer,sepia-ink-wash,cinematic-photoreal}/`
- Create: `content-packs/free-starters/thumbnail/{annotated-business-board,centered-hero-headline,portrait-block-right}/`
- Create: `content-packs/free-starters/kit/{business-explained,human-behavior,history-explained,a-life-as}/pack.json`
- Create: `scripts/content-packs/__tests__/free-starter-wave-two.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–2 and approved legacy assets.
- Produces: 4 Formula + 4 Topic + 4 Style + 3 Recipe + 4 coordination sources; Centered Hero is shared later with Calm Mind.

- [ ] **Step 1: Write failing exact-registry tests**

```js
assert.deepEqual(subjectCounts, [40, 10, 25, 25])
assert.equal(kits['human-behavior'].recipePackId,
  'com.storystudio.pack.thumbnail.centered-hero-headline')
assert.equal(kits['history-explained'].recipePackId,
  'com.storystudio.pack.thumbnail.documentary-label-tableau')
```

Assert promises `Cost → Constraint`, `Signal → Choice`, `Event → Consequence`, and `Role → Reality`, plus full enriched Topic schemas and no HMH-only weakening in the History-compatible wars pack.

- [ ] **Step 2: Run RED, author, and prove coverage**

```bash
node --test scripts/content-packs/__tests__/free-starter-wave-two.test.mjs
```

Expected first run: FAIL on absent sources. Author only approved fields, then run deterministic assignments and ephemeral build/verify for every source.

- [ ] **Step 3: Run GREEN and commit**

```bash
node --test scripts/content-packs/__tests__/free-starter-wave-two.test.mjs \
  scripts/content-packs/__tests__/free-starter-inventory.test.mjs
git diff --check
git add content-packs/free-starters scripts/content-packs/__tests__/free-starter-wave-two.test.mjs
git commit -m "feat: author documentary Starter Kit wave"
```

- [ ] **Step 4: Obtain independent wave review**

Review commercial non-rebilling, HMH compatibility, POV safety, subject specificity, prompt parity, preview accuracy, and exact shared recipe identity. Resolve Critical/Important findings through RED/GREEN.

### Task 5: Author free kit wave three—Calm Mind, Build Momentum, Sleep Journeys

**Files:**
- Create: `content-packs/free-starters/formula/{guided-mindfulness,practical-motivation,sleep-story}/`
- Create: `content-packs/free-starters/topic/{everyday-calm,habits-momentum,night-journeys}/`
- Create: `content-packs/free-starters/style/{watercolor-storybook,flat-vector-explainer}/`
- Create: `content-packs/free-starters/thumbnail/dreamscape-story-window/`
- Create: `content-packs/free-starters/kit/{calm-mind,build-momentum,sleep-journeys}/pack.json`
- Create: `scripts/content-packs/__tests__/free-starter-wave-three.test.mjs`

**Interfaces:**
- Consumes: shared Centered Hero, Annotated Business Board, owner-supplied Dreamscape preview, and exact design identities.
- Produces: 3 Formula + 3 new 15-subject Topics + 2 Style + 1 new Recipe + 3 coordination sources.

- [ ] **Step 1: Write failing wellness/sleep contract tests**

```js
for (const topic of [everydayCalm, habitsMomentum, nightJourneys]) {
  assert.equal(topic.subjects.length, 15)
  assert.equal(new Set(topic.subjects.map(value => value.toLowerCase())).size, 15)
}
assert.doesNotMatch(canonicalJson(everydayCalm), /diagnose|treat|cure|therapy/i)
assert.match(sleepFormula.channel_promise, /low-arousal|rest/i)
```

Assert promises `Pause → Presence`, `Friction → Action`, and `Setting → Rest`; enforce shared Watercolor/Centered/Annotated identities; reject medical claims, coercive motivation, high-arousal sleep structures, and missing Dreamscape preview.

- [ ] **Step 2: Run RED, author, and prove coverage**

```bash
node --test scripts/content-packs/__tests__/free-starter-wave-three.test.mjs
```

Expected first run: FAIL on absent new Topics/Recipe. Author complete structured axes, run offline coverage, decode previews, and ephemeral build/verify.

- [ ] **Step 3: Run GREEN and commit**

```bash
node --test scripts/content-packs/__tests__/free-starter-wave-three.test.mjs \
  scripts/content-packs/__tests__/free-starter-inventory.test.mjs
git diff --check
git add content-packs/free-starters scripts/content-packs/__tests__/free-starter-wave-three.test.mjs
git commit -m "feat: author wellbeing Starter Kit wave"
```

- [ ] **Step 4: Obtain independent safety/content/visual review**

Require a fresh reviewer to verify non-medical framing, calm pacing, complete axes, preview originality/provenance, supported recipe primitives, and exact shared identities.

### Task 6: Prove ten free claims and shared-component closures locally

**Files:**
- Create: `electron/server/__tests__/content-store-free-starter-kits.test.ts`
- Modify: `electron/server/__tests__/fixtures/mock-genstudio-service.ts`
- Modify: `scripts/content-packs/__tests__/free-starter-inventory.test.mjs`

**Interfaces:**
- Consumes: 46 source packs, mock signed quote/purchase/receipt/restore/download surfaces, and exact dependency installation.
- Produces: a local acceptance fixture proving permanent zero-price ownership and one-copy component reuse without touching live credits.

- [ ] **Step 1: Write end-to-end mock tests**

```ts
test('claiming all ten charges zero and grants shared component families once', async () => {
  for (const kit of starterKits) await claimWithExplicitConfirmation(kit.productId)
  assert.equal(mock.totalCreditsCharged, 0)
  assert.equal(new Set(mock.grantedFamilies).size, mock.grantedFamilies.length)
  assert.equal(mock.familyGrantCount('com.storystudio.family.style.watercolor-storybook'), 1)
})
```

Also prove a zero-balance claim, explicit Owned-not-Installed result, same-account key rotation restore, explicit kit install, missing-only dependency downloads, shared dependency downloaded once, offline use after install, and unchanged existing project pins.

- [ ] **Step 2: Run and verify RED**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-store-free-starter-kits.test.ts
```

Expected: FAIL until mock bundle-grant semantics and kit sources are present. This fixture models approved acceptance behavior only; production stocking still waits for GenStudio's field-exact bundle contract.

- [ ] **Step 3: Implement only mock support and source validation**

Extend `MockGenStudioService` with atomic family grants and owned-family deduplication. Do not change Story production purchase code in this task.

- [ ] **Step 4: Run GREEN and commit**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-store-free-starter-kits.test.ts \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/genstudio-content-store-delivery.test.ts
git diff --check
git add electron/server/__tests__/content-store-free-starter-kits.test.ts \
  electron/server/__tests__/fixtures/mock-genstudio-service.ts \
  scripts/content-packs/__tests__/free-starter-inventory.test.mjs
git commit -m "test: qualify free Starter Kit ownership"
```

- [ ] **Step 5: Obtain independent financial/lifecycle review**

Reject automatic claim/install, any live API call, duplicate family grants, credit dependence, current-version substitution, or project-pin mutation.

### Task 7: Run independent catalog-wide content/compliance and code-quality gates

**Files:**
- Review: all source packs and tests from Tasks 1–6
- Review: `docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md`

**Interfaces:**
- Consumes: all ten locally qualified Starter Kit closures.
- Produces: independent GO/NO-GO per kit and a catalog-wide GO only when all ten are accepted.

- [ ] **Step 1: Run all offline authoring/runtime gates**

```bash
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs \
  scripts/content-packs/__tests__/free-starter-inventory.test.mjs \
  scripts/content-packs/__tests__/free-starter-wave-one.test.mjs \
  scripts/content-packs/__tests__/free-starter-wave-two.test.mjs \
  scripts/content-packs/__tests__/free-starter-wave-three.test.mjs
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-archive.test.ts \
  electron/server/__tests__/content-pack-legacy-adapters.test.ts \
  electron/server/__tests__/content-pack-migration-golden.test.ts \
  electron/server/__tests__/idea-campaign-planner.test.ts \
  electron/server/__tests__/content-store-free-starter-kits.test.ts
npm run typecheck
git diff --check
```

Expected: all commands pass; temporary archives/keys are absent afterward.

- [ ] **Step 2: Run independent spec/content/safety review per wave**

Map every exact registry row, advertised count, compatibility, reuse, promise, preview, and content-quality criterion to evidence. Human-sample assignments at the beginning, middle, and end of each coverage order.

- [ ] **Step 3: Run independent code-quality/security review**

Inspect the narrow schema exception, publisher source safety, deterministic archive behavior, secret scanning, unsupported directives, raster decoding, and no-provider test behavior. Critical/Important findings require RED/GREEN corrections.

- [ ] **Step 4: Record the accepted source-only boundary**

```bash
find content-packs/free-starters -type f -name '*.sspack' -o -name '*.pem'
git status --short
```

Expected: no `.sspack` or PEM output and a clean reviewed source worktree. Production keys, final `min_app_version`, signing, stocking, and publication belong to the release/publishing plan.

## Self-review

- Spec coverage: coordination schema, exact ten kits, 10/10/9/7 shared components, seven enriched legacy Topics, three new 15-subject Topics, recipe/style previews, reuse, free claim, and independent wave gates are covered.
- Completeness scan: missing original preview assets are explicit acceptance blockers; no fake preview or provider generation is prescribed.
- Type consistency: pack/item/family/SKU identities follow the approved registry and every coordination pack references exact `1.0.0` dependencies.
