# Story Model Cost Tier Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Story Studio model picker consume GenStudio's published Economy/Balanced/Premium classification while remaining completely flat and backward-compatible until a presented catalog is fully classified.

**Architecture:** The Electron GenStudio boundary validates and preserves one optional compatibility field for all six model catalogs. A pure frontend tier policy owns validation, tab/filter behavior, and safe Economy-only empty selection; the existing shared `ModelMenu` renders the tabs once for every modality. Existing provider, price, capability, availability, and dispatch behavior stays in each current catalog adapter.

**Tech Stack:** TypeScript, Vue 3/Nuxt, Electron/Express, Node test runner, existing `PickerDialog` and `ModelMenu` components.

## Global Constraints

- Valid catalog values are exactly `economy`, `balanced`, and `premium`.
- GenStudio is the only authority; Story never derives tier from price, provider, ID, name, sale status, or workflow.
- Apply the behavior to Language, Image, Video, Music, TTS, and Transcription catalog types. Music has no customer generation picker today; do not invent one.
- A picker is tiered only when every supplied row has a valid tier. Otherwise it retains the entire current flat presentation and legacy selection behavior.
- A tiered empty selector may auto-select only an available Economy model. With no available Economy row it stays empty; it never silently chooses Balanced or Premium.
- A valid explicit selection wins. A named unavailable or vanished model is not replaced. Explicit owner-published legacy aliases remain the only silent migration.
- Empty search respects the active tab. Non-empty search covers all tiers and labels every result with its published tier.
- Saved selections reopen their own tier. New/empty selectors open Economy.
- Provider headings, provider labels, exact live prices, capabilities, ordering within each tier, keyboard behavior, modal focus behavior, and availability states remain intact.
- Tier metadata is display/navigation only and never enters a generation request.
- No new dependency, no duplicated modality-specific tab implementation, and no coupling to the separate idea-originality workstream.
- Every production change follows RED → GREEN TDD and the Story release must bump `package.json`, `package-lock.json`, and newest-first `CHANGELOG.md` together.

---

### Task 1: Preserve the six catalog tiers at the Story backend boundary

**Files:**
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/routes/health.ts`
- Modify: `electron/server/routes/research.ts`
- Modify: `electron/server/routes/vision.ts`
- Test: `electron/server/__tests__/genstudio-client-boundary.test.ts`
- Test: `electron/server/__tests__/genstudio-voices-route.test.ts`

**Interfaces:**
- Produces: `export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'`.
- Produces: optional `cost_tier?: GenStudioCostTier` on `GenStudioChatModel`, `GenStudioImageModel`, `GenStudioVideoModel`, `GenStudioMusicModel`, the TTS model type returned by `listTtsModels`, and `GenStudioTranscriptionModel`.
- Produces: exact optional pass-through on `/models`, Research web-model, thumbnail/reference-vision, and `/app-settings/genstudio/*-models` responses.
- Consumes: raw GenStudio JSON only. Invalid strings are treated as absent for compatibility; no normalization or fallback is allowed.

- [ ] **Step 1: Write failing boundary tests for the six modalities**

  Extend the real mock catalog responses so each model carries a literal tier, then assert the Story result keeps that exact value beside existing price/provider fields:

  ```ts
  assert.equal(chatModels[0]?.cost_tier, 'economy')
  assert.equal(imageModels[0]?.cost_tier, 'balanced')
  assert.equal(videoModels[0]?.cost_tier, 'premium')
  assert.equal(ttsModels[0]?.cost_tier, 'economy')
  assert.equal(transcriptionModels[0]?.cost_tier, 'balanced')
  assert.equal(musicModels[0]?.cost_tier, 'premium')
  ```

  Include one malformed row with `cost_tier: 'cheap'` and assert the result omits the field without dropping the otherwise valid row. Assert representative provider, `price_version`, and price fields are unchanged so the new parser cannot accidentally replace catalog truth.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run:

  ```bash
  STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
    electron/server/__tests__/genstudio-client-boundary.test.ts \
    electron/server/__tests__/genstudio-voices-route.test.ts
  ```

  Expected: failures because the six parsed responses and narrow route mappings do not yet expose `cost_tier`.

- [ ] **Step 3: Add the smallest shared validator and interface fields**

  Define once near the catalog interfaces:

  ```ts
  export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'

  function parseGenStudioCostTier(value: unknown): GenStudioCostTier | undefined {
    return value === 'economy' || value === 'balanced' || value === 'premium'
      ? value
      : undefined
  }
  ```

  Call it from each existing catalog row parser. Add `cost_tier` to mappings that currently construct narrower Language rows. Do not add it to request types or generation payload builders.

