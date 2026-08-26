# Visual Style Content Store Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the six remaining legacy-only visual styles into complete standalone signed products, verify their live signed availability, and then remove Story Studio's static built-in visual-style catalog and every compatibility path.

**Architecture:** Content Pack authoring and runtime cutover are separate gated phases. The authoring phase preserves the six approved rendering contracts and preview bytes under registry-issued signed component identities; the runtime phase begins only after GenStudio returns publication evidence and the installed API exposes all six. The final runtime keeps the shared reactive catalog and selectors but sources them exclusively from signed Content Store records.

**Tech Stack:** TypeScript, Vue/Nuxt, Electron/Node, Zod Content Pack schemas, deterministic `.sspack` builder, JSON authoring registry, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-visual-style-content-store-cutover-design.md`

> **Status, 2026-08-27:** Tasks 1 and 2 are landed on `main`. The six source
> packs live under `content-packs/production-looks/style/`, are registered at
> registry revision 43 (receipt
> `authoring:0b7e8bcafc21b4cc6ea8bfd16ee9c21211544fdcb67d2a27dc71c28dedbc30ae`)
> and were advanced to `authored` at revisions 44-49. Tasks 3-7 are NOT done and
> are not Story-side work alone: Tasks 5 and 6 need GenStudio to stock, price,
> publish and confirm the six products before the Task 7 catalog deletion may
> begin. Nothing in Tasks 1-2 changes runtime behaviour on its own.

## Global Constraints

- The six products are MS Paint Fantasy, Pixel Art Story, Anime Cel, Studio Catalog Realism, Whiteboard Doodle Explainer, and Hand-Drawn Cartoon Explainer.
- New standalone products request active/published/direct reachability and exactly one 300-credit price version with no discount.
- No Channel Kit is created or modified.
- `content-packs/authoring-registry.json` is the sole Story identity authority; leaves verify the exact coordinator receipt before authoring.
- Reserve only against the current committed registry revision; a receipt hashes its own `expected_revision`, so a stale reservation is void rather than rebaseable. Never copy dirty main-checkout bytes into the worktree.
- Story never invents GenStudio product, release, price-version, account, purchase, entitlement, signing, or wire identities.
- Existing checked-in 1672x941 WebP files are the approved migration preview sources; no production image generation or fleet work occurs.
- Hard cutover begins only after six exact archives pass review, GenStudio confirms publication, and all six are installed and API-visible.
- No compatibility, alias, migration, rewrite, or fallback remains for `builtin-*` visual-style selections; saved legacy presets/projects may break.
- Preserve unrelated Formula, Topic Pack, Thumbnail Recipe, generic Image Prompt preset, and custom-style behavior.
- Every shipped application change increments `package.json` and `package-lock.json`, adds the newest `CHANGELOG.md` entry, and passes release integrity checks.

---

### Task 1: Adopt the landed registry and reserve the complete six-style batch

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Create in ignored SDD workspace: `.superpowers/sdd/2026-08-25-visual-style-content-store-cutover/reservation-request.json`
- Create in ignored SDD workspace: six `expected-identity-<slug>.json` files
- Test: `scripts/content-packs/__tests__/authoring-registry.test.mjs`

**Interfaces:**
- Consumes: the latest committed authoritative registry revision after GenStudio lands its concurrent work.
- Produces: one new registry revision, one `receipt_ref`, and six exact reserved Story identities used verbatim by Tasks 2–6.

- [x] **Step 1: Make the worktree current without absorbing uncommitted main-checkout files**

Run:

```bash
git status --short
git fetch --all --prune
git rebase main
git status --short
```

Expected: the plan/spec branch is clean apart from its owned commits; the rebased registry revision matches the latest committed `main` registry, not the old revision 1 copy.

- [x] **Step 2: Validate the authority and record its exact revision**

Run:

```bash
npm run content-pack:registry -- validate
jq '.revision, (.records | length)' content-packs/authoring-registry.json
```

Expected: validation passes. Stop this task if the latest committed registry is older than the concurrently observed revision; do not guess or copy uncommitted bytes.

- [x] **Step 3: Write one atomic reservation request**

Use the validated current revision as `expected_revision`, coordinator task `visual-style-content-store-cutover`, branch `codex/visual-style-builtins-to-store`, and proposal reference `docs/superpowers/specs/2026-08-25-visual-style-content-store-cutover-design.md`.

The six request records use kind `visual-style`, version `1.0.0`, publisher `com.storystudio`, release-bound `{{MIN_APP_VERSION}}`, empty dependencies, reserved status, and these exact proposed Story namespaces/source paths:

| Slug | Pack ID | Item ID | Source path |
| --- | --- | --- | --- |
| `ms-paint-fantasy` | `com.storystudio.pack.style.ms-paint-fantasy` | `com.storystudio.style.ms-paint-fantasy` | `content-packs/production-looks/style/ms-paint-fantasy` |
| `pixel-art-story` | `com.storystudio.pack.style.pixel-art-story` | `com.storystudio.style.pixel-art-story` | `content-packs/production-looks/style/pixel-art-story` |
| `anime-cel` | `com.storystudio.pack.style.anime-cel` | `com.storystudio.style.anime-cel` | `content-packs/production-looks/style/anime-cel` |
| `studio-catalog-realism` | `com.storystudio.pack.style.studio-catalog-realism` | `com.storystudio.style.studio-catalog-realism` | `content-packs/production-looks/style/studio-catalog-realism` |
| `whiteboard-doodle-explainer` | `com.storystudio.pack.style.whiteboard-doodle-explainer` | `com.storystudio.style.whiteboard-doodle-explainer` | `content-packs/production-looks/style/whiteboard-doodle-explainer` |
| `hand-drawn-cartoon-explainer` | `com.storystudio.pack.style.hand-drawn-cartoon-explainer` | `com.storystudio.style.hand-drawn-cartoon-explainer` | `content-packs/production-looks/style/hand-drawn-cartoon-explainer` |

For every slug, propose `com.storystudio.family.style.<slug>` and `com.storystudio.sku.style.<slug>` with status `proposed`. Do not add GenStudio fields.

- [x] **Step 4: Reserve the batch once and record the receipt**

Run:

```bash
npm run content-pack:registry -- reserve --request .superpowers/sdd/2026-08-25-visual-style-content-store-cutover/reservation-request.json
npm run content-pack:registry -- validate
```

Expected: one atomic success, revision increases by one, and output contains one `authoring:<64 lowercase hex>` receipt.

- [x] **Step 5: Verify every leaf identity before source creation**

Write each exact request record to its expected-identity file, then run for every slug:

```bash
npm run content-pack:registry -- verify-receipt --revision "$STYLE_REGISTRY_REVISION" --receipt "$STYLE_RECEIPT_REF" --expected-identity ".superpowers/sdd/2026-08-25-visual-style-content-store-cutover/expected-identity-$STYLE_SLUG.json"
```

Expected: all six return the same revision and receipt with an exact identity match.

- [x] **Step 6: Run registry regression coverage and commit**

Run:

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
git diff --check
git add content-packs/authoring-registry.json
git commit -m "chore(content-packs): reserve six production looks"
```

