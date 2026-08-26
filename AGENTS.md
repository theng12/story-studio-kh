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

## Running Part Of The Backend Suite

- `npm run test:backend` runs all ~327 backend files and is the release gate.
  Do not narrow it when you are verifying a release.
- While ITERATING, run only what you are working on:
  `node scripts/testing/run-backend-tests.mjs --only <substring>`
  The substring matches the test file's name, and `--only` may be repeated to
  select several. One file typically finishes in under a second; the full suite
  does not finish in an hour when two agents are competing for the machine.
- A filtered run prints a loud `PARTIAL RUN` banner before and after the results,
  naming the patterns and counting the skipped files. **If you see that banner,
  the release gate did not run** — never quote a filtered run as a green suite.
- An `--only` that matches nothing FAILS, and so does a run whose summary reports
  zero tests. A suite reporting no tests is a failure, not a pass.

## Mandatory Release Integrity

- Every shipped Story Studio change—including fixes, reliability work, UI/API
  behavior, dependency updates, and workflow changes—must increase the version
  in both `package.json` and `package-lock.json` in the same change set.
- Add the matching newest-first `## vX.Y.Z` entry to `CHANGELOG.md`; this is the
  source shown by the in-app **What's New** experience.
- Run `npm run check:changelog` before finalizing. A release is incomplete if
  the runtime version, newest changelog entry, and What's New details differ.

## Built-In Visual Style Workflow

- When a user provides visual references and asks to add a reusable style, use the `story-studio-visual-style-adoption` skill.
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
  real project ended up at 4–8s, none of it chosen. **This one incident is superseded — for
  `pacing` only — by the owner's reversal below. It is kept here because it is still the
  evidence the other two exclusions stand on, and still the reason this whole section exists.**
- `references.sheet` in the same presets — ORed into `use_episode_sheet`, so applying any
  preset turned "Use episode anchor" **on**, pointing at a sheet that may not exist.

### The shape is wider than presets — instance five, 2026-08-18

**`subtitles.srt_path` in Video Assembly was correctly excluded from presets and still put
EP0048's captions into EP0047's finished video.** It is the fifth instance of the shape above,
and the first to prove the shape is really *episode-specific state surviving an episode
change*, of which "a preset restored it" is only one route.

`EP0047_final_video.mp4` was 989.833s — EP0047's own merged audio to the frame — and the
caption burned at t=14s read "…At Timbuktu, that process has", cue #3 of EP0048's stitched SRT.
Nothing restored that path. `loadSubtitlesStatus()` refetched the file list on every episode
change and then wrote a default only `if (!subtitles.srt_path)`, so a selection that already
existed was never revisited. **The exclusion list is not the safety net.** Three more fields on
that one page carried the same `if (source) assign` / `if (!x) x = …` shape.

What follows, and it applies to every workspace keyed by episode:

- **An episode-change refresh must REPLACE the field, not fill a gap.** `if (newValue) field =
  newValue` with no else is this defect, spelled optimistically. Assign the new episode's value
  or assign empty; never leave the previous episode's standing.
- **Ownership is a fact to look up, not a string to parse.** The backend already returns this
  episode's own file list, so membership in it decides ownership. Reading an episode code out
  of a path is a guess where a fact is available.
- **Re-resolve when the equivalent is identifiable; blank when it is not.** Losing the
  customer's selection on every switch is its own defect. Re-resolving is legitimate only when
  the new value is derivable rather than guessable — here, the same kind of transcript in this
  episode's own folder.
- **Announce it.** Same rule as 1.3.3's auto-approve notice and for the same reason: a value
  that changes under the customer without a word is the quiet version of the same fault. Say
  what was dropped and what replaced it — and say it when the field was cleared, too.
- **The generator must not accept a foreign path either.** `generateVideo` checked only
  `existsSync` and burned whatever it was handed, so a browser-state bug became a finished
  video. `prepareUnifiedVideoAssemblyInputs` now refuses a subtitle file outside the episode's
  own directory, in preflight, before any encode. It **refuses rather than substituting**: it
  silently re-resolves scenes and merged audio because each of those has exactly one correct
  answer, while which transcript to burn is an editorial choice — and a silent repair would
  also hide the next frontend regression of this kind forever.

### Instance six — an overlay's WINDOW, 2026-08-18 (v1.4.1)

**`overlays.layers[].time_range` rode in presets and survived episode changes.** Sixth
instance of the same shape, and the first the owner has answered by SPLITTING one object
rather than including or excluding it whole.

His ruling: *"overlays should belong to episodes and can be in the presets because i might
want to randomize the overlays effects."* Two things that sound contradictory and are not:

- **The look is reusable taste.** Which overlay file, opacity, scale, position, blend,
  chroma key, loop. It belongs in presets, and he wants to shuffle between them.
- **The window is one episode's runtime.** A 12-second flourish over the closing line of a
  16-minute episode lands mid-sentence in a 9-minute one. It travels nowhere.

So the test in this document — include reusable configuration, exclude episode-specific
state — is applied at the FIELD level, not the object level. When a key is a mixture, split
it; do not decide the whole object by its dominant half.

