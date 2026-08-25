# Pre-Soak Product Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the four pending Claude handoffs without weakening paid-work safety, then ship one verified Story Studio release ready for tomorrow's production soak.

**Architecture:** Extend existing boundaries instead of adding parallel systems: cancellation remains queue-owned and provider-authoritative; account capacity continues through the existing admission snapshot; Research becomes optional by deleting its completion gate; Motion carries an exact published variant through the existing scene-clip request; retired formats collapse at the existing effective-format boundary. GenStudio remains the sole source of model, price, capacity, tier, and cancellation facts.

**Tech Stack:** Electron/Express TypeScript backend, Nuxt/Vue frontend, Node test runner, existing GenStudio REST contracts, local file-based handoffs.

## Global Constraints

- Work on branch `codex/pre-soak-product-alignment` in `.worktrees/pre-soak-product-alignment`; preserve clean `main`.
- Use TDD for every behavior change: record a focused RED before production edits, then GREEN.
- Add no dependencies, provider routes, migrations, compatibility catalogues, or background services.
- Never print, persist, or transmit either newly issued API key; no generation or paid endpoint is called.
- Preserve Story Studio v1.0.822's queue-owned durable cancellation, duplicate locks, restart reconciliation, sibling settlement, and output auditors.
- GenStudio catalogue/account values are live authority. Never hardcode tier thresholds, prices, lane counts, burst multipliers, variants, providers, or capabilities.
- Continue dispatch admission from `paid_concurrency_limit`; `burst_concurrency_ceiling` is display-only.
- Research evidence and claim triage remain available and honest, but Research never gates script generation, pipeline execution, board completion, or episode completion.
- Contextual Cues and Sound Design count complete when disabled; when enabled they retain their current strict validation.
- Motion submits exactly the selected live published `(duration_seconds, resolution)` variant and revalidates it at execution.
- Preserve active B-Roll/Image Pool routes, assets, presets, and workflow vocabulary; retire only old Format IDs and `Format.visualSource` compatibility.
- Release as v1.0.823 with matching `package.json`, `package-lock.json`, newest-first `CHANGELOG.md`, full `npm run verify`, production audits, unsigned DMG, visual QA, and independent review before push.
- Keep pending handoffs truthful: do not trash a brief until its verification passes; never delete a handoff.

---

### Task 1: Align Cancellation Settlement Fields and Dispute the Stale Contract

**Files:**
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/__tests__/fixtures/mock-genstudio-service.ts`
- Modify: `electron/server/__tests__/genstudio-video-tts-transcription-hardening.test.ts`
- Modify: `frontend/pages/projects/[slug]/jobs.vue`
- Modify: `frontend/__tests__/genStudioCreditRelease.test.ts`
- Create: `<owner-home>/Developer/_handoffs/2026-08-12_to-claude-genstudio_from-gpt-storystudio_cancel-contract-source-verification.md`

**Interfaces:**
- Consumes: current `GenStudioJob`, cancellation parser, account snapshot settlement, Jobs settlement display.
- Produces: authoritative `released_credits` fallback and a zero-context contract-dispute brief; no cancellation-state-machine change.

- [ ] **Step 1: Write failing settlement tests**

Add behavior tests proving published Image/Video `released_credits` is preserved and displayed, while an omitted field produces no refund/release amount. The expected priority is:

```ts
const released = accountJob?.released_credits
  ?? remoteJob?.released_credits
  ?? remoteJob?.returned_credits
```

- [ ] **Step 2: Verify RED**

Run:

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/genStudioCreditRelease.test.ts
cd ../electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/genstudio-video-tts-transcription-hardening.test.ts \
  server/__tests__/job-cancellation-reconciliation.test.ts \
  server/__tests__/job-control.test.ts
```

Expected: new direct-release assertions fail because current types/comments/UI omit the published path.

- [ ] **Step 3: Implement the minimal contract correction**

Add optional `released_credits` where the concrete image/video response types need it, retain the generic strict parser, update stale comments, and use the priority above. Update the deterministic fixture to represent both present and absent optional fields. Do not alter routes, cancellation claims, retries, terminalization, or locks.

- [ ] **Step 4: Verify GREEN and write the reply brief**

Re-run Step 2. Write a concise reply that records: live 0.93.1 and source 0.94 expose TTS/Image/Transcription/Video cancel; provider cancellation is booleans plus ordinary job state; terminal repeat may be 200; Video supports post-dispatch request/reconciliation; Image/Video publish `released_credits`; Chat/Music have no cancel. Ask Claude whether implementation or its owner-semantics note will change. Leave the disputed incoming brief pending.

