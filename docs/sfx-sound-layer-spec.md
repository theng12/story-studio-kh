# Sound / SFX layer — universal, in Video Assembly — spec (draft)

Status: proposed. A **format-agnostic** sound layer that applies sound effects to
the finished video: **ambient beds** + **spot one-shots**, placed by timing and
mixed under the narration. An LLM "sound director" reads the **subtitle track**
(the one timing backbone every format produces) to propose cues; the user reviews
them on a script-aligned timeline; the existing SFX system resolves the clips;
the final render mixes them in.

This is **not** tied to the Scripted Stock B-Roll format. *Every* format that has
narration + subtitles gets it. See
[`scripted-broll-format-spec.md`](./scripted-broll-format-spec.md) for the
separate *visual* work; that format merely inherits this sound layer.

## Why it lives in Video Assembly (the common ground)

Every format converges on **Video Assembly** — `isBroll`, `isTimestampDriven`,
`isContinuityChain`, `isNarratedScenes`, scene-images, image-pool all end there
(the upstream pages differ, the final editor does not). It is the only surface
they all share, and it already has the exact bones:

- **Merged Audio is its primary, authoritative input** — the final audio mix
  already happens here. SFX layers on top of that, no second pipeline.
- **It already models a positioned timeline** — the existing **"Timeline Clips"**
  feature inserts user clips at named positions in the final render. Spot SFX is
  the audio analogue of that.
- **It already applies subtitles** and does the final FFmpeg render — so the
  timing source and the mix point are both right here.

The deciding constraint: the pipeline order is **Audio Assembly → Subtitles →
Scene Plan → Video Assembly**. Subtitle *timing* doesn't exist until after Audio
Assembly, so the smart placement **cannot** live in Audio Assembly (the LLM would
be placing blind). Video Assembly runs after Subtitles and is universal — so it
is the correct home.

> Surfacing: a new **"Sound / SFX" section** inside Video Assembly, alongside the
> existing Timeline Clips / Subtitles / Overlays / Effects sections. Not a new
> sidebar tab — it belongs on the timeline every format already uses.

## What already exists

- **SFX system (v1.0.481)** — the Assets Library has **audio (SFX) pools**:
  tagged, SSD-backed, shared across projects, with **Freesound fetch** +
  **ElevenLabs generate** already wired. This is the entire sound-sourcing
  backend.
- **Subtitle track** — per-chapter SRTs (Whisper / from-chapters / import),
  stitched by Scene Plan, with segment-level `start → end → text` timing.
- **Video Assembly** — merged-audio input, positioned Timeline Clips, subtitle
  application, and the final FFmpeg composition (the mix injection point).
- **broll-selector** no-repeat logic — reusable for SFX one-shots so the same
  "whoosh" isn't reused every beat.

New work is: the **SFX director LLM**, the **review timeline**, the **resolution
chain wiring**, and the **mix step** in the final composition.

## Two sound roles

