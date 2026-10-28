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

- `pacing` **is not** in Character Sheet presets. It was put back in on 2026-08-18 and **taken back
  out by the owner on 2026-10-17**, when the timing editor moved: Scene Plan's **Visual timing &
  motion** panel owns the episode's rhythm and Scene Review reads it back from the plan. A reader
  who thinks the 2026-08-18 reinstatement is still in force is looking at a decision that was
  superseded; a reader who thinks it was quietly "fixed" back is looking at a deliberate
  2026-10-17 call. The Character Sheet's green *"The preset includes scene rhythm"* notice was
  **deleted** with it, not reworded — this page no longer owns rhythm, so a preset applied there
  has nothing to report.
- **The preset exclusion is only half the rule; the SAVE BOUNDARY carries the other half.** A
  preset is one way a stale value reaches `continuity.json`, not the only one — the Character Sheet
  also saves the whole config it loaded. So the boundary enforces it too: a whole-config save keeps
  the `pacing` already on disk **unless its payload claims it** (`claim_pacing: true`), and Scene
  Plan's timing panel is the only writer that claims. A save that does not claim cannot move the
  rhythm — including one written later, which is the point: the rule is a property of the boundary,
  not a list of pages someone must remember to update. Do not "fix" a page by making it stop
  sending `pacing`: `buildContinuityConfig` substitutes the 1–3s default for an absent value, which
  is the 2026-08-03 incident with the sign flipped.
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
  moves, leave what is on disk alone. Presets still carrying a key that has since been excluded are
  stripped **at the boundary** — on read, before `apply` sees them — and their files are untouched.

**Scene rhythm stays per-episode — nothing may decide an episode's rhythm on the customer's
behalf.** Proposed and rejected by the owner, 2026-08-03: *"it needs to be a deliberate choice on
each episode by the user. not all stories or videos need the same pacing."* No project setting,
Content Series Formula, or visual style may choose the rhythm for an episode, and the Character
Sheet neither shows nor owns it. The exclusion is scoped to the Character Sheet's presets, not to
`pacing`: Scene Plan's own preset may carry a rhythm, because that panel is the thing that owns it —
and at the save boundary the same panel is the only writer that claims it.

**The one owner-approved addition, 2026-10-19 — a NEW channel's STARTING rhythm.** The owner's
standard tiered rhythm: 0–180 s a new scene every 5–10 s, 180–360 s every 10–20 s, after 360 s every
20–30 s. A newly created channel is seeded with it — `createProject` writes `config.json`
`default_scene_pacing` and a Scene Plan preset named **"Owner standard pacing"**, marked last-used.
It is a **starting value only**, and the 2026-08-03 rule still holds: an episode reads it until it
saves a rhythm of its own in Scene Plan's **Visual timing & motion** panel, every episode may still
change it, and **an existing channel is never rewritten**. A channel whose Formula names its own
starting scene length still wins, because the Formula is the more specific choice. Do not "fix" this
by deleting the seed, and do not extend it into anything an episode cannot change. The seeded preset
names **no writing model** — a model is a live GenStudio choice (§1) — so Pipeline preflight counts a
preset with no writing model as **no usable preset** and leaves the step out with a plain message
(`PRESET_MODEL_READERS` in `routes/pipeline.ts`), rather than enqueuing it to fail inside its
generator.

**A SLEEP channel starts on its own four tiers — owner, 2026-10-26.** Every sleep channel begins an
episode on: 0–3 min a new scene every 5–10 s · 3–5 min every 10–20 s · 5–10 min every 20–30 s · from
10 min every 50–60 s. The Sleep-family Formulas carry it — Sleep Story, Sleep History Compilation,
Calm Science for Sleep, Mythology for Sleep and Illustrated History for Sleep — as
`starting_scene_pacing` (the same `variable` shape as above, now a pack field), and the built-in
`electron/server/niches/sleep.json` carries it too, so the answer does not depend on which Formula
is installed. When a Formula declares both, `starting_scene_pacing` supersedes
`starting_scene_seconds`. It is **still a starting value only**: a new channel copies it once,
Scene Plan's **Visual timing & motion** panel still owns each episode's rhythm, an episode that
saved its own keeps it, and **no stored channel or episode is rewritten**. The 2026-10-19 owner
standard tiers are unchanged for a channel whose Formula names no rhythm — a Formula that names one
still wins. These tiers do **not** decide anything for a non-sleep channel.

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

