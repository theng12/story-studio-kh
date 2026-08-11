# Codex Notes

## Everything Follows the Selected Model — The First Rule

**Nothing about a model may be hardcoded, copied, or cached past the moment the selection
changes.** This is the owner's most important rule and it outranks convenience everywhere.

GenStudio publishes what each product can do. Story Studio reads it, live, and re-reads it
whenever the selection changes. It never guesses, never remembers a number that belongs to
the catalogue, and never infers capability from a product's name.

When the user changes model, ALL of these must recompute immediately — not on reload, not on
next launch:

- **Prompt character cap** (`max_prompt_characters`) and any warning derived from it
- **Context window and output allowance** (`context_window_tokens`, `max_output_tokens`),
  plus the available-input budget that falls out of them
- **Price and credit cost** — per image, per video variant, per 1,000 TTS characters, per
  second of transcription, per million chat tokens, plus promotions and `chargeable`
- **Reference-image support and counts** (`supports_reference_images`,
  `min_reference_images`, `max_reference_images`)
- **Aspect ratios, resolutions, durations, modes, voice tiers, languages** — every published
  option list
- **Capability flags** — `supports_seed`, `supports_vision`, `supports_web_search`,
  `structured_output_mode`, `controls[]`, and the rest

Concretely, this forbids:

- A constant, ladder, or option list that duplicates something GenStudio publishes. Generate
  the list from the catalogue.
- Persisting a limit into a draft, preset, or project config. Persist the SELECTION (model
  id, chosen allowance); resolve the limits fresh and re-clamp on load.
- A value computed once into component state and not recomputed when the model changes. If a
  model switch can invalidate it, it needs a watcher.
- Inventing a fallback when GenStudio publishes nothing. Show nothing, disable the control,
  or fail loudly — never a number the customer will mistake for the model's own.
- Converting a token budget into a character or word limit by a fixed ratio. Tokens and
  characters are different units; the ratio is not stable. Use the character figure GenStudio
  publishes.

And it requires: **a limit that is enforced must also be shown.** Silently refusing a request
because of a published limit the user was never told about turns a clear constraint into a
mystery error. Surface the figure at the point of choosing.

Past violations, all real and all costly: a Scene Plan output ladder capped at 32,768 against
a model publishing 128,000; a synthesised image config asserting `supports_reference_images:
false` for every model while silently dropping attached references and billing text-to-image;
an invented steps contract GenStudio never published; a 4,000-character prompt cap overruling
a published 4,800; a chunking threshold derived from a retired provider's 16,000-token cap.

## Provider Transparency — Superseding the Old Masking Rule

**Story Studio now shows which provider serves a model, wherever GenStudio publishes it.**
This reverses the earlier rule that treated provider and engine identity as private routing
detail to be stripped before it reached the customer. The owner's decision, 2026-08-01: the
product has moved from hiding providers to being transparent about them, across every
modality — not voice alone.

What that means concretely:

- Fields such as `provider`, `provider_id`, `provider_name`, `engine_id`, `engine_name`,
  `model_family` and `model_revision_id` are displayed when GenStudio publishes them, and are
  no longer deleted at the backend boundary.
- Provider-named catalogue endpoints are customer-facing surfaces. The voice libraries are
  browsable **by provider**, and named as such.
- **GenStudio remains the only authority on what is published.** Transparency means showing
  what the catalogue states — it does not mean inferring, deriving or guessing a provider from
  a model id, a name pattern, or anything else. If GenStudio does not publish the provider for
  a product, Story Studio shows no provider for it. An unpublished provider is unknown, never
  reconstructed.
- **Provider is display, never dispatch.** Story Studio still does not select, prefer, rank or
  route to a provider, and sends no provider field on any generation request. GenStudio owns
  provider selection entirely. Showing who served a request must never become a control for
  choosing who serves the next one.
- The first rule still governs: a displayed provider is read live from the catalogue on every
  selection change, never cached past it.

## Bugs The Gates Cannot See

**Every automated gate can be green while the app is visibly broken.** On 2026-08-01 three
real defects shipped or survived with backend, frontend, release, lint, typography, security
and model-drift all passing. Each was found in seconds by a person looking at the screen.

Know these three shapes, because they recur:

**1. Layout that overflows its container.** `VoiceLibraryBrowser`'s rows had no scroll
container, so a long list was clipped by the panel and the tail was unreachable (fixed
v1.0.774). Later the same class of bug at a different level: `ModelMenu` anchored its panel to
the trigger, so a field low in the window left no room and the list collapsed to two or three
visible rows (fixed v1.0.778 by making every picker a centred dialog). **No test can see
geometry.** Assertions about content passing say nothing about whether that content is
reachable.

**2. CSS that silently does nothing.** `Modal`'s scoped styles compiled to
`.modal-dialog[data-v-…]` (0,2,0), so any consumer writing a single class (0,1,0) lost without
warning. Of four competing consumers only one won cleanly: one lost outright, one won purely on
byte order in the bundle, and one used `:deep()` on a **teleported** dialog — which never
inherits the consumer's scope id, so that rule could never match at all (fixed v1.0.779).
**A CSS declaration that loses is indistinguishable from one that was never written.** When
styling seems not to apply, check specificity in the *built* CSS before assuming the value is
wrong — reasoning about scoped-style specificity from source is what produced this.

