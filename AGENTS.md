# Codex Notes

Rules for working in Story Studio KH; each is imperative and in force.

**The evidence — incidents, dates, owner quotes and the code that owns each rule — lives in
[`docs/architecture/agents-decisions.md`](docs/architecture/agents-decisions.md).** Read it to know
*why*, or before concluding a rule is wrong. Where a rule records a reversed owner decision, it
says so: "fixing" it back would revert a deliberate call.

---

## 1. Everything follows the selected model

**The first rule. It outranks convenience everywhere.**

Nothing about a model may be hardcoded, copied or cached past the moment the selection changes.
GenStudio publishes what each product can do; Story Studio reads it live and re-reads on every
change — never guessing, remembering a catalogue number or inferring capability from a name.

On a model change, **all** of these recompute immediately — not on reload, not on next launch:
`max_prompt_characters` and any warning derived from it · `context_window_tokens`,
`max_output_tokens`, and the available-input budget that falls out of them · price and credit cost
for every unit (per image, per video variant, per 1,000 TTS characters, per second of transcription,
per million chat tokens) plus promotions and `chargeable` · `supports_reference_images`,
`min_reference_images`, `max_reference_images` · aspect ratios, resolutions, durations, modes, voice
tiers and languages — every published option list · capability flags such as `supports_seed`,
`supports_vision`, `supports_web_search`, `structured_output_mode`, `controls[]`.

