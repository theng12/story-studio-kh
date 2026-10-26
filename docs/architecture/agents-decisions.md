# The evidence behind `AGENTS.md`

`AGENTS.md` states the rules. This file records **why** each one exists: the incident, the date,
the owner's own words, and the code that owns the rule.

You do not need this file to follow the rules. Read it when a rule looks wrong, when you are
tempted to "fix" one back, or when you are deciding whether a new case is covered by an existing
rule. Several entries below record a decision the owner **reversed**; those say so loudly, because
the cost of reverting one twice is a real customer incident.

---

## 1. Everything follows the selected model

The owner's most important rule. GenStudio publishes what each product can do; Story Studio reads
it live and re-reads on every selection change.

**Past violations, all real and all costly:**

- A Scene Plan output ladder capped at **32,768** against a model publishing **128,000** — the
  largest models could not be used at their published size.
- A synthesised image config asserting `supports_reference_images: false` for **every** model while
  silently dropping attached references and billing text-to-image.
- An invented steps contract GenStudio never published.
- A 4,000-character prompt cap overruling a published 4,800.
- A chunking threshold derived from a retired provider's 16,000-token cap.

**Where the rule bites hardest in practice:** a value computed once into component state and not
recomputed on a model switch. If a model change can invalidate a number, it needs a watcher — not a
default, and not a memo.

**Enforced-but-unshown is the same defect wearing a different hat.** The rule "a limit that is
enforced must also be shown" exists because a silent refusal on an unpublished limit reads to the
customer as a broken feature rather than a constraint.

**Related, and currently live:** `readPublishedTokenLimit` in `lib/genstudio-client.ts` normalizes
the wire's `null` onto Story Studio's `0` = "not published" sentinel. That is the one place the two
conventions meet, `null` never reaches arithmetic, and callers downstream are fail-closed on `0`
(`productCeiling` throws rather than inventing a ceiling). Do not "fix" it into a nullable type —
see `docs/genstudio-handoff/gateway-kh-story-studio-wiring.md`.

### Image ratios: a missing choice prefers 16:9 — 2026-10-17

**This reverses the earlier "never defaulted to '16:9' locally" rule.** The owner, 2026-10-17:
when no image ratio was chosen, generation should use 16:9 **if the selected live model publishes
it**; otherwise the model's own published default. The reported symptom was the opposite: the
provider's flagged 1:1 row silently filled Scene Review's empty picker.

The reversal does **not** license inventing anything. With `output_options[]` a real 16:9 ROW must
exist; when it does not, the default falls to the provider's published default (or its first live
option) and the UI states the constraint. An explicit ratio the model does not publish is still
refused loudly, and stored presets/project data are never rewritten — a remembered/preset 9:16 or
1:1 keeps winning while the selected model publishes it. The policy lives in
`electron/server/contracts/genstudio-image-defaults.ts`, shared by the frontend picker and the
backend resolvers; `image-model-resolver.ts` and `models/types.ts` point back to it. The picker
labels the Story-chosen row **Default** and a different provider-flagged row **Gateway default**,
so the two roles cannot be confused.

---

## 2. Provider transparency

**Owner's decision, 2026-08-01.** The product moved from hiding providers to being transparent
about them, across every modality — not voice alone. This **supersedes** the earlier rule that
treated provider and engine identity as private routing detail to be stripped before it reached
the customer.

The reversal did not weaken the boundary: GenStudio still owns provider selection entirely, and
Story Studio still sends no provider field on any request. Transparency means *showing what the
catalogue states*, never inferring it.

---

## 3. Bugs the gates cannot see

**2026-08-01.** Three real defects shipped or survived with backend, frontend, release, lint,
typography, security and model-drift all passing. Each was found in seconds by a person looking at
the screen.