Expected: tests pass and the commit contains only the registry reservation.

---

### Task 2: Author the six signed Visual Style sources from the approved contracts

**Files:**
- Create: `content-packs/production-looks/PREVIEW-PROVENANCE.md`
- Create: `content-packs/production-looks/style/<six-slugs>/pack.json`
- Create: `content-packs/production-looks/style/<six-slugs>/content/visual-style.json`
- Create: `content-packs/production-looks/style/<six-slugs>/assets/<slug>.webp`
- Test: `scripts/content-packs/__tests__/production-looks.test.mjs`
- Source: `frontend/composables/useBuiltInStyles.ts`
- Source assets: `frontend/public/builtin-style-previews/<slug>.webp`

**Interfaces:**
- Consumes: Task 1's exact verified identities and receipt.
- Produces: six complete deterministic source directories with no dependency or Formula restriction.

- [x] **Step 1: Write a failing six-pack inventory/parity test**

Create `production-looks.test.mjs` to assert:

- exactly the six named source directories exist;
- each pack/item/family/SKU/version/publisher matches its verified registry record;
- each document has kind `visual-style`, schema version 1, exact canonical signed ID, exact legacy name/description/category/tags/style bible/negative prompt, one preview path, empty `compatible_formula_ids`, and no dependencies;
- each copied preview is byte-identical to the corresponding approved static source, decodes as WebP, measures exactly 1672x941, exceeds 20 KiB, and matches the provenance SHA-256;
- no source file contains a `builtin-*` identity except the historical source reference inside provenance.

