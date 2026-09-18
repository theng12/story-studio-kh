# Codex Notes

Rules for working in Story Studio KH. Each one is imperative and in force.

**The evidence behind them — incidents, dates, owner quotes, and the code that owns each rule —
lives in [`docs/architecture/agents-decisions.md`](docs/architecture/agents-decisions.md).**
Read that file when you want to know *why*, or before concluding a rule is wrong. Several rules
here record a decision the owner reversed; those say so explicitly, because a future reader who
"fixes" them back would be reverting a deliberate call.

---

## 1. Everything follows the selected model

**The first rule. It outranks convenience everywhere.**

Nothing about a model may be hardcoded, copied, or cached past the moment the selection changes.
GenStudio publishes what each product can do; Story Studio reads it live and re-reads on every
change. It never guesses, never remembers a catalogue number, and never infers capability from a
product's name.

On a model change, **all** of these recompute immediately — not on reload, not on next launch:
`max_prompt_characters` and any warning derived from it · `context_window_tokens`,
`max_output_tokens`, and the available-input budget that falls out of them · price and credit cost
for every unit (per image, per video variant, per 1,000 TTS characters, per second of transcription,
per million chat tokens) plus promotions and `chargeable` · `supports_reference_images`,
`min_reference_images`, `max_reference_images` · aspect ratios, resolutions, durations, modes, voice
tiers and languages — every published option list · capability flags such as `supports_seed`,
`supports_vision`, `supports_web_search`, `structured_output_mode`, `controls[]`.

Forbidden, concretely:

- A constant, ladder, or option list duplicating something GenStudio publishes. Generate it.
- Persisting a limit into a draft, preset, or project config. Persist the **selection** (model id,
  chosen allowance); resolve limits fresh and re-clamp on load.
- A value computed once into component state and not recomputed. If a model switch can invalidate
  it, it needs a watcher.
- Inventing a fallback when GenStudio publishes nothing. Show nothing, disable the control, or
  fail loudly — never a number the customer will mistake for the model's own.
- Converting a token budget into a character or word limit by a fixed ratio. The units differ and
  the ratio is not stable; use the published character figure.

**A limit that is enforced must also be shown.** Silently refusing on a limit the user was never
told about turns a clear constraint into a mystery error. Surface the figure where the choice is
made.

## 2. Provider transparency

Show which provider serves a model **wherever GenStudio publishes it**, across every modality.
This **supersedes** the earlier rule that stripped provider identity before it reached the
customer.

- Display published fields (`provider`, `provider_id`, `provider_name`, `engine_id`,
  `engine_name`, `model_family`, `model_revision_id`); do not delete them at the backend boundary.
  Provider-named catalogue endpoints are customer-facing, and voice libraries are browsable by
  provider.
- **GenStudio is the only authority.** Never infer, derive, or reconstruct a provider from a model
  id, a name pattern, or anything else. Unpublished means show nothing.
- **Provider is display, never dispatch.** Do not select, prefer, rank, or route by provider, and
  send no provider field on any generation request. Showing who served a request must never become
  a control for who serves the next one.
- Read live on every selection change; never cached past it.

## 3. Bugs the gates cannot see

**Every gate can be green while the app is visibly broken.** Three shapes recur:

1. **Layout that overflows its container.** No test sees geometry — content passing an assertion
   says nothing about whether it is reachable.
2. **CSS that silently does nothing.** A declaration that loses is indistinguishable from one
   never written. Check specificity in the *built* CSS rather than reasoning from source; `:deep()`
   on a teleported dialog never matches at all.
3. **Dev wiring that points somewhere plausible but wrong.** Confirm *which* server answered
   before believing what its error says.

Therefore: prefer a screenshot over another test run when the complaint is visual or "it won't
load". `npm run dev` exists to make that loop fast — frontend saves hot-reload, `electron/`
changes recompile but need a relaunch. When you add a gate, say what it **cannot** catch.

## 4. Episode-specific state must not survive an episode change