**1. Layout that overflows its container.**
`VoiceLibraryBrowser`'s rows had no scroll container, so a long list was clipped by the panel and
the tail was unreachable (fixed **v1.0.774**). Later the same class at a different level:
`ModelMenu` anchored its panel to the trigger, so a field low in the window left no room and the
list collapsed to two or three visible rows (fixed **v1.0.778** by making every picker a centred
dialog). **No test can see geometry.** Assertions about content passing say nothing about whether
that content is reachable.

**2. CSS that silently does nothing.**
`Modal`'s scoped styles compiled to `.modal-dialog[data-v-…]` (0,2,0), so any consumer writing a
single class (0,1,0) lost without warning. Of four competing consumers only one won cleanly: one
lost outright, one won purely on byte order in the bundle, and one used `:deep()` on a
**teleported** dialog — which never inherits the consumer's scope id, so that rule could never
match at all (fixed **v1.0.779**). **A CSS declaration that loses is indistinguishable from one
that was never written.** Reasoning about scoped-style specificity from source is what produced
this; check the built CSS.

**3. Dev-environment wiring that points somewhere plausible but wrong.**
`nuxt.config.ts` proxied `/api` to port 8000 — which is **GenStudio's** gateway, not Story
Studio's backend. The app loaded and reported "the backend is probably busy with a big job", when
in truth the AI gateway was correctly answering 404 for a route it has never had. **A misleading
error message cost more time than a crash would have.**

**What follows:** screenshots are the fastest defect-finding tool for this app — prefer one over
another test run when the complaint is visual or "it won't load". `npm run dev` exists precisely so
that loop is fast (frontend saves hot-reload; `electron/` changes recompile but need the app
relaunched). When you add a gate, be explicit about what it **cannot** catch — `check:model-drift`
catches hardcoded catalogue values and nothing about rendering.

---

## 4. Episode-specific state must not survive an episode change

**The most expensive defect class in this repo: six recorded instances of one shape** — a value
belonging to one episode reaching a different episode. It arrived by a different route every time,
which is the point: **the exclusion list is not the safety net.**

The owner's rule, 2026-08-03:

> *"i want actions to be intentional, not swept in with bugs like this."*

### Instances one to three — the preset route (2026-08-03)

- **`title_image.image_path`** in Video Assembly timeline presets — an episode's own image restored
  onto a different episode.
- **`pacing`** in Character Sheet presets — the customer chose "1–3 seconds", applied a preset to
  set the **art style**, and silently got that preset's rhythm instead. **50 of 53 episodes in a
  real project ended up at 4–8s, none of it chosen.** *(That exclusion was lifted on 2026-08-18 and
  put back on 2026-10-17, for a different reason — the timing editor is Scene Plan's now. The key is
  excluded again, so the fix described here is the one in force; see §5 for all three dates.)*
- **`references.sheet`** in the same presets — ORed into `use_episode_sheet`, so applying any
  preset turned "Use episode anchor" **on**, pointing at a sheet that may not exist.

### Instance five — the stale-selection route, 2026-08-18

**`subtitles.srt_path` in Video Assembly was correctly excluded from presets and still put
EP0048's captions into EP0047's finished video.**

`EP0047_final_video.mp4` was 989.833s — EP0047's own merged audio to the frame — and the caption
burned at t=14s read "…At Timbuktu, that process has", cue #3 of EP0048's stitched SRT. **Nothing
restored that path.** `loadSubtitlesStatus()` refetched the file list on every episode change and
then wrote a default only `if (!subtitles.srt_path)`, so a selection that already existed was never
revisited. Three more fields on that one page carried the same `if (source) assign` /
`if (!x) x = …` shape.

**The generator must not accept a foreign path either.** `generateVideo` checked only `existsSync`
and burned whatever it was handed, so a browser-state bug became a finished video.
`prepareUnifiedVideoAssemblyInputs` now refuses a subtitle file outside the episode's own directory,
in preflight, before any encode. It **refuses rather than substituting**: it silently re-resolves
scenes and merged audio because each has exactly one correct answer, while *which transcript to
burn* is an editorial choice — and a silent repair would also hide the next frontend regression of
this kind forever.

