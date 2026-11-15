import { z } from 'zod'

import { FORMAT_POOL_MAX_MEMBERS, type FormatPoolMember, type LiveFormatPool } from './format-pool.js'

/**
 * The trust boundary for the format pool. Server-only: it imports zod, so the
 * frontend imports the shapes from `format-pool.ts` instead and never pulls
 * this module into its bundle.
 */

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

export const FormatPoolSchema = z.object({
  enabled: z.boolean(),
  members: z.array(FormatPoolMemberSchema).min(1).max(FORMAT_POOL_MAX_MEMBERS),
}).partial()

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
  // The schema validated every member; `infer` types them as optional because the
  // object is `.partial()`, so the validated list is asserted to the wire shape.
  return { enabled: true, members: members as FormatPoolMember[] }
}
