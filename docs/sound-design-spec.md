# Sound Design — reviewed local-library workflow

Status: **Phase 1 shipped**.

Sound Design is an optional editorial workflow for placing ambient beds and
spot effects beneath finished narration. It owns the review timeline; Video
Assembly only consumes its approved output during the final FFmpeg mix.

## Phase 1 boundary

- Only the registered local audio library is available as a source.
- Story Studio does not connect directly to Freesound, ElevenLabs, Suno, or any
  other external provider.
- There is no sound-generation model selector until GenStudio KH publishes a
  qualified, typed sound capability.
- A disabled project has no Sound Design prerequisite and renders exactly as it
  did before the feature existed.

## Flow

```text
stitched subtitles + Scene Plan
  → Sound Design timeline (manual local-library selection)
  → approve / exclude every cue
  → final Video Assembly mix
```

Sound Design never changes narration, subtitle timing, Scene Plan timing, or
scene images. It stores a per-episode `sound_design.json` beside the Scene Plan.

## Review contract

Each cue has a stable ID, kind (`bed` or `spot`), exact timing, local-library
asset reference, gain, and status (`proposed`, `matched`, `approved`, or
`excluded`). When Sound Design is enabled, Final Video requires every cue to be
approved or excluded. Approved cues must resolve to an available local asset.

The validator enforces episode bounds, safe gain limits, one ambient bed at a
time, minimum spot spacing, and the preset's maximum spots per minute.

## Mixing contract

Video Assembly dynamically ducks approved ambient beds under narration and
mixes approved spots at their exact timestamps. If a user enables Sound Design
and an approved asset is unavailable, Final Video fails clearly; it never
silently renders a supposedly sound-designed video without those cues.

## Future GenStudio capabilities

When GenStudio KH exposes a qualified live catalog, Sound Design may add:

- typed sound-effect generation with durable task IDs and retries;
- licensed sound-library search with provenance and attribution metadata;
- a separate music-generation workflow.

Those capabilities must remain GenStudio-owned. A library source is not an AI
model, and external licensing must be represented in the approved cue record.
