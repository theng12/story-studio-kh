/**
 * The scene-clip helper's output version, in a leaf module.
 *
 * `services/scene-media-checkpoint.ts` needs this value when checking freshness, while
 * `lib/native-scene-clip.ts` imports the job queue. Keeping the number here means the
 * freshness rule never pulls the native process lifecycle (or the queue) in through a cycle.
 *
 * MUST equal `HELPER_VERSION` in `native/scene-clip/main.swift`; the backend regression
 * reads both files and the build script's version probe enforces it at build time.
 */
export const NATIVE_SCENE_CLIP_VERSION = 2
