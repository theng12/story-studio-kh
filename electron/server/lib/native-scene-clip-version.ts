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
export const NATIVE_SCENE_CLIP_VERSION = 6

/**
 * Helper versions whose Sketch Draw clips are still a valid render for freshness. Version 3 only
 * lengthened the closing hold (2.5 s, or half the clip when shorter); a version-2 clip is complete
 * and exactly as long as its scene window. Version 4 gave the drawing multi-scale ink, two-tone ink
 * and subject-first order, and added the reveal styles — but a version-2 or version-3 clip is still
 * a complete, correct drawing of its scene, so accepted clips must not go stale on the bump. What a
 * version-4 clip adds is a `reveal_type` on its receipt; the freshness rule compares that only once
 * the channel has actually chosen a style. Version 5 adds the "Colour it in" reveal and leaves the
 * five existing types drawing exactly as version 4 did, so every accepted clip stays fresh.
 * Freshness checks use this list; the helper probe still requires NATIVE_SCENE_CLIP_VERSION exactly.
 *
 * Version 6 gives EVERY reveal a closing dissolve: the drawing's ink and tone ease out over the
 * last 12% of the reveal, so the last frame and the whole hold are the scene image itself. A
 * version-5 clip ends on the drawing instead of the picture — a complete, correct drawing of its
 * scene, but not the same ending — so accepted clips stay fresh and only re-render when the owner
 * asks for them again.
 */
export const SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS: readonly number[] = [2, 3, 4, 5, 6]
