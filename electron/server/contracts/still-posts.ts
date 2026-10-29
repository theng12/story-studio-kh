/**
 * Still Posts — the shared contract between the server, the jobs and the page.
 *
 * A Still Post is one short quote burned onto one illustrated image, published in BATCHES. The
 * owner's decisions (2026-10-27) shape every type here:
 *
 *  - **A format is the LOOK** (style bible, negative prompt, background treatment, lettering).
 *    **An option is the LAYOUT** (how many panels, where the words sit, what the picture leaves
 *    room for). The two are independent by construction, so any option works with any format.
 *  - **Characters are channel data, never preset data** (AGENTS §4/§5). A post names characters
 *    that belong to THIS channel; a preset never carries a character id.
 *  - **The words are burned in by our own renderer** (`lib/thumbnail-text-render.ts`), never drawn
 *    by the image model. Khmer is never sent to an image model as lettering.
 *  - **The image model is always a live Gateway model** (a preset may remember the choice; nothing
 *    hardcodes one) and reference to image appears only where the selected model publishes it.
 *  - Posting, carousels-as-posting and Board tracking are LATER phases. The record keeps the
 *    fields they need (`caption`, `batch_id`, `published_at`) so they slot in without a migration.
 */

import type { TextAnchor, TextFill, ScriptCode, ThumbnailFont } from './thumbnail-text.js'
import type { StillPostFontPools } from './still-post-fonts.js'

/** The three export frames. 4:5 is deliberately absent (owner, 2026-10-27). */
// model-drift-allow: the export frames Story composes itself after drawing, chosen by the owner for Still Posts; not a model aspect list
export const STILL_POST_ASPECTS = ['1:1', '9:16', '16:9'] as const
export type StillPostAspect = typeof STILL_POST_ASPECTS[number]

export function isStillPostAspect(value: unknown): value is StillPostAspect {
  return typeof value === 'string' && (STILL_POST_ASPECTS as readonly string[]).includes(value)
}

/**
 * How a batch's pictures are drawn.
 *
 * Owner, 2026-10-27: *"keep the current way to do it but also add the option to have a fresh
 * drawing per size. So we have 2 options but default to just 1 drawing per post."*
 *
 *  - `single`    one drawing per panel, composed once and fitted into every ticked frame by our
 *                renderer (the blurred fill means nothing is cropped). The default.
 *  - `per-size`  a separate drawing per panel per ticked frame, at that frame's own aspect, then
 *                lettered and branded exactly as a single drawing is.
 *
 * The mode is stored on the POST, so a batch keeps the choice it was written with and each drawing
 * records the mode that made it. A render may restate the choice (the page always does); when it
 * differs from the stored mode the job applies it and says so, keeping the other mode's pictures.
 */
export type StillPostArtMode = 'single' | 'per-size'

/** The pixels each export frame is drawn at. 1080 on the short edge, as every platform wants. */
export const STILL_POST_CANVAS: Record<StillPostAspect, { width: number; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
}

/** The languages a Still Post can be written and lettered in. */
export const STILL_POST_LANGUAGES = ['en', 'km', 'zh'] as const
export type StillPostsLanguage = typeof STILL_POST_LANGUAGES[number]

export function isStillPostsLanguage(value: unknown): value is StillPostsLanguage {
  return typeof value === 'string' && (STILL_POST_LANGUAGES as readonly string[]).includes(value)
}

/**
 * The writing system one language is drawn in, as the ISO 15924 code the font manifest declares.
 * Used to pick the format's lettering font for the post's language — never to guess a face.
 */
export const STILL_POST_LANGUAGE_SCRIPT: Record<StillPostsLanguage, ScriptCode> = {
  en: 'latn',
  km: 'khmr',
  zh: 'hani',
}

export const STILL_POST_LANGUAGE_LABELS: Record<StillPostsLanguage, string> = {
  en: 'English',
  km: 'Khmer',
  zh: 'Mandarin (Simplified Chinese)',
}