Forbidden, concretely: a constant, ladder or option list duplicating something GenStudio publishes
(generate it) · persisting a limit into a draft, preset or project config (persist the **selection**
— model id, chosen allowance — and re-clamp fresh limits on load) · a value computed once into
component state and not recomputed (if a model switch can invalidate it, it needs a watcher) ·
inventing a fallback when GenStudio publishes nothing (show nothing, disable the control, or fail
loudly — never a number the customer mistakes for the model's own) · converting a token budget into
a character or word limit by a fixed ratio (the units differ and the ratio is not stable; use the
published character figure).

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
- **GenStudio is the only authority.** Never infer, derive or reconstruct a provider from a model
  id, a name pattern or anything else. Unpublished means show nothing.
- **Provider is display, never dispatch.** Do not select, prefer, rank or route by provider, and
  send no provider field on any generation request. Showing who served a request must never become
  a control for who serves the next one.
- Read live on every selection change; never cached past it.

## 3. Bugs the gates cannot see

**Every gate can be green while the app is visibly broken.** Three shapes recur:

1. **Layout that overflows its container.** No test sees geometry — content passing an assertion
   says nothing about whether it is reachable.
2. **CSS that silently does nothing.** A declaration that loses is indistinguishable from one never
   written. Check specificity in the *built* CSS, not from source; `:deep()` on a teleported dialog
   never matches at all.
3. **Dev wiring that points somewhere plausible but wrong.** Confirm *which* server answered before
   believing its error.

Therefore: prefer a screenshot over another test run when the complaint is visual or "it won't
load". `npm run dev` makes that loop fast — frontend saves hot-reload, `electron/` changes recompile
but need a relaunch. When you add a gate, say what it **cannot** catch.

## 4. Episode-specific state must not survive an episode change

**The most expensive defect class in this repo** — six recorded instances of a value from one
episode reaching another. It arrives by several routes (a preset, a stale selection, an
`if (source)` default), so **an exclusion list is not the safety net**.

- **An episode change REPLACES the field, or blanks it.** `if (newValue) field = newValue` with no
  else is this defect spelled optimistically. Never leave the previous episode's value standing.
- **Ownership is a fact to look up, not a string to parse.** The backend already returns this
  episode's own file list; membership decides ownership.
- **Re-resolve only when the new value is derivable** (the same kind of artifact in this episode's
  own folder); otherwise blank. Losing the customer's selection on every switch is its own defect.
- **Announce it** — what was dropped, what replaced it, and when a field was cleared. A value that
  changes under the customer without a word is the quiet version of the same fault.
- **Generators must refuse foreign input too.** Refuse in preflight rather than substituting when
  choosing the artifact is an editorial decision; silently repair only when exactly one answer is
  correct.

## 5. Presets carry reusable settings, nothing else

**A preset restores the thing it is named for and never quietly re-decides anything else.** Apply
the test at the **field** level — split a mixed object rather than judging the whole by its
dominant half. Include reusable look or configuration (style bible, negative prompt, transitions,
duration, enabled state, overlay appearance and blending); exclude episode-specific state (anything
naming or depending on one episode's files, images, anchors or runtime window); a deliberate choice
made elsewhere is the owner's call — raise it, do not rule from the code.

**Decided exceptions — do not "fix" these back:**

- `pacing` **is not** in Character Sheet presets. Scene Plan's **Visual timing & motion** panel
  owns the episode's rhythm; Scene Review reads it back from the plan, and the Character Sheet's
  old scene-rhythm notice was deleted with the exclusion.
- **The save boundary carries the other half.** A whole-config save keeps the `pacing` already on
  disk **unless its payload claims it** (`claim_pacing: true`); Scene Plan's timing panel is the
  only writer that claims, so a save that does not claim cannot move the rhythm, including one
  written later. Do not "fix" a page by making it stop sending `pacing`: `buildContinuityConfig`
  substitutes the 1–3s default for an absent value — the 2026-08-03 incident with the sign flipped.
- `auto_approve` **is** in Contextual Cues presets, and the page announces it every time a preset
  sets it — in both directions. `use_episode_sheet` and `sheet` **stay excluded** (the anchor
  defect is separate). Title-image settings — enabled state, duration, transition type and
  duration — may remain in Video Assembly presets.

**Two traps, binding either way:** `usePresets.excludeKeys` strips on read as well as write, so
changing an exclusion is only half a fix — a normaliser default can discard the live value, and
un-excluding fails too because presets saved during the exclusion never stored it. Carry the live
value across the apply explicitly and test for its real presence, not the merge. **Never rewrite
stored presets or project data:** a since-excluded key is stripped **at the boundary**, before
`apply` sees it, and files on disk are untouched.

**Scene rhythm stays per-episode — nothing may decide it for the customer.** No project setting,
Content Series Formula or visual style may choose an episode's rhythm; the Character Sheet neither
shows nor owns it. Scene Plan's own preset may carry a rhythm because that panel owns it, and at
the save boundary it is the only writer that claims.

**A NEW channel's starting rhythm is a starting value only; an existing channel is never
rewritten.** An episode reads it until it saves its own rhythm in Scene Plan's **Visual timing &
motion** panel, and every episode may still change it. Do not delete the seed or extend it beyond
what an episode can change.

- **Standard (owner, 2026-10-19):** 0–180 s a new scene every 5–10 s · 180–360 s every 10–20 s ·
  after 360 s every 20–30 s. `createProject` seeds `config.json` `default_scene_pacing` plus a
  Scene Plan preset named **"Owner standard pacing"**, marked last-used. A Formula naming its own
  starting scene length wins as the more specific choice.
- **Sleep channels (owner, 2026-10-26):** 0–3 min every 5–10 s · 3–5 min every 10–20 s · 5–10 min
  every 20–30 s · from 10 min every 50–60 s. The five Sleep-family Formulas carry it as
  `starting_scene_pacing`, and built-in `electron/server/niches/sleep.json` does too, so the answer
  does not depend on the installed Formula. When both are declared, `starting_scene_pacing`
  supersedes `starting_scene_seconds`; these tiers decide nothing for a non-sleep channel.
- The seeded preset names **no writing model** — a model is a live GenStudio choice (§1) — so
  Pipeline preflight counts a preset with no writing model as **no usable preset** and leaves the
  step out with a plain message (`PRESET_MODEL_READERS` in `routes/pipeline.ts`), rather than
  enqueuing it to fail inside its generator.

## 6. A zero that means two things is a defect

**Never let "the answer is none" and "I could not work out the answer" produce the same value.**

- Use a typed measurement (`measured | unmeasurable`), not a number doubling as an error.
- **Adding the honest type is half a fix.** Move the callers that matter onto it and **delete, not
  deprecate**, the flattening wrapper, so no future caller can reintroduce the silent zero.
- **Match filenames on what they END with.** `startsWith(base)` claims every sidecar anyone writes
  beside the file.
- **A test asserting `0` cannot fail when the function always returns `0`.** Pin *which* zero it
  is, and pin at least one non-zero.

## 7. Boundaries — what belongs where

**Scene vs thumbnail.** Separate surfaces; never re-merge them. Preset keys are
`thumbnail_prompts_*` / `thumbnail_generator_*` for thumbnails and `scene_prompts_*` /
`scene_generator_*` for scenes, each with `_presets` and `_last_preset`; `image_prompts_*` and
`image_generator_*` are legacy compatibility only, never primary keys for new UI or Pipeline
selectors. The Pipeline step `image_prompts` picks its mode from the active format: classic
chapter-distributed scene-image formats may run `mode: "all"`; B-Roll, timestamp-driven,
continuity-chain and narrated-scenes must run thumbnails only (`mode: "thumbnails"`), because their
scene prompts come from Scene Plan.

**Video.** Video is a multi-lane feature, and each scene names its own lane: **still · Sketch Draw
(local) · AI image-to-video · AI text-to-video · reference-to-video · an imported clip**. One kind
of motion is not enough; Sketch Draw is one option among several, not the only one.

- **Capabilities come live from the Gateway** (§1): published durations, resolutions, aspect
  ratios, start/end-frame and reference support, audio switches, price basis and controls. Nothing
  is hardcoded, remembered or inferred from a name; a row the Gateway cannot describe is not
  offered.
- **A scene's lane is an editorial choice.** T2V is chosen deliberately at Scene Plan (per scene or
  episode); a T2V scene is reviewed in Motion Review, has a cheap backup still, and must assemble
  as a clip when available. Scene Plan writes a **video prompt** for T2V and a **motion prompt**
  for I2V; neither is optional for its lane.
- **Scene Plan respects the planned model's clip length.** Read min/max duration live and plan
  every video scene inside it. If the model changes, Motion Review flags misfits and offers
  re-plan or fill (chain or hold).
- **Every image lane uses the exact scene image for its stable scene number.** A missing image is a
  **blocking error** for still, Sketch Draw and image-to-video — never permission to reuse another
  scene's image.
- **Reference-to-video may use only this episode's own character images** (§4: ownership is looked
  up in the episode's own file list, never parsed from a path), and the generator refuses foreign
  input in preflight.
- **Mix control belongs to Motion Review.** The per-episode video share (10–100% of running time)
  and its selection formula (opening hook, key moments, spread) are resolved there; the remainder
  becomes stills or still+Sketch Draw. Cost and time are shown before anything is spent.
- **Paid models are added but not used.** Only Wan 3.0 and Seedance 2.5 via the Gateway, every
  option read live. Nothing is charged by default, and nothing in tests.
- **Legacy is deleted, not renamed.** Sora 2, Runway Gen-3 and the local LTX-2.3/Lance/Gemma-3-12B
  packs are gone from code, docs, tests and rules; stored project data still reads safely and is
  never rewritten (§5).
- **Clips must not slow assembly.** A clip is normalised once then copied where possible
  (encode-once); a motion episode's assembly time is measured against a stills-only episode.

Model retirements are by **id**, in one list per app, never by display name.

**Model inventory.** Do not restore the Add Custom Model form, a project-level `models` catalog,
`is_custom` entries, or a unified catalog write path. Inventory and dispatch belong to GenStudio;
do not restore direct Studio Hub or sibling-Studio routing. Story Studio talks to **exactly one**
endpoint and must never be handed a second address.

**Named exceptions to the model-endpoint rule (owner 2026-10-11 and 2026-10-27):**

- **Idea real sources.** `services/reference-pool.ts` makes free, read-only GETs to
  `en.wikipedia.org` — no key, no model, at most one request a second, a non-personal User-Agent,
  cached, failing soft. Never route generation there.
- **Optional local duplicate screening.** *Duplicate screening* (Settings → This Mac) runs
  `google/embeddinggemma-2` (Apache-2.0) inside Story's own process, not on the fleet or through
  the Gateway. It starts OFF and is never required: uploading works exactly as today, and when it
  is off, not downloaded or broken every check reads **"not checked"** — never "passed", never a
  blocker. On opt-in, `services/local-model-store.ts` fetches the pinned ONNX export from
  `huggingface.co/onnx-community/embeddinggemma-2-ONNX` (one immutable revision) plus the
  darwin-arm64 slice of `onnxruntime-node` from `unpkg.com`, each file verified against a pinned
  size and SHA-256. It is a **model-file download only**: no generation request, no provider
  selection or routing, no second endpoint. The model is not in the DMG; removing it moves the
  files to Story's Trash, never `rm`.

**Final Video Assembly — remote through the one paired Gateway (owner, 2026-10-23).**
`private_final_render` is off by default and owner-only. Render locally whenever remote is off,
unavailable or refused, and say why. A remote result passes the same import checks as a local
render (hash, media, loudness, shared final checks) and never replaces an accepted final. Still
retired: Render Studio selection and credit charging for FFmpeg work on the customer's Mac. The
owner chose to use it before formal qualification and fix what breaks; a first use goes to an
episode with no accepted final.

**Visual style packs.** Use the `story-studio-visual-style-adoption` skill and author exactly one
standalone pack; `frontend/composables/useVisualStyleCatalog.ts` is the only frontend consumer — no
static list, no offline fallback. Each style needs a registry-issued qualified id, searchable
metadata, a render-ready `style_bible`, a `negative_prompt`, and **exactly three distinct verified
1672x941 WebP previews — no more, no fewer (owner, 2026-10-25)** — in its own pack `assets/`: the
hero (card image, `preview_assets[0]`), a quiet wide scene with no figure, and the hardest legal
case for the style (owner, 2026-09-08 and again 2026-10-24;
`content-packs/PREVIEW-BACKFILL-2026-09-08.md`). The Style Library shows them all. Generate original
previews with Qwen Image 2.1 turbo for consistency (owner, 2026-10-24) — never copy composition or
depend on generated captions. Legacy `builtin-*` ids may remain only inside existing project-local
`style_presets` and historical migration evidence.

**Generator model defaults.** Restore the user's last explicit choice before the picker mounts;
never hardcode a paid model as the form default. If the remembered model is gone, let the live
inventory choose a usable fallback and persist that healed choice. **Owner, 2026-10-27 — Settings →
Default models** keeps one model per generation family for this Mac and is the LAST link of one
chain read at use time only: the preset's saved model → the page's remembered choice → this default. Never write the
default into a preset, channel config or remembered form, and never remember a defaulted value as
the customer's choice. A default that has left the catalogue is reported by name and leaves the
field empty — never swapped for another product.

**Retired — do not restore.** The Co-writer feature (page, navigation, API routes, local-storage
stores, completion dependencies) · the shared Brand profile system (`/brands`, `brand_id`, Brand
routes and storage, Brand-level prompt, voice, logo, pronunciation, art-style, metadata or format
overrides) · the Add Custom Model form · Render Studio · the per-run Pipeline
writing-model override — the "Models for this run" picker and the `model_policies` batch field.
**Owner, 2026-10-17 — Story Studio does not own the writing model:** a run uses the model its
active preset names, and the Gateway owns any fallback across its pool. The new Pipeline admission reads no `model_policies`;
only compatibility readers for already-queued jobs remain (`pipelinePolicyForJob`, the checkpoint
readers, `params.model`). Independent project controls remain valid: title prefix/suffix branding,
branded intro visuals, project art styles, and Video Assembly logo and presentation controls.

## 8. Verified completion contract

Every generation flow must **prove** its output complete before a job, pipeline step, Production
Board cell or one-click run reports success.

- A generator returning without throwing is not evidence: audit the authoritative files, manifests,
  expected item IDs and usable content.
- Preserve valid partial outputs, but fail the job **loudly** when any required item is missing,
  empty, stale, malformed or failed at its provider, naming the items and how Retry/self-healing
  repairs them without repeating completed work.
- Compare expected versus present artifacts. Never treat directory existence, one matching file, a
  stale derivative, a legacy fallback or `progress = 100` as proof.
- Generator, Job Queue, Pipeline, Production Board, pending filters and downstream gates share the
  same rule.
- Optional steps are skipped only through explicit project configuration; a skipped optional step
  is not missing, and a required step with partial output is never done.
- New generators and material changes need regression tests for complete, partial, empty, stale,
  malformed, provider-failure and retry/self-healing outcomes.
- When auditing generation code, search for swallowed per-item errors, warning-only failures,
  unconditional `progress = 100`, and executors that return after partial work.

## 9. Research

An optional evidence-quality workflow. It must **never** block generation, Pipeline preflight,
Production Board completion or `all_done` — no project gate, no `research_required` setting.

- **Exactly ONE** research decision per claim: `Verified` (keep) or `Ignore` (drop), with `Verify
  all` / `Reset` / `Ignore all` bulk actions. Research-level state is **derived** — reviewed when
  there is at least one claim and none is `unreviewed`; usable when at least one was kept. No
  second attestation.
- Generating or regenerating research resets every claim to `unreviewed` and drops the review
  record (`withResearchUntriaged()`), because nobody has read the new claims — honest workflow
  state, not a gate.
- Reviewed-but-nothing-kept is legitimate: it reports `research_reviewed: true` with
  `research_has_usable_claims: false`, says so plainly, and leaves every downstream workflow
  available.
- Evidence is artifact-based (`isResearchComplete()`): real summary text or a real claim — never a
  directory, file presence, raw count or stored attestation. Claim triage stays visible alongside
  it.
- No wording anywhere — UI, job log, `research.md`, error — may say the user or app checked claims
  against cited sources. Say what happened: a person reviewed model-generated claims and chose
  which the script may use. Where a claim carries no citation, show that absence.
- Opt-in as a one-click Pipeline stage. When selected, Pipeline auto-completes still-pending claims
  and records `review.completed_by: 'pipeline-auto'`, never `'human'`, and never overwrites a
  completed human triage — including a deliberate all-ignored result.

## 10. Working in this repo

**Delegation — owner ruling, 2026-09-20.** Act as the orchestrator: own planning, architecture,
independent review, verification and integration. Delegate bounded work with a base commit, owned
files, deliverable and proving checks. In the Codex runner, prefer Luna for straightforward tasks,
Terra for involved cross-file work, and Sol at no more than high reasoning for data-integrity,
security and lifecycle work — this supersedes earlier Luna-only or unrestricted model-selection
guidance; other runners use their own model menu. Run independent tasks concurrently without overlapping edits. Use Ponytail and
Graphify, verify against current source, reproduce uncertain bugs before fixing, and choose the
smallest complete solution. Keep updates concise and separate verified results from limitations.
Workers must not recursively delegate, commit, push, merge, publish, deploy or make paid calls
unless assigned that authority. Fan tests out whenever safe — see **Parallel tests**.

**Tests — change-aware, owner-approved 2026-11-08.** Every release runs the cheap checks on one
exact source — `lint`, `check:changelog`, `check:typography`, `check:security`, `check:model-drift`,
`typecheck` — plus the packaged launch/update smoke. Changed-area regressions run the focused
suites for every affected path and review their callers. The verification record names the changed
paths and selected tests, reports each test's actual completion line and count, and lists every
omitted suite with its reason. Exact-source and log-hash integrity and actual completion of every
selected test remain mandatory; an omitted suite is reported honestly, never implied to have
passed.

Full regression — every backend and frontend suite plus release and content-pack lanes — is
required when the change's reach cannot be safely bounded (shared queue, storage or generator
infrastructure; dependencies, toolchain, signing, installer or test-harness changes; a broad
refactor) or the last full-run proof is missing. Reuse earlier passing checks when source, tests,
dependencies and toolchain are unchanged, naming the source commit. A skipped suite reads "skipped
(unchanged since <commit>)", never "passed". The ten-step `story-final-gate` runner at
`_orchestra/app-closeout-20261021/story-final-gate-tools/run-gate.sh <worktree> <evidence-dir>` is
the full fallback and never becomes a narrowed claim.

