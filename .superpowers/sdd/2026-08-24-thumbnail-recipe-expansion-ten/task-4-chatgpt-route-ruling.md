# Task 4 execution-route ruling — built-in ChatGPT previews

The owner explicitly replaced the planned Studio Hub route and then confirmed: `yeah use the built in chatgpt image tool.` This addendum resolves only fields made unavailable by that route; the approved creative batch, receipt, source, review, and fail-closed gates remain binding.

## Exact route facts

- Tool provenance: `built-in ChatGPT image generation`.
- Backend provider/model: not exposed by the built-in tool; never claim `gpt-image-2`.
- Fleet worker/controller: not applicable; this Mac never registered or executed as a fleet worker.
- Provider job/request ID: not exposed. The coordinator's exact `draft_job_id` and prompt SHA-256 remain the local correlation keys.
- Seed: not exposed.
- Per-output price/cost receipt: not exposed/not applicable to this built-in route; no Studio Hub credits were charged and no external paid API/CLI call was made.
- Inputs: text-only; every batch row has `reference_images: []`; no source image, likeness, logo, UI screenshot, or third-party asset was supplied.
- Prompt authority: the owner explicitly confirmed the built-in tool after the immutable batch was complete.

Unavailable fields must be recorded as unavailable with the reason above, never invented or silently omitted.

## Official rights and provenance basis

- OpenAI Terms of Use, Content section, accessed 2026-08-24: as between the user and OpenAI and to the extent permitted by applicable law, the user owns Output; output may not be unique; the user remains responsible for use and appropriateness. Source: `https://openai.com/policies/terms-of-use/`.
- OpenAI Help Center, provenance signals, accessed 2026-08-24: supported images generated with ChatGPT, Codex, and the API include C2PA metadata and SynthID; these signals indicate OpenAI-tool origin but do not independently establish accuracy, ownership, or context. Source: `https://help.openai.com/en/articles/8912793`.
- The untouched selected PNGs remain in this plan's ignored `chatgpt-originals/` tree. Their recorded C2PA/OpenAI strings support route provenance; the source pack WebPs must link back to the untouched original hashes.
- Rights description in Story evidence: `OpenAI output terms basis; owner responsible for use; non-exclusive/similarity caveat applies`. Do not call this an exclusive copyright, a model-specific license, or an infringement warranty.

## Conversion contract

- All 30 current selected PNGs passed independent visual/title review and final cross-wave diversity review. Current replacement hashes for the two prior blockers are `9b2e49ace8bbd84fc055cc96a138e6057df40b10b935d31ae9cc51fb5fd92b07` and `b37490d2edd19e55b0ddb5a758541d71cf6b84298ba993009bd7fe2cd515dce8`.
- Convert each selected PNG twice with Sharp using a deterministic whole-image operation: resize to exactly `1672x941` with `fit: "fill"` and `kernel: "lanczos3"`, then WebP lossless with fixed effort. Compare the two outputs byte-for-byte before selecting one.
- This is a full-frame format/dimension conversion only. No crop, mask, overlay, title replacement, inpainting, region edit, compositing, or creative repair is allowed.
- Preserve original and converted SHA-256, bytes, dimensions, format, decode result, prompt SHA, title transcription, line count, visual review references, conversion settings, rights basis, and receipt in the returned-evidence ledger and durable provenance.
- Ten originals are `1671x941`; the other twenty are `1672x941`. Every accepted source asset must be decoded WebP at exactly `1672x941` and greater than 20,000 bytes.

## Task boundary

Task 4 may create the 30 converted WebP assets, `PREVIEW-PROVENANCE.md`, the ignored returned-evidence ledger, and RED source expectations. It must not author `pack.json` or `content/thumbnail-recipe.json`, transition registry status, build archives, stock, publish, push, or commit a globally failing test. Tasks 5–9 own the receipt-bound source manifests and GREEN commits.
