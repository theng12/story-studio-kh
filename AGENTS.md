# Codex Notes

Rules for working in Story Studio KH; each is imperative and in force. The evidence behind a rule —
incidents, owner quotes, the code that owns it — is in
[`docs/architecture/agents-decisions.md`](docs/architecture/agents-decisions.md); read it before
concluding a rule is wrong. Where a rule records a reversed owner decision, "fixing" it back would
revert a deliberate call.

**Delegation (owner 2026-11-10).** Invoke the global `efficient-orchestration` skill for multi-step
coordination after required ponytail, and follow
[Efficient delegation and parallel work](/build/Developer/_orchestra/developer-handoff/LEAD-RULES.md#efficient-delegation-and-parallel-work).
Leads own complete bounded implementation/check/review/fix outcomes and brief workers with required
skills, graph queries, exact working folders, source and owned files. Run independent source/light
work in parallel; serialize only conflicting writers, the KH Apps heavy-job schedule and conflicting
target actions. This supersedes blanket one-app parks; existing permission, release, device, security,
paid/public and Production holds remain.

## 1. Everything follows the selected model

**The first rule. It outranks convenience everywhere.** Nothing about a model may be hardcoded,
copied or cached past the moment the selection changes. GenStudio publishes what each product can do;
Story Studio reads it live and re-reads on every change — never guessing, remembering a catalogue
number or inferring capability from a name.

On a model change these recompute immediately, not on reload or next launch: `max_prompt_characters`
and any warning from it · `context_window_tokens`, `max_output_tokens` and the input budget that
falls out of them · price and credit cost for every unit (image, video variant, 1,000 TTS characters,
second of transcription, million chat tokens) plus promotions and `chargeable` ·
`supports_reference_images`, `min_reference_images`, `max_reference_images` · every published option
list (aspect ratios, resolutions, durations, modes, voice tiers, languages) · capability flags
(`supports_seed`, `supports_vision`, `supports_web_search`, `structured_output_mode`, `controls[]`).

Forbidden: a constant, ladder or option list duplicating something GenStudio publishes (generate it)
· persisting a limit into a draft, preset or project config (persist the **selection** — model id,
chosen allowance — and re-clamp fresh limits on load) · a value computed once into component state
that a model switch can invalidate (it needs a watcher) · inventing a fallback when GenStudio
publishes nothing (show nothing, disable the control, or fail loudly — never a number the customer
mistakes for the model's own) · converting a token budget into characters by a fixed ratio (the units
differ and the ratio is not stable; use the published character figure).

**A limit that is enforced must also be shown**, where the choice is made. Silently refusing on an
untold limit turns a clear constraint into a mystery error.

## 2. Provider transparency

Show which provider serves a model **wherever GenStudio publishes it**, in every modality. This
**supersedes** the earlier rule that stripped provider identity.

- Display the published fields (`provider`, `provider_id`, `provider_name`, `engine_id`,
  `engine_name`, `model_family`, `model_revision_id`); do not delete them at the backend boundary.
- **GenStudio is the only authority.** Never infer or reconstruct a provider from an id or a name
  pattern. Unpublished means show nothing. Read live on every selection change.
- **Provider is display, never dispatch.** Do not select, prefer, rank or route by provider, and send
  no provider field on a generation request.

## 3. Bugs the gates cannot see

**Every gate can be green while the app is visibly broken.** Three shapes recur: layout that
overflows its container (no test sees geometry) · CSS that silently does nothing (check specificity in
the *built* CSS, not the source; `:deep()` on a teleported dialog never matches) · dev wiring that
points somewhere plausible but wrong (confirm *which* server answered).

Prefer a screenshot over another test run when the complaint is visual or "it won't load"; `npm run
dev` makes that loop fast (frontend hot-reloads, `electron/` needs a relaunch). When you add a gate,
say what it **cannot** catch.

## 4. Episode-specific state must not survive an episode change

**The most expensive defect class in this repo.** It arrives by several routes (a preset, a stale
selection, an `if (source)` default), so **an exclusion list is not the safety net**.

- **An episode change REPLACES the field, or blanks it.** `if (newValue) field = newValue` with no
  else is this defect spelled optimistically.
- **Ownership is a fact to look up, not a string to parse** — the backend returns this episode's own
  file list; membership decides ownership.
- **Re-resolve only when the new value is derivable** (the same kind of artifact in this episode's
  own folder); otherwise blank. Losing the customer's selection on every switch is its own defect.
- **Announce it** — what was dropped, what replaced it, when a field was cleared.
- **Generators refuse foreign input too**, in preflight, rather than substituting; silently repair
  only when exactly one answer is correct.

## 5. Presets carry reusable settings, nothing else

**A preset restores the thing it is named for and never quietly re-decides anything else.** Judge at
the **field** level, splitting a mixed object rather than its dominant half. Include reusable look or
configuration (style bible, negative prompt, transitions, duration, enabled state, overlay appearance
and blending); exclude episode-specific state (anything naming or depending on one episode's files,
images, anchors or runtime window); a deliberate choice made elsewhere is the owner's call — raise it,
do not rule from the code.

**Decided exceptions — do not "fix" these back:**

- `pacing` **is not** in Character Sheet presets: Scene Plan's **Visual timing & motion** panel owns
  the episode's rhythm, Scene Review reads it from the plan, and the Character Sheet's old
  scene-rhythm notice was deleted with the exclusion.
- **The save boundary carries the other half.** A whole-config save keeps the `pacing` already on disk
  **unless its payload claims it** (`claim_pacing: true`); Scene Plan's timing panel is the only
  writer that claims, so a save that does not claim cannot move the rhythm. Do not "fix" a page by
  making it stop sending `pacing`: `buildContinuityConfig` substitutes the 1–3s default for an absent
  value — the 2026-08-03 incident with the sign flipped.
- `auto_approve` **is** in Contextual Cues presets and is announced in both directions;
  `use_episode_sheet` and `sheet` **stay excluded** (the anchor defect is separate). Title-image
  settings (enabled state, duration, transition type and duration) may stay in Video Assembly presets.

**Two traps, binding either way:** `usePresets.excludeKeys` strips on read as well as write, so
changing an exclusion is half a fix — a normaliser default can discard the live value, and
un-excluding fails because presets saved during the exclusion never stored it. Carry the live value
across the apply explicitly and test for its real presence, not the merge. **Never rewrite stored
presets or project data:** a since-excluded key is stripped **at the boundary**, before `apply` sees
it.

**Scene rhythm stays per-episode — nothing may decide it for the customer.** No project setting,
Content Series Formula or visual style may choose an episode's rhythm; the Character Sheet neither
shows nor owns it. Scene Plan's own preset may carry one because that panel owns it and is the only
claiming writer.

**A NEW channel's starting rhythm is a starting value only; an existing channel is never rewritten.**
An episode reads it until it saves its own in Scene Plan's **Visual timing & motion** panel, and every
episode may still change it.

- **Standard (owner 2026-10-19):** 0–180 s a new scene every 5–10 s · 180–360 s every 10–20 s · after
  360 s every 20–30 s. `createProject` seeds `config.json` `default_scene_pacing` plus a Scene Plan
  preset named **"Owner standard pacing"**, marked last-used; a Formula naming its own starting scene
  length wins as the more specific choice.
- **Sleep channels (owner 2026-10-26):** 0–3 min every 5–10 s · 3–5 min every 10–20 s · 5–10 min
  every 20–30 s · from 10 min every 50–60 s. The five Sleep-family Formulas carry it as
  `starting_scene_pacing`, and built-in `electron/server/niches/sleep.json` does too, so the answer
  does not depend on the installed Formula. When both are declared, `starting_scene_pacing`
  supersedes `starting_scene_seconds`; these tiers decide nothing for a non-sleep channel.
- The seeded preset names **no writing model** — a model is a live choice (§1) — so Pipeline preflight
  counts a preset with no writing model as **no usable preset** and leaves the step out with a plain
  message (`PRESET_MODEL_READERS` in `routes/pipeline.ts`).

## 6. A zero that means two things is a defect

**Never let "the answer is none" and "I could not work out the answer" produce the same value.**

- Use a typed measurement (`measured | unmeasurable`), not a number doubling as an error.
- **Adding the honest type is half a fix:** move the callers that matter onto it and **delete, not
  deprecate**, the flattening wrapper.
- **Match filenames on what they END with** — `startsWith(base)` claims every sidecar anyone writes
  beside the file.
- **A test asserting `0` cannot fail when the function always returns `0`:** pin *which* zero it is,
  and pin at least one non-zero.

## 7. Boundaries — what belongs where

**Scene vs thumbnail.** Separate surfaces; never re-merge them. Preset keys are `thumbnail_prompts_*`
/ `thumbnail_generator_*` for thumbnails and `scene_prompts_*` / `scene_generator_*` for scenes, each
with `_presets` and `_last_preset`; `image_prompts_*` and `image_generator_*` are legacy compatibility
only, never primary keys for new UI or Pipeline selectors. The Pipeline step `image_prompts` picks its
mode from the active format: classic chapter-distributed formats may run `mode: "all"`; B-Roll,
timestamp-driven, continuity-chain and narrated-scenes must run thumbnails only (`mode:
"thumbnails"`), because their scene prompts come from Scene Plan.

**Video.** Multi-lane, and each scene names its own lane: **still · Sketch Draw (local) · AI
image-to-video · AI text-to-video · reference-to-video · an imported clip**. Sketch Draw is one option
among several, not the only one.

- **Capabilities come live from the Gateway** (§1); a row the Gateway cannot describe is not offered.
- **A scene's lane is an editorial choice**, chosen at Scene Plan (per scene or episode). A T2V scene
  is reviewed in Motion Review, has a cheap backup still, and must assemble as a clip when available.
  Scene Plan writes a **video prompt** for T2V and a **motion prompt** for I2V; neither is optional.
- **Scene Plan respects the planned model's clip length** — read min/max duration live. If the model
  changes, Motion Review flags misfits and offers re-plan or fill (chain or hold).
- **Every image lane uses the exact scene image for its stable scene number.** A missing image is a
  **blocking error** for still, Sketch Draw and image-to-video — never permission to reuse another
  scene's image.
- **Reference-to-video may use only this episode's own character images** (§4) and refuses foreign
  input in preflight.
- **Mix control belongs to Motion Review:** the per-episode video share (10–100% of running time) and
  its selection formula (opening hook, key moments, spread); the remainder becomes stills or
  still+Sketch Draw. Cost and time are shown before anything is spent.
- **Paid models are added but not used.** Only Wan 3.0 and Seedance 2.5 via the Gateway, options read
  live; nothing is charged by default, and nothing in tests.
- **Legacy is deleted, not renamed.** Sora 2, Runway Gen-3 and the local LTX-2.3/Lance/Gemma-3-12B
  packs are gone from code, docs, tests and rules; stored project data still reads safely and is never
  rewritten (§5).
- **Clips must not slow assembly:** normalise once then copy where possible (encode-once), and measure
  a motion episode's assembly against a stills-only one.

Model retirements are by **id**, in one list per app, never by display name.

**Model inventory.** Do not restore the Add Custom Model form, a project-level `models` catalog,
`is_custom` entries, or a unified catalog write path. Inventory and dispatch belong to GenStudio; no
direct Studio Hub or sibling-Studio routing. Story Studio talks to **exactly one** endpoint.

**Named exceptions (owner 2026-10-11 and 2026-10-27):**

- **Idea real sources.** `services/reference-pool.ts` makes free, read-only GETs to `en.wikipedia.org`
  — no key, no model, at most one request a second, non-personal User-Agent, cached, failing soft.
  Never route generation there.
- **Optional local duplicate screening** (Settings → This Mac) runs `google/embeddinggemma-2`
  (Apache-2.0) inside Story's own process. It starts OFF and is never required; when off, not
  downloaded or broken, every check reads **"not checked"** — never "passed", never a blocker. On
  opt-in `services/local-model-store.ts` fetches the pinned ONNX export from
  `huggingface.co/onnx-community/embeddinggemma-2-ONNX` (one immutable revision) plus the darwin-arm64
  slice of `onnxruntime-node` from `unpkg.com`, each file verified against a pinned size and SHA-256.
  It is a **model-file download only** — no generation request, no provider selection, no second
  endpoint. Not in the DMG; removing it moves files to Story's Trash, never `rm`.

**Final Video Assembly — remote through the one paired Gateway (owner 2026-10-23).**
`private_final_render` is off by default and owner-only. Render locally whenever remote is off,
unavailable or refused, and say why. A remote result passes the same import checks as a local render
(hash, media, loudness, shared final checks) and never replaces an accepted final. Render Studio
selection and credit charging for FFmpeg work on the customer's Mac stay retired. A first use goes to
an episode with no accepted final.

**Visual style packs.** Use the `story-studio-visual-style-adoption` skill and author exactly one
standalone pack; `frontend/composables/useVisualStyleCatalog.ts` is the only frontend consumer — no
static list, no offline fallback. Each style needs a registry-issued qualified id, searchable metadata,
a render-ready `style_bible`, a `negative_prompt`, and **exactly three distinct verified 1672x941 WebP
previews — no more, no fewer (owner 2026-10-25)** — in its own pack `assets/`: the hero
(`preview_assets[0]`), a quiet wide scene with no figure, and the hardest legal case for the style
(`content-packs/PREVIEW-BACKFILL-2026-09-08.md`). The Style Library shows them all. Generate original
previews with Qwen Image 2.1 turbo (owner 2026-10-24); never copy composition or depend on generated
captions. Legacy `builtin-*` ids may remain only inside existing project-local `style_presets` and
historical migration evidence.

**Generator model defaults.** Restore the user's last explicit choice before the picker mounts; never
hardcode a paid model as the form default. If the remembered model is gone, let the live inventory
choose a usable fallback and persist that healed choice. **Owner 2026-10-27 — Settings → Default
models** keeps one model per generation family for this Mac, the LAST link of one chain read at use
time only: the preset's saved model → the page's remembered choice → this default. Never write the
default into a preset, channel config or remembered form, and never remember a defaulted value as the
customer's choice. A default that has left the catalogue is reported by name and leaves the field
empty — never swapped for another product.

**Retired — do not restore.** The Co-writer feature (page, navigation, API routes, local-storage
stores, completion dependencies) · the shared Brand profile system (`/brands`, `brand_id`, Brand
routes and storage, and Brand-level prompt, voice, logo, pronunciation, art-style, metadata or format
overrides) · the Add Custom Model form · Render Studio · the per-run Pipeline writing-model override
(the "Models for this run" picker and `model_policies`). **Owner 2026-10-17 — Story Studio does not
own the writing model:** a run uses the model its active preset names, and the Gateway owns any
fallback across its pool. Pipeline admission reads no `model_policies`; only compatibility readers for
already-queued jobs remain (`pipelinePolicyForJob`, the checkpoint readers, `params.model`).
Independent project controls remain valid: title prefix/suffix branding, branded intro visuals,
project art styles, Video Assembly logo and presentation controls.

## 8. Verified completion contract

Every generation flow must **prove** its output complete before a job, pipeline step, Production Board
cell or one-click run reports success.

- A generator returning without throwing is not evidence: audit the authoritative files, manifests,
  expected item IDs and usable content.
- Preserve valid partial outputs, but fail the job **loudly** when any required item is missing,
  empty, stale, malformed or failed at its provider, naming the items and how Retry/self-healing
  repairs them without repeating completed work.
- Compare expected against present artifacts. Never treat directory existence, one matching file, a
  stale derivative, a legacy fallback or `progress = 100` as proof.
- Generator, Job Queue, Pipeline, Production Board, pending filters and downstream gates share this
  rule. Optional steps are skipped only through explicit project configuration; a skipped optional
  step is not missing, and a required step with partial output is never done.
- New generators and material changes need regression tests for complete, partial, empty, stale,
  malformed, provider-failure and retry/self-healing outcomes. When auditing generation code, search
  for swallowed per-item errors, warning-only failures, unconditional `progress = 100`, and executors
  that return after partial work.

## 9. Research

An optional evidence-quality workflow. It must **never** block generation, Pipeline preflight,
Production Board completion or `all_done` — no project gate, no `research_required` setting.

- **Exactly ONE** decision per claim: `Verified` (keep) or `Ignore` (drop), with `Verify all` /
  `Reset` / `Ignore all`. Research-level state is **derived** — reviewed when there is at least one
  claim and none is `unreviewed`, usable when at least one was kept. No second attestation.
- Generating or regenerating research resets every claim to `unreviewed` and drops the review record
  (`withResearchUntriaged()`) — honest workflow state, not a gate.
- Reviewed-but-nothing-kept is legitimate: `research_reviewed: true` with
  `research_has_usable_claims: false`, said plainly, with every downstream workflow still available.
- Evidence is artifact-based (`isResearchComplete()`): real summary text or a real claim — never a
  directory, file presence, raw count or stored attestation. Claim triage stays visible alongside it.
- No wording anywhere — UI, job log, `research.md`, error — may say the user or app checked claims
  against cited sources. Say what happened: a person reviewed model-generated claims and chose which
  the script may use. Where a claim carries no citation, show that absence.
- Opt-in as a one-click Pipeline stage: Pipeline auto-completes still-pending claims and records
  `review.completed_by: 'pipeline-auto'`, never `'human'`, and never overwrites a completed human
  triage — including a deliberate all-ignored result.

## 10. Working in this repo

**Act as the orchestrator (owner 2026-09-20).** Own planning, architecture, independent review,
verification and integration. Delegate bounded work with a base commit, owned files, deliverable and
proving checks. Run independent tasks concurrently without overlapping edits. Use Ponytail and
Graphify, verify against current source, reproduce uncertain bugs before fixing, and choose the
smallest complete solution. Keep updates concise and separate verified results from limitations.
Workers must not recursively delegate, commit, push, merge, publish, deploy or make paid calls unless
assigned that authority. Fan tests out whenever safe — see the [test and release procedure](docs/operations/test-and-release-procedure.md).

**Test and release procedure.** The exact steps — cheap checks, change-aware and full regression
triggers, focused `--only` runs, parallel lanes, detached long runs, graph refresh, test isolation,
release classification, the prebuild → verify → rebuild-from-`main` cycle, batching and `dist:retain`
— live in [`docs/operations/test-and-release-procedure.md`](docs/operations/test-and-release-procedure.md).
That page is procedure; this file is the rules, and where they disagree about what must be true, this
file wins.

**Lifecycle — quit and delete release everything (owner 2026-11-12).** Quit stops the helper, unloads
the login job, frees the ports and leaves no orphan process. A second launch must not start a second
instance **and must not bring the existing window forward** — it reports and stays behind. Uninstall
removes the app, the helper, the launchd job and the login item and keeps the user's data:
`scripts/release/uninstall-local.sh`, which moves the app and the plist to a dated trash folder.

**Removals and history — Story-specific.** Every removal goes to this project's `_trash/` — never
`rm` — keeping any sub-structure, and say where it went. `_trash/` itself is the owner's: never delete
or tidy anything *inside* it. A Git branch or remote ref is not a file: record its name and SHA in a
note under `_trash/` before deleting it, and never rewrite published history.

**Every release updates `docs/tasks/HANDOFF.md`.** Read it first in a new session and keep it current:
the version, anything newly learned or forbidden, and what is still open. A stale handoff is worse
than none because it is trusted — if it disagrees with the code, the code wins and the file gets
fixed.
