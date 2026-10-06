/**
 * One file per chapter (owner decision, 2026-10-03).
 *
 * A chapter longer than the voice model's request limit is narrated as several
 * parts (`{code}_{slug}_part1.mp3`, …). As soon as every part of a chapter has
 * succeeded they are joined into the chapter's ordinary single file
 * (`{code}_{slug}.mp3`, MP3 like every other chapter) and the parts move into a
 * hidden per-episode folder, `<audio folder>/.parts/{code}_{slug}/partN.mp3`,
 * with a small `manifest.json` — so one bad part can be made again alone and
 * the chapter re-joined without paying for, or waiting on, the whole chapter.
 *
 * The join follows the text, like the Hub's own long-form joiner: each part's
 * own leading/trailing silence is trimmed, then exactly 1.0 s goes after a
 * sentence end, 1.5 s at a paragraph break (0.15 s mid-sentence) — one rule for
 * all narration (owner decision 2026-10-04) — or the channel's own sentence /
 * paragraph pause (Series Formula, Audio Generator), the same one the Hub is asked for. Each part is
 * gain-matched to the chapter's median integrated loudness (one linear gain per
 * part, no limiter), lowered together only if a peak would pass -1 dBTP, and
 * gets a 5 ms fade at each edge so no seam clicks.
 *
 * Everything else (Audio Generator, Audio Assembly, subtitles, recovery, the
 * Board) then sees one file per chapter. The active-audio records
 * (`audio_quality.json`, `audio_chapters.json`) are rewritten to name that file.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, renameSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SENTENCE_END_CHARS } from '../lib/sentence-ends.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { readAudioQualityProvenance, updateAudioQualityProvenance } from './audio-quality-store.js'
import { hashSubtitleAudioSources } from './subtitle-completion.js'

export const PARTS_DIRNAME = '.parts'
export const MANIFEST_NAME = 'manifest.json'

/** The narration pauses for ALL narration (owner decision 2026-10-04): sent to the Hub as the
 *  request's own join pauses and used at Story's part seams, so every join sounds the same. */
export const SEAM_PAUSE_S = { sentence: 1.0, paragraph: 1.5, soft: 0.15 } as const
export type SeamPauseRule = { sentence: number; paragraph: number; soft: number }
const MAX_PAUSE_S = 3

/** The seam pauses for a chapter: the asked-for sentence / paragraph pause (0–3 s), else the uniform one. */
export function seamPauseRule(wanted: { paragraph?: number | null; sentence?: number | null } = {}): SeamPauseRule {
  const pick = (value: number | null | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_PAUSE_S) : fallback
  return { sentence: pick(wanted.sentence, SEAM_PAUSE_S.sentence), paragraph: pick(wanted.paragraph, SEAM_PAUSE_S.paragraph), soft: SEAM_PAUSE_S.soft }
}
const SENTENCE_ENDINGS = new Set(SENTENCE_END_CHARS)
const TRAILING_CLOSERS = new Set('"\'”’»）】〕〉')
const SILENCE_DB = -50
export const EDGE_FADE_S = 0.005
const TRUE_PEAK_CEILING_DB = -1
const BITRATE = '96k'

export interface PartText { text: string; start: number; end: number }

/** Where each part sits in the section text, and the pause each seam needs. */
export function planSeams(sectionText: string, parts: string[], rule: SeamPauseRule = SEAM_PAUSE_S): { ranges: PartText[]; pauses: number[] } {
  const ranges: PartText[] = []
  const pauses: number[] = []
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const found = sectionText.indexOf(parts[i]!, cursor)
    const start = found >= 0 ? found : cursor
    const end = start + parts[i]!.length
    ranges.push({ text: parts[i]!, start, end })
    cursor = end
    if (i === parts.length - 1) break
    const next = sectionText.indexOf(parts[i + 1]!, end)
    const separator = next >= 0 ? sectionText.slice(end, next) : ''
    let visible = parts[i]!.trimEnd()
    while (visible && TRAILING_CLOSERS.has(visible.at(-1)!)) visible = visible.slice(0, -1).trimEnd()
    pauses.push((separator.match(/\n/g)?.length ?? 0) >= 2 ? rule.paragraph
      : visible && SENTENCE_ENDINGS.has(visible.at(-1)!) ? rule.sentence
      : rule.soft)
  }
  return { ranges, pauses }
}

