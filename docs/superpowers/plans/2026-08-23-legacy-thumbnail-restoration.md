# Legacy Thumbnail Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every genuinely distinct pre-refactor thumbnail grammar as original, modular Content Pack recipe/style sources, while preserving legacy selections and giving every restored recipe a visible gallery of three to five original 16:9 previews.

**Architecture:** Keep the signed Content Pack documents as the source of new reusable recipe and style contracts. The existing adapters continue to project signed recipes into `ThumbnailTemplate`; legacy bare IDs and user templates continue through their current fallback chain. New source-only components live under `content-packs/legacy-thumbnail-restoration/`; existing free-starter, Archival Ledger, and Editorial components are enriched or verified in place, never replaced by a parallel product.

**Tech Stack:** JSON Content Pack schemas, Node.js `node:test`, TypeScript/TSX tests, Sharp raster decoding, deterministic `.sspack` builder/validator, Ed25519 ephemeral test keys.

**Spec:** `docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md`; this plan implements the owner-approved 2026-08-23 restoration map, and `.superpowers/sdd/editorial-psychology-components/legacy-thumbnail-stock-report.md` is its historical evidence inventory.

## Global Constraints

- Component source identity uses `com.storystudio`, exact `1.0.0`, `{{KEY_ID}}`, and `{{MIN_APP_VERSION}}`; no source document contains model/provider routing, GenStudio product/release/account facts, pricing, a URL, credentials, executable content, or a production key.
- Reserve all six new identities in one coordinator-owned compare-and-swap batch before any leaf creates a component source. Leaf tasks only verify the coordinator receipt; they never reserve, repair, or transition registry records.
- The three new recipes are `animal-hardship-annotation`, `prehistoric-survival-title-card`, and `dreamlike-story-title-card`; the three new styles are `hand-drawn-hardship-cartoon`, `impasto-psychological-animals`, and `dreamlike-luminous-sleep-illustration`.
- Reuse, rather than repackage, `centered-hero-headline` plus `builtin-pixel-art-story` for Night Tales and `portrait-block-right` plus `cinematic-photoreal` for Devotional Hour. Retain Editorial's `editorial-psychology-symbolic-split` and `pastel-surreal-psychological-collage` unchanged as active components.
- Treat `centered-hero-headline-custom` as a compatibility parameter/note for `centered-hero-headline`, not a separately sellable or signed recipe. Keep the 94px user fork readable.
- Preserve all legacy aliases and fallback order: qualified signed recipe, then legacy user template, then legacy built-in; bare historical IDs and user forks must not be rewritten or deleted.
- Every recipe in the restored lineup has three to five declared, decodable, original WebP previews at exactly 1672×941 (16:9). The lineup is the seven free-starter recipes, Archival Map Investigation, Editorial Psychology Symbolic Split, and the three new recipes.
- Reuse owner-supplied saved outputs before any other asset source. This Mac performs no production image generation. If three qualified preview bytes cannot be obtained for a recipe, stop that recipe and record `BLOCKED: Studio Hub paid batch requires an exact owner-approved quote and written authorization identifying provider/model, image count, and maximum spend before paid generation.` No paid request is sent merely to clear the blocker.
- New preview concepts are inspired by the evidence grammar, not copies of any saved composition, episode title, channel phrase, or trade dress. Preserve a source path, SHA-256, dimensions, conversion operation, and owner-rights basis in provenance; do not put owner filesystem paths in runtime JSON.
- Candidate archives use generated ephemeral Ed25519 keypairs and `minAppVersion: '9.9.9-test'` only. They are test outputs in `mkdtemp()` directories and are removed by test teardown. Do not version, changelog, release, push, publish, deploy, mutate GenStudio, use a production key, or create a real catalog product in the authoring branch.

## File Structure

| Path | Responsibility |
| --- | --- |
| `content-packs/authoring-registry.json` | Coordinator-owned reservation receipt and six `reserved` source identities; leaf work reads it only. |
| `.superpowers/sdd/legacy-thumbnail-restoration/reservation-request.json` | Reproducible six-record reservation request used once by the coordinator. |
| `.superpowers/sdd/legacy-thumbnail-restoration/reservation-result.json` | Exact machine-readable `{ revision, receipt_ref }` output from the one accepted coordinator reservation. |
| `.superpowers/sdd/legacy-thumbnail-restoration/expected-identities/*.json` | One exact, receipt-verifiable record per new component; contains no `receipt_ref`. |
| `content-packs/legacy-thumbnail-restoration/{thumbnail,style}/<slug>/` | Each new standalone source: `pack.json`, one strict content document, and only declared WebP assets. |
| `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md` | Rights and byte-level ledger for the three new recipes and three new styles. |
| `content-packs/free-starters/thumbnail/{centered-hero-headline,portrait-block-right,dreamscape-story-window,prehistoric-discovery}/` | Existing recipe sources whose one-image galleries grow to three without replacing the approved current image. |
| `frontend/public/thumbnail-recipe-previews/` and `electron/server/thumbnail-templates/{centered-hero-headline,portrait-block-right}.json` | Legacy-visible gallery copies/URLs for the two legacy templates; every old URL remains in order. |
| `content-packs/free-starters/ASSET-PROVENANCE.md` | Immutable ledger extended for the added free-starter recipe gallery bytes. |
| `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts` | Source contracts, lineup coverage, preview decoding, compatibility map, legacy fallback, and no-runtime-secret checks. |
| `scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs` | Deterministic ephemeral-key qualification of every new/enriched recipe/style source. |