**Execution and receipts use `~/Developer/portfolio/bin/testctl`; Developer owns its core.**
Configure Story's lanes there, scope `paths` only after confirming their complete inputs, and keep
`ship-story` verification as an adapter citing receipt key, source commit and log SHA-256. No second
runner. Story's adapter now lives in this repo (`scripts/release/orchestration/story_testctl_proof.py`,
proof kind `testctl-change-aware`) over the shared portfolio core (library integration `b07f416`,
exact named-lane coverage `9713509`); proofs carrying the never-qualified old schema-3 format are
refused at publication. The bridge is integrated but **no Story release has been proven through it
yet** — preserve the publishing checks and report an unsupported scoped proof as blocked rather than
bypassing verification. Never label a failed or superseded run passed, or rerun unrelated suites
merely to satisfy the old proof format. The earlier standalone runner research (`c20ed497`,
`scripts/release/change-aware/`) is retained **undeployed** on `work/change-aware-release-20261108`:
never revive it, copy it or point a release at it.

While iterating, run only what you are working on:
`node scripts/testing/run-backend-tests.mjs --only <substring>` (repeatable; matches the test
file's name). A filtered run prints a loud `PARTIAL RUN` banner — **that means focused, not a
full-suite proof**, and it is never quoted as a green suite. An `--only` matching nothing fails, as
does a run reporting zero tests. **A read-only agent may run a focused `--only` run in its OWN
worktree** (within **Parallel tests** limits) — never the full regression, never a competing lane in
a shared worktree. For every suite you cite, report its actual exit status, completion line and
test count — a wrapper's exit code is not the suite's, and "completed" is not "passed". The lane's
hang watchdog defaults to 180 minutes (`STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS`); a kill by it is a
machine setting, not a product defect — raise the number, do not narrow the lane.

**Parallel tests — owner, 2026-10-24: "do that whenever possible."** Serial is the exception, kept
only where side-by-side has broken a result. The Story full regression runs alone among Story
suites. The backend lane runs its files in a bounded pool of `min(4, cores/2)` workers
(`STORY_STUDIO_BACKEND_TEST_WORKERS` overrides) and then a measured `SERIAL_TEST_FILES` list;
`STORY_STUDIO_BACKEND_SERIAL_TESTS` adds names for one run only. A serial entry is measured, never
guessed: it failed while other files ran and passed alone, or it asserts a WALL-CLOCK ceiling or
exact interval-fire count. A slow file is fixed at its cause through an existing seam, never by
deleting its assertion. With no gate running, up to two focused (`--only`) runs may share different
worktrees; Hub/Gateway modules run freely in parallel. Never in parallel: two runs in one worktree,
installer tests (they share `_trash`), or anything touching the real mini, live Gateway or
production. A timing-looking failure while other work ran is rerun alone before being called a
defect. Full mechanics and the aggregate-coverage proof: decisions doc.

**Long tests run outside the app — owner, 2026-10-31.** Run release verification and other long
jobs through `_orchestra/tools/run-detached.sh <name> <script>`, then read `<name>.exit` and the
log. Verification runs alone as under **Parallel tests**. When the changed-area set cannot be
established, run the full regression. A launchd job has no app behind it for macOS privacy answers,
so a test opening a protected folder can hang: point such paths at temp dirs, and never change
privacy settings to answer it.

**Every release refreshes the graphs — owner, 2026-10-31.** `_orchestra/tools/refresh-graphs.sh`,
detached, beside the changelog step. A worker uses `_graphs/<app>/graphify-out/graph.json` and asks
for a refresh when it is missing or older than its code; never "if a graph exists".

**Test isolation.** Installer tests copy the real script into a private temporary project with its
own source, target and trash, so they never read, move or remove the owner's `_trash/app` or replace
the app in `/Applications`; keep that property in any new installer test. The release lane's
`install-local` case needs `dist/mac-arm64/Story Studio KH.app`, hence the prebuild. Live fixtures
use `.test-work/` (gitignored); content-pack staging uses `../.test-work/<checkout-name>/`, and
`STORY_STUDIO_TEST_WORK_ROOT` may name another real directory outside Trash. Finished containers
move to `_trash/test-fixtures/` (or `STORY_STUDIO_RETAINED_FIXTURES_ROOT`) only after children
close and evidence is reconciled; removing the retained root mid-run is safe, but removing a live
work directory fails the run loudly and stops its process group. Never use Trash for a test's own
live fixtures.

**Releases.** Classify first.

- **Application release** — any code shipped inside Story Studio (fixes, reliability,
  UI/API/runtime behaviour, dependency updates, migrations): bump the version in **both**
  `package.json` and `package-lock.json` in the same change set.
- **Content-only** — a standalone Content Pack whose kind and schema are already supported ships as
  its own `.sspack`: no app version bump, changelog entry, DMG, deploy or restart. Use the released
  compatibility floor in `content-packs/release-floor.json`.
- **Mixed** follows the application path only for the runtime behaviour it changes; do not force
  unrelated compatible packs into an app release.

Add the newest-first `## vX.Y.Z` entry to `CHANGELOG.md` (the source of in-app **What's New**) and
run `npm run check:changelog`; the release is incomplete if the runtime version, newest entry and
What's New details differ.

**The whole cycle, every time — owner, 2026-09-26.** Every change is merged, committed, pushed and
built into a DMG, and the latest two verified released installers stay in canonical `dist/` (owner,
2026-11-10) — nothing ships un-gated, un-built or un-pushed. **A change is not finished while
any step below is missing.**

The order is **prebuild → release verification → rebuild from `main`**, and it is not optional:

1. **Prebuild in the release worktree:** `npm run dist:smoke` (stable local signing and isolated
   launch) or `npm run dist:public` (signed/notarized candidate). Verification including
   `test:release` needs this build.
2. **Run release verification** on that exact source (see **Tests**). Use the full ten-step
   regression only when a trigger above applies; preserve source identity and evidence integrity.
3. **Integrate, then rebuild from `main`.** Build the final DMG from the **main** checkout into the
   repository-root `dist/`; verify its versioned `arm64` filename and bundled `app.asar` version
   against `main`, and never copy a worktree-built DMG into `main`'s `dist/` before its source is
   integrated. Land it on `main` through the `land/<version>-into-main` flow, then push.

**Batch, do not dribble — owner, 2026-10-26: "do all 4 if possible so it's faster."** Put related
changes into one release and run **one release verification per batch** (focused runs first for
every area touched). Batching never turns a narrowed run into a full-suite claim; full regression
still applies when a trigger above requires it. Both desktop builders stage and verify new output
before exposing it; replaced same-version candidates are backed up recoverably, never deleted, and
the released rollback pair stays while a candidate is unverified. After installed functional
acceptance and active-job/dependency checks, `npm run dist:retain -- <trusted-story-pins.json>`
invokes the shared portfolio helper — it alone manages its recorded pair, and unmanaged historical
aliases need separate recoverable retirement after dependency checks (see
`scripts/release/orchestration/README.md`). **The one exception is content-only**: a standalone
`.sspack` takes no app version bump and no DMG (see the classification above) — a deliberate
carve-out.

**Removals and history — Story-specific.** Every removal goes to this project's `_trash/` — never
`rm` — keeping any sub-structure, and say where it went. `_trash/` itself is the owner's: never
delete or tidy anything *inside* it. A Git branch or remote ref is not a file: record its name and
SHA in a note under `_trash/` before deleting it, and never rewrite published history.

**Every release updates `docs/tasks/HANDOFF.md`.** Read it first in a new session, and keep it
current: the version, anything newly learned or forbidden, and what is still open. A stale handoff
is worse than none because it is trusted — if it disagrees with the code, the code wins and the file
gets fixed.
