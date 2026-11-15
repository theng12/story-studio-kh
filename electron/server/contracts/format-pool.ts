import { z } from 'zod'

/**
 * The format pool — owner 2026-11-15:
 * "i can't keep using the same format of thumbnail... randomize from a pool of
 * 1-10 formats so each episode doesn't have the style 'type' ... it's a new
 * addition and is default off."
 *
 * One member = one bundle: the thumbnail shell/template, the thumbnail
 * lettering (font, text style, position — the same shape the per-thumbnail
 * sidecar stores in contracts/thumbnail-options.ts), and the metadata title
 * style. The SAME member drives the on-image thumbnail and the uploaded
 * video's title, so the two can never disagree.
 *
 * OFF by default: an absent, disabled or empty pool changes nothing — every
 * episode keeps today's one thumbnail format and one title style, byte for
 * byte. The pool is per channel (config.json), the assignment per episode
 * (services/format-pool.ts).
 */

/** Owner's stated range: 1..10 members. A pool of one is valid and honest — it behaves exactly like today. */
export const FORMAT_POOL_MAX_MEMBERS = 10

export const FormatPoolMemberSchema = z.object({
  /** Stable within the channel's pool; this is what an episode's assignment stores. */
  id: z.string().trim().min(1).max(60),
  /** The owner's own words for this format, shown in the editor and on the episode. */
  label: z.string().trim().max(80).optional(),
  // Thumbnail shell/template — the exact fields resolveThumbnailShell reads.
  thumbnail_shell_id: z.string().max(300).optional(),
  thumbnail_template_id: z.string().max(200).optional(),
  // Lettering — the per-thumbnail record's shape (contracts/thumbnail-options.ts).
  style_tag: z.string().max(200).optional(),
  thumb_font_style: z.string().max(200).optional(),
  thumb_text_style: z.string().max(200).optional(),
  thumb_text_position: z.string().max(50).optional(),
  // Metadata title style — the fields generateMetadata's title chain reads.
  /** 'use_idea_title' | 'paraphrase' | 'manual' (the Finalizer's own modes). */
  title_mode: z.string().max(60).optional(),
  title_prefix: z.string().max(200).optional(),
  title_suffix: z.string().max(200).optional(),
  /** Tone guidance that sits ABOVE the Format's titleStyleHint in the chain. */
  title_guidance: z.string().max(500).optional(),
})

export type FormatPoolMember = z.infer<typeof FormatPoolMemberSchema>

export const FormatPoolSchema = z.object({
  enabled: z.boolean(),
  members: z.array(FormatPoolMemberSchema).min(1).max(FORMAT_POOL_MAX_MEMBERS),
}).partial()

export type FormatPool = z.infer<typeof FormatPoolSchema>

/** A pool that is actually in force — never partial: enabled with a real member list. */
export interface LiveFormatPool {
  enabled: true
  members: FormatPoolMember[]
}

/**
 * The pool in force, or null = OFF. Absent (every saved channel before this
 * feature), `enabled: false`, an empty member list, or a shape that fails
 * validation all return null and every caller keeps the single-format path
 * untouched. There is no partial pool: a pool that does not validate is off,
 * never half-on.
 */
export function normaliseFormatPool(value: unknown): LiveFormatPool | null {
  if (!value || typeof value !== 'object') return null
  const parsed = FormatPoolSchema.safeParse(value)
  if (!parsed.success) return null
  const { enabled, members } = parsed.data
  if (enabled !== true || !members || members.length === 0) return null
  return { enabled: true, members }
}