## Restored Lineup Contract

| Historical channel grammar | Recipe | Style | Formula compatibility | Product decision |
| --- | --- | --- | --- | --- |
| Bound-style animal hardship annotation | `com.storystudio.thumbnail.animal-hardship-annotation` | `com.storystudio.style.hand-drawn-hardship-cartoon` | `com.storystudio.formula.natural-world-explained` | New recipe and style. Full truthful title plus one short handwritten hardship annotation and one arrow remain distinct from `curiosity-question-cartoon`. |
| Editorial impasto psychological animal essay | `com.storystudio.thumbnail.editorial-psychology-symbolic-split` | `com.storystudio.style.impasto-psychological-animals` | `com.storystudio.formula.human-behavior-explained` | Retain the existing symbolic recipe; add the distinct impasto animal style. Do not overwrite the existing pastel-collage style or Editorial recipe previews. |
| Brain Wise prehistoric survival explainer | `com.storystudio.thumbnail.prehistoric-survival-title-card` | `com.storystudio.style.prehistoric-stick-cartoon` | `com.storystudio.formula.ancient-humans` | New title-card recipe; reuse the existing style. It stays distinct from short-hook `prehistoric-discovery`. |
| Story Garden/Sleep Stories luminous sleep card | `com.storystudio.thumbnail.dreamlike-story-title-card` | `com.storystudio.style.dreamlike-luminous-sleep-illustration` | `com.storystudio.formula.sleep-story` | New recipe and style; it stays distinct from framed `dreamscape-story-window`. |
| Night Tales fantasy title card | `com.storystudio.thumbnail.centered-hero-headline` | `builtin-pixel-art-story` | Existing legacy-compatible selection | No new component, pack, or preview derivative. Document only that the existing centered headline structure and pixel style remain selectable. |
| Devotional Hour pastoral prayer | `com.storystudio.thumbnail.portrait-block-right` | `com.storystudio.style.cinematic-photoreal` | Existing prayer / POV-compatible selection | No new component. Preserve its legacy typography/fallback and the existing signed cinematic style. |
| Centered 94px custom user template | `centered-hero-headline` with a user-fork `fontSize: 94` compatibility note | N/A | Existing selection | No new item, family, SKU, source folder, or migration. |

### Task 1: Coordinator-only identity reservation and leaf receipt handoff

**Files:**
- Create: `.superpowers/sdd/legacy-thumbnail-restoration/reservation-request.json`
- Create: `.superpowers/sdd/legacy-thumbnail-restoration/expected-identities/animal-hardship-annotation.json`
- Create: `.superpowers/sdd/legacy-thumbnail-restoration/expected-identities/prehistoric-survival-title-card.json`
- Create: `.superpowers/sdd/legacy-thumbnail-restoration/expected-identities/dreamlike-story-title-card.json`
- Create: `.superpowers/sdd/legacy-thumbnail-restoration/expected-identities/hand-drawn-hardship-cartoon.json`
- Create: `.superpowers/sdd/legacy-thumbnail-restoration/expected-identities/impasto-psychological-animals.json`
- Create: `.superpowers/sdd/legacy-thumbnail-restoration/expected-identities/dreamlike-luminous-sleep-illustration.json`
- Modify: `content-packs/authoring-registry.json`
- Test: `scripts/content-packs/__tests__/authoring-registry.test.mjs`

**Interfaces:**
- Consumes: `reserveAuthoringBatch({ request }) -> Promise<{ revision: number; receipt_ref: string }>` and `verifyAuthoringReceipt({ revision, receiptRef, expectedIdentity }) -> Promise<{ revision: number; receipt_ref: string; identity: AuthoringRecord }>` from `scripts/content-packs/authoring-registry.mjs`.
- Produces: one persisted registry batch with six records at a single new revision, one `authoring:<sha256>` receipt, and six exact leaf identity documents whose shape is an `AuthoringRecord` without `receipt_ref`.

- [ ] **Step 1: Write the failing registry fixture test**

Add a test in `scripts/content-packs/__tests__/authoring-registry.test.mjs` that loads the six expected identity JSON files, uses the receipt printed by the coordinator command, and asserts exactly these `(kind, pack_id, item_id, source_path)` tuples:

```js
const expected = [
  ['thumbnail-recipe', 'com.storystudio.pack.thumbnail.animal-hardship-annotation', 'com.storystudio.thumbnail.animal-hardship-annotation', 'content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation'],
  ['thumbnail-recipe', 'com.storystudio.pack.thumbnail.prehistoric-survival-title-card', 'com.storystudio.thumbnail.prehistoric-survival-title-card', 'content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card'],
  ['thumbnail-recipe', 'com.storystudio.pack.thumbnail.dreamlike-story-title-card', 'com.storystudio.thumbnail.dreamlike-story-title-card', 'content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card'],
  ['visual-style', 'com.storystudio.pack.style.hand-drawn-hardship-cartoon', 'com.storystudio.style.hand-drawn-hardship-cartoon', 'content-packs/legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon'],
  ['visual-style', 'com.storystudio.pack.style.impasto-psychological-animals', 'com.storystudio.style.impasto-psychological-animals', 'content-packs/legacy-thumbnail-restoration/style/impasto-psychological-animals'],
  ['visual-style', 'com.storystudio.pack.style.dreamlike-luminous-sleep-illustration', 'com.storystudio.style.dreamlike-luminous-sleep-illustration', 'content-packs/legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration'],
]
assert.deepEqual(records.map(({ kind, pack_id, item_id, source_path }) => [kind, pack_id, item_id, source_path]), expected)
```

