/**
 * Automatic chapter-only, scene-backed chapter titles (1.4.386, item 18).
 *
 * 1.4.384 shipped the FONT half — `chapter-title-font.ts` stages a chosen face,
 * verifies its manifest bytes and refuses a heading it cannot draw. What it does
 * not do is decide *which* scenes carry a heading, *what* that heading says, or
 * *which* face an episode that never opened the font field should use. This
 * module is that half; it never stages or measures a face itself.
 *
 * The rules, each one the reason a function exists:
 *
 *  - **Chapter-only.** Exactly the first scene of each chapter carries its
 *    heading; every other scene in the chapter keeps `show_title: false`. A
 *    title on every scene is a different (much noisier) feature, and nobody
 *    asked for it.
 *  - **Scene-backed.** Which scene opens a chapter is decided from the plan's
 *    own `start_sec` against the chapter clock the merge recorded
 *    (`audio_chapters.json` via `readSectionClock`/`sectionWindows`) — not from
 *    a filename, an index, or a "every Nth scene" guess. The heading text is
 *    the narration's own chapter title; a chapter with no title falls back to
 *    its label (`Chapter 02`), never to invented prose.
 *  - **The feature is the customer's switch.** `enabled: false` returns null and
 *    the caller keeps today's behaviour byte for byte. Nothing here turns
 *    chapter titles on.
 *  - **An explicit font choice always wins.** An explicit `font_id`, a face the
 *    pool already resolved into `resolved_font_id`, and a deliberate "today's
 *    look" (`channel_look: false`) are all returned untouched. The pool is only
 *    consulted when the episode has expressed no choice at all — which is the
 *    automatic binding this item asks for.
 *  - **The automatic face is stable.** When the caller has no stored choice the
 *    pool is drawn with a rng seeded from the episode id, so a retry re-renders
 *    the same face instead of re-rolling one (AGENTS §4: episode state belongs
 *    to the episode).
 *  - **It fails soft, never loud.** An unreadable chapter clock or a missing
 *    narration file means "no automatic headings", reported as a note the job
 *    log can print — never a failed render. Font integrity and glyph coverage
 *    stay where they were, in `chapter-title-font.ts`.
 *
 * The caller owns the request; this module only answers questions about it.
 */

import { mulberry32 } from '../lib/seeded-random.js'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { decideFont, type StillPostFontCursor, type StillPostFontPool } from '../contracts/still-post-fonts.js'
import type { ChapterTitlePresentation } from '../models/types.js'
import { chapterForTime, readSectionClock, sectionWindows } from '../services/translation-timeline-rebase.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import { listPresets, readFontPoolCursor } from '../services/still-posts.js'

/** One scene's answer: draw a heading or do not, and the text to draw. */
export interface ChapterTitleSceneBinding {
  show_title: boolean
  /** The chapter heading, only when `show_title` is true. null = keep the caller's own title. */
  title: string | null
}

/** The chapter clock's shape this module needs — the same rows `sectionWindows` returns. */
export interface ChapterWindow {
  slug: string
  start_sec: number
  end_sec: number
}

/** `Chapter_01` → `Chapter 01`; anything else keeps its own name. */
export function chapterLabelFor(slug: string): string {
  const match = /^chapter_(\d+)$/i.exec(String(slug || '').trim())
  if (match) return `Chapter ${match[1]}`
  return String(slug || '').replace(/_/g, ' ').trim()
}

/** The heading one chapter shows: the narration's own title, else its label. */
export function chapterHeadingFor(slug: string, headings?: Record<string, string> | null): string {
  const explicit = headings?.[slug]?.trim()
  return explicit || chapterLabelFor(slug) || 'Chapter'
}

/**
 * Which scenes open a chapter, and what they say.
 *
 * A scene opens a chapter when the chapter its start time falls in differs from
 * the chapter the previous scene fell in — so a chapter that spans several
 * scenes titles only its first, and a scene that lands in a gap still belongs
 * to the nearer chapter rather than inventing a fourth one.
 *
 * `leadInShiftSec` is `audio_lead_in_shift_sec`: when the plan was timed
 * without the merged audio's intro lead-in, every scene's clock sits that many
 * seconds behind the chapter clock and is moved forward here. Passing it is
 * what keeps the binding honest on a music-lead-in episode.
 */
export function bindChapterTitlesToScenes(input: {
  scenes: Array<{ start_sec?: number }>
  windows: readonly ChapterWindow[]
  headings?: Record<string, string> | null
  leadInShiftSec?: number
}): ChapterTitleSceneBinding[] {
  const { scenes, windows } = input
  const keep = (): ChapterTitleSceneBinding => ({ show_title: false, title: null })
  if (!scenes.length || !windows.length) return scenes.map(keep)
  // No scene carries a clock (an Image Pool render): chapter membership is
  // unknowable, so nothing is titled rather than something guessed.
  if (!scenes.some(scene => Number.isFinite(Number(scene.start_sec)))) return scenes.map(keep)

  const shift = Number(input.leadInShiftSec) > 0 ? Number(input.leadInShiftSec) : 0
  let previous: string | null = null
  return scenes.map((scene) => {
    const raw = Number(scene.start_sec)
    const at = (Number.isFinite(raw) ? raw : 0) + shift
    const slug = chapterForTime(windows as ChapterWindow[], at)
    if (!slug) return keep()
    const opens = slug !== previous
    previous = slug
    return opens ? { show_title: true, title: chapterHeadingFor(slug, input.headings) } : keep()
  })
}

/**
 * The face this episode's chapter headings should be drawn in.
 *
 * Every deliberate choice returns untouched, in the order the render already
 * resolves them (`chapterTitleFontId`): an explicit pick, a face the pool
 * already resolved, then a customer who said "today's look". Only an episode
 * that has expressed nothing is bound to the channel's pool — and only when
 * that pool actually has a face to give.
 */