**Video.** Video is a multi-lane feature, and each scene names its own lane: **still · Sketch Draw
(local) · AI image-to-video · AI text-to-video · reference-to-video · an imported clip**. This
**supersedes the image-to-video-only rule of 2026-09-xx** (owner, 2026-10-26): one kind of motion
is not enough, and Sketch Draw is one option among several, not the only one.

- **Capabilities come live from the Gateway** (§1) — published durations, resolutions, aspect
  ratios, start/end-frame and reference support, audio switches, price basis and controls. Nothing
  here is hardcoded, curated from memory, or inferred from a model's name; a row the Gateway
  cannot describe is not offered.
- **A scene's lane is an editorial choice.** T2V is chosen deliberately at Scene Plan (per scene or
  per episode); a T2V scene is reviewed in Motion Review, has a cheap backup still made as a safety
  net, and must assemble as a clip when available. Scene Plan writes a **video prompt** for T2V
  scenes and a **motion prompt** for I2V scenes; neither is optional for the lane that needs it.
- **Scene Plan respects the planned model's clip length.** Read min/max clip duration live from the
  Gateway capability record; plan every video scene inside that range. If the model changes, flag
  misfits in Motion Review and offer to re-plan or fill (chain or hold).
- **Every image lane uses the exact scene image for its stable scene number.** A missing image is a
  **blocking error** for still, Sketch Draw and image-to-video — never permission to reuse a
  different scene's image.
- **Reference-to-video may use only this episode's own character images** (§4, ownership is looked
  up in the episode's own file list, never parsed from a path), and a generator refuses foreign
  input in preflight.
- **Mix control belongs to Motion Review.** The per-episode video share (a share of running time,
  10–100%) and its selection formula (opening hook, Scene Plan key moments, spread) are resolved
  there; the remainder becomes stills or still+Sketch Draw. Cost and time are shown before anything
  is spent.
- **Paid models are added but not used.** Only Wan 3.0 and Seedance 2.5 via the Gateway, with every
  option read from capability records. Nothing is charged by default, and nothing in tests.
- **Legacy is deleted, not renamed.** Sora 2, Runway Gen-3 and the local LTX-2.3/Lance/Gemma-3-12B
  packs are gone from code, docs, tests and rules; stored project data still reads safely and is
  never rewritten (§5).
- **Clips must not slow assembly.** A clip is normalised once and then copied where possible
  (encode-once); a motion episode's assembly time is measured against a stills-only episode and
  reported.

Model retirements are by **id**, in one list per app, never by display name.

**Model inventory.** Do not restore the Add Custom Model form, a project-level `models` catalog,
`is_custom` entries, or a unified catalog write path. Inventory and dispatch belong to GenStudio; do
not restore direct Studio Hub or sibling-Studio routing. Story Studio talks to **exactly one**
endpoint and must never be handed a second address. **Named exception (owner, 2026-10-11, plan Q4):** the idea
generator's real-source lists (`services/reference-pool.ts`) make free, read-only GETs to
`en.wikipedia.org` — no key, no model, at most one request a second, a User-Agent with nothing
personal in it, cached, and failing soft. It is not a model endpoint; never route generation there.

**Named exception (owner, 2026-10-27): optional local duplicate screening downloads MODEL FILES.**
Settings → This Mac → *Duplicate screening (optional)* runs `google/embeddinggemma-2` (Apache-2.0) on
the Mac running Story, in Story's own process, to warn about near-duplicate scene images and repeated
titles. The owner's decision is binding: **the model runs inside Story, not on the fleet and not
through the Gateway**, and the feature is **optional extra screening, never required** — it starts OFF,
Story offers the download, and the user turns it on deliberately. Uploading without it must work
exactly as today, and when it is off, not downloaded, or broken, every check reads **"not checked"** —
never "passed", never a reason to block anything. The exception, narrowly: on opt-in,
`services/local-model-store.ts` fetches the pinned ONNX export from
`huggingface.co/onnx-community/embeddinggemma-2-ONNX` (one immutable revision) plus the darwin-arm64
slice of `onnxruntime-node` from `unpkg.com`, each file verified against a pinned size and SHA-256.
That is a **model-file download only**: no generation request is ever sent to it, no provider is
selected or routed from it, and nothing about it becomes a second endpoint for anything else. The
model is not in the DMG — the app grows by neither the ≈970 MB of weights nor the ≈46 MB runtime for
a feature that is off by default. Removing it moves the files to Story's Trash, never `rm`.

