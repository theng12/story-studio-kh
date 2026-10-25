/**
 * The queue behind "Generate previews for all styles without one", and behind
 * the three images one style needs.
 *
 * One entry at a time, on purpose: every entry is a paid image render, and a
 * burst of them would spend the credits of every style in the library before the
 * owner could stop it. So the runner awaits each entry in turn, reports progress
 * for each, and reads `isCancelled` BETWEEN entries — a stop takes effect after
 * the render already in flight, never in the middle of one.
 *
 * Kept out of the modal so the sequencing itself can be tested: the component
 * supplies the state, this decides what order anything happens in.
 */

export interface PreviewQueueEntry {
  /** The thing being generated: a style's id, or one of its slots. */
  key: string
  /** What the progress line calls it. */
  label: string
}

export interface PreviewQueueProgress {
  /** 1-based position of the entry being reported. */
  index: number
  total: number
  entry: PreviewQueueEntry
  status: 'running' | 'done' | 'failed'
  error?: string
}

export interface PreviewQueueOutcome {
  completed: string[]
  failed: Array<{ key: string; label: string; error: string }>
  /** True when a stop was asked for and honoured. */
  cancelled: boolean
  /** The entries never started, in order, because the queue was stopped. */
  notStarted: string[]
}

/** The styles the bulk action is for: the owner's own, with no current previews. */
export function userStylesNeedingPreviews<
  T extends { id: string; user_style?: boolean; preview_images?: string[]; preview_stale?: boolean },
>(styles: readonly T[]): T[] {
  return styles.filter(style => style.user_style === true
    && (!style.preview_images?.length || style.preview_stale === true))
}

/**
 * The three previews every style shows, in display order: the hero, the quiet
 * wide scene with no figure in it, and the hardest legal case (owner,
 * 2026-09-08 and again 2026-10-25 — every art style, whatever its kind, shows
 * exactly these three and no other number).
 */
export const STYLE_PREVIEW_SLOTS = ['hero', 'scene', 'face'] as const
export type StylePreviewSlot = typeof STYLE_PREVIEW_SLOTS[number]

/**
 * What each image is, in the owner's own words
 * (`content-packs/PREVIEW-BACKFILL-2026-09-08.md`): the shot the style exists
 * for, a quiet wide scene with no figure in it, and the hardest legal case.
 * One wording for every surface that reports progress on them.
 */
export const STYLE_PREVIEW_SLOT_LABELS: Record<StylePreviewSlot, string> = {
  hero: 'the hero shot',
  scene: 'the empty scene',
  face: 'the hardest case',
}

/** One channel custom style, as `/projects/:slug/channel-style-previews` reports it. */
export interface ChannelStylePreviewState {
  preset_id: string
  name: string
  /** The style text itself — what a generate call is asked for. */
  style_tag: string
  /** Hash of the text the images on screen were made from; empty when none are. */
  source_hash: string
  stale: boolean
  /** The slot images stored for this style's text, present ones only. */
  slots: Array<{ slot: string; url: string }>
  /** Older project-local files to show until the slots exist. */
  stored_files: string[]
  needs_previews: boolean
}

/** One of the three tiles a style card shows. */
export interface ChannelStylePreviewTile {
  slot: StylePreviewSlot
  /** The slot image, when one is stored for this style's own text. */
  url: string | null
  /** An older project-local file for this position, until the slots exist. */
  sourceFile: string | null
}

export interface ChannelStylePreviewDisplay {
  /** Exactly three tiles, always, in slot order. */
  tiles: ChannelStylePreviewTile[]
  /** True when what is shown was made from other text, or by an older flow. */
  stale: boolean
  /** The slots that still need an image for the style's CURRENT text. */
  missing: StylePreviewSlot[]
}

/**
 * What one channel style card shows: exactly three tiles, in slot order.
 *
 * The three slot images win the moment ANY of them exists — a card never mixes
 * an old single-proof sample beside the new framings. Until then the preset's
 * older project-local files are shown in its place, capped at the same three
 * tiles and published as out of date, because that is what they are. Nothing
 * here reads the disk: the files a card may show are named by the route, which
 * caps them at three and never removes them (§5 — the owner's older previews
 * stay on disk, they are only no longer displayed).
 *
 * `missing` is asked of the style's CURRENT text, not of whatever is on screen:
 * a stale style shows three old images and still needs all three re-made, so a
 * "generate what is missing" action does the right thing in both cases.
 */
