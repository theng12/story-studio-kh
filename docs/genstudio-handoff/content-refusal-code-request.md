# Request to GenStudio: a distinct reason code for content refusals

**From:** Story Studio KH
**Status:** OPEN
**Urgency:** medium — it is currently indistinguishable from a generic failure, so Story Studio
cannot tell the customer the one thing that would help.

## The problem

Image providers apply their own content filters. Story Studio's channels are history and
documentary, which brushes against those filters constantly and innocently: battlefield
aftermath, executions, plague scenes, children in historical settings, classical art nudity,
anatomical and medical illustration.

When a provider refuses a prompt on content grounds, Story Studio currently sees a failure with
no distinguishing mark. So the customer is told "generation failed" — and the single most
useful instruction, *"this prompt needs rewording"*, is exactly the one Story Studio cannot
give.

The consequences are concrete:

- The customer retries the identical prompt, which fails identically.
- A Pipeline run stalls on a step that will never succeed unattended, when it could have skipped
  the scene and carried on.
- Story Studio cannot offer to regenerate just that prompt, because it does not know that is the
  problem.

## The request

**Add a provider-agnostic reason code for content refusals**, in the same shape as the
`capacity_reason` codes GenStudio shipped for HTTP 429 — which work well and are exactly the
precedent we would like followed.

Something like `content_refused` on the failed job, distinct from a transport failure, a
capacity refusal, and an invalid request.

Two further things, in decreasing order of value:

**1. Is a content-refused generation charged?** This is the question that decides how hard Story
Studio should work to pre-empt refusals. If refusals are free, prevention is a quality
improvement. If they are billed, every refusal is money lost to a prompt that could have been
worded differently, and prevention becomes urgent. A plain yes or no is a complete answer.

**2. Which category tripped it, if that is safe to disclose.** Even a coarse hint — violence,
minors, sexual content, medical — would let Story Studio steer a rewrite rather than guess.
**If exposing this is a problem** (it may reveal provider-specific policy detail, and providers
differ), say so and skip it: the bare `content_refused` code delivers most of the value on its
own. **Do not synthesise a category** that the upstream did not actually give you — a guessed
category is worse than none, because it would send a rewrite in the wrong direction.

**No provider name is wanted here.** Which upstream refused is routing detail and Story Studio
does not want it. Only *that* it was refused on content grounds.

## What Story Studio does either way

**Prevention is being built regardless, on our side.** The image prompt generator is being given
guidance to write prompts that describe difficult historical subjects without the phrasings that
trip filters — aftermath rather than act, no explicit age markers on figures, period-illustration
framing over photorealism. That work does not depend on this request and is the larger half of
the fix, precisely because providers vary and their policies are not ours to track.

With the code, Story Studio would additionally:

- Say "this prompt was refused on content grounds — rewrite it" instead of "generation failed".
- Offer a one-click reword of that single prompt rather than a whole regeneration.
- Let a Pipeline run record the scene as needing attention and continue, instead of stalling.

Without it, Story Studio will **not** guess. Pattern-matching provider error text to infer a
content refusal is exactly the inference our own rules forbid, and it would break the first time
a provider changed its wording. So the absence of a code means the customer keeps seeing a
generic failure — workable, just needlessly opaque.

## A "no" is a useful answer

If content-refusal reasons cannot be surfaced without leaking provider policy, saying so closes
the question and we will lean entirely on prevention.

---

## ANSWERED AND SHIPPED — 2026-08-28

**Status:** CLOSED. GenStudio `f043f268` (`feat/customer-failure-reason-2026-08-28`);
Story Studio `feat/show-failure-reason-2026-08-28`.

### What shipped

`failure_class` on every modality's job body, in the requested shape — a small
provider-agnostic vocabulary, following the `capacity_reason` precedent this
request asked us to follow:

| Value | Meaning |
|---|---|
| `content_refused` | refused on content-policy grounds |
| `provider_transient` | rate limit, 5xx, provider temporarily unavailable |
| `provider_error` | terminal, and GenStudio will not claim to know why |

Alongside it, `failure_reason` — the provider's own sentence — for display only.
**Story Studio branches on the class and never on the reason's wording**, which
is what this request asked for and what its own reasoning demanded.

It is computed from structured facts only: the job's failure code and the
recorded exception class. Nothing reads provider prose. As part of the same
change, `direct_images` now reads OpenAI's documented `error.code`, so a
`moderation_blocked` rejection raises `ProviderContentRefusedError` and lands as
`content_refused` — previously it arrived as a bare protocol error, which is
exactly why the owner's own blocked thumbnail looked like a generic failure.

### The two further questions

**1. Is a content-refused generation charged? — No.** A content refusal calls
`billing.release(...)` on the reservation, the same as any other provider
failure; nothing is captured. So prevention is a quality improvement, not a
money leak. The cost of a refusal is the customer's time, not their credits.

**2. Which category tripped it? — Not provided, deliberately.** Upstream gives us
a refusal signal, not a taxonomy: OpenAI returns `moderation_blocked` with no
machine-readable category. Synthesising one from the message text is what this
request explicitly asked us not to do, and a guessed category would steer a
rewrite in the wrong direction. The bare `content_refused` code ships; the
category does not.

**No provider name is published in either field on an aggregator route.** As
requested, `failure_class` names nobody at all — it is GenStudio's own closed
vocabulary — which is why it is published even where the provider's words are
withheld.
