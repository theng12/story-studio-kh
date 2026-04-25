/**
 * Unified model catalog projection helpers.
 *
 * The project still persists three typed dicts on disk —
 * `image_models`, `audio_models`, `video_models` — because the seven
 * generator flows and the existing Settings → Models tab both key off those
 * shapes. The "unified" view is a single array that collapses them, giving
 * the refactored Settings UI (Delivery 4) and any future aggregator provider
 * one read surface.
 *
 * `toUnified` / `fromUnified` round-trip losslessly: every type-specific
 * field lives under `.params`, and `provider` is resolved explicitly (image
 * models default to `'kie'`; audio models fall back to prefix-matching for
 * legacy entries that pre-date the explicit `provider` field).
 */

import type {
  ImageModelConfig,
  AudioModelConfig,
  VideoModelConfig,
  UnifiedModel,
} from './types.js'

export interface LegacyCatalogs {
  image_models?: Record<string, ImageModelConfig>
  audio_models?: Record<string, AudioModelConfig>
  video_models?: Record<string, VideoModelConfig>
}

/** Prefix-based fallback for legacy audio model ids that lack `provider`. */
function inferAudioProvider(id: string, explicit: string | undefined): string {
  if (explicit) return explicit
  if (id.startsWith('eleven_')) return 'elevenlabs'
  if (id.startsWith('genaipro-')) return 'genaipro'
  return 'fal'
}

export function toUnified(
  catalogs: LegacyCatalogs,
  opts: { customs?: UnifiedModel[] } = {},
): UnifiedModel[] {
  const out: UnifiedModel[] = []

  for (const [id, m] of Object.entries(catalogs.image_models ?? {})) {
    const { label, provider, is_custom, ...params } = m as ImageModelConfig
    out.push({
      id,
      type: 'image',
      provider: provider || 'kie',
      label,
      ...(is_custom ? { is_custom: true } : {}),
      params,
    })
  }

  for (const [id, m] of Object.entries(catalogs.audio_models ?? {})) {
    const { label, provider, is_custom, ...params } = m as AudioModelConfig
    out.push({
      id,
      type: 'audio',
      provider: inferAudioProvider(id, provider),
      label,
      ...(is_custom ? { is_custom: true } : {}),
      params,
    })
  }

  for (const [id, m] of Object.entries(catalogs.video_models ?? {})) {
    const { label, provider, is_custom, ...params } = m as VideoModelConfig & { provider?: string }
    out.push({
      id,
      type: 'video',
      provider: provider || 'unknown',
      label,
      ...(is_custom ? { is_custom: true } : {}),
      params,
    })
  }

  // Append any user-added custom models that aren't represented in the
  // legacy dicts. Delivery 4 surfaces these via the Settings UI.
  if (opts.customs?.length) {
    const seen = new Set(out.map(m => `${m.type}:${m.id}`))
    for (const m of opts.customs) {
      const key = `${m.type}:${m.id}`
      if (seen.has(key)) continue
      out.push({ ...m, is_custom: true })
      seen.add(key)
    }
  }

  return out
}

/**
 * Inverse of `toUnified` — splits a unified list back into the three dicts.
 * Used by `updateConfig` when the caller writes `models[]` directly, so the
 * legacy projection on disk stays in sync with the canonical list.
 */
export function fromUnified(models: UnifiedModel[]): {
  image_models: Record<string, ImageModelConfig>
  audio_models: Record<string, AudioModelConfig>
  video_models: Record<string, VideoModelConfig>
} {
  const image_models: Record<string, ImageModelConfig> = {}
  const audio_models: Record<string, AudioModelConfig> = {}
  const video_models: Record<string, VideoModelConfig> = {}

  for (const m of models) {
    const customFlag = m.is_custom ? { is_custom: true as const } : {}
    if (m.type === 'image') {
      image_models[m.id] = {
        label: m.label,
        provider: m.provider,
        ...customFlag,
        ...(m.params as object),
      } as ImageModelConfig
    } else if (m.type === 'audio') {
      audio_models[m.id] = {
        label: m.label,
        provider: m.provider as AudioModelConfig['provider'],
        ...customFlag,
        ...(m.params as object),
      } as AudioModelConfig
    } else if (m.type === 'video') {
      video_models[m.id] = {
        label: m.label,
        provider: m.provider,
        ...customFlag,
        ...(m.params as object),
      } as VideoModelConfig
    }
    // 'text' is unified-only for now — no legacy dict to project into.
  }

  return { image_models, audio_models, video_models }
}