- [ ] **Step 2: Run the test to verify it fails before reservation**

Run: `node --test scripts/content-packs/__tests__/authoring-registry.test.mjs`

Expected: FAIL because the six expected identity files and receipt-bound records do not exist.

- [ ] **Step 3: Have the coordinator reserve exactly one six-record batch**

First run `npm run content-pack:registry -- validate` and require output `authoring registry revision 2: 57 records`. If the revision differs, stop this task, rebase the coordinator work, rerun validation, and regenerate the request with the observed revision; do not let a leaf reserve a partial batch.

Create the request with `expected_revision: 2`, coordinator `{ "task": "legacy-thumbnail-restoration", "branch": "codex/legacy-thumbnail-restoration" }`, proposal reference `owner-approved legacy thumbnail restoration 2026-08-23`, and six records using `version: "1.0.0"`, `publisher_id: "com.storystudio"`, `min_app_version: "{{MIN_APP_VERSION}}"`, `min_app_version_status: "release-bound"`, `status: "reserved"`, `dependencies: []`, and family/SKU IDs derived from the table above. Reserve it once:

```bash
npm run content-pack:registry -- reserve \
  --request .superpowers/sdd/legacy-thumbnail-restoration/reservation-request.json \
  > .superpowers/sdd/legacy-thumbnail-restoration/reservation-result.json
```

Write each returned record minus `receipt_ref` to its matching expected-identity file. Record the returned revision and receipt in a coordinator handoff note next to the request; source authoring may begin only after the next step succeeds.

- [ ] **Step 4: Verify every leaf identity against the persisted receipt**

Verify every file from the saved coordinator result without hand-copying or inventing a receipt:

```bash
node --input-type=module - <<'NODE'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyAuthoringReceipt } from './scripts/content-packs/authoring-registry.mjs'

const handoff = '.superpowers/sdd/legacy-thumbnail-restoration'
const receipt = JSON.parse(await readFile(join(handoff, 'reservation-result.json'), 'utf8'))
for (const name of (await readdir(join(handoff, 'expected-identities'))).sort()) {
  const expectedIdentity = JSON.parse(await readFile(join(handoff, 'expected-identities', name), 'utf8'))
  const verified = await verifyAuthoringReceipt({
    revision: receipt.revision,
    receiptRef: receipt.receipt_ref,
    expectedIdentity,
  })
  console.log(`${name}: ${verified.identity.pack_id}@${verified.identity.version}`)
}
NODE
```

Expected: each identity prints the exact persisted `pack_id@version`; do not modify `content-packs/authoring-registry.json` from a leaf task.

- [ ] **Step 5: Run registry tests and validate the registry**

Run:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npm run content-pack:registry -- validate
```

Expected: registry test passes and validation reports one revision higher with six additional `reserved` records.

- [ ] **Step 6: Commit the coordinator gate separately**

```bash
git add content-packs/authoring-registry.json .superpowers/sdd/legacy-thumbnail-restoration scripts/content-packs/__tests__/authoring-registry.test.mjs
git commit -m "chore(content-packs): reserve legacy thumbnail identities"
```

### Task 2: Saved-output intake and no-generation provenance gate

**Files:**
- Create: `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md`
- Modify: `content-packs/free-starters/ASSET-PROVENANCE.md`
- Test: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

**Interfaces:**
- Consumes: owner-supplied saved thumbnail outputs under `<owner-home>/Documents/Story Studio KH/Story Studio Projects/`, `sharp(input).resize(1672, 941, { fit: 'cover' }).webp({ quality: 88 })`, and SHA-256 byte hashes.
- Produces: one ledger row per runtime asset: source path, source SHA-256, output path, output SHA-256, 1672×941 decode result, rights basis, and `saved-output-conversion` or `existing-approved-byte` operation.

- [ ] **Step 1: Write the failing asset ledger contract**

Create `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts` with an asset-ledger helper that rejects a runtime JSON path containing `/Users/`, `provider`, `model_id`, `price`, `discount`, or `GenStudio`, and requires every declared preview to have a matching ledger row with its output SHA-256.

```ts
const forbiddenRuntimeMetadata = /\/Users\/|\bprovider\b|model_id|\bprice\b|\bdiscount\b|GenStudio/i
assert.doesNotMatch(JSON.stringify(runtimeDocument), forbiddenRuntimeMetadata)
assert.match(ledger, new RegExp(`\\| .*${asset.replace('.', '\\.')}`))
assert.match(ledger, new RegExp(createHash('sha256').update(bytes).digest('hex')))
```

- [ ] **Step 2: Run the source-contract test to verify it fails**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: FAIL because the restoration ledger and declared assets do not exist.

- [ ] **Step 3: Inventory only saved, owner-supplied candidates before authoring assets**

Use this read-only inventory command for each approved source family; inspect decoded images rather than trusting filenames:

```bash
find '<owner-home>/Documents/Story Studio KH/Story Studio Projects' -type f \
  \( -iname '*Thumb*.png' -o -iname '*Thumb*.jpg' -o -iname '*Thumb*.jpeg' -o -iname '*Thumb*.webp' \) -print