**The most expensive defect class in this repo** — one shape with six recorded instances: a value
belonging to one episode reaching another. It arrives by more than one route (a preset, a stale
selection, an `if (source)` default), so **an exclusion list is not the safety net**.

- **An episode change REPLACES the field, or blanks it.** `if (newValue) field = newValue` with no
  else is this defect spelled optimistically. Never leave the previous episode's value standing.
- **Ownership is a fact to look up, not a string to parse.** The backend already returns this
  episode's own file list; membership in it decides ownership.
- **Re-resolve only when the new value is derivable** (the same kind of artifact in this episode's
  own folder); otherwise blank. Losing the customer's selection on every switch is its own defect.
- **Announce it** — what was dropped and what replaced it, and say so when the field was cleared.
  A value that changes under the customer without a word is the quiet version of the same fault.
- **Generators must refuse foreign input too.** Refuse in preflight rather than substituting when
  choosing the artifact is an editorial decision; silently repair only when exactly one answer is
  correct.

## 5. Presets carry reusable settings, nothing else

**A preset restores the thing it is named for and never quietly re-decides anything else.** Apply
the test at the **field** level — split a mixed object rather than judging the whole by its
dominant half.

- **Reusable look or configuration → include.** Style bible, negative prompt, transition type,
  duration, enabled state, overlay appearance and blending.
- **Episode-specific state → exclude.** Anything naming or depending on one episode's files,
  images, anchors, or runtime window.
- **A deliberate choice the customer makes elsewhere → the owner decides.** Raise it; do not rule
  on it from the code.

**Decided exceptions — do not "fix" these back:**

- `pacing` **is** in Character Sheet presets. The 2026-08-03 exclusion was **reversed by the owner
  on 2026-08-18**. A reader who thinks scene rhythm wrongly crept back in is looking at a
  deliberate decision, not a regression.
- `auto_approve` **is** in Contextual Cues presets, and the page announces it every time a preset
  sets it — in both directions.
- `use_episode_sheet` and `sheet` **stay excluded** (the anchor defect is a separate matter).
- Title-image settings — enabled state, duration, transition type and duration — may remain in
  Video Assembly presets.

**Two traps, binding in either direction:**

- **Changing whether a key is excluded is only half a fix.** `usePresets.excludeKeys` strips on
  read as well as write, so a normaliser default can still discard the customer's live value — and
  **un-excluding has the same failure**, because presets saved during the exclusion never stored
  it. Carry the live value across the apply explicitly and test for the value's real presence
  rather than trusting the merge.
- **Never rewrite stored presets or project data to compensate.** Whichever way an exclusion
  moves, leave what is on disk alone.

**Scene rhythm stays per-episode. Do not add a project-level pacing default.** Proposed and
rejected by the owner, 2026-08-03: *"it needs to be a deliberate choice on each episode by the
user. not all stories or videos need the same pacing."* **This rule was NOT reversed** with
`pacing`'s reinstatement. Every episode chooses its rhythm in Scene Plan's **Visual timing &
motion** panel; no project setting, Content Series Formula, or visual style may choose it on the
customer's behalf. Character Sheet shows the saved rhythm and links there; it does not own a second
editor. A preset is not a counter-example: a project default applies itself unasked, while a preset
does nothing until the customer applies it to one episode.

## 6. A zero that means two things is a defect

**Never let "the answer is none" and "I could not work out the answer" produce the same value.**

- Use a typed measurement (`measured | unmeasurable`) rather than a number that doubles as an
  error.
- **Adding the honest type is half a fix.** The callers that matter must move onto it, and the
  flattening wrapper should be **deleted, not deprecated**, so no future caller can reintroduce
  the silent zero through the convenient signature.
- **Match filenames on what they END with.** A `startsWith(base)` test claims every sidecar anyone
  ever writes beside the file.
- **A test asserting `0` cannot fail when the function breaks by always returning `0`.** Pin *which*
  zero it is, and pin at least one non-zero.

## 7. Boundaries — what belongs where