**3. Dev-environment wiring that points somewhere plausible but wrong.** `nuxt.config.ts`
proxied `/api` to port 8000 — which is **GenStudio's** gateway, not Story Studio's backend. The
app loaded and reported "the backend is probably busy with a big job", when in truth the AI
gateway was correctly answering 404 for a route it has never had. **A misleading error message
cost more time than a crash would have.** When something cannot load, confirm *which* server
answered before believing what it says.

What follows from this:

- Screenshots are the fastest defect-finding tool available for this app. Prefer them over
  another test run when the complaint is visual or "it won't load".
- `npm run dev` exists precisely so this loop is fast — frontend saves hot-reload; `electron/`
  changes recompile but need the app relaunched.
- When you add a gate, be explicit about what it *cannot* catch. `check:model-drift` catches
  hardcoded catalogue values and nothing about rendering.

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

## Preset Boundaries — A Preset Carries Reusable Settings, Nothing Else

**A preset restores the thing it is named for and never quietly re-decides anything else.**
The owner's rule, 2026-08-03: *"i want actions to be intentional, not swept in with bugs like
this."*

Three instances of the same defect have now shipped, which is why this is a general rule and
not a note about one page:

- `title_image.image_path` in Video Assembly timeline presets — an episode's own image
  restored onto a different episode.
- `pacing` in Character Sheet presets — the customer chose "1–3 seconds", applied a preset to
  set the **art style**, and silently got that preset's rhythm instead. 50 of 53 episodes in a
  real project ended up at 4–8s, none of it chosen.
- `references.sheet` in the same presets — ORed into `use_episode_sheet`, so applying any
  preset turned "Use episode anchor" **on**, pointing at a sheet that may not exist.

The test to apply when deciding whether a key belongs in a preset:

- **Reusable look or configuration → include.** Style bible, negative prompt, recipe,
  transition type, duration, enabled state.
- **Episode-specific state → exclude.** Anything naming or depending on one episode's files,
  images, or anchors.
- **A deliberate choice the customer makes elsewhere → exclude.** Scene rhythm is chosen in its
  own control; an art-style preset must not overwrite it. If two controls are set in different
  places, one must not silently decide the other.

Two practical requirements, both learned the hard way:

- **Excluding a key is usually only half the fix.** `usePresets`' `excludeKeys` strips on read
  as well as write, so already-saved presets stop restoring the key — but if the normaliser
  then falls back to a built-in default, the customer's live value is still discarded, just to
  a different wrong number. Carry the live value across the apply explicitly.
- **Never rewrite stored presets or project data to fix this.** Stop honouring the key; leave
  what is on disk alone. Silently mutating saved files is the same disease.

Reusable title-image settings — enabled state, duration, transition type and duration — may
remain in Video Assembly presets.

**Scene rhythm stays per-episode. Do not add a project-level pacing default.** Proposed and
rejected by the owner, 2026-08-03: *"it needs to be a deliberate choice on each episode by the
user. not all stories or videos need the same pacing."* Every episode chooses its own band on
the Character Sheet, and nothing — not a project setting, not a format, not a preset — may
choose it on the customer's behalf. A tempting-looking gap (53 episodes each needing the
setting) is the intended cost of that decision, not a problem to engineer away.

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
- Model/provider inventory and dispatch belong to GenStudio. Story Studio reads the live GenStudio catalog and must not restore direct Studio Hub or sibling-Studio routing.
- Final Video Assembly is local-only. Do not restore Render Studio selection, remote-render fields, remote assembly clients, or credit charging for FFmpeg work performed on the customer's Mac.

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

## Optional Research and Retired Co-writer

- Research is an optional evidence-quality workflow. It must never block generation, Pipeline preflight, Production Board completion, or `all_done`; do not add a project gate or `research_required` setting.
- There is exactly ONE research decision, and it is per claim: `Verified` (keep) or `Ignore` (drop), with `Verify all` / `Reset` / `Ignore all` as bulk actions. The research-level state is DERIVED from those claim statuses — research is reviewed when there is at least one claim and none is left `unreviewed`, and usable when at least one claim was kept. Do not add a second, research-level attestation.
- Generating or regenerating research resets every claim to `unreviewed` and drops the review record (`withResearchUntriaged()`), because nobody has read the new claims. This is honest workflow state, not a completion gate.
- Reviewed-but-nothing-kept ("I ignored every claim") is a legitimate editorial outcome. It reports `research_reviewed: true` with `research_has_usable_claims: false`; the Research page and episode selector must say so plainly while leaving every downstream workflow available.
- Research evidence is artifact-based (`isResearchComplete()`): real summary text or a real claim, never a directory, file presence, raw count, or stored attestation. Claim triage stays visible alongside that evidence status.
- No wording anywhere — UI, job log, `research.md`, error message — may say the user or the app checked claims against cited sources. Say what actually happened: a person reviewed model-generated claims and chose which ones the script may use. Where a claim carries no citation, show that absence.
- Research remains opt-in as a one-click Pipeline stage. When explicitly selected, Pipeline auto-completes still-pending claims and records `review.completed_by: 'pipeline-auto'`, never `'human'`; it never overwrites a completed human triage, including a deliberate all-ignored result.
- The Co-writer feature is retired. Do not restore its page, navigation entry, API routes, local-storage stores, or completion dependencies. Idea development belongs in Ideas, Research, and Script Generator workflows.

## Retired Brand System

- The shared Brand profile system is retired. Do not restore `/brands`, `brand_id`, Brand API routes, Brand storage, or Brand-level prompt, voice, logo, pronunciation, art-style, metadata, or format overrides.
- Independent project controls remain valid, including title prefix/suffix branding, branded intro visuals, project art styles, and Video Assembly logo and presentation controls.
