# Scripted Stock B-Roll format — spec (draft)

Status: **Phases 1-2 shipped (v1.0.487-488).** Phase 1: shot director
(cues→beats + filmable query LLM), per-beat Pexels/Pixabay search+download into
the pool, bridge to the existing broll-selection sidecar so the existing
assembler renders beats at narration timing. Phase 2: storyboard review — per-beat
editable queries + timing, single-beat LLM re-query, and clip swap via a
thumbnail picker. UI: Video Assembly → Step 1 "Scripted B-Roll". Queued:
in-browser timeline player (Phase 3), styled AI-gen fallback (Phase 4), extra
providers (Storyblocks / logos). The universal SFX sound layer already rides on top.

A video format for current-events / explainer videos where a
simple (often question-style) script is illustrated by **real stock footage**
matched per line, with tight timing — and a **styled AI-generated fallback**
when no real clip fits.

> **Scope note (v2 of this spec).** This doc covers the *visual* side only —
> sourcing and placing b-roll per beat. **Sound effects are NOT part of this
> format.** SFX turned out to be a *universal* concern (every format wants it),
> so it lives as a shared layer in Video Assembly keyed on the subtitle track —
> see [`sfx-sound-layer-spec.md`](./sfx-sound-layer-spec.md). This format simply
> *inherits* that sound layer like every other format; it can optionally feed
> its per-beat visual plan in as extra context for the SFX director.

## The reframe (why this is achievable)
The channels this emulates mostly **don't** use literal news footage. They use
generic *thematic* stock ("gas station at night", "stock ticker", "delivery
truck", "crowd walking") matched to keywords, cut to the narration. The 90%-match
feel comes from **good keyword→clip selection + timing**, not from owning the
event clip. So royalty-free stock (Pexels/Pixabay — already integrated) covers
most of it; literal breaking-news footage is the expensive, gated exception.

## What already exists (≈70%)
- `broll-fetch` — Pexels + Pixabay search/download.
- B-Roll **pool** + `broll-pool-manager`, `broll-autotag` (vision tags per clip),
  `broll-selector` (cross-episode no-repeat), `broll-assemble` (narration + clips
  → video), Video Assembly "load clips as scenes".
- `scene-planner` — splits narration into **time-windowed segments**.
- Research phase (`research_run`) — feeds the script.
- Image + video generators (for the AI-gen fallback).

The new work is mostly **orchestration**: script → per-beat search query →
search/pick/trim → place to timing → assemble.

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
   clips), then subtitles / branding as usual. (Sound/SFX is layered later in
   Video Assembly — see the sound-layer spec.)

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
   its beat boundary — a real scrub of the cut with zero ffmpeg. (The universal
   sound layer adds its own preview of beds + SFX on the same player; see that
   spec.) Approximates the final timing/cuts closely enough to catch problems.
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
      "status": "matched|empty|user-swapped"
    }
  ]
}
```
Picks land in the existing B-Roll pool (so no-repeat + thumbnails + tags apply);
the plan records which clip serves which beat. Editing the storyboard rewrites
the plan; assemble reads it. (Sound has its **own** sidecar, `sfx_plan.json`,
owned by the Video Assembly sound layer — kept separate so any format can use
it. The two never overlap.)

## Where it plugs in
- New `scripted-broll` **visual source / format** (joins the existing
  visualSource flows). Sidebar + Video Assembly surface a "Scripted B-Roll" mode.
- Reuse `scene-planner` for beats, `broll-fetch`/pool/selector for sourcing,
  `broll-assemble` for the render. New: the per-beat **query LLM**, the
  **source fallback chain**, the **storyboard + in-browser player**, and the
  **styled AI-gen** wiring.
- **Sound is out of scope here** — handled by the universal Video Assembly sound
  layer. This format may optionally pass its per-beat visual plan to the SFX
  director as extra context (a "rain" clip → rain bed), but owns none of the SFX
  code.

## Build phases
1. **Beat→query LLM + per-beat stock search/pick/trim/assemble** on Pexels/
   Pixabay (the core; gets the look for free).
2. **Storyboard review UI** (swap / regenerate / re-query / nudge timing).
3. **In-browser timeline player** (scrub before render).
4. **Styled AI-gen fallback** (format `broll_style` + per-run override).
5. **Extra sources**: Storyblocks provider; logo/brand side channel.

*(Sound/SFX is a separate, format-agnostic track — see its own spec + build
phases. It can be built in parallel since it shares nothing with the visual
pipeline except the timeline.)*

## Honest hard parts
- **Abstract→filmable translation** is the craft; concrete nouns search well,
  abstractions don't — the query LLM carries this.
- **Brand/logo/specific entities** need the side channel; free stock won't have
  them.
- **Timing polish** — clip in-points + trims to feel intentional (not just
  cut-on-boundary) is iterative.
