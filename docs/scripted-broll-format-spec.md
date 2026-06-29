# Scripted Stock B-Roll format — spec (draft)

Status: proposed. A video format for current-events / explainer videos where a
simple (often question-style) script is illustrated by **real stock footage**
matched per line, with tight timing — and a **styled AI-generated fallback**
when no real clip fits. A parallel **LLM-directed sound layer** (ambient beds +
spot SFX, drawn from the v1.0.481 SFX system) scores each beat under the
narration. Visual track and sound track are built the same way: an LLM director
maps beats → assets, a sourcing chain fills them, the assembler places + mixes.

## The reframe (why this is achievable)
The channels this emulates mostly **don't** use literal news footage. They use
generic *thematic* stock ("gas station at night", "stock ticker", "delivery
truck", "crowd walking") matched to keywords, cut to the narration. The 90%-match
feel comes from **good keyword→clip selection + timing**, not from owning the
event clip. So royalty-free stock (Pexels/Pixabay — already integrated) covers
most of it; literal breaking-news footage is the expensive, gated exception.

## What already exists (≈75%)
- `broll-fetch` — Pexels + Pixabay search/download.
- B-Roll **pool** + `broll-pool-manager`, `broll-autotag` (vision tags per clip),
  `broll-selector` (cross-episode no-repeat), `broll-assemble` (narration + clips
  → video), Video Assembly "load clips as scenes".
- **SFX system (v1.0.481)** — the Assets Library now has **audio (SFX) pools**:
  tagged, SSD-backed, shared across projects, with **Freesound fetch** and
  **ElevenLabs generate** already wired. This is the entire sound-sourcing
  backend; the sound layer just needs an LLM director + a mix step.
- `scene-planner` — splits narration into **time-windowed segments**.
- Research phase (`research_run`) — feeds the script.
- Image + video generators (for the AI-gen fallback).

The new work is mostly **orchestration**: script → per-beat search query →
search/pick/trim → place to timing → (LLM SFX cues → resolve → place) →
assemble + mix.

## Pipeline
1. **Research → script** (existing) — keep it simple / question-style.
2. **Script → timed beats** (existing scene-planner) — each beat = {start, end,
   narration line}.
3. **Beat → filmable search query (LLM)** — translate abstract narration into
   *concrete, filmable nouns*. "economic uncertainty" → "stock market ticker,
   red downward chart, worried trader". Emit 1 primary + 2 backup queries per
   beat, each as plain noun phrases tuned for stock search.
4. **Search** Pexels + Pixabay (existing) for each beat's queries → candidates.
5. **Pick** best candidate — relevance + the existing vision autotag + the
   existing no-repeat selector. Falls back down the source chain (§Sourcing).
6. **Trim + place** each clip to its beat's exact time window (trim to duration;
   loop/freeze if the clip is shorter; pick an in-point if longer).
7. **Assemble** via the existing b-roll assembler (narration + ordered, timed
   clips), then subtitles / branding as usual.

## Sourcing + fallback chain (per beat)
Try in order until a clip is found:
1. **Pexels / Pixabay** (have it) — free, good for generic concepts.
2. **(optional) Storyblocks / Artgrid / Pond5** — paid, higher quality + coverage
   (the standard for this explainer look). Add as a new fetch provider.
3. **Brand / logo / franchise** — generic stock lacks these. A side channel:
   Brandfetch/Clearbit logo API or Wikimedia Commons for logos/marks.
4. **Styled AI-generation** (see below) — when nothing real fits.
5. **Generic substitute** — a safe on-theme clip from the pool (last resort).

Real editorial/current-events footage (Getty/AP/Reuters) is intentionally OUT of
the default chain — expensive + API-gated. Slot in only for videos that truly
need the literal clip.

