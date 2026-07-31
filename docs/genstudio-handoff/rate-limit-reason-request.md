# Request to GenStudio: say which layer applied backpressure

**From:** Story Studio KH
**Status:** open
**Urgency:** low, but it produces a misleading customer message today

## The problem

When a language generation is refused for capacity reasons, GenStudio returns one generic
message:

> `GenStudio KH is busy or rate-limited: language generation is busy. Story Studio will honor its Retry-After guidance.`

Story Studio displays that verbatim, which is correct — it must never guess at or name a
provider. But the customer cannot act on it, because at least three very different
situations produce identical text:

1. **Their own account limit** — paid concurrency, queued jobs, or submissions-per-minute
   exhausted. Within their control: wait, or upgrade.
2. **GenStudio queue depth** — GenStudio itself is saturated. Retry later. Nothing the
   customer can change.
3. **Upstream provider backpressure** — the routed provider throttled it. Also just retry,
   and it says nothing about the customer's own usage.

A customer nowhere near their limits currently sees the same sentence as one who has
genuinely exhausted their plan, and reasonably concludes they are over quota when they are
not.

## Request

Add a safe, provider-agnostic reason code to capacity refusals. Something like:

- `account_concurrency`
- `account_rate_limit`
- `queue_saturated`
- `provider_backpressure`

No provider name, no route detail — only which **layer** pushed back.

If a `Retry-After` value accompanies the refusal, exposing that too would let Story Studio
show a real wait time instead of an open-ended "busy".

## Why it is worth the effort

In a real 18-chapter chunked run, batches 1 and 3 succeeded while batch 2 was refused, all
concurrent. That pattern rules out an account cap — but only by inference, and only because
a human read the log and reasoned about the timing. Story Studio could not tell the customer
anything useful in the moment.

With a reason code, Story Studio would say *"your account is at its concurrency limit — wait
or raise it"* versus *"GenStudio is busy right now — retrying shortly"*, instead of one
ambiguous sentence covering every cause.

## What Story Studio does either way

Continues to display GenStudio's own message as the primary text, and does not infer a cause
when no code is present.
