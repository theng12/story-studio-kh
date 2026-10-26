# Video Studio Model Boundary

## Current Decision

Story Studio generates motion clips through **image-to-video only**. Text-to-video is not part of
the production flow. A scene must have a generated source image before it can be animated, and a
missing scene image is a **blocking error** — never permission to reuse a different one.

Video models resolve through **the one paired Gateway's live catalogue**, the same endpoint every
other modality uses. Story Studio reads inventory, capability and pricing live on every selection
change (AGENTS §1) and ships no provider-specific list or second catalogue of its own. Sora 2,
Runway Gen-3, and text-only endpoints are retired.

## Owner note — 2026-10-26

The owner said text-to-video may become a future feature, but he has not decided. Until he does,
the image-to-video rule above stands as written; changing it is his decision to make, not an
implementation task to schedule.

## Reopen Criteria

- The Gateway publishes a versioned image-to-video catalogue with stable ids, provider, pricing,
  duration, aspect, and source-image requirements.
- Dispatch accepts a source image, motion prompt, output settings, and an idempotency key.
- Jobs expose durable status, provider task id, retry state, and verified output metadata.
