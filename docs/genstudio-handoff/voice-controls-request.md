# Request to GenStudio: publish per-model voice controls

**From:** Story Studio KH
**Status:** OPEN
**Urgency:** medium — Story Studio is currently showing customers controls that reach nothing.

## The problem, concretely

Story Studio's audio page has **Stability** and **Similarity** sliders. The customer moves
them. They do nothing at all.

`POST /v1/tts/jobs` accepts `{voice_id, text, speed}`. There is no field for stability, no
field for similarity, and no field for anything else of that kind. The values are collected
and discarded. We have just removed the same class of problem for `speed` — it is now shown
only when the model publishes `supports_speed` — but stability and similarity cannot be fixed
the same way, because there is nothing published to gate them on and nowhere to send them.

So today Story Studio has two choices, both bad: keep showing dead controls, or delete
capability that some models genuinely have.

## Why Story Studio cannot solve this on its own

**Different voice models take completely different expression controls.** ElevenLabs-style
stability and similarity are not what Fish Audio takes, which is not what Chatterbox takes,
which is not what Google takes. Each engine has its own parameter vocabulary, its own ranges,
and its own defaults.

Story Studio deliberately cannot see which engine serves a model, and refuses to infer
capability from a model id or name — that rule exists because guessing it has already cost
real money here more than once. So Story Studio has no legitimate way to know that model X
takes `stability` in the range 0–1 while model Y takes something else entirely.

Only GenStudio knows. This is the same reason the per-model step count went to GenStudio.

## The request

**Publish, per TTS model, which generation controls it accepts — and accept them on the job
request.**

There is already a precedent in your own contract: `ChatModelResponse.controls` is an array
of accepted control names, and Story Studio uses it to decide whether to send
`temperature` or `system_instruction`. That pattern works well and we would happily consume
the same shape here.

Voice controls need a little more than chat's, because they are numeric with model-specific
ranges rather than a fixed enum. Something along these lines on `TTSModelResponse`:

```
controls: [
  {
    name: "stability",
    label: "Stability",
    type: "number",
    minimum: 0.0,
    maximum: 1.0,
    default: 0.5,
    step: 0.05,
    description: "Lower is more expressive and variable; higher is more consistent."
  },
  ...
]
```

and correspondingly on the TTS job request, a place to send them — either named fields or a
single `controls: {name: value}` object validated against what the model published.

What matters to us, in order:

1. **Which controls this model accepts**, by name. Without this we cannot show anything.
2. **The valid range and the default**, so the UI can be built from the contract instead of
   from assumptions, and so a customer cannot submit a value the model will reject.
3. **A human-readable label and description**, so Story Studio does not have to invent
   wording for a parameter whose meaning belongs to the engine.
4. **A way to send them** on the job request.

If a model takes no expression controls, publishing an empty list is a complete answer — Story
Studio will show no controls for it, which is correct.

## What Story Studio will do with it

Exactly what it now does for `speed`: render a control only when the model publishes it, with
the published range and default, and send only what the model declared. Nothing inferred,
nothing hardcoded, and the control disappears when the customer switches to a model that does
not take it.

## What Story Studio will do if the answer is no

Remove the Stability and Similarity sliders. Showing a customer a control that silently does
nothing is worse than not offering it. We would rather delete them than leave them lying, so a
"no" is a genuinely useful answer and unblocks us either way.

## One related note

`FishExpressionPanel` and the Delivery/Expression panels in the audio page are currently dead
UI — gated behind flags hardcoded to `false` from a previous integration. If a control
contract lands, that is the surface it would light up. Mentioning it so the shape of the ask
is clear: this is not a new feature request so much as reconnecting something that lost its
contract when everything moved behind GenStudio.