export function channelStylePreviewDisplay(state: {
  slots?: Array<{ slot: string; url: string }>
  stored_files?: string[]
  stale?: boolean
}): ChannelStylePreviewDisplay {
  const byslot = new Map((state.slots || []).map(slot => [slot.slot, slot.url]))
  const slotUrls = STYLE_PREVIEW_SLOTS.map(slot => byslot.get(slot) || null)
  const hasSlotImages = slotUrls.some(url => !!url)
  const storedFiles = state.stored_files || []
  const stale = state.stale === true
  return {
    tiles: STYLE_PREVIEW_SLOTS.map((slot, index) => (hasSlotImages
      ? { slot, url: slotUrls[index]!, sourceFile: null }
      : { slot, url: null, sourceFile: storedFiles[index] || null })),
    stale,
    missing: stale
      ? [...STYLE_PREVIEW_SLOTS]
      : STYLE_PREVIEW_SLOTS.filter(slot => !byslot.get(slot)),
  }
}

/** One text the bulk action renders, and every style of this channel that shows it. */
export interface ChannelPreviewTarget extends PreviewQueueEntry {
  /** The style text — the same string in two channels is one render, not two. */
  style_tag: string
  preset_ids: string[]
}

/**
 * The channel's custom styles that lack previews, DE-DUPLICATED BY STYLE TEXT.
 *
 * A channel's 13 styles are often one look typed once and copied; the images are
 * held once per text in the shared store, so asking for that text once renders
 * it for every style that shows it. The queue therefore carries one entry per
 * distinct text, never one per preset.
 */
export function channelStylesNeedingPreviews(
  states: readonly ChannelStylePreviewState[],
): ChannelPreviewTarget[] {
  const byText = new Map<string, { target: ChannelPreviewTarget; needsPreviews: boolean }>()
  for (const state of states) {
    const styleTag = String(state.style_tag || '')
    if (!styleTag.trim()) continue
    const existing = byText.get(styleTag)
    if (existing) {
      existing.target.preset_ids.push(state.preset_id)
      existing.target.label = `${state.name} (${existing.target.preset_ids.length} styles)`
      existing.needsPreviews = existing.needsPreviews || state.needs_previews === true
      continue
    }
    byText.set(styleTag, {
      target: {
        key: styleTag,
        label: state.name || state.preset_id,
        style_tag: styleTag,
        preset_ids: [state.preset_id],
      },
      needsPreviews: state.needs_previews === true,
    })
  }
  return [...byText.values()].filter(entry => entry.needsPreviews).map(entry => entry.target)
}

/** One thing the bulk action renders: one of the owner's styles, or one style text. */
export type StylePreviewBulkTarget =
  | { kind: 'user'; key: string; label: string; styleId: string }
  | { kind: 'channel'; key: string; label: string; styleTag: string; presetIds: string[] }

/**
 * Everything the "Generate previews for all styles without one" action covers:
 * the owner's own styles from their style packs, AND this channel's own custom
 * styles. It exists as one list rather than two loops in the component because
 * the two halves must stay one queue — one image at a time, cancellable between
 * images — and because "did the bulk action cover the channel's styles too?" is
 * a question a test can answer here and cannot answer in a template.
 */
export function stylePreviewBulkTargets(input: {
  userStyles: readonly {
    id: string
    name: string
    user_style?: boolean
    preview_images?: string[]
    preview_stale?: boolean
  }[]
  channelStyles: readonly ChannelStylePreviewState[]
}): StylePreviewBulkTarget[] {
  return [
    ...userStylesNeedingPreviews(input.userStyles).map(style => ({
      kind: 'user' as const,
      key: style.id,
      label: style.name,
      styleId: style.id,
    })),
    ...channelStylesNeedingPreviews(input.channelStyles).map(target => ({
      kind: 'channel' as const,
      key: target.key,
      label: target.label,
      styleTag: target.style_tag,
      presetIds: target.preset_ids,
    })),
  ]
}

export async function runPreviewQueue<T extends PreviewQueueEntry>(input: {
  entries: readonly T[]
  generate: (entry: T) => Promise<void>
  isCancelled: () => boolean
  onProgress?: (progress: PreviewQueueProgress) => void
}): Promise<PreviewQueueOutcome> {
  const outcome: PreviewQueueOutcome = { completed: [], failed: [], cancelled: false, notStarted: [] }
  for (const [position, entry] of input.entries.entries()) {
    if (input.isCancelled()) {
      outcome.cancelled = true
      outcome.notStarted.push(...input.entries.slice(position).map(pending => pending.key))
      return outcome
    }
    const index = position + 1
    input.onProgress?.({ index, total: input.entries.length, entry, status: 'running' })
    try {
      await input.generate(entry)
      outcome.completed.push(entry.key)
      input.onProgress?.({ index, total: input.entries.length, entry, status: 'done' })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      outcome.failed.push({ key: entry.key, label: entry.label, error: message })
      input.onProgress?.({ index, total: input.entries.length, entry, status: 'failed', error: message })
    }
  }
  // A stop asked for during the LAST render still counts: the queue is over.
  if (input.isCancelled()) outcome.cancelled = true
  return outcome
}