### Instance six — an overlay's WINDOW, 2026-08-18 (v1.4.1)

**`overlays.layers[].time_range` rode in presets and survived episode changes.** The first time the
owner answered by **splitting one object** rather than including or excluding it whole.

> *"overlays should belong to episodes and can be in the presets because i might want to
> randomize the overlays effects."*

Two things that sound contradictory and are not:

- **The look is reusable taste** — which overlay file, opacity, scale, position, blend, chroma key,
  loop. It belongs in presets, and he wants to shuffle between them.
- **The window is one episode's runtime.** A 12-second flourish over the closing line of a
  16-minute episode lands mid-sentence in a 9-minute one. It travels nowhere.

That is why the test is applied at the **field** level, not the object level. What it required:

- **Both preset payloads, not one.** `effectsPresets` *and* the `video_bundle` fallback each carried
  the layers; fixing only the obvious one left the defect reachable by the other door.
- **Windows persist per EPISODE CODE**, in `overlay_time_ranges` on the project config, so a window
  can never be applied to an episode it was not measured against. Stripping them without giving
  them somewhere to live would have been data loss dressed up as a fix.
- **An episode change REPLACES every window**, or clears it to `null`.
- **A pre-1.4.1 preset's windows are RESCUED, not dropped** — adopted as the current episode's,
  never over one it already has, and announced once.

**Randomisation cannot reach the timing, structurally.** Because the window is not in the preset
payload, no shuffle over presets can touch it — the guarantee is a property of the data rather than
a rule a future randomiser has to remember. `overlayLayersForPreset` in
`frontend/utils/overlay-timing.ts` is the single place that decides what a preset carries, and
`frontend/__tests__/overlayTiming.test.ts` asserts it. **If you build that randomiser: vary the
look, leave the window alone.**

---

## 5. The decided exceptions, in full

### `pacing` left Character Sheet presets again — 2026-10-17

**The rule in force: `pacing` is NOT in Character Sheet presets.** This key has now moved three
times, so the whole history is recorded here — a reader who finds only one of the three will
conclude the code is wrong.

> *2026-08-03* — **excluded.** The owner set "Visual pacing" to 1–3 seconds, applied a preset to
> change the **art style**, and the preset's stored `pacing` replaced that choice: 50 of 53
> episodes of a live project ended up on a 4–8s band nobody picked.
>
> *2026-08-18* — **reinstated, by the owner**, with the incident in front of him. He was offered a
> safer alternative — a separate, explicit bulk pacing action that could never fire as a side
> effect — and declined it: *"Put pacing back in presets."*
>
> *2026-10-17* — **excluded again, by the owner.** The timing editor has since moved: scene rhythm
> belongs to Scene Plan's **Visual timing & motion** panel, and Scene Review reads the episode's
> rhythm back from the plan. The Character Sheet is a visual-setup page — cast, episode anchor,
> channel look — and a preset applied there must not move the episode's rhythm. He asked for the
> leftover to be cleaned up, having seen the green notice on that page, and the instruction
> explicitly overrides the 2026-08-18 entry.

**The notice was deleted, not reworded.** The Character Sheet used to show *"The preset includes
scene rhythm — it set 1–3 seconds on this page…"* / *"That preset has no saved scene rhythm…"*.
With `pacing` excluded there is nothing left for it to report, and a notice describing a setting
the page no longer owns is exactly the leftover being removed. Deleting the notice is the visible
half; the load-bearing half is that the exclusion is real in both directions.

**What did NOT change, in either reversal.** `use_episode_sheet` and `sheet` stay excluded — the
owner has only ever asked about rhythm. The exclusion mechanism is unchanged: `usePresets` still
strips excluded keys on read as well as write, and **stored preset files are still never
rewritten**. Presets that still carry a band — every one saved between 2026-08-18 and 2026-10-17
does — are stripped **at the boundary**, on the way in, before `apply` sees them.