Run:

```bash
node --test scripts/content-packs/__tests__/production-looks.test.mjs
```

Expected: FAIL because the six source packs do not yet exist.

- [x] **Step 2: Create the six exact pack manifests**

Each `pack.json` follows the existing signed style pack schema:

```json
{
  "pack_format": 1,
  "pack_id": "<registry-issued pack_id>",
  "publisher_id": "com.storystudio",
  "key_id": "{{KEY_ID}}",
  "version": "1.0.0",
  "min_app_version": "{{MIN_APP_VERSION}}",
  "lifecycle": "active",
  "entitlement": {
    "sku": "<registry-issued proposed sku>",
    "family": "<registry-issued proposed family>"
  }
}
```

Use the exact Task 1 receipt records; do not derive alternative IDs in the leaf.

- [x] **Step 3: Create the six exact style documents**

For each matching `builtin-<slug>` record in `useBuiltInStyles.ts`, copy its `name` to `name`, `blurb` to `description`, `category`, `tags`, `data.style_bible`, and `data.negative_prompt` without creative rewriting. Set:

```json
{
  "kind": "visual-style",
  "schema_version": 1,
  "id": "<registry-issued item_id>",
  "preview_assets": ["assets/<slug>.webp"],
  "compatible_formula_ids": []
}
```

Expected: each signed source is a faithful productized edition of one approved look, not a new expansion.

- [x] **Step 4: Copy and ledger the approved preview bytes**

Copy each exact source WebP into its pack asset path. Record source path, destination path, owner-approved migration provenance, source and destination SHA-256, exact byte count, `1672x941`, WebP decode result, and identical-byte result in `PREVIEW-PROVENANCE.md`.

Expected source SHA-256 values:

| Slug | SHA-256 |
| --- | --- |
| `ms-paint-fantasy` | `5dced4a83086703f8b49ce8edff43b137126a0c237a8636c35ef6b4d5b3afbc8` |
| `pixel-art-story` | `f81fd10b04dabff766f993fe6dfecd80611c5e3d61545abc131431650307adf5` |
| `anime-cel` | `d5c5336ef911b14dec00deee80b112a0d25f70a6e5106cb755f6dc42173f8e18` |
| `studio-catalog-realism` | `60e7b00efb4b6c80e691c6241edcb8a19659a7b069842fd3fb36b11af6a1171e` |
| `whiteboard-doodle-explainer` | `e4ed319d2d1a59b2dabea6d94c114fcdd11e808e80bccd7617e203ae41354dcb` |
| `hand-drawn-cartoon-explainer` | `ad03fb926514316328776c89684f25e8ee34f0635cfff8d8e9c378d077445b16` |

- [x] **Step 5: Pass focused source and registry checks**

Run:

```bash
node --test scripts/content-packs/__tests__/production-looks.test.mjs
npm run content-pack:registry -- validate
git diff --check
```

Expected: all six pass exact identity, parity, provenance, decode, dimension, and size checks.

- [x] **Step 6: Promote six registry records from reserved to authored**

For each exact `pack_id@1.0.0`, submit a lifecycle transition using the current revision, Task 1 receipt, coordinator task/branch, and changes `{ "status": "authored" }`. Re-read the revision before each CAS transition and validate after all six.

Expected: six sequential authored transitions; the immutable reservation receipt remains verifiable.

- [x] **Step 7: Commit the authored batch**

Run:

```bash
git add content-packs/authoring-registry.json content-packs/production-looks scripts/content-packs/__tests__/production-looks.test.mjs
git commit -m "feat(content-packs): productize six legacy visual styles"
```

---

### Task 3: Build and validate six exact delivery archives

**Files:**
- Create outside Git: `/build/Developer/_handoffs/artifacts/story-production-looks-six-2026-08-25/<slug>.sspack`
- Create outside Git: `/build/Developer/_handoffs/artifacts/story-production-looks-six-2026-08-25/ledger.json`
- Test: `scripts/content-packs/__tests__/production-looks.test.mjs`

