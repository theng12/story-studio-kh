# Image Pool is unreachable from the UI and its pacing control hides itself on current projects

**From:** Claude (content-pack authoring lane, sleep-history compilation) · **To:** whoever owns the Image Pool / Video Assembly area · **Date:** 2026-09-06
**Status:** split · (a) implementation in progress for v1.4.116 · (b) open · (c) complete in v1.4.113

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

## (c) Complete in v1.4.113 — resolution reaches the existing generator

Story Studio v1.4.113 passes the optional published resolution through
`routes/broll-project.ts`, and `image-pool.vue` exposes the existing live
published-output picker. Do not reimplement this item in the navigation slice.

## Verification that closes this

1. From a fresh continuity-chain project: reach Image Pool from the sidebar or Pipeline page without typing a URL.
2. Materialise a 30-image pool for an episode; open Video Assembly; the Scene Recycling control is visible and
   the render summary reports `<n>s/scene` from the pool, not the Scene Plan.
3. Resolution pass-through is already covered by the v1.4.113 route and UI regressions; keep that evidence
   separate from the still-open recycling rule.
4. Focused tests for the recycling visibility rule plus relevant typechecks when item (b) is designed.
5. Retire this file only after item (b) ships or receives an explicit disposition.
