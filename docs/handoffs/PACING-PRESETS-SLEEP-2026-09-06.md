# Add slower scene-pacing presets for sleep-length episodes

**From:** Claude (content-pack authoring lane, sleep-history compilation) · **To:** whoever owns the Continuity Engine pacing UI · **Date:** 2026-09-06
**Status:** implementation in progress for Story Studio v1.4.116 · exact values approved 2026-09-06

## What is missing

`PACING_PRESETS` in `frontend/composables/useContinuityConfig.ts` tops out at `contemplative` (8–15 s per scene).
A 150-minute sleep episode at that band needs roughly 600–1,100 generated images. The owner wants
sleep-story channels to run 100–250 images per episode, which needs bands up to the route's existing ceiling.

The backend already permits it: `electron/server/routes/continuity.ts` clamps `min_sec`/`max_sec` to 1–60,
and `contracts/index.ts` allows a Series Formula `visual_pacing_profile` up to 300 s. Only the preset menu is short.

## Proposed presets (append after `contemplative`; keep ids stable once shipped)

| id | min | max | label | images for a 150-min episode (approx.) |
| --- | ---: | ---: | --- | ---: |
| `drifting` | 12 | 20 | 12–20 seconds — Drifting | ~560 |
| `sleep-slow` | 20 | 30 | 20–30 seconds — Slow drift | ~360 |
| `sleep-very-slow` | 30 | 45 | 30–45 seconds — Very slow | ~240 |
| `near-still` | 45 | 60 | 45–60 seconds — Near-still | ~170 |

All four sit inside the current 60 s route clamp, so no backend change is required for this brief.
If the owner later wants bands above 60 s, raise the clamp in `routes/continuity.ts` (both the PUT coercion and
the settled range) to match the 300 s contract ceiling in the same change — do not raise one without the other.

## Constraints to respect

- `frontend/__tests__/characterSheetWorkspace.test.ts` sweeps the tree for any literal `min_sec: <n>, max_sec: <n>`
  pair outside `contracts/pacing.ts`. `PACING_PRESETS` uses `min`/`max`, so appending rows is safe; do not
  introduce a `min_sec` literal anywhere new.
- `DEFAULT_SCENE_PACING` stays 1–3. This brief adds choices; it changes no default.
- The Scene Plan summary and the Video Assembly pacing row should render the new labels without truncation
  (labels above are the longest in the menu; check the narrow-sidebar layout).

## Verification that closes this

1. `npm --prefix frontend run typecheck` clean.
2. `frontend/__tests__/characterSheetWorkspace.test.ts` green (the literal-pair sweep).
3. With a local synthetic 150-minute subtitle timeline, confirm `near-still` produces roughly
   narration seconds ÷ 52.5 scenes and never exceeds 60 seconds of spoken material. The established
   planner may retain a shorter final tail when it cannot rebalance the last two scenes inside the band,
   and a hold spanning inter-cue silence may exceed 60 wall-clock seconds; those are deliberate existing
   exceptions, not reasons to change the splitter in this slice.
4. Move this file to `docs/handoffs-retired/` with the shipping commit.