**The mirror-image trap, which the 2026-10-17 change re-arms.** Because the strip happens on read
as well as save, a preset body arriving at `apply` has had `pacing` removed — and
`normalizeContinuityConfig` would then substitute its own `DEFAULT_SCENE_PACING` (1–3s) for every
preset. That is the 2026-08-03 incident with the sign flipped, and it is why the live rhythm is
carried across the apply **explicitly**, as one whole deep-cloned value rather than a field-by-field
merge: an ordered profile keeps its periods, and a half-written band can never be completed from
the default. The same carry protects the episode anchor and `motion_level`.

**Both sides of the boundary own it.** `CONTINUITY_PRESET_EXCLUDE_KEYS` (now including `pacing`) and
`applyContinuityPagePreset` in `frontend/composables/useContinuityConfig.ts` are the frontend half.
`applyContinuityPresetForPipeline` in `electron/server/routes/pipeline.ts` is the backend half: the
Pipeline's `character_sheet` step folds a saved preset into `continuity.json` inline, and it carries
`current.pacing` across for the same reason, so an unattended batch run cannot apply a stale band
either. `frontend/__tests__/continuityPresetPacing.test.ts` asserts all of it, and
`electron/server/__tests__/pipeline-visual-source.test.ts` covers the batch path. That test file has
been **rewritten, not deleted**, twice — it carries all three dates and the reasoning at the top so
the next reader can see each move was decided rather than quietly dropped.

**The preset payload is not where the rhythm is decided, so the rule is enforced where the file is
written.** Excluding the key stops a *preset* from carrying a rhythm; it does nothing about the other
way the same value arrives — the Character Sheet saves the whole config it loaded, so a rhythm set in
Scene Plan in between was written back from the stale copy. The exclusion was therefore only half the
fix, and the other half sits on the save boundary: `writeContinuityConfig` in
`electron/server/routes/continuity.ts` keeps the `pacing` already on disk **unless the payload claims
it**, the claim is `claim_pacing: true` (`PACING_AUTHORITY_CLAIM`), and `VisualTimingMotion.vue` is
the only writer that sends it. Only an explicit `true` claims, so a caller that gets the claim wrong
fails toward "the rhythm does not move". The read happens inside `withLock(sidecarPath, …)`, because
a plain read-then-write would still lose a timing save that landed in the gap between them. The
pipeline step and the Character Sheet claim nothing and are covered by the same rule — including any
page written later, which is the property that makes this root-complete rather than a second special
case. `electron/server/__tests__/continuity-pacing-ownership.test.ts` asserts the contract.

**What this does NOT fix, and must not be claimed to.** The other whole-config fields — anchors,
style bible, denoise, references — still revert on a stale save. That is the broader
episode-staleness family in §4, and the pacing-authority contract deliberately does not reach it.

**`storedPresetPacing` still exists, deliberately.** Scene Plan's own timing preset is the surface
that *does* carry a rhythm (`VisualTimingMotion.vue` → `applyPreset`), so the helper that reads a
stored band out of a preset body is still live and still needed. The exclusion is scoped to the
Character Sheet, not to `pacing`.


### A NEW channel's STARTING rhythm — owner decision, 2026-10-19

**The 2026-08-03 rejection was of a project-level default that DECIDES an episode's rhythm. This
adds a STARTING value, and the rule itself is untouched.**

> *"yes is my personally preference for each of the channels i run. i let production save those as
> preset. but you can also make this into a default for any new channels in the future. it's
> already built and read."*

The standard, tiered by episode time so a short episode cuts faster than a long one:

| episode time | a new scene every |
| --- | --- |
| 0–180 s | 5–10 s |
| 180–360 s | 10–20 s |
| after 360 s | 20–30 s |