// ── Format: the look ───────────────────────────────────────────────────────

/**
 * How one format letters a post. The FONT is chosen per script so the same format works in every
 * language; everything else (weight, fill, outline, shadow, leading) is the format's voice.
 */
export interface StillPostLettering {
  /** Bundled font id per ISO 15924 script. A script with no entry refuses rather than substitutes. */
  fonts: Partial<Record<ScriptCode, string>>
  weight: number
  uppercase: boolean
  fill: TextFill
  outline: { enabled: boolean; color: string; width_px: number }
  shadow: { enabled: boolean; color: string; opacity: number; dx: number; dy: number; blur_px: number }
  line_height: number
}

/** The rounded panel an option may draw behind the words. Colour belongs to the format's look. */
export interface StillPostTextPanel {
  color: string
  opacity: number
  padding_px: number
  radius_px: number
}

export interface StillPostFormat {
  id: string
  name: string
  /** One line for the picker. */
  description: string
  /** The style bible: prompt language that shapes every image this format makes. */
  style_bible: string
  /** What the picture must never contain. Also appended to the prompt as an explicit avoidance. */
  negative_prompt: string
  /** The background treatment, in words the customer reads. */
  background: string
  lettering: StillPostLettering
  text_panel: StillPostTextPanel
  /** The frame this format composes best in. An export may still request any other. */
  default_aspect: StillPostAspect
}

// ── Option: the layout ─────────────────────────────────────────────────────

export type StillPostPanelRole = 'single' | 'setup' | 'punchline'

/** One panel's text box, in percent of the export canvas. */
export interface StillPostTextBox {
  anchor: TextAnchor
  x_pct: number
  y_pct: number
  width_pct: number
  height_pct: number
  align: 'left' | 'center' | 'right'
  max_lines: number
}

export interface StillPostOption {
  id: string
  name: string
  /** One line for the picker. */
  description: string
  /** 1 = a single picture; 2 = a setup/punchline pair. */
  panels: 1 | 2
  /** One entry per panel, in order. */
  text: StillPostTextBox[]
  /** What each picture must leave room for — added to the image prompt so the words are readable. */
  composition: string[]
  /** Draw the format's text panel behind the words (a solid banner instead of bare lettering). */
  text_background: boolean
}

// ── A post ─────────────────────────────────────────────────────────────────

export interface StillPostImage {
  filename: string
  rendered_at: string
  sha256: string
  /** The live Gateway model that drew it, as the catalogue published it. */
  model_id: string
  model_label: string
  /** The exact prompt submitted (format + option + scene), so a re-draw is reproducible. */
  prompt: string
  reference_character_ids: string[]
  reference_names: string[]
  /**
   * Which mode drew this picture, and the aspect it was requested at.
   *
   * Recorded on every drawing so a mode change on retry is visible rather than guessed: a
   * `single` drawing exists once per panel and is fitted into every frame, while a `per-size`
   * drawing belongs to exactly one frame. Absent on records written before this field existed,
   * which are single drawings by definition.
   */
  mode?: StillPostArtMode
  aspect?: StillPostAspect
  /** An explicit re-draw, so a Retry reconnects instead of buying a second render. */
  generation_action?: { id: string; kind: 'fresh' }
}

export interface StillPostPanel {
  id: string
  role: StillPostPanelRole
  /** The words burned into this panel. Never sent to the image model. */
  text: string
  /** What the picture shows. Text-free by construction. */
  scene_prompt: string
  /** The ONE drawing a `single`-mode batch makes, fitted into every frame. */
  image: StillPostImage | null
  /**
   * The drawings a `per-size` batch makes, one per ticked frame.
   *
   * Keyed by the frame each one was requested at, so completion can require every frame's OWN
   * picture (AGENTS §8) and a retry draws only the frames that are missing.
   */
  images?: Partial<Record<StillPostAspect, StillPostImage>>
}