- [ ] **Step 5: Commit**

```bash
git add electron/server/lib/genstudio-client.ts electron/server/__tests__/fixtures/mock-genstudio-service.ts \
  electron/server/__tests__/genstudio-video-tts-transcription-hardening.test.ts \
  frontend/pages/projects/\[slug\]/jobs.vue frontend/__tests__/genStudioCreditRelease.test.ts
git commit -m "fix: align cancellation settlement fields"
```

---

### Task 2: Display GenStudio Standard Lanes, Temporary Boost, and Tier Progress

**Files:**
- Modify: `electron/server/lib/genstudio-client.ts`
- Modify: `electron/server/lib/genstudio-admission.ts`
- Modify: `electron/server/__tests__/genstudio-client-boundary.test.ts`
- Modify: `electron/server/__tests__/genstudio-admission.test.ts`
- Modify: `frontend/pages/projects/[slug]/jobs.vue`
- Modify: `frontend/__tests__/jobsControls.test.ts`

**Interfaces:**
- Consumes: `GET /v1/account/overview` through `getGenStudioAccountOverview()` and existing `/app-settings/genstudio/admission` response.
- Produces: optional display-only `burst_concurrency_ceiling` and `service_tier`; existing dispatch behavior unchanged.

- [ ] **Step 1: Write failing 0.93/0.94 boundary tests**

Cover: 0.93 payload omits new fields; valid 0.94 payload preserves them; malformed tier/ceiling is omitted; admission dispatch still uses `paid_concurrency_limit`; fallback contains no tier/boost metadata. Use the real published shape:

```ts
interface GenStudioServiceTierStanding {
  current: GenStudioServiceTier
  ladder: GenStudioServiceTier
  overridden: boolean
  lifetime_paid_cents: number
  next_tier: GenStudioServiceTier | null
  cents_to_next_tier: number | null
}
```

- [ ] **Step 2: Verify RED**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/genstudio-client-boundary.test.ts \
  server/__tests__/genstudio-admission.test.ts
cd ../frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/jobsControls.test.ts
```

Expected: new fields are dropped and the UI lacks conditional tier/boost copy.

- [ ] **Step 3: Extend the existing snapshot only**

Parse positive integer ceiling and the exact nested tier fields defensively. Pass optional fields through `normalizeCapacity`; do not add an endpoint. Keep:

```ts
const dispatchLimit = snapshot.paid_concurrency_limit
```

The Jobs hero renders `N active / L standard lanes`. It shows a temporary boost only when `active > standard` and a valid ceiling exists. It displays `current.display_name`; when both next tier and cents remain are valid, format cents as currency and say the next published lane/rate limits. It renders no tier/boost gap on 0.93.

- [ ] **Step 4: Verify GREEN, responsive behavior, and Impeccable detector**

Re-run Step 2. Inspect Project Jobs and All Jobs at desktop and 320–390px using stubbed 0.93, 0.94 baseline, and 0.94 boosted responses. Then run once:

```bash
node <owner-home>/.codex/skills/impeccable/scripts/detect.mjs --json \
  'frontend/pages/projects/[slug]/jobs.vue'
```

- [ ] **Step 5: Commit**

```bash
git add electron/server/lib/genstudio-client.ts electron/server/lib/genstudio-admission.ts \
  electron/server/__tests__/genstudio-client-boundary.test.ts electron/server/__tests__/genstudio-admission.test.ts \
  frontend/pages/projects/\[slug\]/jobs.vue frontend/__tests__/jobsControls.test.ts
git commit -m "feat: show GenStudio capacity tiers"
```

---

### Task 3: Make Research Optional and Correct Disabled Optional-Feature Status

**Files:**
- Modify: `AGENTS.md`
- Modify: `electron/server/lib/research-verification.ts`
- Modify: `electron/server/services/asset-status.ts`
- Modify: `electron/server/services/project-manager.ts`
- Modify: `electron/server/routes/projects.ts`
- Modify: `electron/server/routes/pipeline.ts`
- Modify: `electron/server/routes/ideas.ts`
- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/contracts/index.ts`
- Modify: `electron/server/__tests__/research-verification.test.ts`
- Modify: `electron/server/__tests__/asset-status.test.ts`
- Modify: `frontend/pages/projects/[slug]/settings.vue`
- Modify: `frontend/pages/projects/[slug]/board.vue`
- Modify: `frontend/pages/projects/[slug]/research.vue`
- Modify: `frontend/components/EpisodeSelector.vue`
- Modify: `frontend/composables/useEpisodes.ts`
- Modify: `frontend/__tests__/researchWorkspace.test.ts`