```

Start with the evidence paths named in `legacy-thumbnail-stock-report.md`: one channel per family: hardship annotation, impasto animals, prehistoric survival, and dreamlike sleep, plus existing tracked preview bytes for the free-starter/Archival/editorial families. Select three materially distinct images per new recipe where available; a style may use one text-free original preview. Do not request a model generation, call Studio Hub, or reuse an image containing a copied episode title as the reusable prompt contract.

- [ ] **Step 4: Apply the deterministic conversion and record provenance, or halt exactly**

For each accepted saved output, use the existing image tooling to make a new 1672×941 WebP review asset while retaining the source file untouched. Record exact input/output hashes and dimensions. Do not describe a derivative as an unchanged source byte.

If a recipe has fewer than three qualified source images after the inventory, write this exact blocker in `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md`, omit the incomplete recipe source from authoring, and stop its dependent task:

```text
BLOCKED: Studio Hub paid batch requires an exact owner-approved quote and written authorization identifying provider/model, image count, and maximum spend before paid generation.
```

No paid image request is authorized by this plan.

- [ ] **Step 5: Run the ledger test**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: the test remains intentionally red until the component tasks declare the ledgered assets; it must report the exact missing runtime asset path rather than silently accepting fewer previews.

- [ ] **Step 6: Commit intake evidence only when no recipe is blocked**

```bash
git add content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md content-packs/free-starters/ASSET-PROVENANCE.md electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
git commit -m "docs(content-packs): record restoration preview provenance"
```

### Task 3: Author the animal hardship recipe and hand-drawn hardship style

**Files:**
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation/pack.json`
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation/content/thumbnail-recipe.json`
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation/assets/animal-hardship-annotation-{1,2,3}.webp`
- Create: `content-packs/legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon/pack.json`
- Create: `content-packs/legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon/content/visual-style.json`
- Create: `content-packs/legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon/assets/hand-drawn-hardship-cartoon.webp`
- Modify: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

**Interfaces:**
- Consumes: the verified coordinator identities and ledgered saved-output assets.
- Produces: `thumbnail-recipe` `com.storystudio.thumbnail.animal-hardship-annotation` and `visual-style` `com.storystudio.style.hand-drawn-hardship-cartoon`, both compatible only with `com.storystudio.formula.natural-world-explained`.

- [ ] **Step 1: Add failing source assertions for the distinct hardship grammar**

Add assertions that the recipe has `layout: 'hero'`, `aspect_ratio: '16:9'`, `title_mode: 'ai'`, `headline_mode: 'episode-title'`, exactly three preview assets, and requires all of: one anatomically legible expressive animal, one hand-drawn arrow, one 3–6 word handwritten hardship annotation, and a readable full episode-title card. Assert it rejects a copied channel title, multiple arrows, generic curiosity-only wording, watermarks, logos, malformed text, and copied trade dress.

```ts
assert.deepEqual(recipe.compatible_formula_ids, ['com.storystudio.formula.natural-world-explained'])
assert.match(recipe.composition_guidance, /one hand-drawn arrow/i)
assert.match(recipe.composition_guidance, /3[–-]6 word handwritten hardship annotation/i)
assert.match(recipe.headline_guidance, /full.*episode title/i)
assert.equal(recipe.preview_assets.length, 3)
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: FAIL because neither source directory nor the hardship contract exists.

- [ ] **Step 3: Implement the two strict source documents**

Use the receipt-bound `pack.json` envelope exactly as existing psychology components do. The recipe describes a reusable animal hardship grammar—not the sloth source scene—and the style bible describes uneven black ink, flat limited fills, expressive but anatomically coherent animals, hand-drawn annotation texture, and sparse paper-like backgrounds. The style negative prompt excludes photoreal stock imagery, glossy CGI, copied channel branding, duplicate captions, watermarks/logos, violent cruelty, malformed anatomy, and malformed text.

Use this required recipe structure:

```json
{
  "kind": "thumbnail-recipe",
  "schema_version": 1,
  "id": "com.storystudio.thumbnail.animal-hardship-annotation",
  "layout": "hero",
  "aspect_ratio": "16:9",
  "title_mode": "ai",
  "headline_mode": "episode-title",
  "compatible_formula_ids": ["com.storystudio.formula.natural-world-explained"],
  "preview_assets": [
    "assets/animal-hardship-annotation-1.webp",
    "assets/animal-hardship-annotation-2.webp",
    "assets/animal-hardship-annotation-3.webp"
  ]
}
```

- [ ] **Step 4: Add only ledgered WebP assets and prove the source contract**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: PASS for the hardship recipe/style, with every asset decoding as WebP at 1672×941 and every hash represented in `PREVIEW-PROVENANCE.md`.

- [ ] **Step 5: Commit the independently reviewable hardship components**

```bash
git add content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation content-packs/legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
git commit -m "feat(content-packs): add animal hardship components"
```

### Task 4: Retain Editorial's symbolic recipe and add the impasto psychological-animal style

**Files:**
- Create: `content-packs/legacy-thumbnail-restoration/style/impasto-psychological-animals/pack.json`
- Create: `content-packs/legacy-thumbnail-restoration/style/impasto-psychological-animals/content/visual-style.json`
- Create: `content-packs/legacy-thumbnail-restoration/style/impasto-psychological-animals/assets/impasto-psychological-animals.webp`
- Modify: `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md`
- Modify: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

**Interfaces:**
- Consumes: existing `com.storystudio.thumbnail.editorial-psychology-symbolic-split` and `com.storystudio.style.pastel-surreal-psychological-collage` sources without modifying them.
- Produces: `com.storystudio.style.impasto-psychological-animals`, compatible only with `com.storystudio.formula.human-behavior-explained`.

- [ ] **Step 1: Add failing retention and distinctness assertions**

Assert the existing Editorial symbolic recipe remains present with five declared previews, unchanged identity, and `human-behavior-explained` compatibility. Assert the new style has one text-free declared preview and its style bible explicitly describes thick impasto oil paint, muted melancholy, an anthropomorphic animal engaged in a human-scale activity, strong figure-ground separation, and an optional opposing title-safe band supplied by the retained recipe.

```ts
assert.equal(existingEditorialRecipe.preview_assets.length, 5)
assert.deepEqual(impasto.compatible_formula_ids, ['com.storystudio.formula.human-behavior-explained'])
assert.match(impasto.style_bible, /thick impasto oil paint/i)
assert.match(impasto.style_bible, /anthropomorphic animal/i)
assert.doesNotMatch(impasto.style_bible, /Emotional Armor|EP\d{4}/i)
```

- [ ] **Step 2: Run the source test to verify the new-style assertion fails**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: FAIL only on missing impasto source/asset assertions; the existing Editorial component assertions remain green.

- [ ] **Step 3: Implement the receipt-bound impasto style source**

Use a `visual-style` document with category `Illustration`, search tags `psychology`, `impasto`, `oil paint`, `anthropomorphic animals`, and `editorial`, a render-ready style bible, and a negative prompt excluding cute mascot design, stock photography, glossy CGI, neon, copied trade dress, episode text, watermarks/logos, malformed limbs, malformed anatomy, and malformed text. Do not add a second Editorial recipe or change its existing five preview bytes.

- [ ] **Step 4: Add the ledgered text-free preview and run the focused test**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: PASS; the style preview decodes as 1672×941 and the test proves Editorial's original recipe remains independently available.

- [ ] **Step 5: Commit the Editorial style extension without altering the retained recipe**

```bash
git add content-packs/legacy-thumbnail-restoration/style/impasto-psychological-animals content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
git commit -m "feat(content-packs): add impasto psychology animal style"
```

### Task 5: Author the prehistoric survival title-card recipe

**Files:**
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card/pack.json`
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card/content/thumbnail-recipe.json`
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card/assets/prehistoric-survival-title-card-{1,2,3}.webp`
- Modify: `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md`
- Modify: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

