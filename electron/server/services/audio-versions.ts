/**
 * Narration takes of one chapter, and "Use This Version".
 *
 * "Create Another Version" saves a new take BESIDE the active one (`_v2`
 * files, or `_partN` files beside an old single-file take) and deliberately
 * leaves the active selection alone. Until now nothing could make such a take
 * active (Dreamlands E2E 2026-10-03: a fixed EP0002 Ch12 take sat unused while
 * the defective one stayed active). This lists a chapter's takes and swaps the
 * active one; the previous active files move to the project's `_trash/`.
 *
 * The active selection is the `audio_chapters.json` row (Audio Assembly's
 * selector, which already accepts versioned files — see
 * promoteAudioQualityCandidate). Before that file exists the base names are
 * implicitly active, so the chosen take is renamed onto them instead.
 */

import fs from 'fs/promises'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { moveToTrashSync } from '../lib/trash-move.js'
import { trashTargetFor } from './chapter-parts.js'
import { updateAudioQualityProvenance } from './audio-quality-store.js'
import { hashSubtitleAudioSources } from './subtitle-completion.js'

export interface ChapterTake {
  /** Files of this take in playback order (basenames in the audio folder). */
  files: string[]
  /** 1 = the base names, 2+ = a `_vN` take. */
  version: number
  active: boolean
  bytes: number
  modified_at: string | null
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Pure: group a chapter's audio files into takes (single file or ordered parts, per version). */
export function groupChapterTakes(code: string, slug: string, filenames: string[]): Array<{ files: string[]; version: number }> {
  const pattern = new RegExp(`^${escape(code)}_${escape(slug)}(?:_part(\\d+))?(?:_v(\\d+))?\\.mp3$`, 'i')
  const groups = new Map<string, { version: number; parts: Array<{ n: number; file: string }> }>()
  for (const file of filenames) {
    const match = pattern.exec(file)
    if (!match) continue
    const version = match[2] ? Number(match[2]) : 1
    const part = match[1] ? Number(match[1]) : 0
    const key = `${version}:${part ? 'parts' : 'single'}`
    const group = groups.get(key) || { version, parts: [] }
    group.parts.push({ n: part, file })
    groups.set(key, group)
  }
  return [...groups.values()]
    .map(group => ({ version: group.version, files: group.parts.sort((a, b) => a.n - b.n).map(p => p.file) }))
    .sort((a, b) => a.version - b.version || a.files.length - b.files.length)
}

const sameFiles = (a: string[], b: string[]): boolean => a.length === b.length && a.every((file, i) => file === b[i])

async function readSelector(episodeDir: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8'))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`the active audio selection cannot be read (${error?.message || String(error)})`)
  }
}

function selectedFiles(selector: any, slug: string): string[] | null {
  const row = Array.isArray(selector?.sections)
    ? selector.sections.find((s: any) => typeof s?.slug === 'string' && s.slug.toLowerCase() === slug.toLowerCase())
    : null
  if (!row) return null
  if (Array.isArray(row.source_files) && row.source_files.length) return row.source_files.filter((f: unknown) => typeof f === 'string')
  return typeof row.source_file === 'string' ? [row.source_file] : null
}

export async function listChapterTakes(episodeDir: string, audioDir: string, code: string, slug: string): Promise<ChapterTake[]> {
  const entries = await fs.readdir(audioDir).catch(() => [] as string[])
  const groups = groupChapterTakes(code, slug, entries)
  const selector = await readSelector(episodeDir)
  const selected = selectedFiles(selector, slug)
  // No selector yet: the base take is implicitly active (single file first, as the generator joins into it).
  const active = selected ?? groups.find(g => g.version === 1)?.files ?? null
  const takes: ChapterTake[] = []
  for (const group of groups) {
    const stats = await Promise.all(group.files.map(file => fs.stat(path.join(audioDir, file)).catch(() => null)))
    if (stats.some(stat => !stat?.isFile() || stat.size === 0)) continue
    takes.push({
      files: group.files,
      version: group.version,
      active: !!active && sameFiles(active, group.files),
      bytes: stats.reduce((sum, stat) => sum + (stat?.size || 0), 0),
      modified_at: new Date(Math.max(...stats.map(stat => stat!.mtimeMs))).toISOString(),
    })
  }
  return takes
}

/** Make `files` the chapter's active take; the previous active files go to the project's `_trash/`. */
export async function useChapterTake(input: {
  projectDir: string
  episodeDir: string
  audioDir: string
  code: string
  slug: string
  files: string[]
}): Promise<{ active: string[]; trashed: string[] }> {
  const { projectDir, episodeDir, audioDir, code, slug } = input
  const sidecarPath = path.join(episodeDir, 'audio_chapters.json')
  const result = await withLock(sidecarPath, async () => {
    const takes = await listChapterTakes(episodeDir, audioDir, code, slug)
    const chosen = takes.find(take => sameFiles(take.files, input.files))
    if (!chosen) throw Object.assign(new Error('That version is no longer in the audio folder. Refresh and pick again.'), { statusCode: 404 })
    const previous = takes.find(take => take.active)
    if (chosen.active) return { active: chosen.files, trashed: [] as string[] }
    const outgoing = (previous?.files || []).filter(file => !chosen.files.includes(file))

    const selector = await readSelector(episodeDir)
    let activeFiles = chosen.files
    if (selector) {
      const row = selector.sections?.find((s: any) => typeof s?.slug === 'string' && s.slug.toLowerCase() === slug.toLowerCase())
      if (!row) throw new Error(`the active audio selection has no row for ${slug}`)
      row.source_files = [...chosen.files]
      row.source_file = chosen.files[0]
      await writeJsonAtomic(sidecarPath, selector)
    }
    const trashed: string[] = []
    for (const file of outgoing) {
      moveToTrashSync(path.join(audioDir, file), trashTargetFor(projectDir, path.join(audioDir, file)), 'audio')
      trashed.push(file)
    }
    if (!selector && chosen.version > 1) {
      // No selector: the base names are what is active, so the chosen take takes them over.
      activeFiles = []
      for (const file of chosen.files) {
        const base = file.replace(/_v\d+\.mp3$/i, '.mp3')
        await fs.rename(path.join(audioDir, file), path.join(audioDir, base))
        activeFiles.push(base)
      }
    }
    return { active: activeFiles, trashed }
  })

  // Keep the chapter's provenance describing the bytes that are now active, so
  // subtitles and Audio Assembly see this chapter as changed.
  const hash = await hashSubtitleAudioSources(result.active.map(file => path.join(audioDir, file)))
  await updateAudioQualityProvenance(episodeDir, current => {
    const key = Object.keys(current.chapters).find(k => k.toLowerCase() === slug.toLowerCase())
    if (key && hash) {
      current.chapters[key] = { ...current.chapters[key]!, source_files: result.active, source_audio_hash: hash, recorded_at: new Date().toISOString() }
    }
  })
  return result
}
