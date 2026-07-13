# Codex Notes

## Scene vs Thumbnail Split

Scene prompts, thumbnail prompts, scene image generation, and thumbnail image generation are separate surfaces. Do not collapse them back into the old unified image prompt/image generator model.

- Thumbnail prompt presets use `thumbnail_prompts_presets` and `thumbnail_prompts_last_preset`.
- Scene prompt presets use `scene_prompts_presets` and `scene_prompts_last_preset`.
- Thumbnail generator presets use `thumbnail_generator_presets` and `thumbnail_generator_last_preset`.
- Scene generator presets use `scene_generator_presets` and `scene_generator_last_preset`.
- `image_prompts_*` and `image_generator_*` are legacy compatibility keys only. They should not be the primary keys for new thumbnail/scene UI or Pipeline selectors.
- The Pipeline batch step named `image_prompts` must use the active format to choose prompt mode. Classic chapter-distributed scene-image formats may run `mode: "all"`; B-Roll, timestamp-driven, continuity-chain, and narrated-scenes formats must run thumbnail prompts only (`mode: "thumbnails"`) because scene prompts come from Scene Plan.

## Verified Completion Contract

Every generation flow must prove its output is complete before a job, pipeline step, Production Board cell, or one-click run may report success.

- A generator returning without throwing is not evidence of completion. Audit the authoritative files, manifests, expected item IDs, and usable content after generation.
- Preserve valid partial outputs, but fail the overall job loudly when any required item is missing, empty, stale, malformed, or failed at its provider.
- Error messages must name the missing or invalid items and tell the user how Retry/self-healing will repair them without repeating completed work.
- Completion checks must compare expected versus present artifacts. Never use directory existence, one matching file, a stale derivative, a legacy fallback, or `progress = 100` as proof of completion.
- The generator, Job Queue, Pipeline, Production Board, pending filters, and downstream gates must use the same authoritative completion rule.
- Optional steps may be skipped only through explicit project configuration. A skipped optional step is not missing; a required step with partial output is never done.
- New generators and material changes to existing generators require regression tests for complete, partial, empty, stale, malformed, provider-failure, and retry/self-healing outcomes.
- When auditing or changing generation code, search for swallowed per-item errors, warning-only failures, unconditional `progress = 100`, and queue executors that return after partial work.

## Optional Research and Retired Co-writer

- Research is an opt-in enrichment step. It may appear in supported format flows and expose its own pending filter, but it must never count as a missing Production Board asset, block episode completion, or run by default in the one-click Pipeline.
- The Co-writer feature is retired. Do not restore its page, navigation entry, API routes, local-storage stores, or completion dependencies. Idea development belongs in Ideas, Research, and Script Generator workflows.