What that required, and all of it is load-bearing:

- **Both preset payloads, not one.** `effectsPresets` and the `video_bundle` fallback each
  carried the layers. The bundle is as reusable as the slot preset, so fixing only the
  obvious one would have left the defect reachable by the other door.
- **Windows persist per EPISODE CODE**, in `overlay_time_ranges` on the project config, so a
  window can never be applied to an episode it was not measured against. Stripping them from
  presets without giving them somewhere to live would have been data loss dressed up as a fix.
- **An episode change REPLACES every window**, or clears it to `null` (the documented
  "always visible" default). Same rule as instance five: never `if (newValue) field = newValue`.
- **A pre-1.4.1 preset's windows are RESCUED, not dropped** — adopted as the current
  episode's, but never over a window that episode already has, and announced once. The
  episode is the authority on its own runtime; the preset is not.

**Randomisation cannot reach the timing, structurally.** He asked to randomise the effects.
Because the window is not in the preset payload, no shuffle over presets can touch it — the
guarantee is a property of the data rather than a rule a future randomiser has to remember.
`overlayLayersForPreset` in `frontend/utils/overlay-timing.ts` is the single place that
decides what a preset carries, and `frontend/__tests__/overlayTiming.test.ts` asserts it.
If you build that randomiser: vary the look, leave the window alone.

### Scene rhythm is preset data again — reinstated 2026-08-18

**`pacing` belongs in Character Sheet presets. The owner reversed the 2026-08-03 exclusion
himself, and this is his call to make.** He was shown the original incident, including the 50
of 53 episodes, and was offered a safer alternative — a separate, explicit bulk pacing action
that could never fire as a side effect. He declined it and chose the full reversal: *"Put
pacing back in presets."*

Do not "fix" this back. If a future reader thinks scene rhythm has wrongly crept into presets,
that reader is looking at a deliberate 2026-08-18 decision, not at a regression.

The reversal is scoped to `pacing`. Two things did NOT change:

- **`use_episode_sheet` and `sheet` stay excluded.** He asked about rhythm only. Those two
  carry the separate anchor defect above, and widening the reversal past what he asked for is
  not licensed by it.
- The exclusion mechanism itself is unchanged. `usePresets` still strips excluded keys on read
  as well as write, and stored preset files are still never rewritten.

**The reversal has a mirror-image trap, and it is handled explicitly.** Because `usePresets`
stripped `pacing` on **save** as well as load, every preset saved between 2026-08-03 and
2026-08-18 contains no `pacing` at all — for anyone who kept working through August, that is
most of them. Un-excluding the key alone would let `normalizeContinuityConfig` fall back to
`DEFAULT_SCENE_PACING` for those presets and reset the customer's chosen rhythm to 1–3s: the
same discard as the original incident, only in the other direction. The rule is therefore
explicit in both directions:

- A preset that **stores** a rhythm applies it.
- A preset that stores **none** leaves the episode's live rhythm exactly as it is, and a
  half-written band (one end missing) counts as none.
- **The Character Sheet says which of the two happened.** A rhythm that correctly does not
  move is indistinguishable on screen from a feature that does not work, so the page states
  that the preset carries no saved rhythm and that saving over it captures the current one.

`storedPresetPacing` / `applyContinuityPagePreset` in
`frontend/composables/useContinuityConfig.ts` own this, and
`frontend/__tests__/continuityPresetPacing.test.ts` asserts both directions. That test file was
**rewritten, not deleted** — it carries the reversal's date and reasoning at the top so the
next reader can see this was decided rather than quietly dropped.

### Auto-approve is preset data on Contextual Cues, and is announced — decided 2026-08-17

**`auto_approve` belongs in Contextual Cues presets. It is deliberately carried, and the page
says so every time a preset changes it.** This is the fourth instance of the shape above, and
the second the owner has ruled on rather than had excluded.

The report: he applied his `Contextual Cues - DeepSeek` preset for its model and density and
found **Auto-approve safe proposals** switched on — *"i don't remember telling you that the
it's preset for auto approved is being applied or not."* The preset genuinely stores
`auto_approve: true`, and the control's own label reads *"Off by default. Use only after you
trust this preset"*, so a preset chosen for one reason was re-deciding a trust question.

Shown the alternatives, he **declined removing it from the preset** and chose announcement
instead — consistent with reversing the `pacing` exclusion the same day, and with not wanting
presets made less capable. Do not "fix" this back by adding `auto_approve` to an exclude list.

The announcement is `WorkspaceNotice`, built on 1.2.5's scene-rhythm pattern, and symmetric:

- A preset that stores `true` says the setting is now on and what that means.
- A preset that stores `false` says that too. A silent switch-off is the same defect in the
  opposite direction.
