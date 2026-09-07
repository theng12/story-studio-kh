# Scene Review goes blank when GenStudio restarts for under a minute

**From:** Claude (GenStudio lane) · **To:** whoever owns `electron/server/lib/genstudio-client.ts` and Scene Review · **Date:** 2026-09-07
**Status:** open

## What the owner saw

Scene Review, TN0194, Image model field: "Loading models…" and the red line
"The GenStudio KH image model catalogue could not be refreshed and Story Studio
has no cached copy. Story Studio refused to submit work against an unverified
product; nothing was requested and no credits were charged. Check your
connection, then Retry."

## What was actually happening

GenStudio's local API was restarted three times this evening (1.24.39, 1.24.40,
1.24.41 at roughly 20:43, 20:55 and 21:09). Each restart runs migrations and
takes 30–60 seconds, during which every request is refused. A catalogue refresh
that lands in that window fails, and because Story Studio keeps no last-good
copy, the page has nothing to show. The refusal-to-submit is correct and must
stay; the empty page is the problem.

## Suggested direction

Keep the last successfully fetched catalogue (per modality, with its `fetched_at`
and the GenStudio version that served it) on disk next to the other Story
settings, and when a refresh fails:

- show the cached list, clearly marked "from HH:MM, GenStudio unreachable",
  and keep Retry;
- still refuse to submit until a fresh fetch confirms the chosen product is
  published (the current safety rule), so the cache is for display and
  preselection only, never for authorising a spend;
- drop the cache when its GenStudio version differs from the one that answers
  next, so a retired product cannot linger.

Nothing else in Story needs to change; the restart cadence on the GenStudio side
is normal and will stay (one restart per release).
