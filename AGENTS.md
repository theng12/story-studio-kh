# Codex Notes

## Scene vs Thumbnail Split

Scene prompts, thumbnail prompts, scene image generation, and thumbnail image generation are separate surfaces. Do not collapse them back into the old unified image prompt/image generator model.

- Thumbnail prompt presets use `thumbnail_prompts_presets` and `thumbnail_prompts_last_preset`.
- Scene prompt presets use `scene_prompts_presets` and `scene_prompts_last_preset`.
- Thumbnail generator presets use `thumbnail_generator_presets` and `thumbnail_generator_last_preset`.
- Scene generator presets use `scene_generator_presets` and `scene_generator_last_preset`.
- `image_prompts_*` and `image_generator_*` are legacy compatibility keys only. They should not be the primary keys for new thumbnail/scene UI or Pipeline selectors.
- The Pipeline batch step named `image_prompts` must use the active format to choose prompt mode. Classic chapter-distributed scene-image formats may run `mode: "all"`; B-Roll, timestamp-driven, continuity-chain, and narrated-scenes formats must run thumbnail prompts only (`mode: "thumbnails"`) because scene prompts come from Scene Plan.
