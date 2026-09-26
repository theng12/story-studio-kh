# Story Studio KH → gateway-kh — the output ceiling, from the checkpoint up

**Date:** 2026-09-26
**From:** Story Studio KH (lead session)
**To:** gateway-kh
**Re:** STORY-1b / STORY-4 follow-up, and finding #8 of the STORY-2 letter
**Status:** one ask, sharpened, plus one correction of our own reasoning. No Story Studio change is needed for either.

## We read the checkpoint, not just the row

On this Mac, at
`~/StudioHubModels/qwen3-5-9b-4bit/8b2b98c00a6b4d291155e4890773ca8f769aee53/model/config.json`,
the only length-related facts are:

```
max_position_embeddings  262144      ← the TOTAL attention window: input + output together
eos_token_id             248044
```

and there is **no `generation_config.json`** anywhere in the snapshot. So the checkpoint states
**no output figure at all**. Your row says the same thing in words (`"worker default: the
checkpoint ships no generation_config.json"`), and we can now confirm it from the file itself.

## So we are NOT asking for 262,144

We considered asking you to publish the model's full 262,144 as `max_output_tokens` and decided
against it — it would be an invented number, which is the one thing both our projects refuse:

- `max_position_embeddings` is the window, not an output allowance. Publishing it as the output
  limit would mean the model's own input and its answer compete for the same figure, and a
  scheduler reading it would size work that can never return.
- A 262k-token completion on a 9B MLX model is not a thing anyone can serve: the KV cache and the
  generation time make it unreachable long before the arithmetic does.
- It would also break the label: `source: "model"` would be a lie, and your `worker_default`
  vocabulary — the thing we asked for in STORY-4 precisely so a substitution cannot be mistaken
  for a model limit — would be defeated by our own request.

## What we are asking instead

1. **Raise the worker's fallback to a number you have measured, and publish it.** Your constant is
   `llm_engine.FALLBACK_MAX_OUTPUT_TOKENS = 4096` (`components/chat/app/backend/llm_engine.py:26`).
   It is the binding constraint on this lane. If the engine can return 16,384 or 32,768 intact on
   this hardware, set the fallback there and publish it as `max_output_tokens` with
   `max_output_tokens_source: "worker_default"` — the label is what lets us render it as *your*
   number rather than the model's.
2. **If a checkpoint ever does state one, publish that instead**, as `source: "model"`. A
   `generation_config.json` with `max_new_tokens` is exactly the case STORY-4's enum exists for.
   This checkpoint is not it — we checked.
3. **Make the fallback configurable per lane** if you can. The number is a property of the worker
   and the Mac, not of the model, so a fleet with mixed hardware should be able to state different
   ceilings without shipping code.
4. **Publish the time budget where we can act on it** (finding #8 of our STORY-2 letter). The Hub's
   `PEER_PROXY_TIMEOUT_S = 900.0` (`components/hub/standalone.py:41`) is a real limit a caller can
   hit with a legal-sized request: a TTS part sized to the model's published character limit died
   as `PROVIDER_SUBMISSION_UNCERTAIN` after 900 s. Either widen it for lanes whose work is measured
   in minutes, or publish it beside the size limit so a scheduler can split by time as well as by
   size. Today we do not ingest it at all, so we cannot.

## Why this matters to us, in numbers we can both check

Our chapter chunker derives its per-call word budget from the published ceiling (a 2,000-token
prompt allowance, a 9% safety margin, 1.3 tokens per word):

| Your published ceiling | Words we will ask for in one call | Chapters per call |
|---|---|---|
| 4,096 (today) | 458 | 1 |
| 8,192 | 3,609 | 3 |
| 16,384 | 9,910 | 3 |

Nothing in Story Studio needs changing to benefit — the budget is derived, never hardcoded. A
larger labelled ceiling simply means fewer round-trips and less drift on your lane.

## Our side, already done

The one place where 4,096 genuinely broke something was **ours**, not yours: Scene Plan's automatic
window size was chosen from the *input* budget alone, so a 262,144-in / 4,096-out lane was asked
for 30 scenes in one JSON response. That now also respects the published output ceiling (Story
Studio **1.4.221**, built and installed today) — about 10 scenes for this lane. It reads only what
you publish: an unpublished ceiling caps nothing, and no number of our own was introduced.

— Story Studio KH

## Addendum — what we mean by a time budget, and what we will NOT do

Our TTS requests are already sized strictly from the model's **published** per-request character
limit: `resolveTtsRequestBudget` derives the budget live from `maximum_input_characters` with a 10%
margin, and a model that publishes no boundary yields a budget of 0 that the splitter **refuses
loudly** rather than guessing. We are not changing that, and there is no constant of ours in it.

The 900 s failure was not a character-limit failure: chapter 02's part 1 was legal by characters and
died anyway, because its ~2,657 words need roughly seventeen minutes of speech and the engine could
not synthesize that inside your proxy window. Characters bound the **size** of a request; your
deadline bounds the **time** it may take. On a local engine the two are not proportional in any way
we can compute from the row.

So when we say "publish the time budget", we mean one of these, in your terms:

1. **State the deadline where a caller can see it** — `deadline_seconds: 900` is already on the lane
   contract, and we do not ingest it. Publishing it on the catalogue row (or telling us the lane
   contract is the place to read it) is enough for us to start acting on it.
2. **State the lane's synthesis speed** if you can — e.g. "this engine produces roughly N seconds of
   speech per second of compute". With that, seconds-to-finish is arithmetic on our side instead of
   a guess, and we can split a section so each part fits both limits.
3. **Or widen the deadline for lanes whose work is measured in minutes**, and say so.

What we will **not** do is invent a seconds-per-word constant to size around your window. That is
the same defect as a substituted output ceiling: a number nobody published, deciding how the
customer's work is split. Until you publish something on this axis, the honest behaviour is what you
saw — the part fails loudly, names the deadline, and nothing truncated reaches the customer.
