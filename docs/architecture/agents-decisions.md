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
opened on 1–3 s and needed 20–30 s — so it wins. Since 2026-10-26 that Sleep Formula declares
four tiers rather than one band (below); every other built-in niche still declares nothing, so the
seeded standard tiers are what they start on. The preset is seeded either way, and is available by
name on every channel.

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


### A SLEEP channel's starting rhythm is four tiers — owner decision, 2026-10-26

> *"Sleep pacing, for ALL sleep channels from now on: 0–3 min a scene every 5–10 s; 3–5 min every
> 10–20 s; 5–10 min every 20–30 s; after 10 min every 50–60 s. Applies whether the motion is stills
> or Sketch Draw. Delivered as the Sleep Formula's starting rhythm, so every episode can still
> change it in Scene Plan (AGENTS §5). Never rewrite stored episode or project data."*

| episode time | a new scene every |
| --- | --- |
| 0–180 s | 5–10 s |
| 180–300 s | 10–20 s |
| 300–600 s | 20–30 s |
| after 600 s | 50–60 s |

The fourth tier is what the 2026-10-19 standard did not have. A sleep episode runs 90–180 minutes,
so past ten minutes a 20–30 s cadence is still thousands of stills for a scene that is deliberately
not changing much; holding one picture for nearly a minute costs fewer generations and is what the
owner actually wants on screen for the long tail of a mix.

**The shape is the existing one.** `starting_scene_pacing` is a series-formula document field whose
value is the `VariableScenePacing` shape from `electron/server/contracts/pacing.ts` — ordered periods
over the narration timeline, the same shape Scene Plan's **Visual timing & motion** panel writes into
`continuity.json` and the planner reads through `pacingBandAt`. Nothing new was invented for the
tiers: `StartingScenePacingSchema` (`electron/server/content-packs/schemas.ts`) validates the same
rules `parseScenePacing` enforces (first period at zero, contiguous, only the last open, 1–60 s per
scene), `contentPackDocumentToNiche` (`electron/server/content-packs/legacy-adapters.ts`) maps it onto
`Niche.startingScenePacing` (`electron/server/models/types.ts`), and
`startingDefaultsFromFormula` (`electron/server/services/formula-starting-defaults.ts`) copies it
once into a NEW channel's `config.json` `default_scene_pacing` — the key `readProjectStartingPacing`
already read. When a Formula declares both `starting_scene_pacing` and `starting_scene_seconds`, the
tiers win; the band stays valid for every other Formula.

**Who carries it.** The five Sleep-family Formulas, each shipped as a successor because published
bytes are frozen: Sleep Story 1.0.3, Sleep History Compilation 1.0.2, Calm Science for Sleep 1.0.1,
Mythology for Sleep 1.0.1, Illustrated History for Sleep 1.0.1 (registry reserved at revision 327,
authored at 328–332). Each replaced `starting_scene_seconds` with `starting_scene_pacing`, so the
document states one starting rhythm rather than two. The built-in
`electron/server/niches/sleep.json` carries the same tiers, because it is what an alias answers when
the Store Formula is not installed, and the answer must not depend on which pack a Mac has.

**What did not change, on purpose.** The 2026-10-19 owner standard tiers stay exactly as they were
for a channel whose Formula names no rhythm — Sleep is the more specific choice and wins, it does not
become the app-wide default. An episode's saved `continuity.json` pacing still beats both, through the
same `claim_pacing` boundary. No stored channel or episode is rewritten: `createProject` seeds only a
NEW channel, `POST /projects` overwrites only that new channel's key, and the successor packs change
nothing a customer already installed. The seeded **"Owner standard pacing"** preset is not touched by
a Formula's starting pacing — it is still the 2026-10-19 standard, and the timing panel is where an
episode's rhythm is actually chosen.

**The five successor packs carry their own floor, because the schema is strict.** A series-formula
document is validated with a strict schema, so an older build does not silently ignore
`starting_scene_pacing` — it rejects the pack. Each successor therefore declares an explicit
`min_app_version: "1.4.361"` in `pack.json` and `min_app_version_status: "fixed"` in its registry
record (`validate` refuses the two disagreeing), which is how a single pack states a floor without
moving everyone's: `content-packs/release-floor.json` is substituted into EVERY pack, so raising it
would hide 50+ Formulas and the Custom Looks from 1.4.359/1.4.360 for no reason (coordinator,
2026-10-26). The previously published versions stay installed and untouched on every build. This is
why the change is an **application release**, not content-only: a pack version is content-only only
when the released runtime already supports its kind *and schema*.

