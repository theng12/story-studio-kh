# Video Studio Model Boundary

## Current Decision

Story Studio generates motion clips through image-to-video only. Text-to-video is not part of the production flow. A scene must have a generated source image before it can be animated.

The in-app compatibility catalog is intentionally limited to the current image-to-video models already wired to the fal.ai and kie.ai providers. Sora 2, Runway Gen-3, and text-only endpoints are retired.

## Deferred Integration

`videostudio-mac` should eventually own provider credentials, live model inventory, capability and pricing metadata, request dispatch, and provider deprecation. Story Studio should then consume that inventory instead of shipping a growing provider-specific list.

This integration is shelved until Video Studio has a stable inventory and dispatch API. Story Studio must not add a partial connection or silently fall back to a second model catalog before that contract exists.

## Reopen Criteria

- Video Studio reports online state and a versioned image-to-video catalog.
- Catalog entries expose stable ids, provider, pricing, duration, aspect, and source-image requirements.
- Dispatch accepts a source image, motion prompt, output settings, and an idempotency key.
- Jobs expose durable status, provider task id, retry state, and verified output metadata.
- Story Studio can retain direct providers as an explicit compatibility fallback during migration.
