# Codex Notes

## Mandatory Release Integrity

- Every shipped Story Studio change—including fixes, reliability work, UI/API
  behavior, dependency updates, and workflow changes—must increase the version
  in both `package.json` and `package-lock.json` in the same change set.
- Add the matching newest-first `## vX.Y.Z` entry to `CHANGELOG.md`; this is the
  source shown by the in-app **What's New** experience.
- Run `npm run check:changelog` before finalizing. A release is incomplete if
  the runtime version, newest changelog entry, and What's New details differ.

## Built-In Visual Style Workflow

- When a user provides visual references and asks to add a reusable style, use the `story-studio-add-visual-style` skill.
- `frontend/composables/useBuiltInStyles.ts` is the single source of truth. Do not duplicate built-in style lists in Character Sheet, Settings, Image Prompts, or gallery components.
- Every built-in style needs a unique id, searchable metadata, a render-ready style bible, a negative prompt, and a generated 1672x941 WebP preview in `frontend/public/builtin-style-previews/`.
- Generate an original preview from the supplied references. Do not copy their composition or depend on generated captions; exact wording belongs in Story Studio's text-overlay pipeline.
- Update `frontend/__tests__/builtInStyles.test.ts` and verify the shared catalog consumers rather than wiring the style separately into each page.

## Scene vs Thumbnail Split

Scene prompts, thumbnail prompts, scene image generation, and thumbnail image generation are separate surfaces. Do not collapse them back into the old unified image prompt/image generator model.

- Thumbnail prompt presets use `thumbnail_prompts_presets` and `thumbnail_prompts_last_preset`.
- Scene prompt presets use `scene_prompts_presets` and `scene_prompts_last_preset`.
- Thumbnail generator presets use `thumbnail_generator_presets` and `thumbnail_generator_last_preset`.
- Scene generator presets use `scene_generator_presets` and `scene_generator_last_preset`.
- `image_prompts_*` and `image_generator_*` are legacy compatibility keys only. They should not be the primary keys for new thumbnail/scene UI or Pipeline selectors.
- The Pipeline batch step named `image_prompts` must use the active format to choose prompt mode. Classic chapter-distributed scene-image formats may run `mode: "all"`; B-Roll, timestamp-driven, continuity-chain, and narrated-scenes formats must run thumbnail prompts only (`mode: "thumbnails"`) because scene prompts come from Scene Plan.

## Video Assembly Preset Boundaries

- `title_image.image_path` is episode-specific. Timeline presets and all-steps bundle fallbacks must never save or restore it.
- Reusable title-image settings such as enabled state, duration, transition type, and transition duration may remain in presets.

## Generator Model Defaults

- Generator model pickers must restore the user's last explicit choice before they mount. Do not hardcode a paid model such as GPT-4o as the form default.
- If the remembered model is no longer available, let the live model inventory choose a usable fallback and persist that healed choice.

## Video Model Boundary

- Story Studio video generation is image-to-video only. Do not restore text-to-video modes, models, UI controls, preset values, or fallback behavior.
- Sora 2 and Runway Gen-3 are retired from the built-in catalog.
- New provider/model discovery will eventually come from `videostudio-mac`. That integration is deferred until Video Studio exposes a stable provider inventory and dispatch API; do not half-wire or duplicate new provider catalogs in Story Studio meanwhile.
- Every video request must use the exact scene image for its stable scene number. Missing images are blocking errors, never permission to reuse a different scene image.

## Model Inventory Ownership

- The Settings Models tab may edit built-in pricing and operational limits only. Do not restore the retired Add Custom Model form, project-level `models` catalog, `is_custom` entries, or unified catalog write path.
- Model/provider inventory belongs to the studio applications and Studio Hub. Future Video Studio integration must discover and dispatch its live catalog there rather than duplicating provider setup inside Story Studio.

## Verified Completion Contract

Every generation flow must prove its output is complete before a job, pipeline step, Production Board cell, or one-click run may report success.

- A generator returning without throwing is not evidence of completion. Audit the authoritative files, manifests, expected item IDs, and usable content after generation.
- Preserve valid partial outputs, but fail the overall job loudly when any required item is missing, empty, stale, malformed, or failed at its provider.
- Error messages must name the missing or invalid items and tell the user how Retry/self-healing will repair them without repeating completed work.
- Completion checks must compare expected versus present artifacts. Never use directory existence, one matching file, a stale derivative, a legacy fallback, or `progress = 100` as proof of completion.
- The generator, Job Queue, Pipeline, Production Board, pending filters, and downstream gates must use the same authoritative completion rule.
- Optional steps may be skipped only through explicit project configuration. A skipped optional step is not missing; a required step with partial output is never done.
- New generators and material changes to existing generators require regression tests for complete, partial, empty, stale, malformed, provider-failure, and retry/self-healing outcomes.
- When auditing or changing generation code, search for swallowed per-item errors, warning-only failures, unconditional `progress = 100`, and queue executors that return after partial work.

