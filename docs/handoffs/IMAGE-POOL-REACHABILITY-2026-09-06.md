# Image Pool is unreachable from the UI and its pacing control hides itself on current projects

**From:** Claude (content-pack authoring lane, sleep-history compilation) · **To:** whoever owns the Image Pool / Video Assembly area · **Date:** 2026-09-06
**Status:** navigation and resolution already shipped; separate Image Pool source approved 2026-09-10, implemented and verified for v1.4.144.

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

## Owner-approved resolution — 2026-09-10

The sidebar already exposes Image Pool; the remaining problem was actual render-source selection. The owner approved a separate **Image Pool slideshow** mode per episode. Scene Plan remains the default.

1. In Image Pool, select the episode and registered image folder, choose seconds per image, then use the images for that episode. This freezes the selection and activates its source.
2. Open Video Assembly for the same episode. Its Visual source control distinguishes Scene Plan from Image Pool and shows the saved image count and interval. Scan validates availability against the registered folder.
3. Render with the existing local Video Assembly controls. The frozen selection cycles in order; only the last interval is shortened to fit narration. Opening clips occupy their existing part of the narration timeline. Captions keep their original audio timestamps.
4. Change back to Scene Plan explicitly when wanted. Presets do not carry this episode choice. Missing or changed pool files require repair/reselection rather than silent substitution.

The old suggestion to expose recycling under Scene Plan is superseded by this explicit choice. No paid image generation is required to reuse a registered pool.

## Verification closure — v1.4.144

- Independent frontend/backend review closed source-switch races, activation ordering, short final intervals, existing cue preservation, and renamed sibling output ownership. Final review found no remaining concrete blocker.
- Full backend: 5,048 passed, 447/447 files. Frontend: 1,645 passed, 174/174 files. Release: 36 passed, 4/4 files. Content packs: 366 passed, two optional skips, 38/38 files.
- The initial `npm run verify` stopped at one obsolete frontend source-shape assertion after the backend passed. The assertion now requires the stronger project/episode/pool watcher. The complete frontend, release and content-pack lanes were rerun successfully, followed by Electron typecheck and the production build (exit 0). Both typechecks passed; lint had zero errors and 1,827 existing warnings. Security, typography, model drift, changelog and built release/startup checks passed.
- `npx tsx scripts/testing/smoke-image-pool-render.mts`: exit 0, four real FFmpeg cases passed. Hard cut/crossfade, with/without opening, each produced 9.2 seconds, correct repeated color order, and left a competing renamed episode folder untouched. Synthetic media only; no paid/provider work.
- Rendered isolated fixtures checked Video Assembly ready/missing/offline and episode switching, plus Assets Library load failure/retry and a 760px viewport without horizontal overflow. These checks do not claim every live page/state was manually exercised.

Scene Plan, existing editor controls, subtitle ownership/freshness and remote upload evidence remain active. No new dependency or paid generation was introduced.
