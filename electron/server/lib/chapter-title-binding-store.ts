/**
 * Durable per-episode chapter-title font binding (1.4.386, item 18).
 *
 * `chapter-title-binding.ts` decides WHICH face an episode that expressed no
 * choice should use. This module is the half that makes that answer survive a
 * retry and rotate across episodes:
 *
 *  - The binding belongs to the EPISODE, so it is written in the episode's own
 *    folder (`chapter-title-binding.json`) — never a preset, never channel
 *    config (AGENTS §4/§5).
 *  - A retry reads the stored face and draws it again. It never re-decides.
 *  - A new episode draws the NEXT face from the channel's serial pool, and the
 *    shared cursor advances only after the episode binding has been written.
 *    The read-modify-write runs under the same lock the Still Posts cursor
 *    uses, so two renders can never hand out the same face.
 *
 * The cursor file is the existing `still-posts/font-pool-cursor.json`
 * (`{ "cursors": { "<script>": { last_font_id, last_index } } }`). Reusing it
 * is deliberate: one channel lettering rotation serves every surface that
 * draws the pool, so a still post and a chapter heading do not each start the
 * pool from its first face.
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { withLock, writeJsonAtomic } from './atomic-store.js'
import {
  cursorAfter,
  decideFont,
  type StillPostFontCursor,
  type StillPostFontPool,
} from '../contracts/still-post-fonts.js'
import { fontPoolCursorPath, stillPostsDir } from '../services/still-posts.js'
import type { ChapterTitlePresentation } from '../models/types.js'

export const CHAPTER_TITLE_BINDING_FILE = 'chapter-title-binding.json'

interface ChapterTitleBindingFile {
  bindings: Record<string, { font_id: string; index: number; bound_at: string }>
}

function bindingPath(episodeDir: string): string {
  return path.join(episodeDir, CHAPTER_TITLE_BINDING_FILE)
}

async function readBindingFile(episodeDir: string): Promise<ChapterTitleBindingFile> {
  const file = bindingPath(episodeDir)
  if (!existsSync(file)) return { bindings: {} }
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as ChapterTitleBindingFile
    return parsed && typeof parsed.bindings === 'object' && parsed.bindings ? parsed : { bindings: {} }
  } catch {
    // An unreadable binding is a binding we do not have: the episode is bound
    // afresh from the standing cursor rather than pretending to know its face.
    return { bindings: {} }
  }
}

/** The face this episode was already given for a script, or null. */
export async function readChapterTitleBinding(
  episodeDir: string,
  script: string,
): Promise<{ font_id: string; index: number } | null> {
  const binding = (await readBindingFile(episodeDir)).bindings[script]
  if (!binding || typeof binding.font_id !== 'string' || !binding.font_id) return null
  return { font_id: binding.font_id, index: Number.isInteger(binding.index) ? binding.index : 0 }
}

/** The cursor file's shape, shared with `services/still-posts.ts`. */
async function readCursorState(file: string): Promise<Record<string, StillPostFontCursor>> {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { cursors?: Record<string, StillPostFontCursor> }
    return parsed && typeof parsed.cursors === 'object' && parsed.cursors ? parsed.cursors : {}
  } catch {
    return {}
  }
}

function normaliseCursor(value: StillPostFontCursor | undefined): StillPostFontCursor | null {
  if (!value || typeof value !== 'object') return null
  return {
    last_font_id: typeof value.last_font_id === 'string' && value.last_font_id ? value.last_font_id : null,
    last_index: typeof value.last_index === 'number' && Number.isInteger(value.last_index) && value.last_index >= 0
      ? value.last_index
      : null,
  }
}

/**
 * Bind this episode to a face from the channel's pool, once.
 *
 * Every deliberate choice returns untouched. Only an episode that expressed
 * nothing is bound; its stored binding wins on every later render, and a new
 * episode advances the shared serial cursor exactly once.
 */
export async function bindChapterTitleFontDurably(opts: {
  slug: string
  episodeDir: string
  script: string
  pool: StillPostFontPool | null | undefined
  presentation?: ChapterTitlePresentation | null
  /** Stable per-episode rng for weighted pools (serial ignores it). */
  rng?: () => number
}): Promise<ChapterTitlePresentation | null> {
  const current = opts.presentation ?? null
  if (current?.font_id?.trim()) return current
  if (current?.resolved_font_id?.trim()) return current
  if (current && current.channel_look === false) return current
  const poolIds = (opts.pool?.fonts || []).map(choice => choice.font_id)
  if (!poolIds.length) return current

  const stored = await readChapterTitleBinding(opts.episodeDir, opts.script)
  if (stored && poolIds.includes(stored.font_id)) {
    return { ...(current ?? {}), channel_look: true, resolved_font_id: stored.font_id }
  }

  const cursorFile = fontPoolCursorPath(opts.slug)
  return withLock(cursorFile, async () => {
    const cursors = await readCursorState(cursorFile)
    const chosen = decideFont(opts.pool, normaliseCursor(cursors[opts.script]), opts.rng)
    if (!chosen) return current

    // The binding is written BEFORE the cursor moves, so a crash between the
    // two repeats this episode's face rather than skipping it.
    const file = bindingPath(opts.episodeDir)
    await fs.mkdir(opts.episodeDir, { recursive: true })
    const bindingFile = await readBindingFile(opts.episodeDir)
    bindingFile.bindings[opts.script] = {
      font_id: chosen.font_id,
      index: chosen.index,
      bound_at: new Date().toISOString(),
    }
    await writeJsonAtomic(file, bindingFile)

    cursors[opts.script] = cursorAfter(chosen.font_id, chosen.index)
    await fs.mkdir(stillPostsDir(opts.slug), { recursive: true })
    await writeJsonAtomic(cursorFile, { cursors })

    return { ...(current ?? {}), channel_look: true, resolved_font_id: chosen.font_id }
  })
}
