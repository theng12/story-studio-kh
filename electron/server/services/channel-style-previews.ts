/**
 * The three previews for a CHANNEL's own custom styles (project `style_presets`).
 *
 * A channel's styles are edited in `ProjectStyleLibrary.vue` and saved into
 * `ProjectConfig.style_presets` as a name + a `description` (the style text).
 * They are the one style surface that had NO slot model: the editor rendered a
 * single "Style proof", and a saved preset could hold up to eight project-local
 * PNGs, so a card could show anywhere from one to eight pictures.
 *
 * The owner's rule, 2026-10-25: **every art style shows exactly three previews**
 * — hero, then a quiet wide scene with no figure in it, then the hardest legal
 * case — and no style shows more or fewer. So a channel style renders the same
 * three framings as a style from a pack, with the same prompts.
 *
 * The images themselves are NOT duplicated per channel. They live in the shared
 * content-addressed store (`services/user-style-previews.ts`) under the key of
 * the style text's own hash, so the 215 channel styles on the owner's Mac that
 * are only 34 distinct texts generate 34 sets of three images and every channel
 * showing that text shows the same three. No second generator, no per-channel
 * copy of the bytes.
 *
 * What is per-preset is only the POINTER: `preview_source_hash` records the text
 * the previews on screen were made from, which is how an edited style is shown
 * as out of date rather than as current (§4's spirit — a value that changes
 * under the customer says so).
 *
 * Nothing here deletes anything. A preset's older project-local files stay on
 * disk and stay listed in `preview_files`; they are simply not displayed once
 * the three slot images exist (§5: never rewrite stored project data to
 * compensate).
 */

import * as pm from './project-manager.js'
import type { StylePreset } from '../models/types.js'
import {
  USER_STYLE_PREVIEW_SLOTS,
  hashUserStyleSource,
  sharedStylePreviewSlots,
  type UserStylePreviewSlot,
} from './user-style-previews.js'

/**
 * The three previews every style shows, in display order. One list for the whole
 * app: the slot names come from the store that holds the images, so a channel
 * style and a pack style can never disagree about what the three are.
 */
export const CHANNEL_STYLE_PREVIEW_SLOTS: readonly UserStylePreviewSlot[] = USER_STYLE_PREVIEW_SLOTS

/** How many pictures a style's card may show. The owner's rule: exactly three. */
export const CHANNEL_STYLE_DISPLAY_LIMIT = USER_STYLE_PREVIEW_SLOTS.length

/** One entry of `ProjectConfig.style_presets`, as this surface reads it. */
export interface ChannelStylePreset {
  id: string
  name?: string
  description?: string
  preview_filename?: string
  preview_files?: string[]
  /** Hash of the style text the previews now on screen were made from. */
  preview_source_hash?: string
  preview_model?: string
  preview_aspect_ratio?: string
  preview_tier?: string
  preview_saved_at?: string
}

/**
 * The style text a channel style renders.
 *
 * `style_presets` carries one `description` and no separate negative list — the
 * editor's "Apply to Style Bible" already sends `negative_prompt: ''` — so a
 * channel style's text is exactly its description.
 */
export function channelStyleText(preset: ChannelStylePreset): { style_bible: string; negative_prompt: string } {
  return { style_bible: String(preset.description ?? ''), negative_prompt: '' }
}

/** The hash of a channel style's text: the key its previews are stored under. */
export function channelStyleSourceHash(preset: ChannelStylePreset): string {
  return hashUserStyleSource(channelStyleText(preset))
}

/** The hash of a style text given as the editor holds it (an unsaved draft). */
export function channelStyleTagSourceHash(styleTag: string): string {
  return hashUserStyleSource({ style_bible: styleTag, negative_prompt: '' })
}

/**
 * The project-local files a preset still points at, hero first and
 * de-duplicated, capped at what a card may show.
 *
 * These are the older pictures: either the single "Style proof" the previous
 * flow rendered, or a gallery of up to eight. They are shown — capped at three,
 * and marked out of date — only until the three slot images exist, and they are
 * never deleted from disk.
 */
export function channelStyleStoredFiles(preset: ChannelStylePreset): string[] {
  const listed = [
    ...(Array.isArray(preset.preview_files) ? preset.preview_files : []),
    ...(preset.preview_filename ? [preset.preview_filename] : []),
  ]
  const files = Array.from(new Set(
    listed.filter((file): file is string => typeof file === 'string' && file.length > 0),
  ))
  return files.slice(0, CHANNEL_STYLE_DISPLAY_LIMIT)
}

/** What one channel style shows right now, without generating anything. */
export interface ChannelStylePreviewState {
  preset_id: string
  name: string
  /** The style text itself — what a generate call is asked for. */
  style_tag: string
  /** Hash of the text the images on screen were made from. Empty when none are. */
  source_hash: string
  /** True when what is shown was made from other text than the style has now. */
  stale: boolean
  /** The slot images, hero first, present ones only. */
  slots: Array<{ slot: UserStylePreviewSlot; url: string }>
  /** Project-local files to show until the slots exist. Capped at three. */
  stored_files: string[]
  /** True when this style has fewer than three current previews. */
  needs_previews: boolean
}