**Final Video Assembly — owner, 2026-10-23, superseding the earlier local-only rule:** a final
render may be sent through the one paired Gateway to an idle Mac the owner owns (private fleet
final rendering, `private_final_render`, off by default, owner-only switch). Render locally whenever
remote is off, unavailable or refused, and say why. A remote result is accepted only after the same
import checks as a local render (hash, media, loudness, shared final checks) and never replaces an
accepted final. Still retired: Render Studio selection and credit charging for FFmpeg work on the
customer's Mac. The owner chose to use it before formal qualification and fix what breaks; a first
use goes to an episode with no accepted final.

**Visual style packs.** Use the `story-studio-visual-style-adoption` skill and author exactly one
standalone pack. `frontend/composables/useVisualStyleCatalog.ts` is the only frontend consumer —
no static style list, no offline fallback. Each style needs a registry-issued qualified id,
searchable metadata, a render-ready `style_bible`, a `negative_prompt`, and **exactly three
distinct verified 1672x941 WebP previews — no more, no fewer (owner, 2026-10-25)** — inside its own
pack `assets/`, in this order: the hero (the card image, `preview_assets[0]`), a quiet wide scene
with no figure, and the hardest legal case for the style (owner, 2026-09-08 and again 2026-10-24;
`content-packs/PREVIEW-BACKFILL-2026-09-08.md`).
The Style Library shows them all. Generate original previews — with Qwen Image 2.1 turbo, so the
library is consistent (owner, 2026-10-24) — never copy composition or depend on generated captions. Legacy `builtin-*` ids may remain only inside existing project-local
`style_presets` and historical migration evidence.

**Generator model defaults.** Restore the user's last explicit choice before the picker mounts;
never hardcode a paid model as the form default. If the remembered model is gone, let the live
inventory choose a usable fallback and persist that healed choice. **Owner, 2026-10-27 — Settings →
Default models** keeps one model per generation family for this Mac, and it is the LAST link of one
chain read at use time only: the preset's saved model → the page's remembered choice → this default.
Never write the default into a preset, channel config or remembered form, and never remember a
defaulted value as the customer's choice. A default that has left the catalogue is reported by name
and leaves the field empty — never swapped for another product.

**Retired — do not restore.** The Co-writer feature (page, navigation, API routes, local-storage
stores, completion dependencies) · the shared Brand profile system (`/brands`, `brand_id`, Brand
routes and storage, Brand-level prompt, voice, logo, pronunciation, art-style, metadata or format
overrides) · text-to-video · the Add Custom Model form · Render Studio · the
per-run Pipeline writing-model override — the "Models for this run" picker and the `model_policies`
batch request field it fed. **Owner, 2026-10-17:** Story Studio does not own the writing model; a
run uses the model its active preset names, and the Gateway owns any fallback across its own pool.
The new Pipeline admission reads no `model_policies`; only the compatibility readers for
already-queued jobs remain (`pipelinePolicyForJob`, the checkpoint readers, `params.model`).
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

**Delegation — owner ruling, 2026-09-20.** Act as the orchestrator: own planning,
architecture, independent review, verification, and integration. Delegate
bounded implementation work with a base commit, owned files, deliverable, and
proving checks. In the Codex runner, prefer Luna for straightforward tasks, Terra
for involved cross-file work, and Sol at no more than high reasoning for
data-integrity, security, and lifecycle work; other runners use their own model
menu. Run independent tasks concurrently without overlapping edits. Use Ponytail and Graphify,
verify findings against current source, reproduce uncertain bugs before fixing
them, and choose the smallest complete solution. Keep updates concise and
distinguish verified results from remaining limitations. This supersedes earlier
Luna-only or unrestricted model-selection guidance. Workers must not recursively
delegate, commit, push, merge, publish, deploy, or make paid calls unless
specifically assigned that authority. Fan tests out whenever it is safe — see
**Parallel tests** below.

**Tests.** `npm run test:backend` runs every backend file and is the **backend lane** — one step of
the release gate, not the gate itself. **The release gate is the ten-step `story-final-gate`**:
`lint`, `check:changelog`, `check:typography`, `check:security`, `check:model-drift`, `typecheck`,
`test:backend`, `test:frontend`, `test:release`, `test:content-packs`, all run on one exact
source. The runner lives at
`_orchestra/app-closeout-20261021/story-final-gate-tools/run-gate.sh <worktree> <evidence-dir>`;
`ship-story` (and `story_gate_proof.verify`) **refuses to publish or ask the mini to update**
without a proof for the exact HEAD/tree/diff: all ten steps exit 0, every log hash re-derived,
every suite lane at its discovered coverage floor, and no `PARTIAL RUN`. Do not narrow a step when
verifying a release.