- [ ] **Step 4: Run focused tests and Electron typecheck for GREEN**

  Run:

  ```bash
  STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
    electron/server/__tests__/genstudio-client-boundary.test.ts \
    electron/server/__tests__/genstudio-voices-route.test.ts
  npm run typecheck:electron
  git diff --check
  ```

  Expected: all focused tests pass; typecheck and diff check exit 0.

- [ ] **Step 5: Commit Task 1**

  ```bash
  git add electron/server/lib/genstudio-client.ts electron/server/routes/health.ts \
    electron/server/routes/research.ts electron/server/routes/vision.ts \
    electron/server/__tests__/genstudio-client-boundary.test.ts \
    electron/server/__tests__/genstudio-voices-route.test.ts
  git commit -m "feat: preserve GenStudio model cost tiers"
  ```

---

### Task 2: Add one pure tier policy and shared accessible tabs

**Files:**
- Create: `frontend/utils/genstudio-cost-tier.ts`
- Modify: `frontend/components/ModelMenu.vue`
- Test: `frontend/__tests__/genStudioCostTier.test.ts`
- Test: `frontend/__tests__/modelMenus.test.ts`
- Test: `frontend/__tests__/pickerDialogFocus.test.ts`

**Interfaces:**
- Consumes: menu rows with optional `costTier?: GenStudioCostTier`.
- Produces: `GENSTUDIO_COST_TIERS`, `isCompleteTierCatalog`, `tierForOpening`, and `visibleTierOptions` pure helpers.
- Produces: shared `ModelMenuOption.costTier?: GenStudioCostTier`.
- Produces: one tablist with three tabs only for a fully classified option list.

- [ ] **Step 1: Write failing pure behavior tests**

  Add literal fixtures covering:

  ```ts
  const complete = [
    { id: 'fast', costTier: 'economy' as const },
    { id: 'steady', costTier: 'balanced' as const },
    { id: 'flagship', costTier: 'premium' as const },
  ]
  ```

  Assert:

  - complete rows enable tier mode;
  - one missing or invalid tier disables tier mode for the entire list;
  - empty/new opens `economy`;
  - saved `balanced` and `premium` rows open their own tier;
  - an empty query returns only the active tier;
  - a non-empty query searches all tiers;
  - every cross-tier result retains its tier label.

  Add source/DOM contract assertions that the shared menu owns `role="tablist"`, `role="tab"`, `aria-selected`, linked `tabpanel`, and Left/Right/Home/End handling. Name the production mutation each assertion catches in the test comments.

- [ ] **Step 2: Run the frontend tests and verify RED**

  Run:

  ```bash
  npm --prefix frontend exec -- tsx --import ./__tests__/setup.ts --test \
    __tests__/genStudioCostTier.test.ts \
    __tests__/modelMenus.test.ts \
    __tests__/pickerDialogFocus.test.ts
  ```

  Expected: module-not-found and missing-tab failures.

- [ ] **Step 3: Implement the pure policy**

  Use this public shape:

  ```ts
  export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'

  export const GENSTUDIO_COST_TIERS = [
    { id: 'economy', label: 'Economy', description: 'Routine volume and low credit use' },
    { id: 'balanced', label: 'Balanced', description: 'Moderate cost with greater capability' },
    { id: 'premium', label: 'Premium', description: 'Expensive; choose intentionally' },
  ] as const

  export function isCompleteTierCatalog(options: readonly { costTier?: string }[]): boolean
  export function tierForOpening(
    selectedId: string,
    options: readonly { id: string; costTier?: GenStudioCostTier }[],
  ): GenStudioCostTier
  export function visibleTierOptions<T extends { costTier?: GenStudioCostTier }>(
    options: readonly T[],
    activeTier: GenStudioCostTier,
    searching: boolean,
  ): T[]
  ```

  `isCompleteTierCatalog([])` returns false. `tierForOpening` returns the selected row's valid tier or `economy`. `visibleTierOptions` returns the whole list when searching or tier mode is incomplete; otherwise it filters by the active tier without reordering.

- [ ] **Step 4: Render tabs centrally in `ModelMenu`**

  Add `costTier` to the option interface and include it in the search haystack through its display label. On open, reset the active tier with `tierForOpening(props.modelValue, props.options)`. Render the tablist below search and above the list only when `isCompleteTierCatalog(props.options)` is true.

  Empty query uses the active tier. Any non-whitespace query ignores the active tier and shows all matching rows; add a visible tier badge to each search result. Provider grouping remains the inner grouping for whatever rows are visible.

  Implement tab keyboard handling with real buttons:

  ```ts
  if (event.key === 'ArrowRight') moveTier(1)
  else if (event.key === 'ArrowLeft') moveTier(-1)
  else if (event.key === 'Home') setTier('economy')
  else if (event.key === 'End') setTier('premium')
  ```

  Do not alter existing search focus, list-row arrow keys, Escape handling, or focus restoration.