**Interfaces:**
- Consumes: existing `com.storystudio.style.prehistoric-stick-cartoon`; it is reused, not copied into a new style source.
- Produces: `com.storystudio.thumbnail.prehistoric-survival-title-card`, compatible only with `com.storystudio.formula.ancient-humans`.

- [ ] **Step 1: Add failing tests for the title-card distinction**

Assert `prehistoric-survival-title-card` has exactly three 16:9 previews, `headline_mode: 'episode-title'`, limited-color stick-cartoon survival action, materially connected human/animal/material survival evidence, and an energetic full question or title card. Assert it is not a `curiosity-hook` clone and differs from existing `prehistoric-discovery`, whose hook mode and one-to-three-gallery migration are asserted separately.

```ts
assert.equal(titleCard.headline_mode, 'episode-title')
assert.match(titleCard.composition_guidance, /stick-limbed/i)
assert.match(titleCard.composition_guidance, /full.*title|full.*question/i)
assert.match(titleCard.avoid_elements.join(' '), /fantasy armor|modern objects|fake archaeology/i)
assert.equal(existingPrehistoricDiscovery.headline_mode, 'curiosity-hook')
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: FAIL because the title-card recipe and its three declared preview bytes are missing.

- [ ] **Step 3: Implement the strict recipe source**

Write the recipe as a reusable educational survival explainer. Require an anatomically simple stick-limbed ancient human, limited earthy color palette, a concrete survival challenge with evidence-connected mammals/tools/weather/food only when relevant, an energetic high-contrast full title, and an uncluttered title-safe zone. Avoid violence, fantasy armor, fake archaeology, modern objects, copied Brain Wise titles, watermarks/logos, post-render overlays, and illegible text. Use only `hero`, the installed supported layout primitive.

- [ ] **Step 4: Add the three ledgered previews and prove the recipe contract**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: PASS; all three previews are visible original 16:9 WebPs and the test confirms no new `prehistoric-stick-cartoon` component was created.

- [ ] **Step 5: Commit the prehistoric recipe**

```bash
git add content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
git commit -m "feat(content-packs): add prehistoric survival title card"
```

### Task 6: Author the dreamlike sleep title-card recipe and luminous style

**Files:**
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card/pack.json`
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card/content/thumbnail-recipe.json`
- Create: `content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card/assets/dreamlike-story-title-card-{1,2,3}.webp`
- Create: `content-packs/legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration/pack.json`
- Create: `content-packs/legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration/content/visual-style.json`
- Create: `content-packs/legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration/assets/dreamlike-luminous-sleep-illustration.webp`
- Modify: `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md`
- Modify: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

**Interfaces:**
- Consumes: `com.storystudio.formula.sleep-story` and the distinct existing framed recipe `com.storystudio.thumbnail.dreamscape-story-window`.
- Produces: `com.storystudio.thumbnail.dreamlike-story-title-card` and `com.storystudio.style.dreamlike-luminous-sleep-illustration`, both compatible only with the Sleep Story formula.

- [ ] **Step 1: Add failing tests for the non-window dream title-card grammar**

Assert the recipe requires one gentle subject or quiet setting, amber/moonlit-blue/candle-gold illustration, a large calm gold-serif title card, and low-arousal title-safe composition. Assert it avoids window/doorway/frame requirements so it remains distinct from `dreamscape-story-window`; ensure it avoids violence, urgency, cliffhangers, alarming faces, high-contrast spectacle, watermarks/logos, copied story titles, and malformed text.

```ts
assert.deepEqual(recipe.compatible_formula_ids, ['com.storystudio.formula.sleep-story'])
assert.match(recipe.headline_guidance, /gold serif/i)
assert.doesNotMatch(recipe.composition_guidance, /window|doorway|frame/i)
assert.match(style.style_bible, /amber|moonlit blue|candle gold/i)
assert.match(style.negative_prompt, /violence|urgency|cliffhanger|alarming/i)
```

- [ ] **Step 2: Run the source test to verify the dreamlike additions fail**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: FAIL because the new recipe/style and their declared preview files do not exist.

- [ ] **Step 3: Implement the two receipt-bound sources**

Set the recipe's `layout` to `hero`, `title_mode` to `ai`, and `headline_mode` to `episode-title`; set the visual style category to `Illustration`. Make the wording abstract reusable grammar only: no `The Elephant Who Loved the Rain`, Sleep Stories episode code, channel name, copied composition, or fixed character. The style negative prompt must prohibit visual peril, loud saturated neon, photoreal stock imagery, logos/watermarks, copied trade dress, and malformed anatomy/text.

- [ ] **Step 4: Add ledgered preview assets and run the source test**

Run: `npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`

Expected: PASS; three new recipe previews and one style preview decode at 1672×941, and the existing Dreamscape recipe remains a separate window/framing contract.

- [ ] **Step 5: Commit the dreamlike pair**

```bash
git add content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card content-packs/legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
git commit -m "feat(content-packs): add dreamlike sleep title card"
```

### Task 7: Enrich existing gallery sources and document reuse/compatibility

**Files:**
- Modify: `content-packs/free-starters/thumbnail/centered-hero-headline/content/thumbnail-recipe.json`
- Create: `content-packs/free-starters/thumbnail/centered-hero-headline/assets/centered-hero-headline-{2,3}.webp`
- Modify: `content-packs/free-starters/thumbnail/portrait-block-right/content/thumbnail-recipe.json`
- Create: `content-packs/free-starters/thumbnail/portrait-block-right/assets/portrait-block-right-{2,3}.webp`
- Modify: `content-packs/free-starters/thumbnail/dreamscape-story-window/content/thumbnail-recipe.json`
- Create: `content-packs/free-starters/thumbnail/dreamscape-story-window/assets/dreamscape-story-window-{2,3}.webp`
- Modify: `content-packs/free-starters/thumbnail/prehistoric-discovery/content/thumbnail-recipe.json`
- Create: `content-packs/free-starters/thumbnail/prehistoric-discovery/assets/prehistoric-discovery-{2,3}.webp`
- Modify: `frontend/public/thumbnail-recipe-previews/` (add only the corresponding visible centered/portrait gallery copies)
- Modify: `electron/server/thumbnail-templates/centered-hero-headline.json`
- Modify: `electron/server/thumbnail-templates/portrait-block-right.json`
- Modify: `content-packs/free-starters/ASSET-PROVENANCE.md`
- Modify: `content-packs/free-starters/MIGRATION-RATIONALE.md`
- Modify: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`
- Modify: `electron/server/__tests__/thumbnail-recipe-catalog.test.ts`

