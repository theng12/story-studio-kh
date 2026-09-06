# Image Pool is unreachable from the UI and its pacing control hides itself on current projects

**From:** Claude (content-pack authoring lane, sleep-history compilation) · **To:** whoever owns the Image Pool / Video Assembly area · **Date:** 2026-09-06
**Status:** open · owner-requested · three items, each small; (c) also blocks 2K preview generation for pack authoring

## Why this matters

The owner's sleep channels want to generate 100–250 stills once and cycle them across a 90–180-minute
narration. That workflow shipped as Image Pool (v1.0.403–410) and Scene Recycling, and both still exist,
but neither is reachable on a current project without typing a URL.

## (a) No navigation entry for the Image Pool page

`frontend/pages/projects/[slug]/image-pool.vue` exists and its backend routes are live
(`electron/server/routes/broll-project.ts`: `/image-pool/pick`, `/materialize`, `/generate`, `/suggest-prompts`).
Nothing links to it: `frontend/layouts/dashboard.vue` has only the `/broll-library` "Assets Library" entry, and
`frontend/pages/projects/[slug]/pipeline.vue` (lines ~657 and ~678) lists B-Roll but not Image Pool.
`useFeatureGuide.ts` still carries an `image-pool` guide entry, so the page was meant to be visible.

Suggested direction: add an Image Pool entry beside the B-Roll entries in `pipeline.vue`, and a sidebar
link near Assets Library gated the same way B-Roll is.

## (b) Scene Recycling controls hide on every continuity-chain project

`frontend/pages/projects/[slug]/video-assembly.vue` (~line 2690) sets `isSentenceTimed` when
`effective-format.imagePrompts.alignment === 'sentence'`, and hides the sleep-story Scene Recycling controls
when true. `continuity-chain` is the only format engine and it is sentence-aligned, so on a current project the
recycling control (`seconds_per_scene`, pool cycling) can never be shown — even after Image Pool has materialised
a pool. Backend support is intact (`generators/video.ts` reads `scene_recycling.seconds_per_scene`, default 10).

Suggested direction: show the recycling controls when the episode has a materialised Image Pool selection
(the pool workflow state), regardless of format alignment; keep them hidden only when the Scene Plan is the
timing source and no pool is selected. Not prescriptive — the right signal may be the pool sidecar rather than
the format field.

## (c) `/image-pool/generate` drops the resolution the generator already accepts

`generators/image-pool-generate.ts` reads `params.resolution` and resolves it against the model's published
`output_options[]`, but the route in `routes/broll-project.ts` (~line 559) never copies `body.resolution` into
the job params, so every pool generation runs at the model's default row (1K). Pass it through (string, optional),
and expose a resolution picker on `image-pool.vue` populated from the model's published rows, the same way the
scene-review path does. This is a two-line backend fix plus a small UI control.

## Verification that closes this

1. From a fresh continuity-chain project: reach Image Pool from the sidebar or Pipeline page without typing a URL.
2. Materialise a 30-image pool for an episode; open Video Assembly; the Scene Recycling control is visible and
   the render summary reports `<n>s/scene` from the pool, not the Scene Plan.
3. POST `/projects/:slug/image-pool/generate` with `"resolution": "2K"` on a model that publishes a 2K row;
   the job's request preview shows `resolution: 2K` and the saved PNG is 2560×1440.
4. Focused tests for the route param and the recycling visibility rule; `npm run typecheck:electron` and
   `npm --prefix frontend run typecheck` clean.
5. Move this file to `docs/handoffs-retired/` with the shipping commit.