**Nothing new was built for it.** The shape is the existing `variable` pacing — ordered periods over
the narration timeline (`ScenePacingPeriod[]` in `electron/server/contracts/pacing.ts`) — which is
exactly what Scene Plan's **Visual timing & motion** panel edits and what the planner already reads
through `resolveScenePlanPacing` and `pacingBandAt`. The owner's "it's already built and read" is
that structure; no second tier mechanism was introduced.

**Where it is seeded, and why there.** `createProject`
(`electron/server/services/project-manager.ts`) writes two things into a new channel's own
`config.json`, once, at creation:

- `default_scene_pacing` — the key `readProjectStartingPacing` already reads. Scene Plan plans on it
  and the timing panel shows it for any episode that has not saved a rhythm of its own
  (`defaultContinuityConfig(mode, startingPacing)`), so the channel's first episode opens on the
  tiers without a project setting ever *deciding* anything.
- a Scene Plan preset named **"Owner standard pacing"** (`type: 'scene-plan'`, `data.pacing` the
  same tiers, `motion_scope`/`motion_level` the same defaults `defaultContinuityConfig` uses),
  marked last-used via `scene_plan_last_preset_scene-plan`. The owner already keeps this preset by
  hand in production, so seeding it means a new channel opens Scene Plan on the preset he
  recognises instead of on "— none —".

The seed carries **no writing model**. A model is a live GenStudio choice (§1), and a channel must
not have one baked in by us; the owner picks one in Scene Plan and saves the preset there, exactly
as with a hand-saved preset. `electron/server/__tests__/new-channel-default-pacing.test.ts` pins
that too.