- [ ] **Step 5: Run frontend tests and typecheck for GREEN**

  Run:

  ```bash
  npm --prefix frontend exec -- tsx --import ./__tests__/setup.ts --test \
    __tests__/genStudioCostTier.test.ts \
    __tests__/modelMenus.test.ts \
    __tests__/pickerDialogFocus.test.ts
  npm --prefix frontend run typecheck
  git diff --check
  ```

  Expected: all focused tests pass; typecheck and diff check exit 0.

- [ ] **Step 6: Commit Task 2**

  ```bash
  git add frontend/utils/genstudio-cost-tier.ts frontend/components/ModelMenu.vue \
    frontend/__tests__/genStudioCostTier.test.ts frontend/__tests__/modelMenus.test.ts \
    frontend/__tests__/pickerDialogFocus.test.ts
  git commit -m "feat: browse models by published cost tier"
  ```

---

### Task 3: Wire every catalog and enforce Economy-only empty selection

**Files:**
- Modify: `frontend/utils/live-genstudio-model-selection.ts`
- Modify: `frontend/components/ModelSelector.vue`
- Modify: `frontend/components/ImageModelPicker.vue`
- Modify: `frontend/composables/useGenStudioImageModels.ts`
- Modify: `frontend/composables/useGenStudioMediaModels.ts`
- Modify: `frontend/composables/useGenStudioVoices.ts`
- Modify: `frontend/composables/useGenStudioTranscription.ts`
- Modify: `frontend/pages/projects/[slug]/audio.vue`
- Modify: `frontend/pages/projects/[slug]/motion-review.vue`
- Modify: `frontend/pages/projects/[slug]/research.vue`
- Modify: `frontend/pages/projects/[slug]/image-prompts.vue`
- Modify: `frontend/components/GenStudioCatalogSettings.vue`
- Test: `frontend/__tests__/liveGenStudioModelSelection.test.ts`
- Test: `frontend/__tests__/modelMenus.test.ts`
- Test: `frontend/__tests__/motionReview.test.ts`

**Interfaces:**
- Consumes: optional `cost_tier` from Task 1 and `GenStudioCostTier`/`isCompleteTierCatalog` from Task 2.
- Produces: `costTier: model.cost_tier` on every customer-facing model menu option.
- Produces: Economy-only automatic initial selection for fully tiered catalogs; current first-usable fallback for legacy flat catalogs.
- Preserves: valid saved selection, owner-published alias migration, exact model ID in generation requests, and existing flat fallback behavior.

