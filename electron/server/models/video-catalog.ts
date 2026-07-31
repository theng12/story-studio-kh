import type { VideoModelConfig } from './types.js'

/**
 * Keep the Story Studio compatibility catalog strictly image-to-video, and
 * strictly to entries that publish themselves as available.
 *
 * WHY THIS IS NOT A NAME TEST ANY MORE
 * ------------------------------------
 * This used to drop an entry when a regex matched `sora 2` / `runway gen-3`
 * anywhere in its id, label or provider params. Retiring those two models is
 * still correct (AGENTS.md, "Video Model Boundary") — but deciding a model's
 * fate from a substring of its DISPLAY LABEL is the wrong mechanism twice
 * over: it breaks the moment a label is reworded, and it never applied to
 * anything but two names somebody happened to think of. Capability and
 * availability are properties a catalog publishes, not things to infer from
 * what a model is called.
 *
 * So the rule is now `available === true`, explicitly. An entry with no
 * `available` field was never published as available and is dropped, which is
 * the same "absent is not a yes" reading the rest of this app applies to
 * unpublished catalogue fields — and it retires Sora 2 and Runway Gen-3 along
 * with every other legacy entry, by contract rather than by name.
 *
 * Note this catalog is a COMPATIBILITY surface only: `DEFAULT_VIDEO_MODELS` is
 * empty and every executable video model is resolved against GenStudio's live
 * catalog (see generators/scene-clip.ts). Legacy entries here point at the
 * direct fal/Kie providers that were removed when all generation collapsed
 * onto the GenStudio boundary, so they cannot execute regardless.
 */
export function sanitizeVideoCatalog(
  catalog: Record<string, VideoModelConfig> | null | undefined,
): Record<string, VideoModelConfig> {
  const clean: Record<string, VideoModelConfig> = {}
  for (const [id, model] of Object.entries(catalog || {})) {
    if (!model || !Array.isArray(model.modes) || !model.modes.includes('frames')) continue
    if (model.available !== true) continue
    clean[id] = { ...model, modes: ['frames'] }
  }
  return clean
}