While iterating, run only what you are working on:
`node scripts/testing/run-backend-tests.mjs --only <substring>` (repeatable; the substring matches
the test file's name). A filtered run prints a loud `PARTIAL RUN` banner before and after the
results — **if you see that banner, the release gate did not run**, and never quote a filtered run
as a green suite. An `--only` that matches nothing fails, and so does a run whose summary reports
zero tests. **A read-only agent may run a focused `--only` run in its OWN worktree** (within the
**Parallel tests** limits below) — never the full gate, and never a competing lane in a shared
worktree. For every suite you cite, report the
actual exit status, the completion line, and the test count — a wrapper's exit code is not the
suite's, and "completed" is not "passed".
The lane's hang watchdog defaults to 180 minutes (`STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS`): the old
90-minute default was below the measured serial runtime (5,268–6,189 s) and killed a green 1.4.359
run at 850/854 files. If a run is killed by it, that is a machine setting, not a product defect —
raise the number, do not narrow the lane.

**Parallel tests — owner, 2026-10-24: "do that whenever possible."** This replaces the earlier
"one test suite at a time across all workers". Serial is now the exception, kept only where running
side by side has actually broken a result.

- **The Story release gate runs alone among Story suites.** While `npm run test:backend` or the
  full gate runs, start no other Story backend or frontend suite and no second Story DMG build.
  Timing-sensitive tests flake under load, and on 2026-10-24 a busy Mac failed gate A with zero
  failing tests. This is about OTHER suites: the backend lane now runs its own files in parallel,
  below, and that is the one concurrency it is built for.
- **The backend lane runs a bounded worker pool — owner, 2026-10-26: "do all 4 if possible so it's
  faster."** `run-backend-tests.mjs` deals the files across `min(4, cores/2)` worker processes
  (`STORY_STUDIO_BACKEND_TEST_WORKERS` overrides), each worker one file at a time with its own
  process, its own HOME/TMPDIR sandbox and its own coverage file, then runs a named **serial list**
  alone at the end. The pool replaces "the gate runs its files one by one"; the gate still runs
  alone among Story suites. Every invocation is judged by the same proofs as before — its own node
  summary, its own coverage floor — and a split run also prints
  `aggregate suite coverage: C/D file(s) completed; inputs=[...]`, which
  `story_gate_proof.py` requires the per-invocation lines to add up to exactly.
  **Not yet proven (2026-10-27):** until one serial run (`STORY_STUDIO_BACKEND_TEST_WORKERS=1`) and
  one pooled run on the SAME commit agree, the release gate of record runs with
  `STORY_STUDIO_BACKEND_TEST_WORKERS=1`; delete this sentence when they do.
- **The serial list is measured, never guessed.** A file joins `SERIAL_TEST_FILES` for one of two
  reasons, and its entry says which: it FAILED while other files ran and passed when rerun alone
  (the 2026-10-24 shape), or it asserts a WALL-CLOCK ceiling or an exact interval-fire count, which
  is load-sensitive by construction. A guess, a hunch or a slow stopwatch is neither.
  `STORY_STUDIO_BACKEND_SERIAL_TESTS` adds names for one run; it can never remove one. Anything
  that flakes in a proof run moves to the list and the run is repeated.
- **A slow file is fixed at its cause, not by deleting its assertion.** The waiting comes out
  through a seam the code already has — `_setJobAutoRetryDelaysForTesting` (the 60 s/300 s free-fleet
  retry schedule), `_setGenStudioPollLadderForTesting` (the 1 s poll floor), the existing
  `STORY_STUDIO_*_RETRY_BASE_MS` overrides — or a shared fixture, never by shrinking a fixture until
  a test stops proving what it was written to prove.
- **Alongside a Story gate, these are allowed:** Studio Hub and GatewayKH test modules, static
  checks (typecheck, lint, `py_compile`, `git diff --check`), and builds of other repos.
- **With no gate running:** up to two focused (`--only`) Story runs at once, in different
  worktrees, and Hub and Gateway modules freely in parallel, since each test uses its own temp data.
- **Never in parallel:** two runs in the same worktree; installer tests (they share `_trash`);
  anything that touches the real mini, the live Gateway, or production.
- **A failure that looks timing-related while something else was running** (a timeout, a sleep, an
  empty evidence manifest, a killed child): rerun that file alone before treating it as a defect,
  and say in the report that it ran alongside other work.

**Installer tests never touch the real install.** Every installer test copies the real script into a
private temporary project with its own source, target and trash, so it cannot read, move or remove
the owner's `_trash/app` or replace the app in `/Applications`. Keep that property in any new
installer test: never point one at the real `/Applications` or the owner's `_trash/app`. The release
lane's `install-local` case needs `dist/mac-arm64/Story Studio KH.app`, which is why the prebuild
happens before the gate (see Releases).

**Live test work never sits inside `_trash`.** Backend, frontend, release and retained-filesystem
contract fixtures use `.test-work/` (gitignored). Content-pack staging needs a path outside the
checkout, so that lane uses `../.test-work/<checkout-name>/`. `STORY_STUDIO_TEST_WORK_ROOT` may
name another real directory outside Trash. Only after children close and evidence is reconciled
may finished containers move to `_trash/test-fixtures/` (or `STORY_STUDIO_RETAINED_FIXTURES_ROOT`).
Removing the retained root mid-run is safe; removing or replacing a live work directory fails the
run loudly and stops its owned test process group. Do not use Trash for a test's own live fixtures.

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
version, newest changelog entry, and What's New details differ.

The order is **prebuild → ten-step gate → rebuild from `main`**, and it is not optional:

1. **Prebuild in the release worktree:** `npm run dist:smoke` (unsigned smoke check) or
   `npm run dist:public` (signed/notarized candidate). The release lane's `install-local` test
   needs `dist/mac-arm64/Story Studio KH.app`, so the gate fails without this build.
2. **Run the ten-step gate** on that exact source (see **Tests** above for the runner and what its
   proof enforces).
3. **Integrate, then rebuild from `main`.** After verified application/desktop work is on `main`,
   build the final DMG from the **main** checkout. The artifact belongs in the repository-root
   `dist/`; verify its versioned `arm64` filename and the bundled `app.asar` version against
   `main`, and never copy a worktree-built DMG into `main`'s `dist/` before its source is
   integrated.

## Working rules

- **Every removal goes to this project's `_trash/` — never `rm`.** This covers *all*
  of it, not only what the owner asks for: a file he names, and equally a file you
  decide is clutter while cleaning up. Move it into `_trash/` (create the folder if
  absent), keep any sub-structure, and say where it went. `_trash/` itself is his to
  sort out: never delete or tidy anything *inside* it. The one thing that is not a
  file is a Git branch or remote ref — record its name and SHA in a note under
  `_trash/` before deleting it, and never rewrite published history.

- **Every change is merged, committed, pushed, and built into a DMG — and the previous DMG moves
  to `_trash/dist/` automatically.** The owner's rule, 2026-09-26: **the whole cycle every time**,
  not only for something you would call a release — nothing ships un-gated, un-built or un-pushed.
  Bump `package.json` **and** `package-lock.json`, add the newest-first `CHANGELOG.md` entry, run
  `npm run check:changelog`, prebuild with `npm run dist:smoke`, run the ten-step gate on that
  source, land it on `main` through the `land/<version>-into-main` flow, rebuild the DMG from
  `main`, and push. **A change is not finished while any of those is missing.**
  **Batch, do not dribble — owner, 2026-10-26: "do all 4 if possible so it's faster."** Put related
  changes into one release and run **one full gate per release batch** (focused runs first for every
  area the batch touches). Batching never excuses narrowing the gate.
  `scripts/release/build-unsigned-dmg.mjs` moves the previous DMG aside itself — that line used to be
  `fs.rmSync(dmgOutputPath)`, so a rebuild of the same version destroyed the previous artefact — which
  means `dist/` holds exactly the build you just made and `_trash/dist/` holds the history, with no
  tidy-up step for anyone to remember.
  **The one exception is a content-only change**: a standalone `.sspack` is its own artefact and takes
  no app version bump and no DMG (the release classification in §10). That is a deliberate carve-out,
  not an oversight.

- **Every release updates `docs/tasks/HANDOFF.md`.** Read it first in a new session,
  and keep it current: the version, anything newly learned, anything newly forbidden,
  and what is still open. A stale handoff is worse than none, because it is trusted —
  if it disagrees with the code, the code wins and the file gets fixed.
