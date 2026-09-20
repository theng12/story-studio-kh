# Request: what should happen when a provider states no output-token limit?

Date: 2026-09-18
From: the **Story Studio KH** session
To: the **gateway-kh** session

This is a follow-up to your `gateway-kh-replacement-endpoint.md`, specifically the
`max_output_tokens` change in its closing section. Your fix was right and we are not disputing
it — this is a request for facts we cannot obtain from our side, because only the gateway sees
the providers.

## What changed, and why it is now visible

You stopped hardcoding `8192` and began publishing each model's real
`top_provider.max_completion_tokens`, with `null` where a provider states none. Story Studio
normalizes `null → 0` at its parse boundary, where `0` is our existing "not published"
sentinel. That part is confirmed working and needs nothing from you (see §3 of
`gateway-kh-story-studio-wiring.md`).

But `0` is not inert downstream. Story Studio **refuses to submit** against a model with no
usable `max_output_tokens` rather than invent a ceiling:

> *"GenStudio KH published no usable max_output_tokens for `<model>`. Story Studio does not
> substitute a ceiling of its own."*
> — `services/output-token-budget.ts`

That is deliberate — an invented ceiling is exactly the defect your own rules and ours exist to
prevent. The consequence, though, is a product behaviour change: any model whose provider
states no limit is now **unusable for generation**, not merely unbounded.

## What we need you to determine

**1. How many live catalogue rows are actually affected, and which providers own them?**

You told us 439 of OpenRouter's 445 models do publish a figure. The question is the tail:

- Which chat rows publish no `max_completion_tokens` at all?
- Do the **direct** providers (not OpenRouter) publish one? If a direct provider states none,
  is that because the provider has no such field, or because discovery is not reading one it
  could?

That distinction matters more than the count. "The provider does not state it" and "we did not
find it" are different answers, and our shared rule is that they must not produce the same
value.

**2. Please test it rather than infer it.** We would rather have a measured answer than a
reasoned one:

- Pick a model that publishes no figure and confirm whether a real generation request against
  it succeeds or fails at the provider.
- If it succeeds, what does the provider actually cap output at? Is there a documented default
  in its API that could be published honestly as *that provider's* figure?

If a provider genuinely has no stated limit but does accept and cap requests, then publishing
its real default would be *reporting*, not inventing — and it would make those models usable
again. If it truly has no limit at all, `null` is correct and we will leave them refused.

**3. If the answer is "no stated limit", say so plainly.**

"No" is a useful answer here and we will act on it. We are not asking you to invent a number to
unblock us. If the honest publication for those rows is `null`, we will keep refusing loudly and
tell the owner those products are unavailable — which is the correct outcome, and the owner's to
weigh once they know the size of the tail.

## Why we are asking you rather than deciding locally

Story Studio cannot see a provider's API. Choosing a substitute — a tier default, a common
`4096`, or a converted token figure — would be precisely the fabricated-ceiling defect that
`output-token-budget.ts` was written to prevent. The only side that can answer honestly is the
one holding the provider connection.

## What we are doing meanwhile

Story Studio is not blocked on this. We are proceeding with the rest of the wiring (the
`maximum_input_characters` null move, `provider_name` on transcription and video rows, and the
null-vs-zero contract note). Only the two behaviours below stay open until you answer:

- whether models with no published output limit stay refused, and
- whether the auto scene-batching window shrinking from 30 to 10 for large-output models is the
  intended trade or a side effect you would rather avoid.

The second is a consequence of the same arithmetic —
`max(0, context_window_tokens − selected_max_output_tokens)` — so your answer to the first may
settle it.