- [ ] **Step 1: Write failing selection and consumer tests**

  Extend `LiveGenStudioModel` fixtures with optional `cost_tier`. Assert these literals:

  ```ts
  assert.equal(selectLiveGenStudioModel('', fullyTiered)?.id, 'economy-model')
  assert.equal(selectLiveGenStudioModel('', tieredWithoutEconomy), null)
  assert.equal(selectLiveGenStudioModel('', legacyUntiered)?.id, 'first-live-model')
  assert.equal(selectLiveGenStudioModel('premium-model', fullyTiered)?.id, 'premium-model')
  ```

  Add consumer assertions that Language, Image, Video, TTS, Transcription, Research, and vision menus map `costTier: model.cost_tier`. Assert Music's diagnostic model type retains `cost_tier` without adding a Music generation control.

  Add a Motion Review regression where the saved model is absent and the first catalog row is Premium; assert the saved value is not replaced.

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  npm --prefix frontend exec -- tsx --import ./__tests__/setup.ts --test \
    __tests__/liveGenStudioModelSelection.test.ts \
    __tests__/modelMenus.test.ts \
    __tests__/motionReview.test.ts
  ```

  Expected: the helper still chooses the first live product and consumer options do not expose `costTier`.

- [ ] **Step 3: Extend the selection helper without changing legacy behavior**

  Add `cost_tier?: GenStudioCostTier` to `LiveGenStudioModel`. After exact and alias resolution, replace only the empty-preference return:

  ```ts
  if (saved) return null
  if (!isCompleteTierCatalog(models)) return models.find(usable) || null
  return models.find(model => model.cost_tier === 'economy' && usable(model)) || null
  ```

  Do not change explicit unavailable/vanished handling.

- [ ] **Step 4: Wire the six catalog types and all existing menu consumers**

  Add optional `cost_tier` to each frontend catalog interface and map it as `costTier`. Reuse `selectLiveGenStudioModel` or the same pure Economy-only helper in non-shared selection paths:

  - Language: `ModelSelector`, Research, thumbnail/reference vision.
  - Image: `ImageModelPicker` and shared image catalog type.
  - Video: Motion Review and media catalog type. Remove its first-available explicit fallback for named saved values.
  - TTS: Audio and both shared voice model interfaces. Preserve Audio's deliberate empty start unless the owning workflow already requires an initial selection.
  - Transcription: shared composable used by Subtitles and B-Roll. In a tiered catalog choose Economy only; in a legacy flat catalog keep the current first-available behavior.
  - Music: preserve the field in catalog diagnostics only; add no picker or generation flow.

  Do not change request bodies, model IDs, price/variant calculations, or capability watchers.

- [ ] **Step 5: Run focused and adjacent tests for GREEN**

  Run:

  ```bash
  npm --prefix frontend exec -- tsx --import ./__tests__/setup.ts --test \
    __tests__/genStudioCostTier.test.ts \
    __tests__/liveGenStudioModelSelection.test.ts \
    __tests__/modelMenus.test.ts \
    __tests__/motionReview.test.ts \
    __tests__/pickerDialogFocus.test.ts
  npm run typecheck
  git diff --check
  ```

  Expected: focused tests, Electron typecheck, frontend typecheck, and diff check all pass.

- [ ] **Step 6: Commit Task 3**

  ```bash
  git add frontend/utils/live-genstudio-model-selection.ts \
    frontend/components/ModelSelector.vue frontend/components/ImageModelPicker.vue \
    frontend/composables/useGenStudioImageModels.ts frontend/composables/useGenStudioMediaModels.ts \
    frontend/composables/useGenStudioVoices.ts frontend/composables/useGenStudioTranscription.ts \
    frontend/pages/projects/[slug]/audio.vue frontend/pages/projects/[slug]/motion-review.vue \
    frontend/pages/projects/[slug]/research.vue frontend/pages/projects/[slug]/image-prompts.vue \
    frontend/components/GenStudioCatalogSettings.vue \
    frontend/__tests__/liveGenStudioModelSelection.test.ts frontend/__tests__/modelMenus.test.ts \
    frontend/__tests__/motionReview.test.ts
  git commit -m "fix: keep model tier choices intentional"
  ```

---

### Task 4: Visual QA, release integrity, and artifact verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: completed tier parser, shared picker, and consumer wiring.
- Produces: one verified Story Studio release with version, lockfile, and changelog aligned.

- [ ] **Step 1: Run the Impeccable detector once over changed UI targets**

  Run:

  ```bash
  node <owner-home>/.codex/skills/impeccable/scripts/detect.mjs --json \
    frontend/components/ModelMenu.vue \
    frontend/components/ModelSelector.vue \
    frontend/components/ImageModelPicker.vue \
    frontend/pages/projects/[slug]/audio.vue \
    frontend/pages/projects/[slug]/motion-review.vue \
    frontend/pages/projects/[slug]/subtitles.vue
  ```

  Fix only findings introduced by this feature. Do not refactor incumbent surfaces outside the changed tier UI.

- [ ] **Step 2: Perform bounded visual and keyboard QA**

  Launch the normal development app without submitting any generation work. Inspect one Language picker and each available Image, Video, TTS, and Transcription picker at desktop and at a viewport no wider than 420 pixels.

  Verify in one pass:

  - all three tabs are reachable and at least 44 pixels tall;
  - long model names and provider labels do not overflow;
  - an empty tier has clear copy and leaves other tabs reachable;
  - saved Premium opens Premium;
  - search finds a model from another tier and visibly labels it;
  - Left/Right/Home/End navigate tabs;
  - Tab, Escape, focus trap, row arrows, and trigger focus restoration still work;
  - the list remains internally scrollable on desktop and narrow layouts.

  Apply at most one batched UI correction, rebuild, and confirm once.

- [ ] **Step 3: Bump Story Studio to v1.0.833 and write the newest-first changelog entry**

  Change `package.json` and `package-lock.json` from v1.0.832 to v1.0.833. Add a matching newest-first `## v1.0.833` changelog entry describing:

  - Economy/Balanced/Premium navigation from GenStudio's live catalog;
  - consistent treatment across all model modalities, including Transcription;
  - no silent escalation to a more expensive model;
  - flat backward-compatible presentation when GenStudio has not classified a complete picker.

- [ ] **Step 4: Run full source verification and audits**

  Run:

  ```bash
  npm run check:changelog
  npm run check:release
  npm run verify
  npm audit --omit=dev
  npm --prefix frontend audit --omit=dev
  git diff --check
  ```

  Expected: every command exits 0; both production audits report 0 vulnerabilities.

- [ ] **Step 5: Build and verify the unsigned artifact**

  Run the repository's current unsigned packaging smoke command from `package.json`, then its artifact verification command. Record the absolute artifact path, byte size, SHA-256, architecture, signature status, and read-only mount result in the task report. Do not sign, notarize, publish, tag, or push unless the owner separately authorizes it.

- [ ] **Step 6: Commit Task 4**

  ```bash
  git add package.json package-lock.json CHANGELOG.md
  git commit -m "release: v1.0.833"
  ```