**Interfaces:**
- Consumes: current approved first preview in each named source and the four established three-preview families: Annotated Business Board, Curiosity Question Cartoon, Documentary Label Tableau, and Archival Map Investigation.
- Produces: exactly three previews for each of the four enriched free-starter sources without replacing or reordering their existing preview; runtime legacy JSON galleries retain prior URLs and append new URLs.

- [ ] **Step 1: Write failing gallery and reuse assertions**

In `legacy-thumbnail-restoration-source.test.ts`, define the full twelve-recipe lineup and require `3 <= preview_assets.length && preview_assets.length <= 5` for each. In `thumbnail-recipe-catalog.test.ts`, keep all existing assertions for the four established families and add checks that centered and portrait legacy `previewImages` retain their old first URL and now contain three existing `frontend/public` WebPs.

```ts
const establishedThreePreviewFamilies = [
  'annotated-business-board',
  'curiosity-question-cartoon',
  'documentary-label-tableau',
  'archival-map-investigation',
]
for (const recipe of restoredLineup) {
  assert.ok(recipe.preview_assets.length >= 3 && recipe.preview_assets.length <= 5, recipe.id)
}
assert.equal(centeredLegacy.previewImages[0], '/thumbnail-recipe-previews/centered-hero-headline.webp')
assert.equal(portraitLegacy.previewImages[0], '/thumbnail-recipe-previews/portrait-block-right.webp')
```

Add an explicit reuse matrix assertion:

```ts
assert.deepEqual(nightTales, {
  recipe: 'com.storystudio.thumbnail.centered-hero-headline', style: 'builtin-pixel-art-story',
})
assert.deepEqual(devotional, {
  recipe: 'com.storystudio.thumbnail.portrait-block-right', style: 'com.storystudio.style.cinematic-photoreal',
})
```

- [ ] **Step 2: Run the gallery tests to verify they fail**

Run:

```bash
npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
npx tsx --test electron/server/__tests__/thumbnail-recipe-catalog.test.ts
```

Expected: FAIL because the four sources expose one preview and the two legacy runtime galleries do not yet have three visible files.

- [ ] **Step 3: Append, never replace, the new original gallery bytes**

