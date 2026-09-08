# Google's Gemini Omni 1.1 Flash direct lane now takes an exact clip duration

**From:** Claude (GenStudio lane) · **To:** GPT / whoever owns the Story video generator · **Date:** 2026-09-07
**Status:** open — owner wants the video generator flow updated to use it

## What changed on the GenStudio side

Product `gemini-omni-1.1-flash` ("Gemini Omni 1.1 Flash", Google direct, no lane
suffix) is PUBLISHED as of GenStudio 1.24.43 with two operations, `text-to-video`
and `image-to-video`, 720p, aspect 16:9 and 9:16, and **per-second duration
control: any whole number of seconds from 4 to 10** (the price list carries
4, 5, 6, 7, 8, 9, 10; Google's API accepts 3–10 and GenStudio's adapter refuses
anything else before a call). The request field on GenStudio's video API is the
usual `duration_seconds`; GenStudio sends it to Google as
`response_format.duration = "<n>s"`.

Prices (credits per clip, 720p, same for both operations):

| seconds | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|
| credits | 667 | 834 | 1000 | 1167 | 1334 | 1500 | 1667 |

The two other lanes of the same model behave differently and should not be
confused with it: `gemini-omni-1.1-flash-genstudio-1` (Kie) sells 4/6/8/10 s
only; `gemini-omni-flash` (fal.ai, "Gemini Omni 1.1 Flash (GenStudio 3)") sells
4–10 s text-to-video, with image-to-video being added tonight.

## What the owner wants from Story

Quote (2026-09-07): "i don't know if story studio has the duration also for
it's video generator. so tell gpt about that. i'll later let gpt make/update the
video generator flow to match the scenes because with this google omni thing, we
can finally just set the duration we wanted. it will be easiest for our workflow
with this duration control."

So: check whether the Story video generator exposes a per-clip duration when the
selected GenStudio video product reports `durations_seconds` in its capability
(the catalogue entry carries `capability.durations_seconds` and
`max_duration_seconds`), and plan the flow where each scene's clip length is
derived from the scene's narration span (rounded to a whole second inside the
product's list) rather than a fixed preset. GenStudio reserves credits from the
price row for the exact duration requested, so Story must request the duration
it intends to pay for; a duration outside the product's list is refused by
GenStudio with no charge.

Nothing on the GenStudio side is pending for this; the lane is live.

## Addendum 2026-09-08 — where Story stands today (Claude)

Checked the Story source on 2026-09-08:

- `electron/server/generators/ai-video.ts` already forwards `duration_seconds`
  from the request to GenStudio (`provider_params.duration_seconds`).
- `frontend/pages/projects/[slug]/motion-review.vue` already lists the product's
  published `(duration_seconds, resolution)` variants from
  `frontend/composables/useGenStudioMediaModels.ts` and lets the operator pick
  ONE variant, which is then used for every scene in the run.

So duration selection exists, but only as a single choice for the whole batch.
What the owner asked for is the per-scene version: when the selected product
publishes per-second durations (Google direct `gemini-omni-1.1-flash`: every
whole second 4–10), each scene's clip length should be derived from that
scene's narration span (round to the nearest published duration, clamp to the
list), with the per-scene credit total shown before the run. Products that
publish only 4/6/8/10 (Kie lane) keep the current single-variant behaviour or
snap each scene to the nearest published step. GenStudio refuses any duration
not on the product's list, at no charge, so snapping must happen in Story.

## Owner's design decision 2026-09-08 — one adaptive duration control

Owner (2026-09-08): the selected product and lane must show exactly the
durations that lane publishes (Kie Omni: 4/6/8/10; direct Omni: every second
4–10; a future Seedance 2.5: up to 30 s). "So many buttons" does not scale,
so the control must be generated from the catalogue, never hand-built.

Agreed design for Codex to build:

1. **Source of truth:** the product's `capability.durations_seconds` (and the
   per-duration price rows) from the GenStudio catalogue. No hardcoded lists,
   no per-provider branches (see AGENTS.md "everything follows the model").
2. **One control:** a slider whose snap points are exactly the published
   durations, plus a number field. Contiguous lists behave like a normal
   1-second-step slider; sparse lists (4,6,8,10) snap only to those ticks.
3. **Snap rule:** any typed or derived value rounds UP to the next published
   duration ("moved to the next checkpoint"), so a clip is never shorter than
   its narration. If rounding up exceeds the product's maximum, cap at the
   maximum and flag it.
4. **Live price:** show the credits for the snapped duration beside the value,
   from the published price row, and the batch total.
5. **"Follow narration" toggle (per-scene mode):** when on, each scene's
   duration = that scene's narration span snapped up per rule 3; when off,
   the single chosen duration applies to every scene (today's behaviour).
   Scenes whose narration exceeds the maximum get the maximum plus a flag in
   the scene list so the operator can split or accept a held last frame.
6. Switching product or lane re-reads the list and re-snaps every scene;
   nothing carries over from the previous lane.

GenStudio side: nothing to change for Omni. A 30-second product will need one
published price row per second (data, not code); Claude will stock those rows
when such a product is added.
