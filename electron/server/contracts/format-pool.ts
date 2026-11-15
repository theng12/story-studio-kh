/**
 * The format pool's WIRE SHAPE — zero-dependency, like every contract the
 * frontend runtime also imports (`section-quality.ts` says the same).
 *
 * Owner, 2026-11-15: "randomize from a pool of 1-10 formats so each episode
 * doesn't have the style 'type' … it's a new addition and is default off."
 *
 * One member = one bundle: the thumbnail shell/template, the thumbnail
 * lettering (the same fields the per-thumbnail sidecar stores in
 * `thumbnail-options.ts`), and the metadata title style. The SAME member drives
 * the on-image thumbnail and the uploaded title, so the two cannot disagree.
 *
 * The zod schema and the validation live in `format-pool-schema.ts`, which is
 * server-only, so a UI component can import these types without pulling zod
 * (and its module graph) into the frontend build.
 */

/** Owner's stated range: 1..10 members. A pool of one is valid and honest — it behaves exactly like today. */
export const FORMAT_POOL_MAX_MEMBERS = 10

export interface FormatPoolMember {
  /** Stable within the channel's pool; this is what an episode's assignment stores. */
  id: string
  /** The owner's own words for this format, shown in the editor and on the episode. */
  label?: string
  // Thumbnail shell/template — the exact fields resolveThumbnailShell reads.
  thumbnail_shell_id?: string
  thumbnail_template_id?: string
  // Lettering — the per-thumbnail record's shape (contracts/thumbnail-options.ts).
  style_tag?: string
  thumb_font_style?: string
  thumb_text_style?: string
  thumb_text_position?: string
  // Metadata title style — the fields generateMetadata's title chain reads.
  /** 'use_idea_title' | 'paraphrase' | 'manual' (the Finalizer's own modes). */
  title_mode?: string
  title_prefix?: string
  title_suffix?: string
  /** Tone guidance that sits ABOVE the Format's titleStyleHint in the chain. */
  title_guidance?: string
}

/** The channel's saved pool, exactly as `config.format_pool` holds it. */
export interface FormatPool {
  enabled?: boolean
  members?: FormatPoolMember[]
}

/** A pool that is actually in force — never partial: enabled with a real member list. */
export interface LiveFormatPool {
  enabled: true
  members: FormatPoolMember[]
}
