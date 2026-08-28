# Request to GenStudio: publish the serving provider on every modality

**From:** Story Studio KH
**Status:** OPEN
**Urgency:** low — nothing is broken. This is consistency, and it finishes a decision already
made on both sides.

## Background

The owner's decision of 2026-08-01 moved Story Studio from hiding providers to showing them:

> *"we have moved from hiding provider into showing it and being transparent. so yeah we will
> show it. not just for voice but in fact for all any other models as well if they aren't
> already public yet."*

Story Studio implemented that immediately — the masking that used to strip `provider`,
`engine_id`, `engine_name`, `model_family` and `model_revision_id` at our backend boundary is
gone, and provider is now displayed wherever GenStudio publishes it.

The gap is that GenStudio publishes it for speech and voice-clone surfaces only.

## Current state, read from the live spec

| Response schema | Provider fields published |
|---|---|
| `StandardVoiceResponse` | `provider`, `engine_id`, `engine_name`, `model_family`, `model_revision_id` |
| `TTSModelResponse` | `provider_id`, `provider_name` |
| `TranscriptionModelResponse` | **none** |
| `ChatModelResponse` | **none** |
| `ImageModelResponse` | **none** |
| `VideoModelResponse` | **none** |
| `MusicModelResponse` | **none** |

The voice work of 1–2 August did this properly and is the model to copy: `provider_id` plus a
human-readable `provider_name` is exactly the right shape — an id to key on and a label to show.

## The request

**Publish the serving provider on the remaining modalities: chat, image, video, music, and
transcription.** A scalar `provider_name` fits chat, video, music, and transcription. Images
need an operation-aware shape such as `provider_name_by_operation`, because their serving
route can differ by operation and output variant. Story Studio will display either shape but
will not infer it.

## Why it is worth doing

**Chat is where it matters most.** A customer choosing a language model sees 34 entries whose
names alone imply a vendor — but Story Studio will not infer one from a name, because deriving
capability or identity from a model id is the single rule that has cost real money here more
than once. So the row shows the model name and nothing else, while the voice picker beside it
names ElevenLabs and Fish Audio outright. Same product, two different levels of candour,
decided entirely by which schema happens to carry the field.

**It also removes a source of noise.** Until now Story Studio appended "[GenStudio KH]" to every
model name, which said nothing — every model comes through GenStudio. That is being removed. On
voice and TTS the space is now filled with something real. On chat, image, video and music it
is simply blank.

## What Story Studio will do either way

- **Never infer a provider.** No name patterns, no id prefixes, no lookup table. If GenStudio
  does not publish it, no provider is shown — the control is absent, not guessed.
- **Display only, never dispatch.** Story Studio does not select, rank, prefer or route to a
  provider, and sends no provider field on any generation request. Provider selection is
  entirely GenStudio's. Showing who served a request must never become a way to choose who
  serves the next one.
- **Read it live.** A displayed provider is re-read from the catalogue on every selection
  change, never cached past it.

Adopting the fields is a small change on our side, because voice already established the path.

## Owner decision

The owner chose **extend** on 2026-08-01, as quoted above. Provider identity stays display-only
and GenStudio-owned; this request does not authorize Story Studio to infer providers or steer
routing.

---

## ALREADY SHIPPED — verified 2026-08-28

**Status:** CLOSED. No new work was required; this was verified complete, not built.

The table in the body of this request is stale. Checked against GenStudio `main`
(`0f8f28c1`), **all five remaining modalities already publish `provider_name`**:

| Response schema | Field | Populated by |
|---|---|---|
| `ImageModelResponse` | `provider_name` | `images/catalog.py` (per-product literals) |
| `ChatModelResponse` | `provider_name` | `chat/router.py` → `origin_provider_name(...)` |
| `MusicModelResponse` | `provider_name` | `music/router.py` → `origin_provider_name(...)` |
| `VideoModelResponse` | `provider_name` | `videos/router.py` → `origin_provider_name(...)` |
| `TranscriptionModelResponse` | `provider_name` | `transcriptions/router.py` → `origin_provider_name(...)` |

Video and transcription — the two this was reopened for — are populated at
`videos/router.py:284` and `transcriptions/router.py:367` respectively. The
declaration and the population were both checked; a field present in a schema
but never assigned would have looked identical from the schema alone.

`origin_provider_name()` resolves an exact-id lookup in `PRODUCT_ORIGIN_PROVIDERS`
and returns `None` when nobody has established the maker — "by exact id and never
by inference", which matches this request's own rule that identity is published
or absent, never guessed. The scalar shape shipped rather than the
operation-aware `provider_name_by_operation` floated here for images; a scalar
was sufficient because a product's MAKER does not vary by operation, even when
its serving route does.

Nothing here changed in `feat/customer-failure-reason-2026-08-28`; the branch
only confirmed it. The separate rule that an *aggregator* must never be named is
enforced independently in `app/modules/jobs/failure_reason.py`.
