/**
 * The pixel size every scene picture is written at (owner 2026-11-19).
 *
 * Two models published two different sizes — FLUX2 only 1280x720, qwen only 1024x576 — so an episode
 * that mixes models came out mixed. The app now writes one canonical size: the model draws what it
 * publishes, and the picture is brought to this size before it lands. 1024x576 is the owner's default;
 * 1280x720 stays available by name, per episode.
 */
export const IMAGE_SIZE_OPTIONS = ['1024x576', '1280x720'] as const
export type ImageSizeLabel = typeof IMAGE_SIZE_OPTIONS[number]
export const DEFAULT_IMAGE_SIZE: ImageSizeLabel = '1024x576'

export interface ImageSize { width: number; height: number }

/** `"1024x576"` (or a width/height pair from a job) — never a guessed size. */
export function parseImageSize(value: unknown): ImageSize | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(value.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) return null
  return { width, height }
}

/** The size a render writes at: the episode's choice when it named a valid one, otherwise the default. */
export function resolveRenderImageSize(requested: unknown): { size: ImageSize; label: string } {
  const parsed = parseImageSize(requested)
  if (parsed) return { size: parsed, label: `${parsed.width}x${parsed.height}` }
  const fallback = parseImageSize(DEFAULT_IMAGE_SIZE)!
  return { size: fallback, label: DEFAULT_IMAGE_SIZE }
}