- A preset that stores **neither** leaves the live setting exactly as it is and says nothing.
  This is the same trap `useContinuityConfig.ts`'s `storedPresetPacing` documents: the apply
  handler read `data?.auto_approve === true`, which collapses "no opinion" into `false` and
  switches the setting off for every preset saved before the field existed.
  `storedPresetAutoApprove` in `frontend/utils/contextual-cues.ts` is what makes that third
  case expressible, and `frontend/__tests__/contextualCuesAutoSave.test.ts` asserts all three.
- The notice is cleared by a hand edit of the tick-box and by an episode change, and it never
  fires for the preset re-apply `usePresets.load()` performs on mount — that is a restore, not
  a change the customer just made.

The test to apply when deciding whether a key belongs in a preset:

- **Reusable look or configuration → include.** Style bible, negative prompt, recipe,
  transition type, duration, enabled state.
- **Episode-specific state → exclude.** Anything naming or depending on one episode's files,
  images, or anchors.
- **A deliberate choice the customer makes elsewhere → the owner decides.** Two controls set in
  different places, where one silently decides the other, is the shape of this whole defect
  class — but whether a given pair is a defect or a convenience is a product call, not one to
  settle from the code. Scene rhythm was excluded on exactly this reasoning and then reinstated
  by the owner. Raise it; do not rule on it.

Two practical requirements, both learned the hard way, and both still binding in either
direction:

- **Changing whether a key is excluded is usually only half the fix.** `usePresets`'
  `excludeKeys` strips on read as well as write. Excluding a key stops already-saved presets
  restoring it — but if the normaliser then falls back to a built-in default, the customer's
  live value is still discarded, just to a different wrong number. **Un-excluding a key has the
  same failure**, because presets saved during the exclusion never stored it: the normaliser
  supplies its default for a value the preset never had an opinion about. Either way, carry the
  live value across the apply explicitly, and check for the value's real presence rather than
  trusting the merge.
- **Never rewrite stored presets or project data to fix this.** Whichever way the exclusion
  moves, leave what is on disk alone — do not back-fill a rhythm into presets that lack one.
  Silently mutating saved files is the same disease.

Reusable title-image settings — enabled state, duration, transition type and duration — may
remain in Video Assembly presets.

**Scene rhythm stays per-episode. Do not add a project-level pacing default.** Proposed and
rejected by the owner, 2026-08-03: *"it needs to be a deliberate choice on each episode by the
user. not all stories or videos need the same pacing."* **This rule was NOT reversed on
2026-08-18 and still stands in full.** Every episode chooses its own band on the Character
Sheet, and no project setting and no format may choose it on the customer's behalf. A
tempting-looking gap (53 episodes each needing the setting) is the intended cost of that
decision, not a problem to engineer away.

A preset is not a counter-example to this. A project-level default applies itself, to every
episode, unasked; a preset does nothing until the customer selects it on one episode and clicks
Apply. That single deliberate act on a single episode is precisely the per-episode choice this
rule protects — which is why the owner could reinstate one without disturbing the other.

## A Zero That Means Two Things Is A Defect

**Never let "the answer is none" and "I could not work out the answer" produce the same value.**
Established 2026-08-18, after the second one shipped inside a month.

`computeEpisodeIntroLeadInSec` returned `Promise<number>`, and every caller wrapped it in
`.catch(() => 0)` or a bare `catch {}`. When it began selecting the merge's
`{CODE}_merged_audio.completion.json` record instead of the track — a `startsWith` match that a
sidecar added in July started satisfying — it ffprobed a JSON file and returned 0. But 0 is
also the correct answer for an episode with no intro. Every episode merged after 2026-07-14 got
a stitched timeline 16 seconds early, with nothing in any log to see, and every YouTube chapter
timestamp on those episodes was early by the same amount.

`lib/intro-lead-in.ts` had already grown `IntroLeadInMeasurement` (`measured | unmeasurable`)
in v1.3.2 for exactly this reason — but only the display path used it, while the timing path
kept a flattening wrapper. **Adding the honest type is half a fix; the callers that matter have
to be moved onto it.** `resolveEpisodeIntroLeadIn` replaces `computeEpisodeIntroLeadInSec` and
returns the measurement; the episode-level flattening wrapper is *deleted* rather than
deprecated, so no future caller can reintroduce the silent zero by reaching for the convenient
signature. All three callers now state the outcome — job log, toast, package warning.

(`computeIntroLeadInSec`, the pure path-plus-sections variant, survives for `computeStoryStartSec`,
whose callers resolve the merged file through the extension-filtered asset scanner and were never
exposed to this. Do not add new callers to it without deciding what an unmeasurable result means.)

Two supporting rules, both paid for:

- **Match filenames on what they END with, not what they start with.** A `startsWith(base)`
  test claims every sidecar anyone ever writes beside the file. `generators/video.ts`'s
  `/_merged_audio(?:_v\d+)?\.(mp3|wav|m4a)$/i` is the reference, and it also covers the `_vN`
  re-merge variants the prefix test rejected outright.
- **A test asserting a function returns 0 cannot fail when the function breaks by always
  returning 0.** `intro-lead-in-episode.test.ts` had two tests, both asserting zero, both green
  throughout. Pin *which* zero it is, and pin at least one non-zero.

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
