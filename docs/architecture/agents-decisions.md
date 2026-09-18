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
  real project ended up at 4–8s, none of it chosen.** *(This incident is now superseded for
  `pacing` only, by the owner's 2026-08-18 reversal — see §5.)*
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

### `pacing` is preset data again — reinstated 2026-08-18

**The owner reversed the 2026-08-03 exclusion himself, and this is his call to make.** He was shown
the original incident, including the 50 of 53 episodes, and was offered a safer alternative — a
separate, explicit bulk pacing action that could never fire as a side effect. He declined it and
chose the full reversal:

> *"Put pacing back in presets."*

**Do not "fix" this back.** A reader who thinks scene rhythm has wrongly crept into presets is
looking at a deliberate 2026-08-18 decision, not a regression.

The reversal is scoped to `pacing`. Two things did **not** change: `use_episode_sheet` and `sheet`
stay excluded (he asked about rhythm only, and widening a reversal past what was asked is not
licensed by it), and the exclusion mechanism itself is unchanged — `usePresets` still strips
excluded keys on read as well as write, and stored preset files are still never rewritten.

**The mirror-image trap.** Because `usePresets` stripped `pacing` on **save** as well as load, every
preset saved between 2026-08-03 and 2026-08-18 contains no `pacing` at all — for anyone who kept
working through August, that is most of them. Un-excluding the key alone would let
`normalizeContinuityConfig` fall back to `DEFAULT_SCENE_PACING` and reset the customer's chosen
rhythm to 1–3s: the same discard as the original incident, in the other direction. Hence the rule
in both directions: a preset that **stores** a rhythm applies it; a preset that stores **none**
leaves the live rhythm untouched, and a half-written band (one end missing) counts as none.
**The Character Sheet says which of the two happened**, because a rhythm that correctly does not
move is indistinguishable on screen from a feature that does not work.

`storedPresetPacing` / `applyContinuityPagePreset` in
`frontend/composables/useContinuityConfig.ts` own this, and
`frontend/__tests__/continuityPresetPacing.test.ts` asserts both directions. That test file was
**rewritten, not deleted** — it carries the reversal's date and reasoning at the top so the next
reader can see this was decided rather than quietly dropped.

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