- **Ambient bed** — a loopable atmosphere spanning a run of time ("city street
  night", "newsroom hum", "tense low drone"). Usually one at a time, low gain,
  cross-faded on change. Sets the scene.
- **Spot SFX (one-shot)** — a short effect anchored to a moment ("whoosh" on a
  transition, "cash register", "phone notification", "door slam"). Punctuation,
  not wallpaper.

## Data flow

```
Subtitle track (timed segments) ──┐         ┌─ Scene/clip list (optional,
                                  │         │   when the format has one)
                                  ▼         ▼
                          LLM "Sound Director"
                                  │  proposes cues (sparse):
                                  │   • beds  { label, start, end, gain }
                                  │   • spots { label, at,  gain }
                                  ▼
                          Review UI = subtitle rows as a timeline,
                          each annotated with SFX chips
                          (accept / swap / mute / nudge / gain)
                                  │
                          Resolve each cue ──► pool → Freesound → ElevenLabs
                                  │            (resolved clips curated back
                                  ▼             into the SFX pool)
                            sfx_plan.json  (absolute timestamps + clip paths)
                                  │
                          Final composition (runFinalComposition)
                          ffmpeg: amix( merged_audio
                                        + beds  [adelay/volume/afade]
                                        + spots [adelay/volume] ) → mux
```

### The LLM has two decision modes — both key off the timed transcript
1. **Narration-driven (universal).** Reads the timed subtitle text — *"…and then
   the door slammed shut"* at 00:12.4 → door-slam at 12.4s. Needs nothing but
   subtitles, so **every** format gets good SFX from narration alone.
2. **Visual-driven (bonus, when a scene/clip plan exists).** Reads what's on
   screen — a "gas station at night" clip → *city-night bed* + *fuel-pump* spot.
   Formats that plan visuals (scripted-broll, scene formats) feed their plan in
   as extra context; it's an enhancement, never a requirement.

The director is prompted to be **sparse** — silence beats clutter; wall-to-wall
SFX reads as amateur. Concrete, onomatopoeic sound nouns, same craft as a good
visual search query.

## `sfx_plan.json` (the sidecar this layer authors)

Per-episode, light, in the project tree — **separate** from any visual plan so
any format can use it:
```jsonc
{
  "schema_version": 1,
  "beds": [
    { "label": "city street night", "start_sec": 0, "end_sec": 31.0,
      "source": "pool|freesound|elevenlabs", "clip": "<sfx pool filename>",
      "gain_db": -20, "status": "matched|empty|user-swapped" }
  ],
  "spots": [
    { "label": "car door close", "at_sec": 12.4,
      "source": "pool|freesound|elevenlabs", "clip": "<sfx pool filename>",
      "gain_db": -12, "status": "matched|empty|user-swapped" }
  ]
}
```
Absolute timestamps are resolved from the subtitle segments. Editing the review
UI rewrites the plan; the final render reads it. Resolved clips land **in the SFX
pool**, so the channel's sound library compounds over time — the same
one-time-effort property as the b-roll / image pools.

## Resolution chain (per cue) — mirrors the b-roll chain
1. **SFX pool** (have it) — match cue label against clip tags; no-repeat selector
   for one-shots. Free + instant.
2. **Freesound fetch** (have it) — search CC sound effects, download, auto-tag
   into the pool; the CC-attribution sidecar is already captured.
3. **ElevenLabs generate** (have it) — for a cue nothing fits, generate it; lands
   tagged in the pool.
4. **None** — leave the cue empty (sparse is fine).

## Mixing model (final composition)
- Tracks: narration/merged-audio (existing) + ambient beds + spot SFX, summed.
- Gains (starting points, tunable per cue): VO/merged at 0 dB reference; ambient
  ~-18 to -22 dB ducked under VO; spot SFX ~-10 to -14 dB.
- **Ducking**: drop the bed a few dB whenever VO is present — VO timing is known
  from subtitles/merged audio, so this is gain automation, not full sidechain
  compression, for v1.
- ffmpeg `amix` / `volume` / `adelay` / `afade` — **no new dependency**; the
  final composition already shells ffmpeg.

## Review UI (inside Video Assembly's Sound section)
- **Script run-through = the subtitle segments as timeline rows.** Each row shows
  the narration line at its timestamp, plus the bed chip covering it and any spot
  SFX chips, with **accept / swap / regenerate (ElevenLabs) / re-query
  (pool+Freesound) / mute / nudge offset / gain slider** per cue.
- **In-browser scrub (zero render cost).** Play the merged audio in the browser;
  the bed `<audio>` plays under it and each spot fires at its offset via the Web
  Audio API (rough gains) — previews the full mix before any ffmpeg.

## Safety / non-destructive
- **Additive.** The whole feature is a new sidecar + a new optional mix branch in
  the final render. With no `sfx_plan.json` (or an empty one), Video Assembly
  renders **exactly as today** — narration/music/ambience only. No existing
  output changes unless the user opts in.
- **Reversible.** Deleting `sfx_plan.json` (or clearing the Sound section)
  reverts to the current behaviour. Merged audio is never rewritten; SFX is a
  late overlay at render time.

## Build phases
1. **Sound section scaffold + narration-driven director LLM** — read subtitle
   segments, propose beds + spot SFX, write `sfx_plan.json`. (Universal; no
   dependency on any visual format.)
2. **Review UI** — subtitle rows + SFX chips (swap / mute / nudge / gain) + Web
   Audio scrub.
3. **Mix at final render** — `amix` of beds/spots over merged audio in the final
   composition, with ducking.
4. **Resolution chain wiring** — pool → Freesound → ElevenLabs, no-repeat on
   one-shots, curate back into the pool.
5. **Visual-driven cues** — feed the format's scene/clip plan in as a second LLM
   signal (where scripted-broll and scene formats plug in).
6. **Freesound credits roll-up** — gather the CC attributions used in a video
   into a description-ready list.

## Honest hard parts
- **Sound restraint** — the director must *under*-do it; dense SFX sounds
  amateur. The "be sparse" prompt + conservative defaults (often just a quiet
  bed, no spots) is the craft.
- **Mix balance / ducking** — VO clarity vs. atmosphere is iterative; start with
  fixed conservative gains and a simple duck, refine later.
- **Subtitle granularity** — segment-level timing is good enough for v1; some
  one-shots want word-level precision, which needs the finer Whisper output if
  available.
- **Freesound licensing** — CC clips need attribution; the provenance sidecar
  captures it, but the format should surface the credits used per video.
