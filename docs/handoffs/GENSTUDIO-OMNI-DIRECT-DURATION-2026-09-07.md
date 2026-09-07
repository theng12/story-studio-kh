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
