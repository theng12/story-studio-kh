/**
 * Reconstruct a missing `audio_chapters.json` from the per-chapter audio that's
 * still on disk (v1.0.398).
 *
 * Audio Assembly writes `audio_chapters.json` (per-section durations + the
 * inter-chapter gap) at merge time — it's what the subtitle stitcher and the
 * chapter-aligned video assembler read. Episodes merged before that sidecar was
 * written reliably (or where it was lost) leave the stitcher dead-in-the-water
 * with "audio_chapters.json not found — Run Audio Assembly first", even though
 * every per-chapter audio file is right there. Re-running Audio Assembly would
 * fix it but re-creates the merged audio, which can desync already-rendered
 * scenes.
 *
 * Instead we rebuild the sidecar from disk WITHOUT touching the audio:
 *   - measure each chapter file (grouping multi-part chapters by slug),
 *   - derive the gap from `merged duration − sum of chapter durations` spread
 *     over the inter-chapter gaps (exact to encoder residue — sub-second across
 *     a whole episode), falling back to a 5 s default if the merged file's gone.
 *
 * The math core is pure + exported for unit coverage; the IO wrappers measure
 * durations and (optionally) persist the result.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { getAudioDuration } from './ffmpeg-utils.js'
import { resolveEpisodeMergedAudioChoice } from './merged-audio-selection.js'
import { chapterKeyOf, compareChapterFilenames, isActiveChapterAudioFilename } from '../generators/audio-merge.js'

const AUDIO_RE = /\.(mp3|wav|m4a)$/i
/** Gap used when the merged file is missing so we can't derive the real one. */
export const DEFAULT_GAP_SEC = 5
/** Clamp band for a derived gap — guards against a weird measurement producing
 *  absurd cumulative offsets. Real merges use 0–10 s. */
const MAX_DERIVED_GAP_SEC = 15

export interface ReconstructedSection {
  slug: string
  duration_s: number
  source_file: string
  source_files: string[]
}

export interface ReconstructedSidecar {
  sections: ReconstructedSection[]
  gap_duration_s: number
  /** How the gap was determined. */
  gap_source: 'derived' | 'default'
}

/**
 * Pure core: group already-measured chapter files (in play order) by chapter
 * slug, sum their durations, and derive the inter-chapter gap from the merged
 * duration. Returns null when there are no usable chapter files.
 *
 * `files` MUST already be ordered the way the merge concatenated them (use
 * compareChapterFilenames). Multi-part chapters (`_part1`/`_part2`) collapse to
 * one section whose duration is the sum of its parts — matching how Audio
 * Assembly emits the sidecar.
 */
export function buildReconstructedSidecar(
  files: Array<{ filename: string; duration_s: number }>,
  episodeCode: string,
  mergedDuration?: number,
): ReconstructedSidecar | null {
  const groups = new Map<string, ReconstructedSection>()
  const order: string[] = []
  let sumDur = 0
  for (const f of files) {
    if (!Number.isFinite(f.duration_s) || f.duration_s <= 0) continue
    const slug = chapterKeyOf(f.filename, episodeCode)
    let g = groups.get(slug)
    if (!g) { g = { slug, duration_s: 0, source_file: f.filename, source_files: [] }; groups.set(slug, g); order.push(slug) }
    g.duration_s += f.duration_s
    g.source_files.push(f.filename)
    sumDur += f.duration_s
  }
  if (!order.length) return null
  const sections = order.map(s => groups.get(s)!)

  let gap = DEFAULT_GAP_SEC
  let gapSource: 'derived' | 'default' = 'default'
  const nGaps = Math.max(1, sections.length - 1)
  if (typeof mergedDuration === 'number' && Number.isFinite(mergedDuration) && mergedDuration > sumDur) {
    const derived = (mergedDuration - sumDur) / nGaps
    gap = Math.max(0, Math.min(MAX_DERIVED_GAP_SEC, derived))
    gapSource = 'derived'
  }

  // Round to ms — plenty of precision, keeps the JSON tidy.
  for (const s of sections) s.duration_s = Number(s.duration_s.toFixed(3))
  return { sections, gap_duration_s: Number(gap.toFixed(3)), gap_source: gapSource }
}