**Scene vs thumbnail.** Separate surfaces; never re-merge them into the old unified prompt /
generator model. Preset keys: thumbnail prompts use `thumbnail_prompts_presets` and
`thumbnail_prompts_last_preset`; scene prompts use `scene_prompts_presets` and
`scene_prompts_last_preset`; thumbnail generators use `thumbnail_generator_presets` and
`thumbnail_generator_last_preset`; scene generators use `scene_generator_presets` and
`scene_generator_last_preset`. `image_prompts_*` and `image_generator_*` are legacy compatibility
keys only and must not be the primary keys for new thumbnail/scene UI or Pipeline selectors. The
Pipeline step named `image_prompts` chooses its mode from the active format: classic
chapter-distributed scene-image formats may run `mode: "all"`; B-Roll, timestamp-driven,
continuity-chain and narrated-scenes must run thumbnail prompts only (`mode: "thumbnails"`),
because their scene prompts come from Scene Plan.

**Video.** Image-to-video only — never restore text-to-video modes, models, UI controls, preset
values, or fallbacks. Sora 2 and Runway Gen-3 are retired. New provider discovery is deferred until
`videostudio-mac` exposes a stable provider inventory and dispatch API; do not half-wire or
duplicate new catalogues meanwhile. Every request uses the exact scene image for its stable scene
number, and a missing image is a **blocking error**, never permission to reuse a different one.

**Model inventory.** Settings → Models may edit built-in pricing and operational limits only; do
not restore the Add Custom Model form, a project-level `models` catalog, `is_custom` entries, or a
unified catalog write path. Inventory and dispatch belong to GenStudio; do not restore direct
Studio Hub or sibling-Studio routing. Story Studio talks to **exactly one** endpoint and must never
be handed a second address. Final Video Assembly is local-only: no Render Studio selection,
remote-render fields, remote assembly clients, or credit charging for FFmpeg work on the
customer's Mac.

**Visual style packs.** Use the `story-studio-visual-style-adoption` skill and author exactly one
standalone pack. `frontend/composables/useVisualStyleCatalog.ts` is the only frontend consumer —
no static style list, no offline fallback. Each style needs a registry-issued qualified id,
searchable metadata, a render-ready `style_bible`, a `negative_prompt`, and a verified 1672x941
WebP preview inside its own pack `assets/`. Generate an original preview; never copy composition or
depend on generated captions. Legacy `builtin-*` ids may remain only inside existing project-local
`style_presets` and historical migration evidence.

**Generator model defaults.** Restore the user's last explicit choice before the picker mounts;
never hardcode a paid model as the form default. If the remembered model is gone, let the live
inventory choose a usable fallback and persist that healed choice.

**Retired — do not restore.** The Co-writer feature (page, navigation, API routes, local-storage
stores, completion dependencies) · the shared Brand profile system (`/brands`, `brand_id`, Brand
routes and storage, Brand-level prompt, voice, logo, pronunciation, art-style, metadata or format
overrides) · text-to-video · the Add Custom Model form · Render Studio · remote assembly.
Independent project controls remain valid, including title prefix/suffix branding, branded intro
visuals, project art styles, and Video Assembly logo and presentation controls.

## 8. Verified completion contract

Every generation flow must **prove** its output complete before a job, pipeline step, Production
Board cell, or one-click run reports success.

- A generator returning without throwing is not evidence. Audit the authoritative files,
  manifests, expected item IDs, and usable content.
- Preserve valid partial outputs, but fail the overall job **loudly** when any required item is
  missing, empty, stale, malformed, or failed at its provider.
- Error messages must name the missing or invalid items and say how Retry/self-healing repairs them
  without repeating completed work.
- Compare expected versus present artifacts. Never treat directory existence, one matching file, a
  stale derivative, a legacy fallback, or `progress = 100` as proof.
- Generator, Job Queue, Pipeline, Production Board, pending filters and downstream gates share the
  same authoritative rule.