export function bindChapterTitleFont(
  presentation: ChapterTitlePresentation | null | undefined,
  pool: StillPostFontPool | null | undefined,
  opts: { cursor?: StillPostFontCursor | null; rng?: () => number } = {},
): ChapterTitlePresentation | null {
  const current = presentation ?? null
  if (current?.font_id?.trim()) return current
  if (current?.resolved_font_id?.trim()) return current
  if (current && current.channel_look === false) return current
  if (!pool?.fonts?.length) return current
  const chosen = decideFont(pool, opts.cursor ?? null, opts.rng)
  if (!chosen) return current
  return { ...(current ?? {}), channel_look: true, resolved_font_id: chosen.font_id }
}

/** A rng that answers the same for the same episode, so a retry does not re-roll the face. */
export function chapterTitleSeedRng(seed: string): () => number {
  let hash = 2166136261 >>> 0
  for (const char of String(seed || '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return mulberry32(hash || 1)
}

/**
 * Every chapter heading this episode's narration actually names, by slug.
 * Missing or unreadable narration is an empty map — a fallback label, never a
 * failure (AGENTS §8: the honest answer, not a thrown render).
 */
export async function readChapterHeadings(slug: string, episodeId: string): Promise<Record<string, string>> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const sections = await parseNarrationDocx(paths.narration_docx).catch(() => [])
  const headings: Record<string, string> = {}
  for (const section of sections) {
    const title = String(section?.title || '').trim()
    if (title) headings[section.slug] = title
  }
  return headings
}

/**
 * The channel's active lettering pool for one writing system, and where its
 * rotation stands. Mirrors what the assembly page reads, from the same config —
 * one answer, never a second interpretation of the customer's pool.
 */
export async function readChannelFontPool(slug: string, script: string): Promise<{
  pool: StillPostFontPool | null
  cursor: StillPostFontCursor | null
}> {
  const raw = ((await pm.getConfig(slug)) || {}) as unknown as Record<string, any>
  const presets = await listPresets(raw)
  const lastId = typeof raw.still_post_last_preset === 'string' ? raw.still_post_last_preset : null
  const selected = lastId ? presets.find(preset => preset.id === lastId) : undefined
  const pool = (selected?.data?.font_pools as Record<string, StillPostFontPool | undefined> | undefined)?.[script]
    ?? presets
      .map(preset => (preset?.data?.font_pools as Record<string, StillPostFontPool | undefined> | undefined)?.[script])
      .find(entry => !!entry?.fonts?.length)
    ?? null
  const cursor = await readFontPoolCursor(slug, script).catch(() => null)
  return { pool: pool ?? null, cursor }
}

/** Khmer or Latin, the same test the assembly page uses to pick a pool. */
export function chapterTitleScriptFor(text: string): string {
  return /[ក-៿]/.test(String(text || '')) ? 'khmr' : 'latn'
}

export interface AutomaticChapterTitles {
  scenes: ChapterTitleSceneBinding[]
  /** The presentation the render should read: the customer's own, possibly bound to the pool. */
  presentation: ChapterTitlePresentation | null
  /** Plain lines for the job log. Empty when everything resolved. */
  notes: string[]
}

/**
 * The whole automatic answer for one render, or null when the feature is off.
 *
 * Null means "keep today's behaviour exactly" — the caller then leaves
 * `show_title` false and the presentation alone. Everything else comes back
 * with a note explaining anything that could not be resolved, so a render that
 * shows no headings says why instead of quietly doing nothing.
 */
export async function applyAutomaticChapterTitles(opts: {
  slug: string
  episodeId: string
  enabled: boolean
  scenes: Array<{ start_sec?: number }>
  leadInShiftSec?: number
  presentation?: ChapterTitlePresentation | null
}): Promise<AutomaticChapterTitles | null> {
  if (!opts.enabled) return null
  const notes: string[] = []
  const presentation = opts.presentation ?? null

  let windows: ChapterWindow[] = []
  try {
    windows = sectionWindows(await readSectionClock(opts.slug, opts.episodeId))
  } catch {
    notes.push('The chapter clock could not be read for this episode, so no chapter headings were added. Run Audio Assembly, then render again.')
    return { scenes: opts.scenes.map(() => ({ show_title: false, title: null })), presentation, notes }
  }
  if (!windows.length || !opts.scenes.length) {
    return { scenes: opts.scenes.map(() => ({ show_title: false, title: null })), presentation, notes }
  }

  const headings = await readChapterHeadings(opts.slug, opts.episodeId).catch(() => ({}))
  if (!Object.keys(headings).length) {
    notes.push('The narration names no chapter titles, so headings use each chapter\'s own label (Chapter 01, Chapter 02, …).')
  }
  const scenes = bindChapterTitlesToScenes({
    scenes: opts.scenes,
    windows,
    headings,
    leadInShiftSec: opts.leadInShiftSec,
  })
  const opener = scenes.find(scene => scene.show_title)
  if (!opener?.title) return { scenes, presentation, notes }

  // The font only matters where a heading is actually drawn.
  const { pool, cursor } = await readChannelFontPool(opts.slug, chapterTitleScriptFor(opener.title)).catch(() => ({ pool: null, cursor: null }))
  const bound = bindChapterTitleFont(presentation, pool, {
    cursor,
    rng: chapterTitleSeedRng(opts.episodeId),
  })
  if (bound !== presentation && !presentation?.font_id && !presentation?.resolved_font_id && presentation?.channel_look !== false) {
    notes.push(`Chapter headings use this channel's font pool: ${bound?.resolved_font_id || 'no face'}.`)
  }
  return { scenes, presentation: bound, notes }
}