**Interfaces:**
- Consumes: Task 2 authored sources and registry lifecycle state.
- Produces: six exact keyless delivery archives plus measured digest/size/profile evidence.

- [ ] **Step 1: Build every source twice under the delivery profile**

For each slug, run twice to separate temporary outputs:

```bash
npm run content-pack:build -- content-packs/production-looks/style/<slug> --output <temporary-a>.sspack --min-app-version "$FINAL_STORY_STUDIO_RELEASE_VERSION" --delivery-profile genstudio-store-receipt-v1
npm run content-pack:build -- content-packs/production-looks/style/<slug> --output <temporary-b>.sspack --min-app-version "$FINAL_STORY_STUDIO_RELEASE_VERSION" --delivery-profile genstudio-store-receipt-v1
cmp <temporary-a>.sspack <temporary-b>.sspack
```

Expected: the two archive byte streams are identical.

- [ ] **Step 2: Validate every archive**

Run for each final archive:

```bash
npm run content-pack:validate -- <archive>.sspack --delivery-profile genstudio-store-receipt-v1
shasum -a 256 <archive>.sspack
stat -f '%z' <archive>.sspack
```

Expected: validation passes, each archive is at most 52,428,800 bytes, and no production/private signing key is used or retained.

- [ ] **Step 3: Write the exact artifact ledger**

Record artifact absolute path, pack/item/version/publisher, family/SKU proposal status, min app version, delivery profile, SHA-256, bytes, declared files, preview digest/dimensions/bytes, registry revision/receipt, dependencies `[]`, and build/validation command evidence.

- [ ] **Step 4: Re-run source gates**

Run:

```bash
node --test scripts/content-packs/__tests__/production-looks.test.mjs
npm run content-pack:registry -- validate
git status --short
```

Expected: tracked source remains clean; artifacts exist only under the handoff artifact root.

---

### Task 4: Complete independent review of the six-product batch

**Files:**
- Create in ignored SDD workspace: six specification review reports
- Create in ignored SDD workspace: six quality/visual review reports
- Create in ignored SDD workspace: one batch final review report

**Interfaces:**
- Consumes: Task 2 source diff, Task 3 exact archives/ledger, and the approved spec.
- Produces: independent schema, parity, provenance, visual, safety, copy, commercial-boundary, and deterministic-build approval with zero open findings.

- [ ] **Step 1: Review each source/identity contract independently**

For every style, verify registry receipt, exact document parity, no hidden subject/topic rewrite, dependency closure, component summary readiness, archive contents, digest/size/profile, and 300-credit standalone request boundary.

- [ ] **Step 2: Decode and visually inspect every final preview**

Inspect the pack asset, not merely the legacy source path. Confirm it accurately represents its style bible, is legible at gallery size, contains no corrupted raster, logo/watermark, harmful content, or contradictory visual language.

- [ ] **Step 3: Review the whole six-pack batch**

Confirm no identity collision, accidental seventh product, omitted pack, Channel Kit mutation, GenStudio identity invention, private key, executable content, arbitrary URL, or production-generation action.

- [ ] **Step 4: Fix and re-review all Critical/Important findings**

Resume the implementer for rounds 1–3 and use a fresh higher-capability implementer for rounds 4–5. Every fix gets a scoped independent re-review. Do not proceed while any applicable review is blocked or pending.

Expected: all required reviews pass with zero unresolved findings.

---

### Task 5: Send one complete six-product GenStudio stocking handoff

**Files:**
- Create outside Git: `/build/Developer/_handoffs/2026-08-25_to-claude-genstudio_from-gpt-storystudio_production-looks-six-ready.json`
- Create outside Git: `/build/Developer/_handoffs/2026-08-25_to-claude-genstudio_from-gpt-storystudio_production-looks-six-ready.md`

**Interfaces:**
- Consumes: six exact Task 3 archives and all Task 4 approvals.
- Produces: one complete stocking request; no product mutation is performed by Story.

- [ ] **Step 1: Assemble the complete-only JSON**

For each product include exact Story identity, registry revision/receipt, archive absolute path/digest/bytes/profile/minimum version, dependencies, component summary, review evidence, provenance, family/SKU proposal, and intended kit `not-applicable`.

