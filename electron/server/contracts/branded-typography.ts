/**
 * Branded typography — the channel's optional composited thumbnail layer (2026-11-16).
 *
 * OFF by default and independent of the format pool: a channel that never turns it on keeps the
 * model-lettered thumbnail and its metadata title exactly as today. Accents are the channel's own
 * accepted transparent PNGs; the pool is separate from the 10-member format cap, and the last-N
 * guard needs `N <= accents - 1`.
 */
import { z } from 'zod'

export const BrandedAccentSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  /** Relative to the channel's branded-typography asset folder; portable. */
  file: z.string().trim().min(1).max(300),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  has_alpha: z.boolean(),
  retired_at: z.string().datetime().nullable().optional(),
}).strict()
export type BrandedAccent = z.infer<typeof BrandedAccentSchema>

export const BrandedPlacementSchema = z.object({
  mode: z.enum(['auto', 'pinned']),
  anchor: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top', 'bottom']),
}).strict()

export const BrandedTypographySchema = z.object({
  enabled: z.boolean(),
  accents: z.array(BrandedAccentSchema).max(100),
  placement: BrandedPlacementSchema,
  /** Draw one accent from the pool per episode; off pins the default one. */
  randomise: z.boolean(),
  /** Do not repeat an accent within the last N episodes. 1 disables the guard. */
  no_repeat_episodes: z.number().int().min(1).max(100),
  title: z.object({
    source: z.enum(['approved-title', 'separate-hook']),
    font_id: z.string().trim().min(1).max(80),
    weight: z.number().int().min(100).max(900),
  }).strict(),
  /** The whole set saves and reloads as presets; one may be marked active. */
  presets: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(160),
    settings: z.record(z.string(), z.unknown()),
  }).strict()).max(50),
  active_preset: z.string().trim().min(1).max(120).nullable(),
}).strict()
export type BrandedTypography = z.infer<typeof BrandedTypographySchema>

export const BRANDED_TYPOGRAPHY_DEFAULTS: BrandedTypography = {
  enabled: false,
  accents: [],
  placement: { mode: 'auto', anchor: 'bottom-left' },
  randomise: true,
  no_repeat_episodes: 3,
  title: { source: 'approved-title', font_id: 'kantumruy-pro', weight: 700 },
  presets: [],
  active_preset: null,
}

export interface BrandedAccentPick {
  accent: BrandedAccent
  index: number
  /** How many accents were eligible after the last-N exclusion. */
  eligible: number
  /** 'pooled' is a deterministic pick; 'pinned' is an explicit human choice. */
  source: 'pooled' | 'pinned'
}

/**
 * The accents an episode may draw from: every live accent not used by the last N stored episode
 * assignments. When every accent is inside the window the whole live pool is eligible again (the
 * guard cannot exclude everything) and `wrapped` says so.
 */
export function eligibleAccents(
  accents: readonly BrandedAccent[],
  recentAccentIds: readonly string[],
  noRepeatEpisodes: number,
): { eligible: BrandedAccent[]; wrapped: boolean } {
  const live = accents.filter(accent => !accent.retired_at)
  if (!live.length) return { eligible: [], wrapped: false }
  const window = Math.max(1, Math.floor(noRepeatEpisodes))
  if (window === 1) return { eligible: live, wrapped: false }
  const recent = new Set(recentAccentIds.filter((id): id is string => typeof id === 'string'))
  const free = live.filter(accent => !recent.has(accent.id))
  if (free.length) return { eligible: free, wrapped: false }
  return { eligible: live, wrapped: true }
}

/** Deterministic pick over the eligible list, reusing the episode-hash rule the format pool uses. */
export function pickBrandedAccent(
  episodeId: string,
  accents: readonly BrandedAccent[],
  recentAccentIds: readonly string[],
  noRepeatEpisodes: number,
  pinnedAccentId: string | null = null,
): BrandedAccentPick | null {
  const live = accents.filter(accent => !accent.retired_at)
  if (!live.length) return null
  if (pinnedAccentId) {
    const index = live.findIndex(accent => accent.id === pinnedAccentId)
    if (index >= 0) return { accent: live[index]!, index, eligible: live.length, source: 'pinned' }
  }
  const { eligible } = eligibleAccents(live, recentAccentIds, noRepeatEpisodes)
  let hash = 2166136261
  for (let i = 0; i < episodeId.length; i++) {
    hash ^= episodeId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const pick = eligible[(hash >>> 0) % eligible.length]!
  return { accent: pick, index: live.indexOf(pick), eligible: eligible.length, source: 'pooled' }
}
