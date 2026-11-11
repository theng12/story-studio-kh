/**
 * Thumbnail OPTION metadata — the per-option editing state beside the
 * authoritative numbered `*_Thumbnail_Prompts.md`.
 *
 * The prompts file stays the source of truth for WHAT each option says; this
 * contract only describes the sidecar `<episode>/thumbnail_options.json`, which
 * stores, per option number, the customer's own SELECTIONS (recipe, style,
 * font, text, placement) and the approval given to that option's prompt —
 * keyed by the SHA-256 of the prompt text at approval time, so editing the
 * prompt in the Markdown file invalidates the approval by hash mismatch
 * (nothing else has to touch the prompts file).
 *
 * Field names are the Image Prompts page's own thumbnail model fields
 * (`thumbnail_template_id`, `style_tag`, `thumb_font_style`,
 * `thumb_text_style`, `thumb_text_position`) so a later UI reads one shape
 * everywhere. Episode state only (AGENTS §4): the sidecar lives in the
 * episode's folder, never in a preset (AGENTS §5).
 */

import { z } from 'zod'

export const THUMBNAIL_OPTIONS_SCHEMA = 1

/**
 * Visual art style tag / style bible character ceiling. Matches the
 * authoritative content-pack style text limit (MAX_TEXT in content-packs/schemas.ts).
 */
export const THUMBNAIL_OPTION_STYLE_TAG_MAX = 12_000

/** One option's stored selection. Absent key = never chosen. */
export const ThumbnailOptionStoredSchema = z.object({
  /** Selected recipe — the thumbnail template id. */
  thumbnail_template_id: z.string().max(200),
  /** Selected visual art style tag / style bible. */
  style_tag: z.string().max(THUMBNAIL_OPTION_STYLE_TAG_MAX),
  /** Selected lettering font. */
  thumb_font_style: z.string().max(200),
  /** Selected headline/text style. */
  thumb_text_style: z.string().max(200),
  /** Selected text placement. */
  thumb_text_position: z.string().max(50),
  /** The source option when this option was duplicated inside the episode. */
  duplicate_of: z.number().int().safe().min(1),
  /** SHA-256 of the prompt text the option was approved against. */
  approved_prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).partial()

/** The sidecar file itself. */
export const ThumbnailOptionSettingsSchema = z.object({
  schema: z.literal(THUMBNAIL_OPTIONS_SCHEMA),
  /**
   * Skip prompt approval entirely. ABSENT means inherit the channel's saved
   * default (`config.auto_approve_thumbnail_prompts`, ON by default); an
   * explicit true/false is this episode's own choice and wins over it.
   * Optional so a sidecar written before the channel setting existed keeps
   * working without being rewritten.
   */
  auto_approve: z.boolean().optional(),
  /** Keyed by the option's prompt number as it appears in the Markdown file. */
  options: z.record(z.string().regex(/^[1-9][0-9]*$/), ThumbnailOptionStoredSchema),
})

/**
 * The update body. Edits ONE option (its `number` names it inside THIS
 * episode's prompts file); every field is optional so a partial update leaves
 * the rest of that option — and every sibling option — exactly as it was.
 *
 * Unknown keys are stripped by zod, which is the trust boundary: no prompt
 * text, no episode id and no path can ride along, so a request can neither
 * reference another episode nor alter the prompts file itself.
 */
export const ThumbnailOptionUpdateSchema = z.object({
  number: z.number().int().safe().min(1),
  thumbnail_template_id: z.string().max(200).optional(),
  style_tag: z.string().max(THUMBNAIL_OPTION_STYLE_TAG_MAX).optional(),
  thumb_font_style: z.string().max(200).optional(),
  thumb_text_style: z.string().max(200).optional(),
  thumb_text_position: z.string().max(50).optional(),
  /** true: approve the CURRENT prompt text (stores its hash).
   *  false: withdraw approval. Absent: approval untouched. */
  approve: z.boolean().optional(),
  /** Turn the episode's prompt-approval gate on or off. Absent: untouched. */
  auto_approve: z.boolean().optional(),
})

export type ThumbnailOptionStored = z.infer<typeof ThumbnailOptionStoredSchema>
export type ThumbnailOptionSettings = z.infer<typeof ThumbnailOptionSettingsSchema>
export type ThumbnailOptionUpdate = z.infer<typeof ThumbnailOptionUpdateSchema>