Request from GenStudio for each product:

- one active standalone product;
- one published release containing the exact archive;
- direct listing, purchase, and delivery;
- one published 300-credit price version with no discount;
- returned server-assigned product, release, price-version, family/SKU confirmation, measured digest/bytes, publication state, direct reachability, and mutation ledger.

Explicitly prohibit Channel Kit mutation, unrelated legacy-product mutation, extra products/releases/archives, customer charge/refund/purchase/grant/data mutation, paid generation/fleet work, and production signing outside the declared delivery path.

- [ ] **Step 2: Validate handoff completeness against disk**

Re-measure every archive and reject the handoff if any digest, byte count, identity, review, dependency, status, or absolute path differs.

- [ ] **Step 3: Place the JSON and covering note once**

Expected: no `blocked`, `partial`, `pending-review`, `awaiting-owner`, scaffold, question, or missing archive appears in the submission.

---

### Task 6: Gate the hard cutover on GenStudio and live signed API evidence

**Files:**
- Read: GenStudio reply handoff
- Read: installed Content Pack state
- Read: live `/api/visual-styles` response
- Create in ignored SDD workspace: `signed-availability-gate.md`

**Interfaces:**
- Consumes: GenStudio's field-exact reply and the installed signed styles.
- Produces: explicit PASS evidence authorizing Task 7, or a blocker that leaves built-ins untouched.

- [ ] **Step 1: Verify all six server mutations exactly**

Require six product IDs, release IDs, price-version IDs, active/published/direct states, one 300-credit no-discount price each, and three matching archive measurements (Story declaration, GenStudio server, object-store reread).

- [ ] **Step 2: Install/refresh through the authorized signed delivery path**

Do not side-load keyless archives or use a production key. Use the same GenStudio-owned installation/delivery path customers use.

- [ ] **Step 3: Query the signed Visual Style API**

Confirm every exact signed item ID is present once and its name, style bible, negative prompt, category, tags, and preview asset resolve correctly.

- [ ] **Step 4: Confirm Hand-Drawn Hardship is no longer silently hidden**

Require the installed active signed style to be returned or record the exact category-contract defect as blocking Task 7.

Expected: signed-availability gate PASS. If any product is absent or malformed, stop before deletion and send an evidence-backed correction handoff.

---

### Task 7: Remove the static catalog and all visual-style compatibility paths

**Files:**
- Modify/rename: `frontend/composables/useBuiltInStyles.ts`
- Modify: `frontend/components/BuiltInStyleLibraryModal.vue`
- Modify: `frontend/components/StylePicker.vue`
- Modify: `frontend/components/ProjectStyleLibrary.vue`
- Modify: `frontend/pages/projects/[slug]/scene-plan.vue`
- Modify: `frontend/pages/projects/[slug]/image-prompts.vue`
- Modify: `frontend/pages/projects/[slug]/settings.vue`
- Modify: `electron/server/services/art-style-resolver.ts`
- Modify: `electron/server/content-packs/project-pins.ts`
- Modify: `electron/server/content-packs/legacy-adapters.ts`
- Modify: `electron/server/niches/deep-time-documentary.json`
- Modify: `electron/server/niches/hidden-mechanics-history.json`
- Delete: `frontend/public/builtin-style-previews/*.webp`
- Update: `content-packs/free-starters/ASSET-PROVENANCE.md`
- Update: `AGENTS.md`
- Replace: `docs/BUILT_IN_STYLE_FORMAT.md`
- Update: `developer-migration/codex-skills/story-studio-visual-style-adoption/SKILL.md`
- Test: all visual-style, project-pin, resolver, migration, Content Pack golden, modal, Scene Plan, Settings, and source-pack tests named by repository search.

**Interfaces:**
- Consumes: Task 6 signed-availability PASS.
- Produces: a signed-only catalog with honest error/empty behavior and no `builtin-*` resolution.

- [ ] **Step 1: Write failing signed-only catalog tests**

Assert:

- initial state contains no static styles;
- successful API data is returned once without merging;
- API failure yields an empty catalog plus explicit error, never fallback;
- authenticated empty response remains empty;
- filesystem-backed preview paths are rejected;
- active signed categories do not disappear silently;
- legacy `builtin-*` IDs fail resolution and are never migrated or rewritten;
- exact signed IDs persist both `style_bible` and `negative_prompt`.

