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

## 7. Related records kept elsewhere

- **`docs/genstudio-handoff/`** — everything Story Studio is waiting on from GenStudio, plus the
  wiring notes. Disposable by design; closed items move to `docs/handoffs-retired/`.
- **`docs/planning/`** — the speed and responsiveness audits, with measured baselines.
- **`CHANGELOG.md`** — the shipped-fix record, newest first. The in-app What's New reads it.
- **The test suite** — where most of these rules are actually enforced. When a rule here and a test
  disagree, the test is what runs; fix one of them deliberately.