export interface PartMeasure {
  duration_s: number
  lead_silence_s: number
  trail_silence_s: number
  /** Integrated loudness (LUFS); null for a silent part. */
  lufs: number | null
  true_peak_db: number | null
}

/** One decode per part: duration, edge silence, loudness and true peak. */
export async function measurePart(file: string): Promise<PartMeasure> {
  // `len` treats everything as silence, so its one report ends at the exact
  // decoded duration; `edge` finds the part's own leading/trailing silence.
  const log = await runFfmpeg(['-hide_banner', '-nostats', '-i', file, '-af',
    `ebur128=peak=true:framelog=quiet,silencedetect@edge=n=${SILENCE_DB}dB:d=0.01,silencedetect@len=n=0dB:d=0`, '-f', 'null', '-'])
  const duration = Number(log.match(/silencedetect@len[^\n]*silence_end: ([\d.]+)/)?.[1] ?? 0)
  const starts = [...log.matchAll(/silencedetect@edge[^\n]*silence_start: (-?[\d.]+)/g)].map(m => Number(m[1]))
  const ends = [...log.matchAll(/silencedetect@edge[^\n]*silence_end: ([\d.]+)/g)].map(m => Number(m[1]))
  const lead = starts.length && starts[0]! <= 0.001 && ends.length ? ends[0]! : 0
  // silencedetect reports a silence that runs to the end of the stream with an
  // end at the decoded duration; anything that stops earlier is not a tail.
  const tailStart = starts.length && (ends.length < starts.length || ends.at(-1)! >= duration - 0.002) ? starts.at(-1)! : duration
  const summary = log.slice(log.lastIndexOf('Summary:'))
  const lufs = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1])
  const peak = Number(summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1])
  const silent = tailStart <= lead
  return {
    duration_s: duration,
    lead_silence_s: silent ? 0 : lead,
    trail_silence_s: silent ? 0 : Math.max(0, duration - tailStart),
    lufs: Number.isFinite(lufs) && lufs > -70 ? lufs : null,
    true_peak_db: Number.isFinite(peak) ? peak : null,
  }
}

export interface StitchedPart extends PartMeasure { gain_db: number }

/**
 * Join `files` with `pauses[i]` seconds after part i into `outPath` (callers
 * pass a hidden temp name and rename it into place, so a stop mid-join never
 * leaves a half file where a chapter belongs).
 */