export interface StillPostFinal {
  aspect: StillPostAspect
  panel_id: string
  filename: string
  rendered_at: string
  /** What was drawn, so a final made from older words is detectable as stale. */
  text: string
  /** Identity of the whole look that produced it (text + lettering + layout + branding + canvas). */
  style_hash: string
  font_id: string
}

export interface StillPost {
  /** Stable id inside the channel, e.g. `post-0001`. */
  id: string
  batch_id: string
  created_at: string
  updated_at: string
  format_id: string
  option_id: string
  language: StillPostsLanguage
  /** Characters of THIS channel that appear. Channel data — a preset never carries these. */
  character_ids: string[]
  /** The social caption written with the quote. Phase 1 stores it; posting uses it later. */
  caption: string
  panels: StillPostPanel[]
  finals: StillPostFinal[]
  /** Requested export frames, captured when the batch was written. */
  aspects: StillPostAspect[]
  /**
   * How this post's pictures are drawn. Absent means `single` — the original behaviour, kept
   * byte-for-byte for every post written before this choice existed.
   */
  art_mode?: StillPostArtMode
  /**
   * The lettering face this post was GIVEN when it was written, from the channel's font pool.
   *
   * Recorded on the post so a Retry, a re-render or a later pool edit never silently changes the
   * face of a post that already exists. Absent means the format's own face for this post's script —
   * which is exactly how every post written before the pool existed is lettered.
   */
  font_id?: string
  /** Reserved for the posting phase. Absent means never published. */
  published_at?: string | null
}

/** The channel's own Still Posts settings (config.json → `still_posts`). */
export interface StillPostsProjectConfig {
  /**
   * The channel's character roster, ordered, 1–10 entries.
   *
   * Each id must resolve to a character of THIS channel (its Library record assigned to this
   * project, or a project-scoped character). This is channel data: it is never copied into a
   * preset, and a post's `character_ids` must be a subset of it.
   */
  character_ids?: string[]
  /** Absolute path to the logo art. Absent = the logo layer draws nothing at all. */
  logo_path?: string | null
  /** A handle to burn in instead of the channel profile's own. Absent = use the channel handle. */
  handle?: string | null
}

// ── Presets ────────────────────────────────────────────────────────────────

export interface StillPostBranding {
  /** Burn the handle in. */
  handle_enabled: boolean
  /** A handle for this preset, or null to use the channel profile's own handle. */
  handle_text: string | null
  /** Burn the channel's logo in. Does nothing until a logo file is set on the channel. */
  logo_enabled: boolean
  /** Where the handle and the logo sit. */
  position: TextAnchor
  /** Handle type size, in canvas pixels at the 1080 short edge. */
  handle_size_px: number
  /** Logo width, in percent of the canvas width. */
  logo_width_pct: number
  /** Distance from the edge, in percent of the canvas. */
  margin_pct: number
  opacity: number
}

/** Everything a preset restores. Reusable look and configuration only (AGENTS §5). */
export interface StillPostPresetData {
  /** A live Gateway chat model id, or null to use this Mac's writing default. */
  writing_model: string | null
  /** A live Gateway image model id, or null until the customer picks one. */
  image_model: string | null
  format_id: string
  option_id: string
  language: StillPostsLanguage
  aspects: StillPostAspect[]
  /**
   * Draw a separate picture per ticked frame instead of one fitted into each.
   *
   * A reusable configuration choice, so §5 puts it in the preset. Absent/false keeps the original
   * one-drawing behaviour.
   */
  fresh_drawing_per_size: boolean
  /**
   * The channel's lettering font pool, one per writing system. A reusable look, so §5 keeps it in
   * the preset. Empty/absent = every post uses the format's own face, exactly as before.
   *
   * This is what NEW posts are assigned from; the face a post was actually given is recorded on the
   * post (`StillPost.font_id`), so editing the pool never re-letters work that already exists.
   */
  font_pools?: StillPostFontPools
  /** Multiplies the format's fitted type size, so a preset can whisper or shout. */
  text_scale: number
  branding: StillPostBranding
}