Keep each original asset reference as index zero and append only ledgered `-2` and `-3` asset paths. Copy the centered and portrait additions to `frontend/public/thumbnail-recipe-previews/` under the same basenames, then append URLs to their legacy template JSON. Do not alter their `id`, existing `recipe` nullability, fixed geometry, `textZones`, `backgroundDimGradient`, `accentStrokes`, `logoSlot`, or user-template compatibility.

Do not add a Night Tales or Devotional Hour pack. Update `MIGRATION-RATIONALE.md` to state that Night Tales reuses the existing centered recipe plus `builtin-pixel-art-story`, Devotional Hour reuses portrait plus signed `cinematic-photoreal`, and the centered 94px custom JSON remains a loadable fork rather than a product.

- [ ] **Step 4: Run focused gallery checks**

Run:

```bash
npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
npx tsx --test electron/server/__tests__/thumbnail-recipe-catalog.test.ts
```

Expected: PASS; all four enrichment targets have exactly three source previews, every pre-existing correct image is still declared, and each of the four already-three-preview families remains decodable and unchanged.

- [ ] **Step 5: Commit gallery enrichment and compatibility notes**

```bash
git add content-packs/free-starters/thumbnail frontend/public/thumbnail-recipe-previews electron/server/thumbnail-templates/centered-hero-headline.json electron/server/thumbnail-templates/portrait-block-right.json content-packs/free-starters/ASSET-PROVENANCE.md content-packs/free-starters/MIGRATION-RATIONALE.md electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts electron/server/__tests__/thumbnail-recipe-catalog.test.ts
git commit -m "feat(content-packs): expand legacy recipe preview galleries"
```

### Task 8: Prove legacy aliases, user-fork fallback, and adapter compatibility remain intact

**Files:**
- Modify: `electron/server/__tests__/content-pack-registry.test.ts`
- Modify: `electron/server/__tests__/content-pack-migration-golden.test.ts`
- Modify: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`
- Preserve: `electron/server/services/thumbnail-template-loader.ts`
- Preserve: `electron/server/content-packs/legacy-adapters.ts`

**Interfaces:**
- Consumes: `loadTemplate(id, options) -> Promise<ThumbnailTemplate | null>` and `getEffectiveTemplateFor(project, niche, config, options) -> Promise<ThumbnailTemplate | null>`.
- Produces: proof that bare legacy IDs still resolve through legacy fallback, qualified IDs resolve signed catalog entries when installed, and a user-fork `centered-hero-headline-custom` with `fontSize: 94` remains a user template rather than a content product.

- [ ] **Step 1: Add failing fallback regression cases**

Extend the existing loader test fixtures to assert the complete fallback behavior without changing production loader code:

```ts
assert.equal((await thumbnailTemplateLoader.loadTemplate('centered-hero-headline', options))?.id, 'centered-hero-headline')
assert.equal((await thumbnailTemplateLoader.loadTemplate('portrait-block-right', options))?.id, 'portrait-block-right')
assert.equal((await thumbnailTemplateLoader.loadTemplate('centered-hero-headline-custom', options))?.id, 'centered-hero-headline-custom')
assert.equal((await thumbnailTemplateLoader.loadTemplate('com.storystudio.thumbnail.animal-hardship-annotation', signedOptions))?.id,
  'com.storystudio.thumbnail.animal-hardship-annotation')