## Styled AI-gen fallback (NOT photoreal)
When the chain reaches AI-gen, it should produce **channel-style** visuals, not
fake-real footage:
- A per-format **`broll_style`** (the channel's default look — e.g. "flat
  editorial illustration", "paper-cutout motion", "muted 2D vector") stored on
  the format, with a **per-run override** in the generator UI (pick the style
  each time).
- The AI-gen step prefixes the beat's visual prompt with that style so fallback
  clips/images are visually consistent and clearly stylised — they read as
  "our channel's b-roll", never as fake real footage.
- Uses the existing image generator (Ken-Burns to motion) and/or the image-to-
  video generator for moving fallback. Both already exist.

## Sound design layer (SFX) — LLM-directed
Builds directly on the v1.0.481 SFX system (Assets Library audio pools + Freesound
fetch + ElevenLabs generate). The sound layer is the audio twin of the visual
layer: an LLM **sound director** maps beats → sound, the **SFX sourcing chain**
fills them, and the assembler **mixes** them under the narration.

Two distinct sound roles:
- **Ambient bed** — a loopable atmosphere spanning a run of beats ("city street
  night", "newsroom hum", "tense low drone"). Usually one at a time, low gain,
  cross-faded on change. Sets the scene.
- **Spot SFX (one-shots)** — short effects anchored to a moment inside a beat
  ("whoosh" on a transition, "cash register", "phone notification", "door slam").
  Punctuation, not wallpaper.

### Pipeline addition (a parallel branch, runs after visuals are picked)
- **3b. Beat → SFX cues (LLM "sound director").** Given the beat's narration +
  the chosen visual (its query/tags) + neighbouring beats, emit: an optional
  ambient label (and whether it *continues* the previous bed or starts a new
  one), plus 0–N spot cues `{ label, at_sec (offset within beat), gain_db }`.
  The director is prompted to be **sparse** — silence is fine; wall-to-wall SFX
  reads as amateur. Concrete, onomatopoeic sound nouns, same craft as the visual
  query LLM.
- **4b. Resolve each cue** through the SFX sourcing chain (below).
- **6b. Place + mix.** Ambient beds laid as a continuous low-gain track with
  cross-fades on change; spot SFX dropped at their offsets; narration **ducks**
  the bed so the VO stays clear.

### SFX sourcing chain (per cue) — mirrors the b-roll chain
Try in order until the cue is filled:
1. **SFX pool** (have it) — match the cue label against clip tags (pool is
   already tagged). The no-repeat selector idea applies to one-shots too, so the
   same "whoosh" isn't reused on every beat. Free + instant.
2. **Freesound fetch** (have it) — search CC sound effects, download, auto-tag
   into the pool; the CC-attribution sidecar is already captured.
3. **ElevenLabs generate** (have it) — for a cue nothing fits ("1950s rocket
   ignition with a metallic shimmer"), generate it; lands tagged in the pool.
4. **None** — leave the cue empty (sparse is fine).

Everything resolved is curated **into the SFX pool**, so the channel's sound
library compounds over time — same one-time-effort property as the b-roll/image
pools.

### Mixing model (assemble step)
- Tracks: narration (existing) + ambient bed + spot SFX, summed.
- Gains (starting points, tunable per cue): VO at 0 dB reference; ambient
  ~-18 to -22 dB ducked under VO; spot SFX ~-10 to -14 dB.
- **Ducking**: drop the bed a few dB whenever VO is present — the assembler
  already knows VO timing, so this is gain automation, not full sidechain
  compression, for v1.
- ffmpeg `amix` / `volume` / `afade` — **no new dependency**; the assembler
  already shells ffmpeg.

## Preview before render (the user's concern)
There is **no full scrubbable preview** of the assembled video today (you render
to see the cut). Plan, cheapest-first:
1. **Per-beat storyboard review (primary).** A list aligned to the script: each
   beat shows the narration line + chosen clip thumbnail + duration + source
   badge (stock / logo / AI-gen), with **swap clip / regenerate / re-query /
   nudge timing** controls. Reuses the existing selection-review + thumbnails.
   This is where the user fixes mismatches BEFORE paying for a render.
2. **In-browser timeline player (recommended, ~no render cost).** Play the
   narration audio in the browser and swap each muted clip `<video>` / image at
   its beat boundary — a real scrub of the cut with zero ffmpeg. **Layer the
   sound too**: the ambient bed `<audio>` plays under the VO and each spot SFX
   fires at its offset, so the scrub previews the full mix (rough gains via the
   Web Audio API), still at zero render cost. Approximates the final
   timing/cuts/sound closely enough to catch problems.
3. **Optional fast draft render.** A low-res / fast-preset assemble (the encoder
   already has a fast tier) for an exact check before the full-quality render.

## Data model
A per-episode `broll_plan.json` sidecar (light, in the project tree):
```jsonc
{
  "schema_version": 1,
  "broll_style": "${format default or per-run override}",
  "beats": [
    {
      "start_sec": 0, "end_sec": 4.2,
      "line": "Every morning millions stop for gas…",
      "queries": ["gas station morning wide", "fuel pump close up", "car at gas station"],
      "source": "pexels|pixabay|storyblocks|logo|ai-gen|substitute",
      "clip": "<pool filename or generated path>",
      "in_point_sec": 1.0,            // where to start within a longer clip
      "status": "matched|empty|user-swapped",

      // ── sound layer ──
      "ambient": {                    // null = no bed for this beat
        "label": "city street night",
        "continue": false,            // true = same bed as previous beat (no re-trigger)
        "source": "pool|freesound|elevenlabs",
        "clip": "<sfx pool filename>",
        "gain_db": -20
      },
      "sfx": [                        // 0–N spot one-shots
        {
          "label": "car door close",
          "at_sec": 1.4,              // offset within the beat
          "gain_db": -12,
          "source": "pool|freesound|elevenlabs",
          "clip": "<sfx pool filename>",
          "status": "matched|empty|user-swapped"
        }
      ]
    }
  ]
}
```
Visual picks land in the B-Roll pool and SFX picks in the **SFX pool** (so
no-repeat + tags apply to both); the plan records which asset serves which beat.
Editing the storyboard rewrites the plan; assemble + mix read it. (A bed that
spans many beats is expressed as `continue:true` on the followers — or hoisted to
a top-level `beds[]` segment array; decide during build.)

## Where it plugs in
- New `scripted-broll` **visual source / format** (joins the existing
  visualSource flows). Sidebar + Video Assembly surface a "Scripted B-Roll" mode.
- Reuse `scene-planner` for beats, `broll-fetch`/pool/selector for sourcing,
  `broll-assemble` for the render. New: the per-beat **query LLM**, the
  **source fallback chain**, the **storyboard + in-browser player**, and the
  **styled AI-gen** wiring.
- **Sound layer** reuses the v1.0.481 SFX pool + Freesound/ElevenLabs backend.
  New: the **SFX director LLM**, the SFX sourcing chain (pool → Freesound →
  ElevenLabs), and the **mix step** (ducked bed + spot one-shots) in the
  assembler. The selector's no-repeat logic extends to SFX one-shots.

## Build phases
1. **Beat→query LLM + per-beat stock search/pick/trim/assemble** on Pexels/
   Pixabay (the core; gets the look for free).
2. **Storyboard review UI** (swap / regenerate / re-query / nudge timing).
3. **In-browser timeline player** (scrub before render).
4. **Styled AI-gen fallback** (format `broll_style` + per-run override).
5. **Sound layer (SFX)** — SFX director LLM (ambient + spot cues), SFX sourcing
   chain (pool → Freesound → ElevenLabs), mix into assemble (ducked bed + spot
   one-shots), and sound rows in the storyboard + player. *Independent of the
   visual track — could be built right after phase 2/3 since it rides the same
   beat model and review UI.*
6. **Extra sources**: Storyblocks provider; logo/brand side channel.

## Honest hard parts
- **Abstract→filmable translation** is the craft; concrete nouns search well,
  abstractions don't — the query LLM carries this.
- **Brand/logo/specific entities** need the side channel; free stock won't have
  them.
- **Timing polish** — clip in-points + trims to feel intentional (not just
  cut-on-boundary) is iterative.
- **Sound restraint** — the SFX director must *under*-do it; dense SFX sounds
  amateur. The "be sparse" prompt + conservative defaults (often no spot SFX,
  just a quiet bed) is the craft, same as abstract→filmable for visuals.
- **Mix balance / ducking** — VO clarity vs. atmosphere is iterative; start with
  fixed conservative gains and a simple duck, refine later.
- **Freesound licensing** — CC clips need attribution; the provenance sidecar
  already captures it, but the format should roll the credits used in a video
  into a description-ready list.