/** Largest audio file in a dir = the merged track. Returns its absolute path. */
async function largestAudioFile(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null
  const files = (await fs.readdir(dir)).filter(f => AUDIO_RE.test(f) && !f.startsWith('.tmp_'))
  let best: string | null = null
  let bestSize = 0
  for (const f of files) {
    const st = await fs.stat(path.join(dir, f)).catch(() => null)
    if (st && st.size > bestSize) { bestSize = st.size; best = path.join(dir, f) }
  }
  return best
}

/**
 * Measure the per-chapter audio + merged audio on disk and reconstruct the
 * sidecar payload. Returns null when there's no per-chapter audio to work from.
 * Read-only — never writes.
 */
export async function reconstructAudioChapters(opts: {
  audioDir: string          // per-chapter audio ("… - 07 Audio Assets")
  mergedAudioDir?: string   // merged output ("… - 08 Audio Merge Output")
  episodeCode: string
}): Promise<ReconstructedSidecar | null> {
  const { audioDir, mergedAudioDir, episodeCode } = opts
  if (!existsSync(audioDir)) return null
  const names = (await fs.readdir(audioDir))
    .filter(f => AUDIO_RE.test(f) && !f.startsWith('.') && !f.startsWith('.tmp_') && isActiveChapterAudioFilename(f))
    .sort(compareChapterFilenames)
  if (!names.length) return null

  const files: Array<{ filename: string; duration_s: number }> = []
  for (const name of names) {
    const d = await getAudioDuration(path.join(audioDir, name)).catch(() => undefined)
    if (typeof d === 'number' && d > 0) files.push({ filename: name, duration_s: d })
  }
  if (!files.length) return null

  let mergedDuration: number | undefined
  if (mergedAudioDir) {
    // v1.4.314 — measure the track this episode renders with: the owner's pinned
    // merge when he made one, else the largest file (the long-standing rule). A
    // pin that no longer names a real track leaves the gap at its default rather
    // than measuring a track the app will not use.
    const choice = await resolveEpisodeMergedAudioChoice(mergedAudioDir, episodeCode)
    const chosenPath = choice.source === 'selected'
      ? path.join(mergedAudioDir, choice.filename!)
      : choice.source === 'unset'
        ? await largestAudioFile(mergedAudioDir)
        : null
    if (chosenPath) mergedDuration = await getAudioDuration(chosenPath).catch(() => undefined)
  }

  return buildReconstructedSidecar(files, episodeCode, mergedDuration)
}

/**
 * Ensure `audio_chapters.json` exists for an episode. When it's missing,
 * reconstruct it from the chapter audio and write it (so the stitcher — and the
 * chapter-aligned video assembler — find it, and it's healed for next time).
 * Returns a short status string for the job log, or null when nothing was done
 * (sidecar already present, or no audio to rebuild from).
 */
export async function ensureAudioChaptersSidecar(opts: {
  episodeDir: string
  audioDir: string
  mergedAudioDir?: string
  episodeCode: string
}): Promise<string | null> {
  const sidecarPath = path.join(opts.episodeDir, 'audio_chapters.json')
  if (existsSync(sidecarPath)) return null
  const rebuilt = await reconstructAudioChapters({
    audioDir: opts.audioDir,
    mergedAudioDir: opts.mergedAudioDir,
    episodeCode: opts.episodeCode,
  })
  if (!rebuilt) return null
  await fs.writeFile(sidecarPath, JSON.stringify({
    sections: rebuilt.sections.map(s => ({ slug: s.slug, duration_s: s.duration_s, source_file: s.source_file })),
    gap_duration_s: rebuilt.gap_duration_s,
    // Marker so it's obvious this wasn't written by Audio Assembly directly.
    reconstructed: true,
  }, null, 2), 'utf-8')
  return `reconstructed audio_chapters.json from ${rebuilt.sections.length} chapter file(s) on disk, ` +
    `gap≈${rebuilt.gap_duration_s}s (${rebuilt.gap_source}). Re-run Audio Assembly for an exact value.`
}