- Optional steps are skipped only through explicit project configuration. A skipped optional step is
  not missing; a required step with partial output is never done.
- New generators and material changes to existing ones need regression tests for complete, partial,
  empty, stale, malformed, provider-failure, and retry/self-healing outcomes.
- When auditing generation code, search for swallowed per-item errors, warning-only failures,
  unconditional `progress = 100`, and queue executors that return after partial work.

## 9. Research

An optional evidence-quality workflow. It must **never** block generation, Pipeline preflight,
Production Board completion, or `all_done` — no project gate, no `research_required` setting.

- There is **exactly ONE** research decision, per claim: `Verified` (keep) or `Ignore` (drop), with
  `Verify all` / `Reset` / `Ignore all` as bulk actions. Research-level state is **derived** —
  reviewed when there is at least one claim and none is left `unreviewed`; usable when at least one
  was kept. Do not add a second, research-level attestation.
- Generating or regenerating research resets every claim to `unreviewed` and drops the review
  record (`withResearchUntriaged()`), because nobody has read the new claims. That is honest
  workflow state, not a gate.
- Reviewed-but-nothing-kept is a legitimate editorial outcome: it reports `research_reviewed: true`
  with `research_has_usable_claims: false`, says so plainly, and leaves every downstream workflow
  available.
- Evidence is artifact-based (`isResearchComplete()`): real summary text or a real claim — never a
  directory, file presence, raw count, or stored attestation. Claim triage stays visible alongside
  it.
- No wording anywhere — UI, job log, `research.md`, error message — may say that the user or the app
  checked claims against cited sources. Say what happened: a person reviewed model-generated claims
  and chose which ones the script may use. Where a claim carries no citation, show that absence.
- Opt-in as a one-click Pipeline stage. When explicitly selected, Pipeline auto-completes
  still-pending claims and records `review.completed_by: 'pipeline-auto'`, never `'human'`, and
  never overwrites a completed human triage — including a deliberate all-ignored result.

## 10. Working in this repo

**Tests.** `npm run test:backend` runs every backend file and **is the release gate** — do not
narrow it when verifying a release. While iterating, run only what you are working on:
`node scripts/testing/run-backend-tests.mjs --only <substring>` (repeatable; the substring matches
the test file's name). A filtered run prints a loud `PARTIAL RUN` banner before and after the
results — **if you see that banner, the release gate did not run**, and never quote a filtered run
as a green suite. An `--only` that matches nothing fails, and so does a run whose summary reports
zero tests. Do not run competing suites: one test run at a time, and read-only agents stay off the
suite entirely. For every suite you cite, report the actual exit status, the completion line, and
the test count — a wrapper's exit code is not the suite's, and "completed" is not "passed".

**Releases.** Classify the deliverable first.

- **Application release** — fixes, reliability work, UI/API/runtime behaviour, dependency updates,
  migrations, or any other code shipped inside Story Studio: increase the version in **both**
  `package.json` and `package-lock.json` in the same change set.
- **Content-only** — a new or updated standalone Content Pack whose kind and schema are already
  supported ships as its own `.sspack`: no application version bump, no changelog entry, no DMG, no
  deploy, no restart. Use the released compatibility floor in
  `content-packs/release-floor.json`.
- **Mixed** follows the application path only for the runtime behaviour it actually changes. Do not
  force unrelated compatible packs into an app release because they share a branch or launch date.

Add the matching newest-first `## vX.Y.Z` entry to `CHANGELOG.md` — the source shown by the in-app
**What's New** — and run `npm run check:changelog`; the release is incomplete if the runtime
version, newest changelog entry, and What's New details differ. After verified application/desktop
work is integrated into `main`, build the final DMG from the **main** checkout with
`npm run dist:smoke` (unsigned smoke check) or `npm run dist:public` (signed/notarized candidate).
The artifact belongs in the repository-root `dist/`; verify its versioned `arm64` filename and the
bundled `app.asar` version against `main`, and never copy a worktree-built DMG into `main`'s
`dist/` before its source is integrated.