export async function stitchParts(files: string[], pauses: number[], outPath: string): Promise<{ parts: StitchedPart[]; target_lufs: number | null }> {
  const measures: PartMeasure[] = []
  for (const file of files) measures.push(await measurePart(file))
  const levels = measures.map(m => m.lufs).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const target = levels.length
    ? (levels.length % 2 ? levels[(levels.length - 1) / 2]! : (levels[levels.length / 2 - 1]! + levels[levels.length / 2]!) / 2)
    : null
  let gains = measures.map(m => (target !== null && m.lufs !== null ? target - m.lufs : 0))
  const loudestPeak = Math.max(...measures.map((m, i) => (m.true_peak_db ?? -Infinity) + gains[i]!))
  if (loudestPeak > TRUE_PEAK_CEILING_DB) gains = gains.map(g => g - (loudestPeak - TRUE_PEAK_CEILING_DB))
  const graph = measures.map((m, i) => {
    const end = Math.max(m.lead_silence_s + 2 * EDGE_FADE_S, m.duration_s - m.trail_silence_s)
    const length = end - m.lead_silence_s
    return `[${i}:a]atrim=start=${m.lead_silence_s.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS,`
      + `volume=${gains[i]!.toFixed(3)}dB,afade=t=in:d=${EDGE_FADE_S},afade=t=out:st=${(length - EDGE_FADE_S).toFixed(6)}:d=${EDGE_FADE_S}`
      // The two 5 ms edge fades already sit below the silence line (the trim
      // cut exactly there), so they count toward the pause the ear hears.
      + (i < files.length - 1 ? `,apad=pad_dur=${Math.max(0, (pauses[i] ?? SEAM_PAUSE_S.sentence) - 2 * EDGE_FADE_S).toFixed(3)}` : '')
      + `[p${i}]`
  })
  graph.push(`${files.map((_, i) => `[p${i}]`).join('')}concat=n=${files.length}:v=0:a=1[out]`)
  await runFfmpeg(['-y', '-hide_banner', '-nostats', ...files.flatMap(file => ['-i', file]),
    '-filter_complex', graph.join(';'), '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', BITRATE, '-f', 'mp3', outPath])
  return { parts: measures.map((m, i) => ({ ...m, gain_db: Number(gains[i]!.toFixed(2)) })), target_lufs: target }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export interface PartsManifest {
  schema_version: 1
  chapter: string
  stitched_file: string
  stitched_sha256: string
  stitched_at: string
  target_lufs: number | null
  pause_rule: SeamPauseRule
  model_id?: string
  voice_id?: string
  settings?: Record<string, unknown>
  parts: Array<{
    file: string
    /** The name the part had in the audio folder (its request identity). */
    source_name: string
    sha256: string
    request_key?: string
    task_id?: string
    text_start?: number
    text_end?: number
    text_sha256?: string
    pause_after_s?: number
    duration_s: number
    lead_silence_s: number
    trail_silence_s: number
    lufs: number | null
    gain_db: number
  }>
}

export function partsDir(audioDir: string, stem: string): string {
  return path.join(audioDir, PARTS_DIRNAME, stem)
}

export async function readPartsManifest(audioDir: string, stem: string): Promise<PartsManifest | null> {
  try { return JSON.parse(await fs.readFile(path.join(partsDir(audioDir, stem), MANIFEST_NAME), 'utf8')) as PartsManifest }
  catch { return null }
}

export function textSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The kept copy of `{stem}_part{n}.mp3` in `.parts`, when it is there. */
export async function keptPartPath(audioDir: string, stem: string, partNumber: number): Promise<string | null> {
  const file = path.join(partsDir(audioDir, stem), `part${partNumber}.mp3`)
  const stat = await fs.stat(file).catch(() => null)
  return stat?.isFile() && stat.size > 0 ? file : null
}

/**
 * The `_trash` mirror of `file` on the file's own drive: `<project>/_trash/<same relative path>`,
 * or, for heavy media under a `media_root` on another drive (`mediaAnchor`), that drive's
 * `<media root>/_trash/<slug>/<same relative path>` (the Free up space convention, `trashRootFor`).
 * ponytail: without a `mediaAnchor`, media on another drive keeps its file in place instead
 * (rename across volumes fails and nothing is copied-then-deleted).
 */
export function trashTargetFor(projectDir: string, file: string, mediaAnchor?: string): string {
  const under = (root: string) => {
    const rel = path.relative(root, file)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
  }
  const rel = under(projectDir)
  if (rel) return path.join(projectDir, '_trash', rel)
  const mediaRel = mediaAnchor ? under(mediaAnchor) : null
  if (mediaRel) return path.join(trashRootFor(mediaAnchor!, projectDir, path.basename(projectDir)), mediaRel)
  return path.join(projectDir, '_trash', 'media', path.basename(path.dirname(path.dirname(file))), path.basename(path.dirname(file)), path.basename(file))
}

function trash(projectDir: string, file: string, log: (line: string) => void): void {
  try { moveToTrashSync(file, trashTargetFor(projectDir, file)) }
  catch (error: any) { log(`  Could not move ${path.basename(file)} to _trash (${error?.message || error}); it was left where it is.`) }
}

export interface ConsolidateInput {
  projectDir: string
  episodeDir: string
  audioDir: string
  code: string
  /** Section text + exact part texts, when the caller knows them (generation does). */
  texts?: Map<string, { sectionText: string; parts: string[] }>
  /** Loads `texts` lazily for a migration; failures fall back to sentence pauses. */
  loadTexts?: () => Promise<Map<string, { sectionText: string; parts: string[] }>>
  /** Limit to these chapters (slugs, any case). */
  only?: string[]
  settings?: Record<string, unknown>
  /** The channel's sentence / paragraph pause (`seamPauseRule`); absent = the uniform 1.0 / 1.5 s. */
  pauseRule?: SeamPauseRule
  log?: (line: string) => void
}

type SelectorRow = { slug?: unknown; source_file?: unknown; source_files?: unknown; [key: string]: unknown }

function rowFiles(row: SelectorRow | undefined): string[] | null {
  if (!row) return null
  if (Array.isArray(row.source_files) && row.source_files.length) return row.source_files.filter((f): f is string => typeof f === 'string')
  return typeof row.source_file === 'string' ? [row.source_file] : null
}

const same = (a: string[] | null | undefined, b: string[]) => !!a && a.length === b.length && a.every((f, i) => f === b[i])

/** Slugs that a pending audio-quality action holds; their source map must not move under it. */
function pendingQualitySlugs(actions: Awaited<ReturnType<typeof readAudioQualityProvenance>>['actions']): Set<string> {
  const held = new Set<string>()
  for (const action of Object.values(actions || {})) {
    const open = ['checked', 'confirmed', 'candidate_ready', 'needs_approval'].includes(action.state)
      || ['quoted', 'checking', 'needs_approval'].includes(action.active_check?.state || '')
    if (open) for (const slug of action.sections) held.add(slug.toLowerCase())
  }
  return held
}

/**
 * Join every chapter whose parts are complete and active, move the parts into
 * `.parts/`, and finish any join a stop interrupted. Idempotent and safe to run
 * on every audio action. Never deletes: a replaced older take goes to `_trash`.
 *
 * "Complete and active" is decided by the records generation writes only after
 * every part succeeded: `audio_quality.json` names the part list and the hash
 * of their bytes (and Audio Assembly's `audio_chapters.json`, when present,
 * selects the same list). Older episodes without that record fall back to an
 * Audio Assembly selection naming only this chapter's parts.
 */
export async function consolidateChapterParts(input: ConsolidateInput): Promise<string[]> {
  const log = input.log ?? (() => {})
  return withLock(path.join(input.audioDir, PARTS_DIRNAME), async () => {
    const stitched: string[] = []
    const provenance = await readAudioQualityProvenance(input.episodeDir)
    const selectorPath = path.join(input.episodeDir, 'audio_chapters.json')
    let selector: { sections?: SelectorRow[] } | null = null
    try { selector = JSON.parse(await fs.readFile(selectorPath, 'utf8')) } catch { /* optional */ }
    const rows = new Map((selector?.sections || [])
      .filter(row => typeof row.slug === 'string')
      .map(row => [String(row.slug).toLowerCase(), row] as const))
    const held = pendingQualitySlugs(provenance.actions)
    const only = input.only ? new Set(input.only.map(slug => slug.toLowerCase())) : null
    const slugs = new Map<string, string>()
    for (const slug of Object.keys(provenance.chapters)) slugs.set(slug.toLowerCase(), slug)
    for (const row of rows.values()) if (!slugs.has(String(row.slug).toLowerCase())) slugs.set(String(row.slug).toLowerCase(), String(row.slug))
    let texts = input.texts

    for (const [key, slug] of slugs) {
      if (only && !only.has(key)) continue
      if (held.has(key)) continue
      try {
      const stem = `${input.code}_${slug}`
      const base = `${stem}.mp3`
      const basePath = path.join(input.audioDir, base)
      const chapter = Object.entries(provenance.chapters).find(([s]) => s.toLowerCase() === key)?.[1]
      const row = rows.get(key)
      const partRe = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_part(\\d+)\\.mp3$`, 'i')

      // ── Finish a join a stop interrupted (the joined file is already in place). ──
      const manifest = await readPartsManifest(input.audioDir, stem)
      if (manifest && existsSync(basePath) && (await sha256File(basePath)) === manifest.stitched_sha256) {
        const sources = manifest.parts.map(part => part.source_name)
        // A loose part with other bytes than the manifest's is a NEW take
        // (Regenerate wrote it), not the leftover of an interrupted move.
        let newTake = false
        for (const part of manifest.parts) {
          const loose = path.join(input.audioDir, part.source_name)
          if (existsSync(loose) && (await sha256File(loose)) !== part.sha256) newTake = true
        }
        if (!newTake && (!chapter || same(chapter.source_files, sources) || same(chapter.source_files, [base]))) {
          await commitJoin(input, key, base, chapter ? sources : null, row && same(rowFiles(row), sources) ? selectorPath : null,
            manifest.parts.map(part => [path.join(input.audioDir, part.source_name), path.join(partsDir(input.audioDir, stem), part.file), part.sha256]))
          continue
        }
      }

      const files = chapter?.source_files?.length ? chapter.source_files : rowFiles(row)
      if (!files || files.length < 2 || !files.every(file => partRe.test(file))) continue
      if (row && !same(rowFiles(row), files)) continue
      const numbers = files.map(file => Number(file.match(partRe)![1]))
      if (!numbers.every((n, i) => n === i + 1)) continue
      const partPaths = files.map(file => path.join(input.audioDir, file))
      if (chapter) {
        if ((await hashSubtitleAudioSources(partPaths)) !== chapter.source_audio_hash) continue
      } else {
        const stats = await Promise.all(partPaths.map(file => fs.stat(file).catch(() => null)))
        if (!stats.every(stat => stat?.isFile() && stat.size > 0)) continue
      }

      if (!texts && input.loadTexts) texts = await input.loadTexts().catch(() => new Map())
      const known = texts && [...texts.entries()].find(([s]) => s.toLowerCase() === key)?.[1]
      const rule = input.pauseRule ?? SEAM_PAUSE_S
      const plan = known && known.parts.length === files.length ? planSeams(known.sectionText, known.parts, rule) : null
      const pauses = plan?.pauses ?? files.slice(1).map(() => rule.sentence)

      // 1. Join into a hidden temp file, then 2. move an older take aside, 3. rename.
      const temp = path.join(input.audioDir, `.${stem}.joined.mp3`)
      const result = await stitchParts(partPaths, pauses, temp)
      if (existsSync(basePath)) {
        trash(input.projectDir, basePath, log)
        log(`  The older single-file take of ${slug.replaceAll('_', ' ')} was moved to _trash.`)
      }
      if (existsSync(basePath)) { await fs.rm(temp, { force: true }); continue }
      await fs.rename(temp, basePath)
      const stitchedSha = await sha256File(basePath)

      // 4. Manifest beside the parts (an older .parts folder for this chapter goes to _trash first).
      const dir = partsDir(input.audioDir, stem)
      if (existsSync(dir)) trash(input.projectDir, dir, log)
      await fs.mkdir(dir, { recursive: true })
      const next: PartsManifest = {
        schema_version: 1,
        chapter: slug,
        stitched_file: base,
        stitched_sha256: stitchedSha,
        stitched_at: new Date().toISOString(),
        target_lufs: result.target_lufs,
        pause_rule: rule,
        ...(chapter?.tts?.model_id ? { model_id: chapter.tts.model_id } : {}),
        ...(chapter?.tts?.voice_id ? { voice_id: chapter.tts.voice_id } : {}),
        ...(input.settings ? { settings: input.settings } : {}),
        parts: await Promise.all(files.map(async (file, i) => ({
          file: `part${i + 1}.mp3`,
          source_name: file,
          sha256: await sha256File(partPaths[i]!),
          ...(chapter?.tts?.idempotency_keys?.[file] ? { request_key: chapter.tts.idempotency_keys[file] } : {}),
          ...(chapter?.tts?.task_ids?.[file] ? { task_id: chapter.tts.task_ids[file] } : {}),
          ...(plan ? { text_start: plan.ranges[i]!.start, text_end: plan.ranges[i]!.end, text_sha256: textSha(plan.ranges[i]!.text) } : {}),
          ...(i < pauses.length ? { pause_after_s: pauses[i] } : {}),
          ...result.parts[i]!,
        }))),
      }
      await writeJsonAtomic(path.join(dir, MANIFEST_NAME), next)

      // 5. Records name the joined file (6. selector), then 7. parts move into .parts.
      await commitJoin(input, key, base, chapter ? files : null, row ? selectorPath : null,
        next.parts.map((part, i) => [partPaths[i]!, path.join(dir, part.file), part.sha256]))
      stitched.push(slug)
      log(`  Joined ${files.length} parts of ${slug.replaceAll('_', ' ')} into ${base} (pauses follow the text; parts kept in ${PARTS_DIRNAME}/${stem}).`)
      } catch (error: any) {
        // The parts stay exactly where they were: the old, still-working layout.
        log(`  ${slug.replaceAll('_', ' ')} was left as separate parts (joining them failed: ${error?.message || error}).`)
      }
    }
    return stitched
  })
}

/**
 * Point the active-audio records at the joined file, then move the parts into
 * `.parts`. Each step is atomic and re-runnable, so a stop between any two of
 * them is finished by the next run.
 */
async function commitJoin(
  input: ConsolidateInput, key: string, base: string,
  provenanceParts: string[] | null, selectorPath: string | null,
  moves: Array<[from: string, to: string, sha: string]>,
): Promise<void> {
  if (provenanceParts) {
    const hash = await hashSubtitleAudioSources([path.join(input.audioDir, base)])
    await updateAudioQualityProvenance(input.episodeDir, current => {
      const entry = Object.entries(current.chapters).find(([s]) => s.toLowerCase() === key)?.[1]
      if (entry && hash && (same(entry.source_files, provenanceParts) || same(entry.source_files, [base]))) {
        entry.source_files = [base]
        entry.source_audio_hash = hash
      }
    })
  }
  if (selectorPath) await rewriteSelectorRow(selectorPath, key, base)
  for (const [from, to, sha] of moves) {
    if (!existsSync(from) || (await sha256File(from)) !== sha) continue
    // A kept copy with the very same bytes (a re-made part came back identical) is simply replaced.
    if (!existsSync(to) || (await sha256File(to)) === sha) renameSync(from, to)
  }
}

async function rewriteSelectorRow(selectorPath: string, key: string, base: string): Promise<void> {
  await withLock(selectorPath, async () => {
    const sidecar = JSON.parse(await fs.readFile(selectorPath, 'utf8')) as { sections?: SelectorRow[] }
    const row = sidecar.sections?.find(r => typeof r.slug === 'string' && r.slug.toLowerCase() === key)
    if (!row) return
    row.source_files = [base]
    row.source_file = base
    await writeJsonAtomic(selectorPath, sidecar)
  })
}

/**
 * The section and part texts generation used, rebuilt for a migration from the
 * narration and the split boundary recorded beside the episode's audio.
 */
export async function loadPartTexts(slug: string, code: string, episodeDir: string): Promise<Map<string, { sectionText: string; parts: string[] }>> {
  const { findNarrationFile } = await import('../generators/audio.js')
  const { parseNarrationDocx } = await import('../lib/docx-parser.js')
  const { normalizeForTts } = await import('../lib/tts-text.js')
  const { splitGenStudioApiRequests } = await import('../lib/genstudio-client.js')
  const { readAudioTtsModelRecord } = await import('./audio-tts-model-record.js')
  const budget = (await readAudioTtsModelRecord(episodeDir))?.request_budget
  const out = new Map<string, { sectionText: string; parts: string[] }>()
  if (!budget) return out
  for (const section of await parseNarrationDocx(await findNarrationFile(slug, code))) {
    const sectionText = normalizeForTts(section.text).text
    out.set(section.slug, { sectionText, parts: splitGenStudioApiRequests(sectionText, budget) })
  }
  return out
}

/**
 * Migration entry for Audio Assembly / subtitles: join any complete parts of
 * this episode. Never throws — a join that cannot run leaves the parts exactly
 * as they were (the old, still-working layout) and says so.
 */
export async function consolidateEpisodeParts(slug: string, code: string, log: (line: string) => void): Promise<string[]> {
  try {
    const { resolveEpisodePathsByCodeWithSidecar, projectDirFor } = await import('./utils.js')
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json')
    if (!existsSync(paths.audio_dir)) return []
    // The channel's pauses (Series Formula), as the narration run would have used them.
    const { getEffectiveFormat } = await import('./format-loader.js')
    const pauses = await getEffectiveFormat(slug).then(format => format?.script.narrationPauses).catch(() => undefined)
    return await consolidateChapterParts({
      projectDir: projectDirFor(slug), episodeDir: paths.episode_dir, audioDir: paths.audio_dir,
      code: code.toUpperCase(), loadTexts: () => loadPartTexts(slug, code, paths.episode_dir), log,
      pauseRule: seamPauseRule({ paragraph: pauses?.paragraphSec, sentence: pauses?.sentenceSec }),
    })
  } catch (error: any) {
    log(`Chapter parts were left as separate files (joining them failed: ${error?.message || error}).`)
    return []
  }
}

/** One thing Free up space › Narration parts can move: a kept `.parts/<stem>` folder or a loose part. */
export interface NarrationPartsItem { path: string; relative_path: string; bytes: number }

async function treeBytes(p: string): Promise<number> {
  const stat = await fs.lstat(p).catch(() => null)
  if (stat?.isFile()) return stat.size
  if (!stat?.isDirectory()) return 0
  let total = 0
  for (const name of await fs.readdir(p)) total += await treeBytes(path.join(p, name))
  return total
}

async function joinedChapterExists(audioDir: string, stem: string, manifest: PartsManifest): Promise<boolean> {
  const stat = await fs.stat(path.join(audioDir, manifest.stitched_file || `${stem}.mp3`)).catch(() => null)
  return !!stat?.isFile() && stat.size > 0
}

/**
 * What Free up space › Narration parts may move without losing anything: each loose
 * `{stem}_part{n}.mp3` whose exact bytes went into its chapter's join (manifest sha) and each kept
 * `.parts/<stem>` folder, both only while the joined chapter file is there. Loose parts of a newer
 * take, or of a chapter never joined, are still needed and are not offered. Loose parts come first so
 * moving a folder (and its manifest) never makes a later loose part unprovable.
 */
export async function narrationPartsToFree(audioDir: string): Promise<NarrationPartsItem[]> {
  const loose: NarrationPartsItem[] = []
  const folders: NarrationPartsItem[] = []
  for (const entry of await fs.readdir(audioDir, { withFileTypes: true }).catch(() => [])) {
    const stem = entry.isFile() ? /^(.+)_part\d+\.mp3$/.exec(entry.name)?.[1] : undefined
    const manifest = stem ? await readPartsManifest(audioDir, stem) : null
    const expected = manifest?.parts?.find(part => part.source_name === entry.name)?.sha256
    const file = path.join(audioDir, entry.name)
    if (!expected || !await joinedChapterExists(audioDir, stem!, manifest!) || await sha256File(file) !== expected) continue
    loose.push({ path: file, relative_path: entry.name, bytes: (await fs.stat(file)).size })
  }
  for (const entry of await fs.readdir(path.join(audioDir, PARTS_DIRNAME), { withFileTypes: true }).catch(() => [])) {
    const manifest = entry.isDirectory() ? await readPartsManifest(audioDir, entry.name) : null
    if (!manifest || !await joinedChapterExists(audioDir, entry.name, manifest)) continue
    const dir = partsDir(audioDir, entry.name)
    folders.push({ path: dir, relative_path: path.relative(audioDir, dir), bytes: await treeBytes(dir) })
  }
  return [...loose, ...folders]
}

/**
 * Free up space › Narration parts: the ONLY thing that moves narration parts out of the
 * episode (owner decision 2026-10-06 — nothing is moved automatically, not even after the
 * final render). Each of `only` that is still safe to move (checked again now) goes to
 * `_trash` on its own drive (`trashTargetFor`); anything else stays exactly where it is.
 */
export async function trashEpisodeParts(
  projectDir: string, audioDir: string, only: string[], mediaAnchor?: string,
): Promise<{ moved: Array<{ path: string; to: string }>; left: Array<{ path: string; reason: string }> }> {
  const safe = new Set((await narrationPartsToFree(audioDir)).map(item => item.path))
  const moved: Array<{ path: string; to: string }> = []
  const left: Array<{ path: string; reason: string }> = []
  for (const item of only) {
    if (!safe.has(item)) {
      left.push({ path: item, reason: 'Left where it is: its joined chapter is missing or the part changed since review, so it may still be needed.' })
      continue
    }
    try { moved.push({ path: item, to: moveToTrashSync(item, trashTargetFor(projectDir, item, mediaAnchor)) }) }
    catch (error: any) { left.push({ path: item, reason: `Left where it is: it could not be moved to _trash on its own drive (${error?.message || error}).` }) }
  }
  return { moved, left }
}
