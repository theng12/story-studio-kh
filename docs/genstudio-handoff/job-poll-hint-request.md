# Request to GenStudio: let the server control job-poll cadence

**From:** Story Studio KH
**Status:** open
**Urgency:** rises with your hosted customer count — this is a load-shape issue, not a bug

## The situation

Story Studio submits a durable job and then polls it until it finishes. That is the right
model and it fixed a real failure (the synchronous route abandoning 70–90 second
generations at its 30-second timeout).

But every poll that answers "still running" is wasted work for both sides, and Story Studio
currently has no way to know how often GenStudio actually wants to be asked.

## The numbers

At a flat one-second interval:

- a 90-second chapter generation costs **90 requests, 89 of them answering "still running"**
- Story Studio's chapter batches run 4 concurrent, so that is a sustained **4 requests/second
  from a single customer sitting in a single app**
- the 4-hour job ceiling means one genuinely stuck job would fire **14,400 requests** before
  giving up
- Story Studio is a desktop app the customer is expected to leave open in the background, so
  this is steady-state traffic, not a burst

Multiply by a hosted customer base and the majority of GenStudio's request volume becomes
clients asking a question whose answer has not changed.

## What Story Studio is doing regardless

Capped exponential backoff with jitter — roughly 1s for the first few seconds (so short
operations still feel instant), widening through 2s, 5s, 10s, capping around 15s, with ±20%
random jitter so concurrent clients do not fall into lockstep and produce synchronised
spikes.

That alone takes the 90-second job from ~90 requests to ~15, and the stuck-job worst case
from 14,400 to under 1,000.

## What would be better, in increasing order of effort

**1. A poll hint on the job response.** A field such as `poll_after_ms` (or a `Retry-After`
header on the job GET) telling the client when to ask again. This is the highest
value-per-effort option: it moves control to the side that actually knows the load, lets you
widen intervals during a busy period without any client release, and Story Studio would
honour it in preference to its own backoff.

**2. Long polling.** Story Studio asks "tell me when job X changes, wait up to N seconds."
One request covers the whole window instead of N/interval requests. Note this must hold
*below* the 30-second control-request timeout to be safe — a ~25-second hold would work.

**3. Server-sent events** on a job. Story Studio opens one connection and receives state
changes as they happen. Eliminates polling entirely rather than reducing it. Most work, and
needs care with reconnection, but it is the endgame if job volume grows.

Webhooks are **not** a good fit here: Story Studio is a desktop app on a customer machine
with no reachable inbound endpoint.

## What Story Studio does if the answer is no

Ships the backoff described above and leaves it. That is a large improvement on its own, and
nothing here blocks any feature. This is about your infrastructure bill and headroom rather
than Story Studio's correctness.

If you implement option 1, say so and Story Studio will prefer your hint over its own
schedule — no release needed on our side beyond reading the field.