/**
 * Resolve what one channel style shows.
 *
 * The order is the owner's: the three slot images win as soon as they exist for
 * the style's own text (an older gallery is not mixed in beside them); failing
 * that, the images made from a previous text are STILL SHOWN but published as
 * out of date, so an edit never hides the only evidence of what the look used to
 * be; failing that, the older project-local files, also out of date, because
 * they were made by a flow that predates the three framings.
 */
export async function channelStylePreviewState(
  preset: ChannelStylePreset,
): Promise<ChannelStylePreviewState> {
  const styleTag = String(preset.description ?? '')
  const currentHash = channelStyleSourceHash(preset)
  const base = {
    preset_id: preset.id,
    name: String(preset.name ?? preset.id),
    style_tag: styleTag,
  }

  const current = await sharedStylePreviewSlots(currentHash)
  if (current.length) {
    return {
      ...base,
      source_hash: currentHash,
      stale: false,
      slots: current,
      stored_files: [],
      needs_previews: current.length < CHANNEL_STYLE_DISPLAY_LIMIT,
    }
  }

  // Previews made from the text this style used to have. They describe a real
  // look, just not this one, so they are shown and said to be out of date.
  const storedHash = typeof preset.preview_source_hash === 'string' ? preset.preview_source_hash : ''
  if (storedHash && storedHash !== currentHash) {
    const previous = await sharedStylePreviewSlots(storedHash)
    if (previous.length) {
      return {
        ...base,
        source_hash: storedHash,
        stale: true,
        slots: previous,
        stored_files: [],
        needs_previews: true,
      }
    }
  }

  const storedFiles = channelStyleStoredFiles(preset)
  return {
    ...base,
    source_hash: '',
    stale: storedFiles.length > 0,
    slots: [],
    stored_files: storedFiles,
    needs_previews: true,
  }
}

/** Every channel style of one project, resolved. */
export async function listChannelStylePreviewStates(slug: string): Promise<ChannelStylePreviewState[]> {
  const presets = await readChannelStylePresets(slug)
  return Promise.all(presets.map(preset => channelStylePreviewState(preset)))
}

/** The project's own `style_presets`, or an empty list. */
export async function readChannelStylePresets(slug: string): Promise<ChannelStylePreset[]> {
  try {
    const config = await pm.getConfig(slug)
    const presets = (config as { style_presets?: unknown } | null)?.style_presets
    if (!Array.isArray(presets)) return []
    return presets.filter((preset): preset is ChannelStylePreset =>
      !!preset && typeof preset === 'object' && typeof (preset as ChannelStylePreset).id === 'string')
  } catch {
    return []
  }
}

/**
 * Record on every preset whose style text is this one that its previews now
 * describe that text.
 *
 * This is the whole of the per-preset write. It touches no files and changes no
 * style text — it only says "the three previews on screen were made from exactly
 * this style" — which is what lets a later edit of the text mark them out of
 * date. Every preset with that text is recorded together, because presets that
 * share a text ARE the same style; a channel whose 13 styles are one look does
 * not get 12 unknowns and one known.
 *
 * Returns the preset ids that now point at these previews.
 */
export async function markChannelStylePreviewsCurrent(input: {
  slug: string
  sourceHash: string
  modelId: string
  aspectRatio: string
  tier?: string
  now?: string
}): Promise<string[]> {
  const config = await pm.getConfig(input.slug)
  if (!config) return []
  const listed = config.style_presets
  if (!Array.isArray(listed)) return []
  const matched = new Set(
    listed
      .filter(preset => preset && typeof preset.id === 'string'
        && channelStyleSourceHash(preset) === input.sourceHash
        // Already pointing at these previews, made with the same model: nothing
        // to write, so config.json is left untouched (a repeated bulk run is
        // not a stream of identical saves).
        && (preset.preview_source_hash !== input.sourceHash
          || preset.preview_model !== input.modelId
          || preset.preview_aspect_ratio !== input.aspectRatio
          || (preset.preview_tier || '') !== (input.tier || '')))
      .map(preset => preset.id),
  )
  if (!matched.size) return []

  const now = input.now ?? new Date().toISOString()
  const next = listed.map((preset) => {
    if (!preset || !matched.has(preset.id)) return preset
    const updated: StylePreset = {
      ...preset,
      preview_source_hash: input.sourceHash,
      preview_model: input.modelId,
      preview_aspect_ratio: input.aspectRatio,
      preview_saved_at: now,
    }
    if (input.tier) updated.preview_tier = input.tier
    else delete updated.preview_tier
    return updated
  })
  await pm.updateConfig(input.slug, { style_presets: next })
  return [...matched]
}
