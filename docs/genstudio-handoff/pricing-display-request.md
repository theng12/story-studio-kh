# Request to GenStudio: small gaps for live credit-cost display

**From:** Story Studio KH
**Short version:** almost nothing is needed. GenStudio already publishes a price for every
modality, and Story Studio is going to surface those live figures everywhere instead of
showing nothing (or, historically, a local guess). This lists only the small gaps.

## What is already sufficient — no change requested

| Modality | Fields Story Studio will read |
|---|---|
| Image | `credits_per_image`, `base_credits_per_image`, `promotion_name`, `promotion_discount_percent`, `reference_generation_credits`, `chargeable`, `price_version` |
| Video | per-variant `credits_per_video`, `minimum_credits`, `price_version` |
| Voice / TTS | `/v1/tts/models` → `credits_per_1000_characters`, `minimum_credits`, **plus `POST /v1/tts/quotes` → exact `credits`** |
| Transcription | `credits_per_second`, `minimum_credits`, `price_version`, **plus the quote endpoint → `quoted_credits`** |
| Music | `credits_per_request`, `minimum_credits` |
| Chat | `input_credits_per_million_tokens`, `output_credits_per_million_tokens`, `minimum_credits`, and `web_search_credits_per_search` |

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

## Gap 2 — `price_version` missing on TTS models and music

Every other modality carries `price_version`. `TTSModelResponse` and
`MusicModelResponse` do not. The authenticated rate card can now be joined through
`customer_handle`, but publishing the value on each model list would keep the normal
catalogue path self-contained.

Story Studio stores `price_version` with each job so historical jobs stay interpretable
after prices change ("this cost 4 credits under the 2026-07 price list"). Without it, voice
and music jobs cannot be explained later — the number is recorded but not what it was
priced against.

Small addition, and it makes the audit trail consistent across modalities.

## Gap 3 — `minimum_credits` missing on image

`ChatModelResponse`, `TranscriptionModelResponse`, `VideoPriceVariantResponse`,
`MusicModelResponse`, and `TTSModelResponse` all publish `minimum_credits`.
`ImageModelResponse` does not.

If a floor applies to those two, Story Studio would under-display the price of a very small
request. If no floor applies, ignore this — Story Studio will assume none.

## Not requested

- No new endpoint for image/video/music estimates. They are flat per-unit prices; Story
  Studio can display unit price and quantity without inventing anything.
- No change to how actual charges are reported. `credit_cost` / `remaining_credits` on the
  job response is exactly what Story Studio needs, and it will keep preferring those over
  anything it derived beforehand.

## Status header — added 2026-08-28

**STILL-REFERENCED.** Cited directly (as `docs/genstudio-handoff/pricing-display-request.md`)
in a doc comment on `GenStudioTranscriptionModel.credits_per_second` in
`electron/server/lib/genstudio-client.ts` (~L831), explaining why transcription is priced
per-second rather than per-minute. Do not move this file while that comment cites the path.

**Progress since 2026-08-10, verified against the current tree:**
- **Gap 3 (minimum_credits on image) — shipped.** `GenStudioImageModel` now carries both
  `minimum_credits: number | null` and `price_version: string | null`.
- **Gap 2 (price_version on TTS/music) — half-shipped.** `GenStudioMusicModel` now carries
  `price_version`. `GenStudioTtsModel` still does not — only `GenStudioTtsQuote` carries
  `price_version`, so a TTS job's price version is knowable at quote time but not from the
  model catalogue row itself. Still a real, if narrower, gap.
- **Gap 1 (chat cost estimate)** — no `POST /v1/chat/quotes` or `typical_output_tokens`
  found; Story Studio is still on option (a), rate + actual only, exactly as the doc says it
  would be regardless.

## What Story Studio is building regardless

Live credit cost shown for every action and model, read from the catalogue at run time,
with no hardcoded prices anywhere. Estimates labelled as estimates, quotes labelled as
quotes, actuals labelled as actuals, and "not reported" where GenStudio does not supply a
figure — never a locally computed stand-in.
