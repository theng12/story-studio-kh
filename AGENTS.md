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

This section replaces the former "Research is an opt-in enrichment step" rule. Evidence-led channels (science, history) need claims someone actually checked, so research is now gated per project and carries a verification state. Do not revert to the old unconditional rule.

- Research is gated by the per-project setting `research_required` in `project.json`. Resolve it ONLY through `resolveResearchRequired()` in `electron/server/lib/research-verification.ts`. The default resolution is explicit, not incidental: `true` is on, `false` is off, and an ABSENT field means the project predates the gate and resolves OFF. `createProject` stamps `research_required: true` on every new project, which is what makes "absent means legacy" safe — existing finished episodes never retroactively become incomplete.
- Generating research does NOT complete it. A generated sidecar enters an explicit unverified state persisted as `verification` inside `{code} - 11 Research/research.json`. Generating or regenerating always resets it to `{ verified: false }`, because new claims have never been reviewed.
- When `research_required` is ON, research counts as complete only when the sidecar holds real evidence AND that evidence is verified. It then counts as a Production Board asset and blocks episode completion. When the gate is OFF, behaviour is exactly as it was before: optional enrichment that never blocks anything and is never folded into `all_done`.
- `isResearchComplete()` in `lib/research-verification.ts` is the single authoritative rule, per the Verified Completion Contract. The generator, Job Queue, Pipeline, Production Board, Research pending filter, and downstream gates must all use it. Never re-derive completion from directory existence, sidecar presence, or a claim count.
- Unverified research must remain visible in the Research pending filter with a Verify action, and verification must be reversible so a regenerated or disputed sidecar can be un-verified.
- Research remains opt-in as a one-click Pipeline STAGE (it is not selected by default). When it does run in a Pipeline batch, verification is applied automatically so an unattended run is never blocked — recorded as `verified_by: 'pipeline-auto'`, never as `'human'`. Auto-verification must stay distinguishable from a human attestation in the sidecar, the Research page, and the episode selector. Pipeline preflight also auto-verifies existing unverified evidence rather than paying to regenerate it.
- Error and warning messages about research must name what is missing and how to fix it (`describeResearchGap()`), per the Verified Completion Contract.
- The Co-writer feature is retired. Do not restore its page, navigation entry, API routes, local-storage stores, or completion dependencies. Idea development belongs in Ideas, Research, and Script Generator workflows.

## Retired Brand System

- The shared Brand profile system is retired. Do not restore `/brands`, `brand_id`, Brand API routes, Brand storage, or Brand-level prompt, voice, logo, pronunciation, art-style, metadata, or format overrides.
- Independent project controls remain valid, including title prefix/suffix branding, branded intro visuals, project art styles, and Video Assembly logo and presentation controls.