```

Also assert no source or registry record has `pack_id`, `item_id`, family, or SKU containing `centered-hero-headline-custom`.

- [ ] **Step 2: Run tests to verify the new coverage fails before fixtures/catalog entry injection**

Run:

```bash
npx tsx --test electron/server/__tests__/content-pack-registry.test.ts
npx tsx --test electron/server/__tests__/content-pack-migration-golden.test.ts
```

Expected: FAIL only where the new fixture is absent; never "fix" the failure by removing legacy fallback assertions.

- [ ] **Step 3: Add fixture-only signed catalog records and user fork data**

Use each test's existing injected registry/options fixture mechanism to supply new qualified recipe documents and declared assets. Add a temporary `.thumbnail-templates/centered-hero-headline-custom.json` fixture with `fontSize: 94`, verify it wins only for the exact bare custom ID, and leave runtime loader order unchanged.

- [ ] **Step 4: Run compatibility tests**

Run:

```bash
npx tsx --test electron/server/__tests__/content-pack-registry.test.ts
npx tsx --test electron/server/__tests__/content-pack-migration-golden.test.ts
npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
```

Expected: PASS; old project IDs, custom fork, qualified recipe adapter, existing fixed legacy geometry, and project-over-niche precedence all remain readable.

- [ ] **Step 5: Commit tests only**

```bash
git add electron/server/__tests__/content-pack-registry.test.ts electron/server/__tests__/content-pack-migration-golden.test.ts electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
git commit -m "test(content-packs): preserve legacy thumbnail fallbacks"
```

### Task 9: Whole-lineup audit and deterministic candidate-build qualification

**Files:**
- Create: `scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs`
- Modify: `electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts`
- Preserve: `package.json`, `package-lock.json`, `CHANGELOG.md`, all release scripts, production keys, and all GenStudio state.

**Interfaces:**
- Consumes: `buildContentPack({ sourceDirectory, privateKeyPath, outputPath, minAppVersion }) -> Promise<{ packId: string; version: string; sha256: string }>` and `validateContentPack({ archivePath, publicKeyPath, publisherId, keyId }) -> Promise<{ packId: string; version: string; sha256: string }>` from `scripts/content-packs/lib.mjs`.
- Produces: a deterministic qualification test across the six new source packs and the modified four free-starter recipe sources; it leaves no archive/key outside its temporary directory.

- [ ] **Step 1: Write the failing whole-lineup audit and candidate-build test**

Define a single `RESTORED_RECIPES` list with these twelve IDs and exact preview count range three through five:

```js
const RESTORED_RECIPES = [
  'com.storystudio.thumbnail.annotated-business-board',
  'com.storystudio.thumbnail.centered-hero-headline',
  'com.storystudio.thumbnail.curiosity-question-cartoon',
  'com.storystudio.thumbnail.documentary-label-tableau',
  'com.storystudio.thumbnail.portrait-block-right',
  'com.storystudio.thumbnail.prehistoric-discovery',
  'com.storystudio.thumbnail.dreamscape-story-window',
  'com.storystudio.thumbnail.archival-map-investigation',
  'com.storystudio.thumbnail.editorial-psychology-symbolic-split',
  'com.storystudio.thumbnail.animal-hardship-annotation',
  'com.storystudio.thumbnail.prehistoric-survival-title-card',
  'com.storystudio.thumbnail.dreamlike-story-title-card',
]
```

For the ten source directories in scope (six new + four enriched), generate one ephemeral `ed25519` pair, build each source twice to two distinct non-existent temp output paths with `minAppVersion: '9.9.9-test'`, assert byte-for-byte archive equality and identical SHA-256, validate the first archive using only its matching public key, and assert the temporary directory is removed in `t.after()`.

- [ ] **Step 2: Run the audit to verify it fails before all sources/assets are complete**

Run:

```bash
node --test scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs
npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
```

Expected: FAIL with the exact missing component, preview, provenance row, or deterministic archive discrepancy.

- [ ] **Step 3: Implement the qualification test using only ephemeral keys**

Follow the established `archival-ledger-components.test.mjs` pattern exactly:

```js
const temporary = await mkdtemp(join(tmpdir(), 'legacy-thumbnail-restoration-'))
t.after(() => rm(temporary, { recursive: true, force: true }))
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
const first = await buildContentPack({ sourceDirectory, privateKeyPath, outputPath: firstPath, minAppVersion: '9.9.9-test' })
const second = await buildContentPack({ sourceDirectory, privateKeyPath, outputPath: secondPath, minAppVersion: '9.9.9-test' })
assert.equal(first.sha256, second.sha256)
assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
```

Do not call the CLI production Store delivery profile, sign a release, retain the key, or write an artifact to `dist/`.

- [ ] **Step 4: Run the final focused and repository gates**

Run:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs
npx tsx --test electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts electron/server/__tests__/thumbnail-recipe-catalog.test.ts electron/server/__tests__/content-pack-contract.test.ts electron/server/__tests__/content-pack-registry.test.ts electron/server/__tests__/content-pack-archive.test.ts electron/server/__tests__/content-pack-legacy-adapters.test.ts electron/server/__tests__/content-pack-migration-golden.test.ts
npm run content-pack:registry -- validate
npm run typecheck:electron
npm run lint
npm run check:security
npm run check:model-drift
```

Expected: all functional checks pass; lint may report the repository's existing warnings but exits 0 with no lint errors. The explicit audit must report all twelve recipes, three-to-five previews each, four established three-preview families retained, three new recipes/styles, Editorial retention, Night Tales/Devotional Hour reuse, and legacy fallback preservation.

- [ ] **Step 5: Commit qualification code only; do not release**

```bash
git add scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs electron/server/__tests__/legacy-thumbnail-restoration-source.test.ts
git commit -m "test(content-packs): qualify restored thumbnail lineup"
```

Do not change version files or `CHANGELOG.md`, run a release/GenStudio command, push, publish, deploy, or transition the reserved registry records in this authoring branch.

## Plan Self-Review

**Spec coverage:** Componentized independent recipe/style sources, exact IDs/versions, compatible Formula declarations, strict decoded previews, no provider/model/pricing material, immutable candidate bytes, legacy readability, and deterministic offline validation map to Tasks 1–9. The plan deliberately does not claim a catalog product, customer entitlement, install, migration, Store UI change, production delivery profile, or release because the approved catalog spec keeps those outside source authoring.

**Owner-approved restoration coverage:** Task 3 covers animal hardship plus hand-drawn style; Task 4 retains Editorial symbolic and adds impasto style; Task 5 covers prehistoric full-title survival and reuses its current style; Task 6 covers dreamlike title card plus luminous style; Task 7 documents Night Tales/Devotional Hour reuse and centered-custom compatibility. Tasks 7 and 9 enforce three-to-five previews for all twelve recipes, enrich the four named one-preview sources, and preserve the four pre-existing three-preview families.

**Placeholder scan:** No task authorizes unspecified paid generation. The only path for missing preview bytes is the exact written Studio Hub authorization blocker. All new identities, paths, IDs, test commands, lifecycle boundaries, and expected outputs are specified above.

**Type consistency:** Recipe documents remain `thumbnail-recipe`; style documents remain `visual-style`; source paths map to `pack.json`, strict content document, and declared assets. The plan uses the existing builder/validator and `loadTemplate` signatures without adding a runtime API or schema field.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-23-legacy-thumbnail-restoration.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Use the coordinator reservation task first. Do not begin a leaf source task until every receipt verification succeeds; do not begin a recipe whose ledger reports the Studio Hub authorization blocker.
