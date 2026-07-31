# Request to GenStudio: small gaps for live credit-cost display

**From:** Story Studio KH
**Short version:** almost nothing is needed. GenStudio already publishes a price for every
modality, and Story Studio is going to surface those live figures everywhere instead of
showing nothing (or, historically, a local guess). This lists only the small gaps.

## What is already sufficient — no change requested

| Modality | Fields Story Studio will read |
|---|---|
| Image | `credits_per_image`, `base_credits_per_image`, `promotion_name`, `promotion_discount_percent`, `reference_generation_credits`, `chargeable`, `unlimited_relaxed`, `price_version` |
| Video | per-variant `credits_per_video`, `minimum_credits`, `price_version` |
| Voice / TTS | `credits_per_1000_characters`, `unlimited_relaxed`, **plus `POST /v1/tts/quotes` → exact `credits`** |
| Transcription | `credits_per_second`, `minimum_credits`, `price_version`, **plus the quote endpoint → `quoted_credits`** |
| Music | `credits_per_request`, `minimum_credits` |
| Chat | `input_credits_per_million_tokens`, `output_credits_per_million_tokens`, `minimum_credits`, `unlimited_relaxed`, and now `web_search_credits_per_search` |

Story Studio never computes a customer charge. It displays GenStudio's published unit
price, and after a run it displays the `credit_cost` GenStudio reports. Where a quote
endpoint exists it uses the quote rather than an estimate.

## Gap 1 — chat cost cannot be estimated before a run (the only structural one)

Chat is token-priced. Story Studio knows the input tokens (it wrote the prompt) but nobody
knows the output length until the model produces it. TTS and transcription both solve this
with a quote endpoint; chat has none.

So today Story Studio can only show a rate ("X credits per million output tokens") and the
actual charge afterwards. That is honest, but it means a customer starting an expensive
long-form research run has no idea of the magnitude until it finishes.

**Question, not a demand:** is a chat estimate feasible — even a coarse one? Options, in
increasing order of effort:

- **(a) Nothing.** Story Studio shows the rate and the actual. Acceptable; this is today.
- **(b) A typical-output hint on the catalogue**, e.g. `typical_output_tokens` per product,
  so Story Studio can show "usually around N credits" with an explicit "varies" caveat.
- **(c) A real `POST /v1/chat/quotes`** taking the request body and returning a bounded
  estimate. Most useful, most work.

Story Studio will implement (a) now and can adopt (b) or (c) with no redesign — the display
already distinguishes "estimate" from "actual".

## Gap 2 — `price_version` missing on voice and music

Every other modality carries `price_version`. `StandardVoiceResponse` and
`MusicModelResponse` do not.

Story Studio stores `price_version` with each job so historical jobs stay interpretable
after prices change ("this cost 4 credits under the 2026-07 price list"). Without it, voice
and music jobs cannot be explained later — the number is recorded but not what it was
priced against.

Small addition, and it makes the audit trail consistent across modalities.

## Gap 3 — `minimum_credits` missing on voice and image

`ChatModelResponse`, `TranscriptionModelResponse`, `VideoPriceVariantResponse` and
`MusicModelResponse` all publish `minimum_credits`. `StandardVoiceResponse` and
`ImageModelResponse` do not.

If a floor applies to those two, Story Studio would under-display the price of a very small
request. If no floor applies, ignore this — Story Studio will assume none.

## Not requested

- No new endpoint for image/video/music estimates. They are flat per-unit prices; Story
  Studio can display unit price and quantity without inventing anything.
- No change to how actual charges are reported. `credit_cost` / `remaining_credits` on the
  job response is exactly what Story Studio needs, and it will keep preferring those over
  anything it derived beforehand.

## What Story Studio is building regardless

Live credit cost shown for every action and model, read from the catalogue at run time,
with no hardcoded prices anywhere. Estimates labelled as estimates, quotes labelled as
quotes, actuals labelled as actuals, and "not reported" where GenStudio does not supply a
figure — never a locally computed stand-in.
