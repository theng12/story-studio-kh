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

The gap is that GenStudio publishes it for only three of seven modalities.

## Current state, read from the live spec

| Response schema | Provider fields published |
|---|---|
| `StandardVoiceResponse` | `provider`, `engine_id`, `engine_name`, `model_family`, `model_revision_id` |
| `TTSModelResponse` | `provider_id`, `provider_name` |
| `TranscriptionModelResponse` | `provider` |
| `ChatModelResponse` | **none** |
| `ImageModelResponse` | **none** |
| `VideoModelResponse` | **none** |
| `MusicModelResponse` | **none** |

The voice work of 1–2 August did this properly and is the model to copy: `provider_id` plus a
human-readable `provider_name` is exactly the right shape — an id to key on and a label to show.

## The request

**Publish the serving provider on the remaining modalities: chat, image, video and music** —
ideally as the `provider_id` + `provider_name` pair `TTSModelResponse` already uses, so Story
Studio can consume all of them through one code path.

`TranscriptionModelResponse` publishes a bare `provider`. A `provider_name` beside it would let
transcription use the same path as everything else, but that is cosmetic and not worth a
migration on its own.

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

## A "no" is a fine answer

If provider identity is deliberately private for the routed modalities — that would be a
reasonable position, and it was Story Studio's original instruction until 1 August — then say
so and we will stop asking. What is awkward is only that it is currently private for four
modalities and public for three, with no stated reason for the split, so neither side can tell
whether the gap is a decision or an oversight.