Run the focused tests and confirm they fail against the legacy implementation.

- [ ] **Step 2: Remove `BUILT_IN_STYLES` and fallback state**

Keep one shared reactive signed catalog composable, but initialize it empty, populate it only from `/visual-styles`, delete `mergeWithLegacyRecovery`, delete `usingFallback`, and make resets empty. Rename types/files/UI copy away from “Built-in” where doing so reduces misleading terminology without duplicating catalogs.

- [ ] **Step 3: Remove category rejection that hides valid signed products**

Make signed category handling match the Content Pack schema and customer filter contract. Do not invent or infer a category; accept the published validated value or fail the product loudly with actionable evidence rather than silently skipping it.

- [ ] **Step 4: Remove resolver and project-pin legacy behavior**

Delete visual-style-only `builtin-*` alias/migration/grandfathering logic. Preserve custom user style resolution only when it cannot resolve a retired built-in ID. Do not touch unrelated migration kinds.

- [ ] **Step 5: Replace shipped niche recommendations with signed IDs**

Use:

```text
com.storystudio.style.paleo-documentary-tableau
com.storystudio.style.archival-documentary-reconstruction
```

for the corresponding current niches. Do not leave aliases.

- [ ] **Step 6: Delete static previews and update provenance**

Delete all 17 `frontend/public/builtin-style-previews/*.webp` files only after Task 6. Preserve the six product copies and the existing signed component copies. Rewrite provenance to point to durable signed source assets and retain historical checksums without a runtime dependency on deleted paths.

- [ ] **Step 7: Remove or rewrite legacy tests/fixtures/docs**

Repository-search `BUILT_IN_STYLES`, `builtin-style-previews`, `builtin-`, `usingFallback`, and `mergeWithLegacyRecovery`. Remove visual-style compatibility assertions, rewrite signed-source goldens to compare signed sources or explicit contracts, and update contributor instructions to the registry/component lane.

- [ ] **Step 8: Pass focused gates and commit**

Run:

```bash
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/production-looks.test.mjs
npm run test:backend
npm run test:frontend
npm run lint
npm run typecheck
npm run check:security
npm run check:model-drift
git diff --check
```

Expected: all pass; repository search finds no production/test/fixture runtime dependency on built-in visual styles.

Commit:

```bash
git add -A
git commit -m "refactor(styles): use signed Content Store catalog only"
```

---

### Task 8: Release integrity, rendered verification, and final review

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Test: release checks and rendered Story Studio picker flow

**Interfaces:**
- Consumes: reviewed Tasks 1–7.
- Produces: release-ready branch and evidence; no merge/push/deploy/publish without separate authority.

- [ ] **Step 1: Increase the patch version in both manifests**

Use the next patch version after the branch is rebased onto the final integration target. Add the matching newest-first changelog entry describing six standalone Production Looks and signed-only visual-style selection.

- [ ] **Step 2: Run release and production builds**

Run:

```bash
npm run check:changelog
npm run check:typography
npm run check:security
npm run check:model-drift
npm run check:release
npm run build:frontend
npm run build:electron
npm run check:security -- --built
npm run check:release -- --built
```

- [ ] **Step 3: Inspect the rendered application**

Open Story Studio and verify Character Sheet, Thumbnail Prompts, Settings, and Scene Plan all show the same signed catalog; the six products appear once; Hand-Drawn Hardship appears; no card says built-in; search/filter/selection/persistence work; an API failure shows an honest unavailable state; and no static style appears after failure.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
npm run verify
git diff --check
git status --short
```

- [ ] **Step 5: Obtain final independent whole-branch review**

Review the complete merge-base-to-HEAD diff for spec compliance, data loss outside the authorized visual-style boundary, registry integrity, archive reproducibility, UI correctness, legacy removal completeness, security, and release integrity. Fix every Critical/Important finding and run one scoped re-review.

- [ ] **Step 6: Present the branch for integration**

Use `superpowers:finishing-a-development-branch`. Do not merge, push, tag, build a public DMG, deploy, or publish from this plan without the owner's explicit authority for that external action.