export interface StillPostPreset {
  id: string
  name: string
  builtin: boolean
  data: StillPostPresetData
}

// ── Verification (§8) ──────────────────────────────────────────────────────

export type StillPostArtifactState = 'ok' | 'missing' | 'invalid' | 'stale'

export interface StillPostPanelState {
  panel_id: string
  role: StillPostPanelRole
  /** The generated art: present, decodable and non-empty. `ok` only when every required frame has one. */
  image: StillPostArtifactState
  /** Per-size mode only: the state of each frame's OWN drawing. */
  images?: Record<string, StillPostArtifactState>
  /** One entry per requested frame. */
  finals: Record<string, StillPostArtifactState>
  problems: string[]
}

export interface StillPostState {
  id: string
  complete: boolean
  panels: StillPostPanelState[]
  problems: string[]
}

export interface StillPostsBatchState {
  batch_id: string
  aspects: StillPostAspect[]
  total: number
  complete_count: number
  /** True only when EVERY post has its art and a final in EVERY requested frame. */
  complete: boolean
  posts: StillPostState[]
  /** What is missing, in plain words, for the page and the job log. */
  missing: string[]
}

/** `GET /api/projects/:slug/still-posts` — everything the workspace renders from. */
export interface StillPostsWorkspace {
  config: {
    character_ids: string[]
    logo_path: string | null
    /** The handle that will actually be burned in when a preset uses the channel's own. */
    handle: string | null
    /** True when the channel has a logo file that exists on disk. */
    logo_ready: boolean
  }
  /** The channel's characters, for the roster and the per-post picker. */
  characters: ChannelCharacterRow[]
  formats: StillPostFormat[]
  options: StillPostOption[]
  /**
   * The bundled font catalogue, read live from `bundled/fonts/fonts.json` — the same list the
   * thumbnail text editor uses. The pool picker offers only faces whose manifest lists the script
   * being edited, so a face that cannot draw the language is never offered.
   */
  fonts: ThumbnailFont[]
  presets: StillPostPreset[]
  last_preset_id: string | null
  posts: StillPost[]
  batches: StillPostsBatchState[]
}

/** One character as the Still Posts workspace lists it. */
export interface ChannelCharacterRow {
  id: string
  name: string
  description: string
  /** True when the character has at least one reference image on disk. */
  has_reference: boolean
  reference_count: number
  /** Where the portrait the generator will attach lives (`GET …/characters/:id/portrait`). */
  portrait_url: string | null
}

/** POST …/still-posts/batches — write N posts. */
export interface StillPostBatchRequest {
  brief: string
  count: number
  format_id: string
  option_id: string
  language: StillPostsLanguage
  aspects: StillPostAspect[]
  /** Draw a separate picture per ticked frame. Absent/false = one drawing, fitted to each size. */
  fresh_drawing_per_size?: boolean
  /**
   * The preset's lettering font pools. New posts are given a face from the pool for their own
   * script; an empty/absent pool leaves the format's face in place.
   */
  font_pools?: StillPostFontPools
  /** Characters every post may use. Must be a subset of the channel roster. */
  character_ids: string[]
  /** A live Gateway chat model id. Absent uses this Mac's writing default. */
  writing_model?: string | null
  /** Name for the batch, shown in the workspace. */
  name?: string
}

/** POST …/still-posts/render — draw art + finals for a batch (or named posts). */
export interface StillPostRenderRequest {
  batch_id?: string
  post_ids?: string[]
  /** A live Gateway image model id. Absent is refused — nothing picks a model for the customer. */
  image_model: string
  /** Re-draw even the art that already exists. Finals are always brought up to date. */
  redraw?: boolean
}
