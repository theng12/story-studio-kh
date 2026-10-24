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
export const NATIVE_SCENE_CLIP_VERSION = 3

/**
 * Helper versions whose Sketch Draw clips are still a valid render for freshness. Version 3 only
 * lengthened the closing hold (2.5 s, or half the clip when shorter); a version-2 clip is complete
 * and exactly as long as its scene window, so accepted clips must not go stale on the bump.
 * Freshness checks use this list; the helper probe still requires NATIVE_SCENE_CLIP_VERSION exactly.
 */
export const SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS: readonly number[] = [2, 3]