**Tests.** `electron/server/__tests__/formula-starting-defaults.test.ts` now pins the tiers on the
built-in niche and on all five pack sources, and keeps the precedence checks (tiers over band, band
over the seeded standard, an episode's own pacing over everything).
`electron/server/__tests__/sleep-tiered-starting-pacing.test.ts` pins each boundary — 179.9 s is
still 5–10 s, 180 s is 10–20 s, 299.9 s is 10–20 s, 300 s is 20–30 s, 599.9 s is 20–30 s, 600 s and
every later moment are 50–60 s — plus contiguity, the open final tier and the "never cuts faster as
it lengthens" direction. `scripts/content-packs/__tests__/free-starter-inventory.test.mjs` pins the
seven 1.0.3 roots (six of them the 2026-10-25 modernization's, previously unpinned).

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

### Sound & Labels: one page, one auto-approve, one readiness answer (2026-10-28)

The owner approved merging Contextual Cues and Sound Design into **one page, Sound & Labels**.
Phases P1–P3 are built; P4 (an EmbeddingGemma ranker choosing sounds) is a documented hook, not
built.

**Why the merge.** Two pages for two optional layers of the same moment. The audit found the pair
failing in each other's blind spots: the sound page's PUT answered `validation: []` while its GET
validated with `requireResolved`, so a page could report "ready" for a cue the renderer refused;
each page had its own idea of where a cue sits; and both stored absolute seconds that a Scene Plan
re-run left pointing at the wrong scene.

**What did NOT change, and must not.** The two file names (`contextual_cues.json`,
`sound_design.json`), the two project config keys, the two preset types, and the job type and step
id of the `contextual_cues` job — queued jobs, history and Pipeline links all name it. Both old
pages are redirects and both old API paths answer 410 with the new address in `detail`.

**One auto-approve switch.** The project-level `contextual_cues.auto_approve_cues` is deleted. The
preset's `auto_approve` is the only one, for the reason 2026-08-17 already settled (§5). A stored
channel config still carrying the old key is read safely and ignored: nothing rewrites it, and
`normalizeContextualCueConfig` does not carry it through, so a stale `true` cannot start approving
cues nobody asked to approve. **Do not restore the field to "support" old configs** — that is the
defect, not the fix.

**Nothing optional blocks Video Assembly.** An unreviewed, missing or turned-off item is silence
(or no label) plus a stated note; approved items render. This replaces a hard gate that refused the
whole episode over one unreviewed cue. Only a defect approving cannot fix still refuses, and it
refuses from the same resolver the Production Board reads: a label outside its scene, one shorter
than 2.25s, two approved labels crowding, two approved beds overlapping. `resolveRenderable*` is the
single answer — do not add a second opinion anywhere.

**A page READ reports; it never refuses.** `routes/sound-and-labels.ts` catches the resolver's
refusal into `readiness.*.refuses` and still returns every row, because a 400 hides the very row
that needs fixing. The renderer keeps refusing for itself.

**Anchors, not absolute seconds.** A v2 cue carries `scene_id` + `anchor_word`, and
`contracts/cue-anchor.ts` finds the phrase in this episode's own subtitle cues — so a label lands
where the narration says it rather than at a fixed pad (`scene start + 0.15s` was the complaint).
Re-anchoring happens on READ, so no save path can certify a stale time. **A cue with NO anchor
keeps the seconds it was saved with** (`unanchored` in `resolveAnchoredStart`): every v1 file is
that case, and re-deriving it to the scene start would move every delivered episode's labels the
first time a plan was rebuilt. Nothing rewrites a stored v1 file; a save writes v2.

**What the gates cannot see, from this change.** The route-order bug (fixed-path routes declared
below `/:episodeId`, so "config" was read as an episode code) and the "Scene undefined" fallback
both passed typecheck, lint and every unit test. Both were found by running the page against a real
isolated Library — the same lesson §3 already records.

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

### Video expansion: multi-lane motion & T2V approved (2026-10-26)

AGENTS §7 previously mandated image-to-video only and strictly forbade text-to-video modes or UI
controls. On 2026-10-26, the owner approved the video expansion plan (`memory/video-expansion.md`,
`_orchestra/video-expansion-20261026/PLAN.md`):

1. **Multi-lane motion**: scenes choose between still, Sketch Draw (local), AI image-to-video, AI
   text-to-video, and imported clips. One motion type is not enough.
2. **Text-to-video at Scene Plan**: T2V is a deliberate per-scene editorial choice. T2V scenes get a
   video prompt (channel style + action + camera) and are reviewed in Motion Review. A cheap backup
   still is generated for every scene as a safety net.
3. **Running-time video share in Motion Review**: mix control operates as a share of total running
   time (10–100%), filled via formulas (opening hook, key moments, spread).
4. **Planned model clip bounds**: Scene Plan respects the planned model's min/max duration. If the
   model changes, Motion Review flags scenes outside the range and offers re-plan or fill (chain/hold).
5. **Encode-once clips**: clips are normalized once on arrival so final video assembly copies matching
   streams instead of re-decoding and re-encoding.
6. **Paid models added but not used**: only Wan 3.0 and Seedance 2.5 via the Gateway, with every
   option read live from capability records. Nothing is charged by default, and nothing in tests.

### Model inventory and its named exceptions — 2026-10-11 and 2026-10-27

**Inventory and dispatch belong to GenStudio.** The Add Custom Model form, a project-level `models`
catalog, `is_custom` entries and a unified catalog write path were removed, along with direct Studio
Hub and sibling-Studio routing. Story Studio talks to exactly one endpoint and must never be handed
a second address. Two narrow exceptions were decided; neither is a generation endpoint:

- **Idea real sources (2026-10-11, plan Q4).** `services/reference-pool.ts` makes free, read-only
  GETs to `en.wikipedia.org` — no key, no model, at most one request a second, a non-personal
  User-Agent, cached, failing soft. Generation is never routed there.
- **Optional local duplicate screening (2026-10-27).** `google/embeddinggemma-2` (Apache-2.0) runs
  inside Story's own process, not on the fleet and not through the Gateway, to warn about
  near-duplicate scene images and repeated titles. It starts OFF and is never required: uploading
  without it works as before, and when it is off, not downloaded or broken every check reads "not
  checked", never "passed". On opt-in, `services/local-model-store.ts` fetches the pinned ONNX
  export from `huggingface.co/onnx-community/embeddinggemma-2-ONNX` (one immutable revision) plus
  the darwin-arm64 slice of `onnxruntime-node` from `unpkg.com`, each file verified against a pinned
  size and SHA-256. It is a model-file download only — no generation request, no provider selection
  or routing, no second endpoint. The model is not in the DMG (≈970 MB of weights, ≈46 MB runtime);
  removing it moves the files to Story's Trash, never `rm`.

### Other retired surfaces — why the list is closed

The Co-writer, shared Brand profile system, Add Custom Model form and Render Studio remain retired.
The older retired list also said `text-to-video`; the owner's explicit 2026-10-26 multi-lane approval
above supersedes that entry. AI text-to-video is now a deliberate Scene Plan lane, not a retired
capability. Title prefix/suffix branding, branded intro visuals, project art styles, and Video
Assembly logo/presentation controls remain valid independent project controls. Story Studio does not own the writing model (2026-10-17); the
Gateway does. Model retirements are by id, in one list per app, never by display name. Sora 2,
Runway Gen-3 and the local LTX-2.3/Lance/Gemma-3-12B packs are deleted from code, docs, tests and
rules; stored project data still reads safely and is never rewritten.

---

## 8. Related records kept elsewhere

- **`docs/genstudio-handoff/`** — everything Story Studio is waiting on from GenStudio, plus the
  wiring notes. Disposable by design; closed items move to `docs/handoffs-retired/`.
- **`docs/planning/`** — the speed and responsiveness audits, with measured baselines.
- **`CHANGELOG.md`** — the shipped-fix record, newest first. The in-app What's New reads it.
- **The test suite** — where most of these rules are actually enforced. When a rule here and a test
  disagree, the test is what runs; fix one of them deliberately.

## 9. Release verification — change-aware policy and watchdog history

**Owner, 2026-11-08: "there's no point in rerunning the same test over any over again."** The
change-aware policy replaces the mandatory ten-step gate as the default: the cheap checks (lint,
changelog, typography, security, model-drift, typecheck) plus the packaged launch/update smoke on
one exact source, focused regressions for every changed path and its callers, and an honest record
of what ran, what was reused (with its source commit) and what was skipped. Full regression stays
required when the reach cannot be bounded — shared queue, storage or generator infrastructure;
dependencies, toolchain, signing, installer or test-harness changes; a broad refactor — or when the
last full-run proof is missing. A skipped suite reads "skipped (unchanged since <commit>)", never
"passed".

**The publisher historically required the ten-step schema-1 proof.** It binds exact HEAD/tree/diff,
actual exits, re-derived log hashes and discovered coverage floors, and rejects `PARTIAL RUN` as
full-suite evidence. Those integrity requirements remain; repeating unrelated suites merely to
satisfy that old format does not. Developer owns `~/Developer/portfolio/bin/testctl` as the one
executor and receipt store; there is no second Story runner. Story configures its affected lanes
there, scopes `paths` only after reviewing all test inputs, and keeps publisher verification as an
adapter citing receipt key, source commit and log SHA-256.

**Adapter status at candidate `0f565217b` (recorded 2026-11-10).** The shared-library bridge is
integrated: portfolio `b07f416` merged git-preflight hardening with the qualified proof adapter, and
`9713509` requires exact named-lane proof coverage with no waivers. Story side, `054b6a9` replaced
the never-qualified WIP schema-3 verifier with a thin caller-supplied trusted-CLI adapter
(`scripts/release/orchestration/story_testctl_proof.py`, proof kind `testctl-change-aware`, schema
2); `story_gate_proof.py` refuses the old kind and bare schema 3 at publication. Integrated is not
released: no Story release has yet been proven through the bridge, so an unsupported scoped proof
stays blocked rather than bypassing verification or relabelling a failed or superseded run. The
standalone change-aware reference in `c20ed497` (`scripts/release/change-aware/`, branch
`work/change-aware-release-20261108`) is retained as research only — it was never deployed, and no
release, rule or tool may be pointed back at it or copy from it. Core changes go to Developer's
portfolio branch for merge.

**The hang watchdog is 180 minutes** (`STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS`). The old 90-minute
default sat below the measured serial runtime (5,268–6,189 s) and killed a green 1.4.359 run at
850/854 files. A kill by this watchdog is a machine setting, not a product defect: raise the
number, do not narrow the lane.

**Parallel tests (owner, 2026-10-24: "do that whenever possible")** replaced "one suite at a time
across all workers". The Story full regression runs alone among Story suites; the backend lane deals
files across `min(4, cores/2)` workers (`STORY_STUDIO_BACKEND_TEST_WORKERS` overrides), each with
its own process, HOME/TMPDIR sandbox and coverage file, then runs a measured `SERIAL_TEST_FILES`
list alone. A split run prints `aggregate suite coverage: C/D file(s) completed; inputs=[...]`,
which `story_gate_proof.py` requires the per-invocation lines to add up to exactly. A serial entry
is measured, never guessed: it failed while other files ran and passed alone, or it asserts a
wall-clock ceiling or exact interval-fire count. Slow files are fixed through an existing seam
(`_setJobAutoRetryDelaysForTesting`, `_setGenStudioPollLadderForTesting`,
`STORY_STUDIO_*_RETRY_BASE_MS`) or a shared fixture, never by deleting the assertion. With no gate
running, up to two focused runs may share different worktrees; installer tests and anything touching
the real mini, live Gateway or production never run in parallel. A timing-looking failure that ran
alongside other work is rerun alone before being called a defect.

**Released installers keep a rollback pair — owner, 2026-11-10, candidate `0f565217b`.** The old
rule said `scripts/release/build-unsigned-dmg.mjs` moved the previous DMG to `_trash/dist/` itself,
so `dist/` held only the build just made. That made a rebuild of the same version destroy its own
predecessor (the line used to be `fs.rmSync(dmgOutputPath)`) and left no working installer if the
new one failed acceptance. Both desktop builders now stage and verify new output before exposing it,
replaced same-version candidates are backed up recoverably rather than deleted, and the released
pair stays in place while a candidate is unverified. Rotation of the retained pair happens only
through `npm run dist:retain -- <trusted-story-pins.json>`, which runs the shared portfolio helper
(`portfolio/tools/release-dist.py`); it manages only the pair it recorded, and unmanaged historical
aliases need their own recoverable retirement after dependency and active-job checks. Never rotate
an artifact some build or release is still using. See `scripts/release/orchestration/README.md`.