**Because it carries no model, Pipeline preflight had to learn the same fact.** Enqueuing a step
whose preset names no writing model only moved the failure into the generator — `scene-plan.ts`'s
`model is required` — minutes later, naming neither the step nor what to do. `admitStep`
(`electron/server/routes/pipeline.ts`) now counts such a preset as "no usable preset", through the
SAME `step_preset` safety switch and with the plain message *"Scene Plan has no writing model
chosen. Open Scene Plan and pick one."*, so the step is left out at preflight. The rule is a table,
`PRESET_MODEL_READERS`, not a Scene Plan special case: a step joins it and inherits the
classification, the message and the switch. `metadata` and `introduction-only` stay out of it — each
already has its own branch in the enqueue loop with an escape hatch the table cannot see (a carried
`pipeline_model_policy`, the channel's own opening model, the script-side model) and a plain message
of its own, and a step must not be reported twice. `script-only` is in it, reading the same two
shapes `resolveScriptSideChatModel` reads, so a preset the rest of the app can read is never called
model-less.

**Why this is not the 2026-08-03 rejection coming back.** That rejection was about a project setting
*choosing* the rhythm for an episode — *"it needs to be a deliberate choice on each episode by the
user."* This is what an episode **starts** on and it stays fully editable per episode in Scene Plan;
`electron/server/__tests__/new-channel-default-pacing.test.ts` proves the override path through the
same `claim_pacing` save boundary every other rhythm change uses. It also proves an existing channel
is untouched: creating a channel leaves another channel's `config.json` **byte-identical**, and a
channel that predates the seed and sets no rhythm still gets the one app-wide 1–3 s default.

**Precedence, decided rather than incidental.** `createProject` seeds the tiers, and a channel whose
Series Formula names its own starting scene length overwrites `default_scene_pacing` afterwards
(`seedFormulaStartingDefaults`, called by `POST /projects` after creation). The Formula is the more
specific, owner-chosen answer — it is the 2026-10-02 Dreamlands fix, where a Sleep channel had
opened on 1–3 s and needed 20–30 s — so it wins. Today only `electron/server/niches/sleep.json` sets
one. The preset is seeded either way, and is available by name on every channel.

**The trap this seeds around.** The `if (!existsSync(configPath))` block in `createProject` never
ran: the blank template already ships `electron/templates/blank/config.json`, so the copy placed one
first (the same trap `electron/server/__tests__/publishing-overview.test.ts` documents for
`publish_cadence`). Seeding inside that block would have looked correct and done nothing. The block
is now a merge that reads the template's config first, which is what makes the seed run on the real
creation path.

**Tests updated, not weakened.** `electron/server/__tests__/formula-starting-defaults.test.ts`
previously asserted that a channel with no Formula keeps 1–3 s — the decision this one supersedes —
and now asserts the tiers. `electron/server/__tests__/pipeline-visual-source.test.ts` covers "a
missing Scene Plan preset blocks only the row whose branch needs it", so it clears the seed
explicitly; its subject is the partial-success behaviour, not the absence of a preset. The same file
covers the model-less case end to end: the seeded channel's Scene Plan step is left out of the run
with the plain message and is **not** enqueued, while its sibling step still runs.


### `auto_approve` is preset data on Contextual Cues — decided 2026-08-17

The fourth instance of the shape, and the second the owner ruled on rather than had excluded.

The report: he applied his `Contextual Cues - DeepSeek` preset for its model and density and found
**Auto-approve safe proposals** switched on.

> *"i don't remember telling you that the it's preset for auto approved is being applied or not."*

The preset genuinely stores `auto_approve: true`, and the control's own label reads *"Off by
default. Use only after you trust this preset"* — so a preset chosen for one reason was
re-deciding a trust question. Shown the alternatives, he **declined removing it from the preset**
and chose announcement instead. **Do not "fix" this back by adding `auto_approve` to an exclude
list.**

The announcement is `WorkspaceNotice`, built on the scene-rhythm pattern, and symmetric: `true`
says the setting is now on and what that means; `false` says that too, because a silent switch-off
is the same defect in the opposite direction; **neither** leaves the live setting alone and says
nothing. That third case is the trap `storedPresetPacing` documents — the apply handler read
`data?.auto_approve === true`, which collapses "no opinion" into `false` and switches the setting
off for every preset saved before the field existed. `storedPresetAutoApprove` in
`frontend/utils/contextual-cues.ts` is what makes it expressible, and
`frontend/__tests__/contextualCuesAutoSave.test.ts` asserts all three. The notice is cleared by a
hand edit of the tick-box and by an episode change, and it never fires for the preset re-apply
`usePresets.load()` performs on mount — that is a restore, not a change the customer just made.

---

## 6. A zero that means two things

**Established 2026-08-18, after the second one shipped inside a month.**

`computeEpisodeIntroLeadInSec` returned `Promise<number>`, and every caller wrapped it in
`.catch(() => 0)` or a bare `catch {}`. When it began selecting the merge's
`{CODE}_merged_audio.completion.json` record instead of the track — a `startsWith` match that a
sidecar added in July started satisfying — it ffprobed a JSON file and returned 0. But 0 is also
the correct answer for an episode with no intro.

**Every episode merged after 2026-07-14 got a stitched timeline 16 seconds early**, with nothing in
any log to see, and every YouTube chapter timestamp on those episodes was early by the same amount.

`lib/intro-lead-in.ts` had already grown `IntroLeadInMeasurement` (`measured | unmeasurable`) in
**v1.3.2** for exactly this reason — but only the display path used it, while the timing path kept a
flattening wrapper. **Adding the honest type is half a fix; the callers that matter have to be moved
onto it.** `resolveEpisodeIntroLeadIn` replaces `computeEpisodeIntroLeadInSec`, and the
episode-level flattening wrapper is *deleted* rather than deprecated, so no future caller can
reintroduce the silent zero by reaching for the convenient signature. All three callers now state
the outcome — job log, toast, package warning.

(`computeIntroLeadInSec`, the pure path-plus-sections variant, survives for `computeStoryStartSec`,
whose callers resolve the merged file through the extension-filtered asset scanner and were never
exposed to this. Do not add new callers to it without deciding what an unmeasurable result means.)

**Two supporting rules, both paid for:**

- **Match filenames on what they END with.** `generators/video.ts`'s
  `/_merged_audio(?:_v\d+)?\.(mp3|wav|m4a)$/i` is the reference — and it also covers the `_vN`
  re-merge variants the prefix test rejected outright.
- **A test asserting a function returns 0 cannot fail when the function breaks by always returning
  0.** `intro-lead-in-episode.test.ts` had two tests, both asserting zero, both green throughout.

---

## 7. Boundaries — retired surfaces

### The per-run Pipeline writing model — retired 2026-10-17

"Models for this run" let one batch override the writing model of seven steps (research,
script-only, introduction-only, image_prompts, metadata, scene_plan, contextual_cues) through a
per-step picker, a `model_policies` batch request field, and a Story-side admission
(`normalizePipelineModelPolicies` → `validatePipelineModelCatalogue` → `assignedPipelinePolicy`,
writing `params.pipeline_model_policy` + `params.model`).

**Owner, 2026-10-17:** the picker overflows its step cards, and — the larger point — Story Studio
should not own the writing model at all. The Gateway already does. A run uses the model its active
preset names; falling back across several models is a Gateway pool the owner makes in
GatewayKH → Providers → Pools. The removal takes the whole surface: the picker and its dead CSS,
the `model_policies` request field, the admission and its catalogue validation, and the write-side
library helpers. **Do not restore it.**

**What was kept, deliberately.** Already-queued jobs carry `params.pipeline_model_policy` and
`params.model`, and their recovery is model-preserving and key-preserving
(`executePipelineModelPolicy`, the checkpoint readers, `pipelinePolicyForJob`). The removal *reads*
that state and never rewrites it — the same rule as §5's "never rewrite stored presets or project
data to compensate". The new admission simply never writes it.

### Final assembly on another owned Mac — local-only rule lifted 2026-10-23

AGENTS §7 used to say Final Video Assembly was local-only, with no remote-render fields or remote
assembly clients. 1.4.347 nonetheless shipped private fleet final rendering (`private_final_render`,
off by default; `services/final-render-transport.ts` and its staging, reconciler and importer). At
that point its build carried descriptor-only render provenance with `qualification: null`, so every
leaf was ineligible and renders stayed local — **a pre-2026-10-23 state, now superseded.**
Qualification back then would have needed a local launch on an idle 16 GB leaf that no authorized
channel could reach (`_orchestra/app-closeout-20261021/fleet-qualification/ACCESS-REVIEW-20261022.md`).

**Owner, 2026-10-23:** "can't we just acept that it work and use it? like do it. if it breaks we
fix it that way?" and "do update th erule too. that's outdated." The rule now allows remote final
rendering through the one paired Gateway. **The current gate is the live one, not a qualification
file:**

- **The installed build must carry paired descriptor pins** (`sameDescriptorPins` against the
  Gateway's profile/tools/compiler digests). A build with no pins or mismatched pins keeps the
  render local and says why.
- **The Gateway's live `execution_bounds` are checked before staging** (`privateFinalRenderBoundsViolation`
  in `preparePrivateFinalRenderDescriptor`): fps, canvas and byte bounds are read from the paired
  machine's own published profile, and a packet outside them stays local instead of being accepted
  and then refused 409 at the render boundary.
- **The encode must appear in the live qualified-encode list**; an unqualified encode stays local.

What does not move is that a remote result is accepted only through the same import checks as a
local render (hash, media, loudness, shared final checks), and it never replaces an accepted final.
Render Studio selection and FFmpeg credit charging stay retired.

---

## 8. Related records kept elsewhere

- **`docs/genstudio-handoff/`** — everything Story Studio is waiting on from GenStudio, plus the
  wiring notes. Disposable by design; closed items move to `docs/handoffs-retired/`.
- **`docs/planning/`** — the speed and responsiveness audits, with measured baselines.
- **`CHANGELOG.md`** — the shipped-fix record, newest first. The in-app What's New reads it.
- **The test suite** — where most of these rules are actually enforced. When a rule here and a test
  disagree, the test is what runs; fix one of them deliberately.