**Interfaces:**
- Consumes: existing research evidence/triage helpers and project configs `contextual_cues` / `sound_design`.
- Produces: Research status as optional evidence only; disabled optional features report complete; enabled features retain strict artifact validation.

- [ ] **Step 1: Write failing owner-ruling tests**

Add tests proving: new and existing project metadata no longer exposes a Research requirement; absent/untriaged/all-ignored Research cannot block `all_done`, script, or Pipeline; Research page still shows evidence/triage honestly; disabled cues/sound design return `true` even with no sidecar; enabled variants require a valid resolved sidecar.

- [ ] **Step 2: Verify RED**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/research-verification.test.ts \
  server/__tests__/asset-status.test.ts \
  server/__tests__/contextual-cues.test.ts \
  server/__tests__/sound-design.test.ts
cd ../frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/researchWorkspace.test.ts
```

Expected: current `research_required` tests and missing-sidecar optional status fail the new contract.

- [ ] **Step 3: Delete the hard gate and reuse existing config normalizers**

Remove the setting, contract field, default stamp, project update path, board-required copy, downstream gate/warning, and `research_required` status. Keep evidence detection, claim decisions, source safety, and pipeline auto-triage when Research is explicitly selected. In `computeEpisodeStatus()`, read project config once and set:

```ts
status.contextual_cues = !cueConfig.enabled || validResolvedCueTimeline
status.sound_design = !soundConfig.enabled || validResolvedSoundTimeline
```

Use `normalizeContextualCueConfig()` and `normalizeSoundDesignConfig()`; do not duplicate configuration rules.

- [ ] **Step 4: Update project instructions and verify GREEN**

Replace AGENTS' “Gated Research” section with the newer owner ruling: Research is optional, triage remains honest, no downstream completion/generation gate. Re-run Step 2, typecheck both projects, and grep to ensure production code contains no `research_required` or `resolveResearchRequired` consumer.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md electron frontend
git commit -m "fix: make research and optional stages honest"
```

---

### Task 4: Let Customers Select an Exact Published Motion Variant

**Files:**
- Modify: `frontend/pages/projects/[slug]/motion-review.vue`
- Modify: `electron/server/routes/scene-review.ts`
- Modify: `electron/server/generators/scene-clip.ts`
- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/__tests__/genstudio-capacity-and-variants.test.ts`
- Modify: relevant scene-clip/route integration test selected during RED setup
- Modify: relevant frontend Motion Review source-contract test, or create `frontend/__tests__/motionReview.test.ts`

**Interfaces:**
- Consumes: selected GenStudio video model's live `variants[]`.
- Produces: queued `duration_seconds` and `resolution`, revalidated against the selected model's current live catalogue at execution.

- [ ] **Step 1: Write failing selection and stale-catalog tests**

Cover: UI lists every published variant with exact credits/minimum/price; cheapest is initial default only; model change clamps selection; route persists exact values; generator accepts an exact current variant; removed/unpublished combination fails before provider POST; old jobs lacking a variant use the current cheapest published option for safe retry compatibility.

- [ ] **Step 2: Verify RED**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/genstudio-capacity-and-variants.test.ts \
  server/__tests__/generation-control-wiring.test.ts
cd ../frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/motionReview.test.ts
```

Expected: route/generator ignore requested variant and UI exposes only cheapest.

- [ ] **Step 3: Add one native selector and exact boundary validation**

Store selection as `{ duration_seconds, resolution }`, derived from current selected model. Render a standard `<select>` beside the model picker with human-readable published price. Send both fields on one, missing, and batch routes. Extend `requireSceneClipGenStudioModel(selectedModel, requestedVariant?)` to find an exact published match; use cheapest only when the request omits a variant. Persist both in job params so Retry is deterministic, then revalidate live before submit.

- [ ] **Step 4: Verify GREEN and bounded visual QA**

Re-run Step 2 and typechecks. Inspect Motion Review at desktop and 320–390px for focus, overflow, disabled/no-variant state, and model-switch clamping. Run the Impeccable detector once on `motion-review.vue`.

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/projects/\[slug\]/motion-review.vue frontend/__tests__/motionReview.test.ts \
  electron/server/routes/scene-review.ts electron/server/generators/scene-clip.ts \
  electron/server/models/types.ts electron/server/__tests__/genstudio-capacity-and-variants.test.ts \
  electron/server/__tests__/generation-control-wiring.test.ts