## Gated Research and Retired Co-writer

This section replaces the former "Research is an opt-in enrichment step" rule. Evidence-led channels (science, history) need claims someone actually read and chose, so research is now gated per project and carries a review state. Do not revert to the old unconditional rule.

- Research is gated by the per-project setting `research_required` in `project.json`. Resolve it ONLY through `resolveResearchRequired()` in `electron/server/lib/research-verification.ts`. The default resolution is explicit, not incidental: `true` is on, `false` is off, and an ABSENT field means the project predates the gate and resolves OFF. `createProject` stamps `research_required: true` on every new project, which is what makes "absent means legacy" safe — existing finished episodes never retroactively become incomplete.
- There is exactly ONE research decision, and it is per claim: `Verified` (keep) or `Ignore` (drop), with `Verify all` / `Reset` / `Ignore all` as bulk actions. The research-level state is DERIVED from those claim statuses — research is reviewed when there is at least one claim and none is left `unreviewed`, and usable when at least one claim was kept. Do not add a second, research-level attestation on top of it; v1.0.760 shipped one and v1.0.761 removed it as a redundant decision.
- Generating research does NOT complete it. Generating or regenerating always resets every claim to `unreviewed` and drops the review record (`withResearchUntriaged()`), because nobody has read the new claims.
- When `research_required` is ON, research counts as complete only when the sidecar holds real evidence AND every claim has been triaged AND at least one claim was kept. It then counts as a Production Board asset and blocks episode completion. When the gate is OFF, behaviour is exactly as it was before: optional enrichment that never blocks anything and is never folded into `all_done`.
- Reviewed-but-nothing-kept ("I ignored every claim") is a legitimate editorial outcome, not an error and not a pending state. It reports `research_reviewed: true` with `research_has_usable_claims: false`, is surfaced in those words on the Research page, in the episode selector and in `describeResearchGap()`, and does NOT satisfy the completion gate — the gate exists to guarantee the script has evidence, and an all-ignored sidecar hands it none. Research with zero claims is likewise never complete.
- `isResearchComplete()` in `lib/research-verification.ts` is the single authoritative rule, per the Verified Completion Contract. The generator, Job Queue, Pipeline, Production Board, Research pending filter, and downstream gates must all use it. Never re-derive completion from directory existence, sidecar presence, a raw claim count, or a stored "verified" flag.
- Research whose claims still need a decision must remain visible in the Research pending filter, and the per-claim decisions must stay reversible (a claim can go back to `unreviewed`, and re-running research resets everything).
- No wording anywhere — UI, job log, `research.md`, error message — may say the user or the app checked claims against the cited sources. The shipping adapter is `llm-only` (`services/research/genstudio.ts`), is explicitly told it has no live web access, is instructed not to fabricate URLs, and typically returns zero citations. Say what actually happened: a person reviewed model-generated claims and chose which ones the script may use. Where a claim carries no citation, show that absence.
- Research remains opt-in as a one-click Pipeline STAGE (it is not selected by default). When it does run in a Pipeline batch, the claim review is machine-completed so an unattended run is never blocked — every still-pending claim is accepted and the sidecar records `review.completed_by: 'pipeline-auto'`, never `'human'`. That must stay distinguishable from a person's review in the sidecar, the Research page, and the episode selector. Pipeline preflight also completes the review of existing evidence rather than paying to regenerate it, and never overwrites a triage a human already finished — including a deliberate all-ignored one.
- Error and warning messages about research must name what is missing and how to fix it (`describeResearchGap()`), per the Verified Completion Contract.
- The Co-writer feature is retired. Do not restore its page, navigation entry, API routes, local-storage stores, or completion dependencies. Idea development belongs in Ideas, Research, and Script Generator workflows.

## Retired Brand System

- The shared Brand profile system is retired. Do not restore `/brands`, `brand_id`, Brand API routes, Brand storage, or Brand-level prompt, voice, logo, pronunciation, art-style, metadata, or format overrides.
- Independent project controls remain valid, including title prefix/suffix branding, branded intro visuals, project art styles, and Video Assembly logo and presentation controls.
