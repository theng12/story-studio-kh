# Removed: `ken_burns` request field + scene-animation fallback

**Removed in:** v1.0.40 (commit pending)
**Original feature:** Pre-`scene_animation` flag that toggled a hard-coded
Ken Burns effect on rendered videos.
**Why removed:** Replaced by the structured `scene_animation` request
field in v1.0.38. Frontend stopped sending `ken_burns` after that
release; only the read-side fallback remained, and no internal code
ever referenced it.

## What was removed

### 1. Type field — `electron/server/models/types.ts:1438`

The annotation sat inside the `VideoRequest` interface (or whatever
the surrounding interface was — likely `VideoAssembleRequest`). The
removed line:

```ts
ken_burns?: boolean               // DEPRECATED — kept for backward compat, maps to scene_animation 'ken-burns'
```

Surrounding context:

```ts
chapter_titles: VideoChapterTitles
scene_animation?: VideoSceneAnimation
post_audio?: VideoPostAudio       // what happens after narration ends, default fade-to-black
ken_burns?: boolean               // DEPRECATED — kept for backward compat, maps to scene_animation 'ken-burns'  ← removed
audio_gap?: number                // seconds of silence between narration chapters, default 5
```

### 2. Read-side fallback — `electron/server/generators/video.ts:776-781`

```ts
// 5. Resolve scene animation (backward compat: convert old ken_burns boolean)
const sceneAnimation: VideoSceneAnimation = req.scene_animation ?? (
  req.ken_burns
    ? { type: 'ken-burns', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 }
    : { type: 'none', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 }
)
```

Replaced with a direct fallback to `'none'` when `scene_animation` isn't
provided:

```ts
// 5. Resolve scene animation
const sceneAnimation: VideoSceneAnimation = req.scene_animation ?? {
  type: 'none', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103,
}
```

## How to restore

If a request shape ever needs to carry a boolean Ken Burns toggle again:

1. Re-add the type field to `VideoRequest` (or current name) in
   `electron/server/models/types.ts`.
2. Re-introduce the ternary in `electron/server/generators/video.ts`
   in the `Resolve scene animation` step.
3. Update the frontend caller to send `ken_burns: true` if reverting
   to the old API shape — but in practice you'd want a new
   `scene_animation: { type: 'ken-burns', … }` request instead.