git commit -m "feat: select published motion variants"
```

---

### Task 5: Purge Retired Format-Contract Vocabulary Safely

**Files:**
- Modify: `electron/server/services/format-loader.ts`
- Modify: `electron/server/__tests__/format-loader.test.ts`
- Modify: `electron/server/models/types.ts`
- Modify: `frontend/composables/useFormats.ts`
- Modify: `frontend/composables/useProjectFlow.ts`
- Modify: `frontend/__tests__/useProjectFlow.test.ts`
- Modify: `electron/server/__tests__/pipeline-step-skip.test.ts`
- Modify: `frontend/composables/useSectionLabel.ts`
- Modify: `frontend/composables/useVideoAssemblyIo.ts`
- Modify: `frontend/components/PromptReviewPanel.vue`
- Move: `docs/format-niche-refactor-plan.md` → `_trash/format-niche-refactor-plan.md`

**Interfaces:**
- Consumes: existing `getEffectiveFormat()` and frontend flow normalization.
- Produces: only `timestamp-driven`, `continuity-chain`, and `narrated-scenes` as live `visualSource`; active media routes preserved.

- [ ] **Step 1: Write failing collapse/allowlist tests**

Replace remap-table expectations with: arbitrary/retired IDs resolve to `continuity-chain`; the two observed saved IDs (`stock-footage`, `scenes`) resolve to continuity without data mutation; only the three live visual sources pass; a `format_overrides.visualSource: 'broll'` fixture collapses to continuity/sentence. Keep retired literals only in fixture evidence.

- [ ] **Step 2: Verify RED**

```bash
cd electron
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit \
  server/__tests__/format-loader.test.ts server/__tests__/pipeline-step-skip.test.ts
cd ../frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/useProjectFlow.test.ts
```

- [ ] **Step 3: Delete tables and enforce the live-value boundary**

Delete both unused `RETIRED_FORMAT_IDS`, backend `LEGACY_FORMAT_REMAP`, and enumerated retired visual-source cases. `canonicalFormatId()` returns the single engine. At the effective-format boundary, allow only the three live values and otherwise use `continuity-chain` plus `sentence`. Preserve all B-Roll/Image Pool route, asset, preset, and workflow code.

- [ ] **Step 4: Retire stale documentation and verify saved-project fate**

Move the old plan to `_trash` with a one-line superseded header. Update only stale format-contract comments. Re-run Step 2 and typechecks. With a zero-cost local Story server, GET both saved projects' effective format and confirm continuity/continuity-chain/sentence without rewriting their project files.

- [ ] **Step 5: Commit**

```bash
git add electron frontend _trash docs AGENTS.md
git commit -m "refactor: retire legacy format contracts"
```

---

### Task 6: Release v1.0.823, Close Handoffs, and Prove Soak Readiness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Move completed incoming briefs to `<owner-home>/Developer/_handoffs/_handoff-trash/` only after their verification passes.

**Interfaces:**
- Consumes: reviewed commits from Tasks 1–5.
- Produces: one clean local release commit and verified unsigned DMG; integration follows the finishing-branch choice presented to the owner.

- [ ] **Step 1: Independent whole-branch review**

Review the complete branch against all five incoming handoffs and Global Constraints. Fix every Critical/Important issue through one reviewed fix wave. Confirm no secret, hardcoded GenStudio tier/model value, new dependency, paid call, or weakened safeguard.

- [ ] **Step 2: Set release metadata**

Set both manifests to `1.0.823` and add newest-first changelog bullets covering cancellation settlement truth, capacity/tier display, optional Research/status, selectable motion variants, and retired format cleanup.

- [ ] **Step 3: Run fresh release gates**

```bash
npm run check:changelog
npm run check:release
npm run verify
npm audit --omit=dev
npm --prefix frontend audit --omit=dev
npm run dist:smoke
npm run verify:artifact
```

Record test counts, lint errors/warnings, audit totals, artifact path/bytes/SHA-256/signature/mount result. No completion claim is made from an earlier run.

- [ ] **Step 4: Bounded visual QA**

Launch the packaged app without generation. Verify Jobs 0.93 fallback and stubbed 0.94 tier/boost states, Motion variant selector, Research optional copy, disabled optional statuses, and both legacy projects. Test desktop and 320–390px once, apply one batched correction if needed, then confirm once.

- [ ] **Step 5: Commit, present integration options, and close handoffs truthfully**

Commit release metadata, then use the finishing-development-branch workflow to present local merge, PR, or keep-branch options. Move only verified incoming briefs to `_handoff-trash`; leave the disputed cancellation brief pending until Claude resolves it and leave the soak-key brief pending until the new key passes Test scopes/catalog/usage checks. Keep the soak paused.
