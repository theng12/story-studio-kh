/**
 * Audio merge generator — merges narration chapter audio files with silence gaps,
 * optionally normalizes volume, and mixes in background music and ambient noise.
 *
 * Pipeline:
 *   1. Validate chapter files exist
 *   2. Resolve output directory (merged_audio subfolder)
 *   3. Normalize volume (optional two-pass loudnorm)
 *   4. Concatenate chapters with silence gaps
 *   5. Mix with background music and/or ambient noise
 *   6. Cleanup temp directory
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import * as pm from '../services/project-manager.js'
import { trackChild } from '../services/job-queue.js'
import { resolveSubfolderNames, resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import { runFfmpeg, getAudioDuration, formatConcatFileLine, appendCappedTail } from '../lib/ffmpeg-utils.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import type {
  AudioMergeRequest, Job,
  VideoMusicConfig, VideoBackgroundNoise, AmbientTrack,
} from '../models/types.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { resolveAssetPath, isPortablePath } from '../services/path-resolver.js'
import { checkAssetAvailability } from '../lib/sync-safe.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { requireChapterAudioReady } from '../services/audio-workflow-readiness.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'
import { recordSubtitleSourceEvidence } from '../services/subtitle-recovery.js'
import { ensureStitchedSubtitle } from '../lib/subtitle-autostitch.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { readAudioQualityProvenance, updateAudioQualityProvenance } from '../services/audio-quality-store.js'
import {
  buildMergedAudioOpeningRecord,
  type MergedAudioIntroRecord,
} from '../services/merged-audio-opening.js'
import { segmentPositionForFilename } from '../lib/episode-segments.js'

// ── Run FFmpeg and capture stderr (needed for loudnorm measurement) ────────

/**
 * Default audio-merge wall-clock watchdog. Both loudnorm pass and the
 * final mix run through this; 30 min is plenty for a multi-chapter sleep
 * story. Tunable via the same env var as video.ts so there's one knob.
 */
function audioMergeTimeoutMs(): number {
  return Number(process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS) || 30 * 60_000
}

async function runFfmpegWithStderr(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  // Bare `spawn('ffmpeg', …)` ENOENT'd on packaged Macs without system ffmpeg
  // — same class of bug as runEncode() in video.ts. Route through the resolver
  // so the bundled binary wins. Can't use `runFfmpeg()` from ffmpeg-utils.ts
  // because this function has to RETURN stderr (loudnorm measurement is
  // printed there, not stdout).
  const ffmpegBin = await getFFmpegPath()
  const { timeoutMs } = opts
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Register with the current job so cancel → SIGTERM kills this spawn too.
    trackChild(proc)

    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => { stderr = appendCappedTail(stderr, data.toString()) })

    let watchdogKilled = false
    const termTimer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          watchdogKilled = true
          try { proc.kill('SIGTERM') } catch { /* exited */ }
          const killTimer = setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { /* exited */ }
          }, 5000)
          proc.once('close', () => clearTimeout(killTimer))
        }, timeoutMs)
      : null

    proc.on('error', (err) => {
      if (termTimer) clearTimeout(termTimer)
      reject(new Error(`FFmpeg failed to start: ${err.message}`))
    })

    proc.on('close', (code, signal) => {
      if (termTimer) clearTimeout(termTimer)
      if (code === 0) {
        resolve(stderr)
        return
      }
      if (watchdogKilled && timeoutMs) {
        const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
        const lines = stderr.split('\n').filter(l => l.trim())
        const tail = lines.slice(-5).join('\n') || '(no stderr captured)'
        reject(new Error(
          `FFmpeg exceeded ${minutes}-minute wall-clock watchdog — job killed to free the queue. Last stderr: ${tail}`,
        ))
        return
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error(`FFmpeg killed (${signal})`))
        return
      }
      const lines = stderr.split('\n').filter(l => l.trim())
      const errorLine = lines.slice(-5).join('\n')
      reject(new Error(`FFmpeg exited with code ${code}:\n${errorLine}`))
    })
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function findEpisodeDir(projectDir: string, code: string): Promise<string | null> {
  async function searchRecursive(dir: string, depth: number): Promise<string | null> {
    if (depth > 4) return null
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const cleanName = entry.name
        if (cleanName.toUpperCase().startsWith(code)) {
          return path.join(dir, entry.name)
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const found = await searchRecursive(path.join(dir, entry.name), depth + 1)
        if (found) return found
      }
    } catch { /* skip */ }
    return null
  }
  return searchRecursive(projectDir, 0)
}

async function resolveSubfolder(episodeDir: string, subfolderName: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(episodeDir)
    for (const entry of entries) {
      const clean = entry
      if (clean === subfolderName) return path.join(episodeDir, entry)
    }
  } catch { /* fall through */ }
  const exactPath = path.join(episodeDir, subfolderName)
  if (existsSync(exactPath)) return exactPath
  return null
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

const escPath = formatConcatFileLine

/**
 * Un-bash-escape a path the user may have dragged/pasted from Terminal.
 * `spawn()` passes argv directly; bash backslash-escapes become literal chars and
 * break the open(2) call. Turn `/Users/foo\ bar/\(baz\).mp3` back into
 * `/Users/foo bar/(baz).mp3`. Safe for already-clean paths (no-op).
 */
function unescapeShellPath(p: string | undefined): string | undefined {
  if (!p) return p
  return p.replace(/\\([ ()~&!?*;|$`'"\[\]])/g, '$1').trim()
}

/**
 * Resolve the merged_audio subfolder name from project config.
 * The base resolveSubfolderNames doesn't include merged_audio,
 * so we read it from project.json directly.
 */
async function resolveMergedAudioName(slug: string, code: string): Promise<string> {
  try {
    const metaRaw = await fs.readFile(
      // Linked-aware project.json read so iCloud projects pick up their
      // own subfolder_names override.
      path.join(pm.getProjectDir(slug) || path.join(pm.projectsRoot(), slug), 'project.json'), 'utf-8',
    )
    const meta = JSON.parse(metaRaw)
    const subfolder = meta.subfolder_names || {}
    const template = subfolder.merged_audio || DEFAULT_SUBFOLDER_NAMES.merged_audio
    return template.replace('{code}', code)
  } catch {
    return DEFAULT_SUBFOLDER_NAMES.merged_audio.replace('{code}', code)
  }
}

/**
 * Decide the filename for a merged output.
 * - 'overwrite': replace the highest existing version (or create v1)
 * - 'new': pick the next `{code}_merged_audio_vN.mp3` that doesn't exist
 */
export async function resolveMergedOutputName(
  dir: string, code: string, mode: 'overwrite' | 'new',
): Promise<string> {
  const base = `${code}_merged_audio`
  const existing = await safeReaddir(dir)
  const re = new RegExp(`^${code}_merged_audio(?:_v(\\d+))?\\.mp3$`)
  let latest: { version: number; filename: string } | null = null
  for (const f of existing) {
    const m = f.match(re)
    if (!m) continue
    const v = m[1] ? parseInt(m[1], 10) : 1
    if (!latest || v > latest.version) latest = { version: v, filename: f }
  }
  if (mode === 'overwrite') return latest?.filename || `${base}.mp3`
  const next = Math.max(2, (latest?.version || 0) + 1) // first "new" is v2, since base = v1
  return `${base}_v${next}.mp3`
}

// ── Loudnorm Two-Pass Normalization ───────────────────────────────────────

interface LoudnormMeasurements {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

async function measureLoudnorm(filePath: string): Promise<LoudnormMeasurements> {
  const stderr = await runFfmpegWithStderr([
    '-y', '-i', filePath,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-',
  ], { timeoutMs: audioMergeTimeoutMs() })

  // The JSON block is printed at the end of stderr
  const jsonMatch = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`Failed to parse loudnorm measurements from: ${path.basename(filePath)}`)
  }

  const data = JSON.parse(jsonMatch[0])
  return {
    input_i: data.input_i,
    input_tp: data.input_tp,
    input_lra: data.input_lra,
    input_thresh: data.input_thresh,
    target_offset: data.target_offset,
  }
}

async function applyLoudnorm(
  inputPath: string,
  outputPath: string,
  m: LoudnormMeasurements,
): Promise<void> {
  const af = [
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    `measured_I=${m.input_i}`,
    `measured_TP=${m.input_tp}`,
    `measured_LRA=${m.input_lra}`,
    `measured_thresh=${m.input_thresh}`,
    `offset=${m.target_offset}`,
    'linear=true',
  ].join(':')

  await runFfmpeg([
    '-y', '-i', inputPath,
    '-af', af,
    '-c:a', 'libmp3lame', '-b:a', '192k',
    outputPath,
  ], { timeoutMs: audioMergeTimeoutMs() })
}

/**
 * v1.0.224 — collapse a chapter-audio filename to its CHAPTER key, so the
 * multiple chunk files a long chapter is split into (`{code}_{slug}_part1.mp3`,
 * `_part2.mp3`, … — written by the audio generator when a section exceeds the
 * TTS char cap) group back under one chapter. Without this, the merge treated
 * every part as its own "chapter": it put silence gaps BETWEEN parts of the
 * same chapter and wrote per-part sections into audio_chapters.json — which
 * then didn't line up with the per-chapter SRTs the Subtitles step produces,
 * so the stitch came out empty/misaligned.
 */
/**
 * v1.0.315 — Comparator for audio-asset filenames so the Audio Assembly list
 * and the merge concat order are NATURAL:
 *
 *   Introduction < Chapter_01 < Chapter_02 < … < Chapter_10
 *   Chapter_04   < Chapter_04_part1 < Chapter_04_part2 < … < Chapter_04_part10
 *
 * The old comparator only sorted by chapter NUMBER and let the same-chapter
 * tiebreak fall through to `readdir` order (lexical on most filesystems), so
 * `_part10` slotted between `_part1` and `_part2` — exactly the visible bug on
 * a 23-part Chapter 04. A BARE chapter file (no `_partN`) sorts before any of
 * its parts so the merge picks it up first when both exist.
 *
 * v1.4.73 — the "Introduction first" half of that order is no longer a name
 * this function knows; it is a position the segment itself declares.
 */
export function compareChapterFilenames(a: string, b: string): number {
  // v1.4.73 — placement is a POSITION now, not a special-cased name.
  //
  // This used to say "a filename containing the letters intro plays first",
  // which was the only notion the merge had of where anything sits. That rule
  // could only ever describe one thing. A segment now declares where it sits
  // relative to the chapter body (see lib/episode-segments.ts), so a sign-off
  // that belongs after the last chapter can be added later without another
  // special case here. Only the Introduction is registered today, at a
  // position before chapter one, so the running order is unchanged.
  const aPos = segmentPositionForFilename(a)
  const bPos = segmentPositionForFilename(b)
  if (aPos !== null && bPos !== null) {
    if (aPos !== bPos) return aPos - bPos
    return a.localeCompare(b, undefined, { numeric: true })
  }
  if (aPos !== null) return aPos < 0 ? -1 : 1
  if (bPos !== null) return bPos < 0 ? 1 : -1
  const aNum = a.match(/chapter[_\s]*(\d+)/i)
  const bNum = b.match(/chapter[_\s]*(\d+)/i)
  if (aNum && bNum) {
    const diff = parseInt(aNum[1], 10) - parseInt(bNum[1], 10)
    if (diff !== 0) return diff
    // Same chapter — order by part number. A bare file (no _partN) comes
    // before any of its parts; numeric comparison so part2 < part10.
    const aPart = a.match(/_part(\d+)/i)
    const bPart = b.match(/_part(\d+)/i)
    if (!aPart && bPart) return -1
    if (aPart && !bPart) return 1
    if (aPart && bPart) return parseInt(aPart[1], 10) - parseInt(bPart[1], 10)
    // Both bare for the same chapter (e.g. _v2 vs bare) — natural compare.
    return a.localeCompare(b, undefined, { numeric: true })
  }
  if (aNum && !bNum) return 1
  if (!aNum && bNum) return -1
  return a.localeCompare(b, undefined, { numeric: true })
}

/** `_vN` is an alternate saved by Audio; Audio Assembly only uses the active base source. */
export function isActiveChapterAudioFilename(filename: string): boolean {
  return !/_v\d+\.(?:mp3|wav|m4a)$/i.test(filename)
}

export function chapterKeyOf(filename: string, code: string): string {
  let base = filename.replace(/\.[^.]+$/, '')
  if (base.startsWith(`${code}_`)) base = base.slice(code.length + 1)
  // Strip the tempdir `_normalized` marker, then any trailing `_part{N}` /
  // `_v{N}` suffixes (in any order). Mirrors the per-chapter SRT grouping in
  // generators/subtitles.ts so the chapter slugs match on both sides.
  base = base.replace(/_normalized$/i, '')
  while (/(?:_part\d+|_v\d+)$/i.test(base)) base = base.replace(/(?:_part\d+|_v\d+)$/i, '')
  return base
}

/**
 * Finish the local half of an audio-quality repair after the selected candidate
 * has been assembled with the episode's original mix settings.  Candidate raw
 * ASR is copied only after every selected staged transcript parses; provider
 * work is intentionally absent from this successor.
 */
async function refreshAudioQualityTimeline(input: {
  job: Job
  projectSlug: string
  episodeId: string
  episodeDir: string
  audioDir: string
  mergedAudioDir: string
}): Promise<void> {
  const marker = (input.job.params as AudioMergeRequest).audio_quality_refresh
    || await pendingSelectedQualityRefresh(input)
  if (!marker) return
  const actionId = typeof marker.action_id === 'string' ? marker.action_id : ''
  const sourceFingerprint = typeof marker.source_fingerprint === 'string' ? marker.source_fingerprint : ''
  const sections = Array.isArray(marker.sections) ? [...new Set(marker.sections.filter(section => typeof section === 'string' && section.trim()))] : []
  if (!actionId || !sourceFingerprint || !sections.length) throw new Error('Audio-quality refresh has no valid action scope.')

  const saved = await readAudioQualityProvenance(input.episodeDir)
  const action = saved.actions?.[actionId]
  if (!action?.candidate || action.source_fingerprint !== sourceFingerprint
    || !action.verification_model_id || action.state === 'cancelled') {
    throw new Error('Audio-quality refresh no longer matches its verified candidate action.')
  }
  if (marker.promoted_files && sections.some(section =>
    JSON.stringify(marker.promoted_files?.[section] || []) !== JSON.stringify(action.candidate?.promoted_files?.[section] || []))) {
    throw new Error('Audio-quality refresh no longer matches the verified candidate file map.')
  }
  const candidateRoot = path.resolve(input.episodeDir, action.candidate.staging_dir, 'transcripts')
  const expectedRoot = path.resolve(input.episodeDir, '.audio-quality-candidates', actionId, 'transcripts')
  if (candidateRoot !== expectedRoot) throw new Error('Audio-quality candidate transcript path is invalid.')
  const { resolveSubtitlesDir } = await import('./subtitles.js')
  const subtitlesDir = await resolveSubtitlesDir(input.projectSlug, input.episodeId)
  await fs.mkdir(subtitlesDir, { recursive: true })
  const { findNarrationFile } = await import('./audio.js')
  const narration = await findNarrationFile(input.projectSlug, input.episodeId)
  const { inspectAudioQualityActionScope, currentChapterScriptHash } = await import('../services/audio-quality.js')
  const currentScope = await inspectAudioQualityActionScope({
    episodeDir: input.episodeDir, audioDir: input.audioDir, subtitlesDir,
    scriptDir: path.dirname(narration), episodeCode: input.episodeId,
  }, action.sections)
  if (action.script_fingerprint && currentScope.script_fingerprint !== action.script_fingerprint) {
    throw new Error('The script or active source changed after candidate promotion; the older repair was not refreshed.')
  }

  // Validate the entire selected set before touching a current SRT.  Each raw
  // transcript was already vetted before candidate selection; parsing again
  // proves the staged bytes survived the queued local merge unchanged.
  const ready: Array<{ slug: string; raw: string; target: string; sourceHash: string }> = []
  for (const slug of sections) {
    const transcriptFile = action.candidate.transcript_files?.[slug]
    const transcriptHash = action.candidate.transcript_hashes?.[slug]
    const sourceFiles = action.candidate.promoted_files?.[slug]
    const expectedAudioHash = action.candidate.candidate_audio_hashes?.[slug]
    if (!transcriptFile || !transcriptHash || !sourceFiles?.length || !expectedAudioHash) {
      throw new Error(`Audio-quality refresh is missing verified ${slug} evidence.`)
    }
    const rawPath = path.resolve(candidateRoot, transcriptFile)
    if (path.dirname(rawPath) !== candidateRoot) throw new Error('Audio-quality candidate transcript escaped its staging directory.')
    const raw = await fs.readFile(rawPath, 'utf8')
    const { hashInput } = await import('../services/task-manifest.js')
    if (hashInput(raw) !== transcriptHash) throw new Error(`Verified raw transcript for ${slug} changed before refresh.`)
    if (!parseSrt(raw).some(cue => cue.text.trim() && cue.end_sec > cue.start_sec)) {
      throw new Error(`Audio-quality candidate transcript for ${slug} is no longer usable.`)
    }
    const sourceHash = await hashSubtitleAudioSources(sourceFiles.map(file => path.join(input.audioDir, file)))
    if (!sourceHash || sourceHash !== expectedAudioHash) {
      throw new Error(`Selected candidate audio for ${slug} changed before subtitle refresh.`)
    }
    ready.push({ slug, raw, sourceHash, target: path.join(subtitlesDir, `${input.episodeId.toUpperCase()}_${slug}.srt`) })
  }

  // A later ordinary Regenerate may have legitimately changed the selected
  // source map while this local merge waited. Do not let the older repair
  // overwrite its subtitle evidence merely because retained candidate files
  // still exist on disk.
  const sidecar = JSON.parse(await fs.readFile(path.join(input.episodeDir, 'audio_chapters.json'), 'utf8')) as { sections?: Array<{ slug?: unknown; source_files?: unknown; source_file?: unknown }> }
  for (const section of ready) {
    const current = sidecar.sections?.find(row => typeof row.slug === 'string' && row.slug.toLowerCase() === section.slug.toLowerCase())
    const files = Array.isArray(current?.source_files) ? current.source_files.filter((file): file is string => typeof file === 'string')
      : typeof current?.source_file === 'string' ? [current.source_file] : []
    if (JSON.stringify(files) !== JSON.stringify(action.candidate.promoted_files?.[section.slug])) {
      throw new Error(`Active ${section.slug} changed after candidate promotion; the older repair was not refreshed.`)
    }
  }

  for (const section of ready) {
    const temporary = `${section.target}.${actionId}.tmp`
    await fs.writeFile(temporary, section.raw, 'utf8')
    await fs.rename(temporary, section.target)
    await recordSubtitleSourceEvidence(
      subtitlesDir,
      path.basename(section.target),
      section.sourceHash,
      action.verification_model_id,
    )
  }

  const stitch = await ensureStitchedSubtitle({
    episodeDir: input.episodeDir,
    subtitlesDir,
    mergedAudioDir: input.mergedAudioDir,
    audioDir: input.audioDir,
    episodeCode: input.episodeId,
  })
  if (!['stitched', 'fresh'].includes(stitch.status)) {
    throw new Error(`Audio-quality subtitles could not be stitched: ${stitch.reason}`)
  }
  await updateAudioQualityProvenance(input.episodeDir, async current => {
    const currentAction = current.actions?.[actionId]
    if (!currentAction || currentAction.source_fingerprint !== sourceFingerprint) {
      throw new Error('Audio-quality action changed while local refresh was finishing.')
    }
    // The selected candidate is now the active source. Record its actual
    // byte map and current script hash so future status reads can distinguish
    // this completed repair from a later ordinary Regenerate.
    for (const section of ready) {
      const scriptHash = await currentChapterScriptHash(path.dirname(narration), input.episodeId, section.slug)
      if (!scriptHash) throw new Error(`The current script for ${section.slug} could not be fingerprinted during refresh.`)
      current.chapters[section.slug] = {
        normalized_script_hash: scriptHash,
        normalization: 'tts-v1',
        source_audio_hash: section.sourceHash,
        source_files: [...(currentAction.candidate?.promoted_files?.[section.slug] || [])],
        recorded_at: new Date().toISOString(),
        tts: {
          model_id: currentAction.candidate?.model_id,
          voice_id: currentAction.candidate?.voice_id,
        },
      }
    }
    currentAction.state = 'fixed'
    delete currentAction.refresh_needed
  })
  input.job.result = {
    ...input.job.result,
    quality_repair: { action_id: actionId, state: 'fixed', refreshed_sections: ready.map(section => section.slug), stitch: stitch.status },
  }
  input.job.output_lines.push(`Audio-quality refresh completed: ${ready.length} chapter transcript(s) restitched from verified candidate audio.`)
}

/**
 * A candidate made before any saved Audio Assembly settings cannot enqueue a
 * private successor. When the user later runs the ordinary assembly control,
 * adopt exactly one still-selected candidate after proving its current map
 * and script fence. This is local-only; it never promotes or submits work.
 */
async function pendingSelectedQualityRefresh(input: {
  job: Job
  projectSlug: string
  episodeId: string
  episodeDir: string
  audioDir: string
  mergedAudioDir: string
}): Promise<NonNullable<AudioMergeRequest['audio_quality_refresh']> | null> {
  const saved = await readAudioQualityProvenance(input.episodeDir)
  const pending = Object.values(saved.actions || {}).filter(action =>
    action.state === 'candidate_ready' && !!action.refresh_needed && !!action.candidate?.promoted_files)
  if (pending.length !== 1) return null
  const action = pending[0]!
  let sidecar: { sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }> }
  try {
    sidecar = JSON.parse(await fs.readFile(path.join(input.episodeDir, 'audio_chapters.json'), 'utf8'))
  } catch {
    return null
  }
  for (const slug of action.sections) {
    const section = sidecar.sections?.find(row => typeof row.slug === 'string' && row.slug.toLowerCase() === slug.toLowerCase())
    const current = Array.isArray(section?.source_files) ? section.source_files.filter((file): file is string => typeof file === 'string')
      : typeof section?.source_file === 'string' ? [section.source_file] : []
    if (JSON.stringify(current) !== JSON.stringify(action.candidate?.promoted_files?.[slug])) return null
  }
  if (action.script_fingerprint) {
    try {
      const { findNarrationFile } = await import('./audio.js')
      const narration = await findNarrationFile(input.projectSlug, input.episodeId)
      const { inspectAudioQualityActionScope } = await import('../services/audio-quality.js')
      const { resolveSubtitlesDir } = await import('./subtitles.js')
      const subtitlesDir = await resolveSubtitlesDir(input.projectSlug, input.episodeId)
      const scope = await inspectAudioQualityActionScope({
        episodeDir: input.episodeDir, audioDir: input.audioDir,
        subtitlesDir,
        scriptDir: path.dirname(narration), episodeCode: input.episodeId,
      }, action.sections)
      if (scope.script_fingerprint !== action.script_fingerprint) return null
    } catch {
      return null
    }
  }
  return {
    action_id: action.action_id,
    source_fingerprint: action.source_fingerprint,
    sections: action.sections,
    promoted_files: action.candidate!.promoted_files,
  }
}

// ── Main Generator ────────────────────────────────────────────────────────

export async function generateAudioMerge(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as AudioMergeRequest
  const code = episode_id.toUpperCase()

  // Submission routes preflight this too, but Pipeline jobs can enqueue
  // internally and files may change while a job waits. Re-prove the complete
  // base set immediately before FFmpeg starts. This is read-only; the selected
  // sidecar map below remains the source authority for a promoted `_vN` file.
  const readiness = await requireChapterAudioReady(project_slug, code)

  // `audio_chapters.json` records the active audio map. Generic disk scans
  // deliberately ignore `_vN` alternates, so a complete selected map wins.
  // Normal maps are also retained; only a verified old base-plus-part map is
  // repaired from durable normal-generation provenance below.
  let selectedSources: string[] = []
  const refresh = req.audio_quality_refresh
  const refreshActionId = typeof refresh?.action_id === 'string' ? refresh.action_id : ''
  const sameFiles = (left: string[] | undefined, right: string[]) =>
    !!left && left.length === right.length && left.every((file, index) => file === right[index])
  const resolveSidecarSelection = async (requiredRefresh: boolean): Promise<string[]> => {
    let paths: Awaited<ReturnType<typeof resolveEpisodePathsByCodeWithSidecar>>
    let sidecar: { sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }> }
    try {
      paths = await resolveEpisodePathsByCodeWithSidecar(project_slug, code, 'audio_chapters.json')
      sidecar = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'))
    } catch (error: any) {
      if (requiredRefresh) {
        throw new Error(`Audio-quality refresh cannot read its authoritative selected audio map: ${error?.message || String(error)}`)
      }
      return [] // Normal first assembly keeps the established disk scan fallback.
    }

    const sections = Array.isArray(sidecar.sections) ? sidecar.sections : []
    if (!sections.length) {
      if (requiredRefresh) throw new Error('Audio-quality refresh cannot use an empty audio_chapters.json source map.')
      return []
    }
    const sourcesBySlug = new Map<string, string[]>()
    const sourceEntries: Array<{ key: string; files: string[] }> = []
    const ordered: string[] = []
    for (const section of sections) {
      const slug = typeof section.slug === 'string' ? section.slug.trim() : ''
      const listed = Array.isArray(section.source_files)
        ? section.source_files.filter((file): file is string => typeof file === 'string' && path.basename(file) === file)
        : []
      const single = typeof section.source_file === 'string' && path.basename(section.source_file) === section.source_file
        ? [section.source_file] : []
      const files = listed.length ? listed : single
      if (!slug || !files.length) {
        const message = `audio_chapters.json has no valid selected source for ${slug || 'a chapter'}`
        if (requiredRefresh) throw new Error(`Audio-quality refresh cannot resolve its authoritative selected audio map: ${message}`)
        return []
      }
      const key = slug.toLowerCase()
      if (sourcesBySlug.has(key)) {
        const message = `audio_chapters.json repeats selected chapter ${slug}`
        if (requiredRefresh) throw new Error(`Audio-quality refresh cannot resolve its authoritative selected audio map: ${message}`)
        return []
      }
      sourcesBySlug.set(key, files)
      sourceEntries.push({ key, files })
      ordered.push(...files)
    }

    const expectedSections = new Set(readiness.expected_files
      .map(filename => chapterKeyOf(filename, code).toLowerCase()))
    const missingSections = [...expectedSections].filter(slug => !sourcesBySlug.has(slug))
    const containsAlternate = ordered.some(file => /_v\d+\.(?:mp3|wav|m4a)$/i.test(file))
    if (missingSections.length) {
      const message = `audio_chapters.json is missing selected source(s) for ${missingSections.join(', ')}`
      if (requiredRefresh || containsAlternate) {
        throw new Error(`Audio Assembly cannot use its authoritative selected audio map: ${message}`)
      }
      return []
    }

    if (requiredRefresh) {
      const action = refreshActionId
        ? (await readAudioQualityProvenance(paths.episode_dir)).actions?.[refreshActionId]
        : null
      if (!action?.candidate?.promoted_files || !Array.isArray(refresh?.sections)) {
        throw new Error('Audio-quality refresh cannot resolve its authoritative selected audio map: the server-stamped repair action or promoted file map is unavailable.')
      }
      for (const slug of refresh.sections) {
        const expected = refresh.promoted_files?.[slug] || action.candidate.promoted_files[slug]
        const selected = sourcesBySlug.get(slug.toLowerCase())
        if (!expected?.length || !sameFiles(selected, expected)) {
          throw new Error(`Audio-quality refresh cannot resolve its authoritative selected audio map: the selected source map no longer contains the promoted ${slug} files.`)
        }
      }
    }

    let activeFiles = ordered
    if (!requiredRefresh && !containsAlternate) {
      const provenance = await readAudioQualityProvenance(paths.episode_dir)
      const provenanceBySlug = new Map(Object.entries(provenance.chapters)
        .map(([slug, chapter]) => [slug.toLowerCase(), chapter] as const))
      const hasBaseAndParts = (files: string[]) => {
        const bases = new Set(files
          .filter(file => !/_part\d+\.[^.]+$/i.test(file))
          .map(file => chapterKeyOf(file, code).toLowerCase()))
        return files.some(file => /_part\d+\.[^.]+$/i.test(file)
          && bases.has(chapterKeyOf(file, code).toLowerCase()))
      }
      const repaired = await Promise.all(sourceEntries.map(async entry => {
        const saved = provenanceBySlug.get(entry.key)
        if (!hasBaseAndParts(entry.files) || !saved?.source_files?.length || sameFiles(entry.files, saved.source_files)) return entry.files
        const savedPaths = saved.source_files.map(file => path.join(paths.audio_dir, file))
        const hash = await hashSubtitleAudioSources(savedPaths)
        return hash && hash === saved.source_audio_hash ? saved.source_files : entry.files
      }))
      activeFiles = repaired.flat()
    }

    const candidate = activeFiles.map(file => path.join(paths.audio_dir, file))
    const missing = candidate.filter(file => !existsSync(file))
    if (missing.length) {
      const message = `selected audio file(s) are missing: ${missing.map(file => path.basename(file)).join(', ')}`
      if (requiredRefresh || containsAlternate) {
        throw new Error(`Audio Assembly cannot use its authoritative selected audio map: ${message}`)
      }
      return []
    }
    return candidate
  }

  selectedSources = await resolveSidecarSelection(!!refresh)
  const scanned = selectedSources.length ? null : await scanEpisodeAudioAssets(project_slug, code)
  if (!selectedSources.length && !scanned?.chapters.length) {
    throw new Error(`Audio Assembly is blocked: no chapter audio files were found for ${code}.`)
  }
  req.chapters = selectedSources.length ? selectedSources : scanned!.chapters.map(chapter => chapter.path)
  job.output_lines.push(
    `Audio preflight passed: ${readiness.present_files.length}/${readiness.expected_files.length} required file(s) ready`,
  )
  job.output_lines.push(`Resolved ${req.chapters.length} ordered chapter file(s) ${selectedSources.length ? 'from the verified active mapping' : 'from disk'}`)

  // 1. Validate chapter files exist
  const validChapters: string[] = []
  for (const ch of req.chapters) {
    if (existsSync(ch)) {
      validChapters.push(ch)
    } else {
      job.output_lines.push(`Warning: chapter file not found: ${path.basename(ch)}`)
    }
  }

  if (validChapters.length === 0) {
    throw new Error('No valid chapter audio files found')
  }
  job.output_lines.push(`Chapters: ${validChapters.length} valid files`)

  // 2. Resolve output directory
  const outputRoot = await pm.getProjectOutputRoot(project_slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Expand portable asset paths (`${PROJECT}`, `${MY_FOLDER}`, …) to absolute
  // paths for this machine. Legacy absolutes pass through untouched.
  const tryResolve = (p: string | undefined, label: string): string | undefined => {
    if (!p || !isPortablePath(p)) return p
    try { return resolveAssetPath(p, outputRoot) } catch (e: any) {
      job.output_lines.push(`⚠ ${label}: ${e.message}`)
      return undefined
    }
  }
  if (req.intro?.file) req.intro.file = tryResolve(req.intro.file, 'intro.file') || ''
  if (Array.isArray(req.chapters)) {
    req.chapters = req.chapters
      .map((c, i) => tryResolve(c, `chapters[${i}]`) || '')
      .filter(Boolean)
  }
  if (req.music?.files?.length) {
    req.music.files = req.music.files
      .map((f, i) => tryResolve(f, `music.files[${i}]`) || '')
      .filter(Boolean)
  }
  if (req.background_noise?.custom_file) {
    req.background_noise.custom_file = tryResolve(req.background_noise.custom_file, 'background_noise.custom_file') || ''
  }
  if (Array.isArray(req.ambient_tracks)) {
    req.ambient_tracks = req.ambient_tracks
      .map((t, i) => t && t.source_path
        ? { ...t, source_path: tryResolve(t.source_path, `ambient_tracks[${i}].source_path`) || '' }
        : t)
      .filter(t => !!t && !!t.source_path)
  }

  const episodeDir = await findEpisodeDir(outputRoot, code)
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)

  const mergedAudioName = await resolveMergedAudioName(project_slug, code)
  // Level B (opt-in): merged audio is heavy media — route to the external
  // media root when configured, else the iCloud episodeDir as before.
  const mergedBase = (await mediaEpisodeBaseForCode(project_slug, code)) ?? episodeDir
  const mergedDir = await resolveSubfolder(mergedBase, mergedAudioName)
    || path.join(mergedBase, mergedAudioName)
  await fs.mkdir(mergedDir, { recursive: true })

  // Create temp directory under os.tmpdir() so iCloud doesn't watch the
  // intermediate normalised chapters / concat list / drawtext renders
  // while ffmpeg is mid-merge. Final merged file is renamed back into
  // mergedDir on success.
  const tempDir = await getWorkTempDir(project_slug, code)

  try {
    // 3. Normalize volume (optional)
    let chapterFiles = validChapters
    if (req.normalize_volume) {
      job.output_lines.push('Normalizing volume (two-pass loudnorm)...')
      const normalizedFiles: string[] = []

      for (let i = 0; i < chapterFiles.length; i++) {
        const chapterPath = chapterFiles[i]
        const basename = path.basename(chapterPath, '.mp3')
        const normalizedPath = path.join(tempDir, `${basename}_normalized.mp3`)

        job.output_lines.push(`  Pass 1: measuring ${path.basename(chapterPath)}`)
        const measurements = await measureLoudnorm(chapterPath)

        job.output_lines.push(`  Pass 2: applying normalization (I=${measurements.input_i}dB)`)
        await applyLoudnorm(chapterPath, normalizedPath, measurements)

        normalizedFiles.push(normalizedPath)
        job.progress = Math.round(((i + 1) / chapterFiles.length) * 30)
      }

      chapterFiles = normalizedFiles
      job.output_lines.push(`Normalized ${normalizedFiles.length} chapters`)
    }

    // 4. Concatenate chapters with silence gaps
    job.output_lines.push(`Concatenating chapters with ${req.gap_duration}s gaps...`)

    let silenceFile: string | undefined
    if (req.gap_duration > 0) {
      silenceFile = path.join(tempDir, 'silence.mp3')
      await runFfmpeg([
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', req.gap_duration.toString(),
        '-c:a', 'libmp3lame', '-b:a', '128k',
        silenceFile,
      ], { timeoutMs: audioMergeTimeoutMs() })
    }

    // v1.0.317 — per-chunk pause: a short silence inserted between PARTS of
    // the same chapter (the _part1/_part2/... files a long chapter gets split
    // into). Default 0 = back-to-back (legacy). 0.3-1.0s gives cloud TTS
    // chunks a natural breath at the chunk boundary so the narration doesn't
    // feel rushed where the chunker split a sentence.
    const chunkSilenceSec = Math.max(0, Number(req.chunk_silence_sec) || 0)
    let chunkSilenceFile: string | undefined
    if (chunkSilenceSec > 0) {
      chunkSilenceFile = path.join(tempDir, 'chunk_silence.mp3')
      await runFfmpeg([
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', chunkSilenceSec.toString(),
        '-c:a', 'libmp3lame', '-b:a', '128k',
        chunkSilenceFile,
      ], { timeoutMs: audioMergeTimeoutMs() })
      job.output_lines.push(`Per-chunk pause: ${chunkSilenceSec}s between parts of the same chapter.`)
    }

    // Build concat list file
    const concatListPath = path.join(tempDir, 'concat_list.txt')
    const concatLines: string[] = []

    // Optional intro: prepend to the front with a configurable gap after it.
    //
    // v1.3.2 — what gets prepended here is written into the completion record
    // (`schema_version: 2`). Until then the merge knew this and threw it away,
    // so the only way to find out whether an episode's merged track already
    // carried the intro was to play it and listen — which the owner asked not
    // to have to do, and certainly not after rendering the video.
    let introRecord: MergedAudioIntroRecord | null = null
    const introEnabled = req.intro?.enabled && !!req.intro?.file
    if (introEnabled && req.intro) {
      const introPath = unescapeShellPath(req.intro.file)!
      const avail = checkAssetAvailability(introPath, 'intro.file')
      if (avail.status !== 'available') {
        // Throw rather than skip — the user explicitly enabled an intro,
        // and losing it silently would surprise them. The message already
        // tells them to trigger the iCloud download when that's the cause.
        throw new Error(avail.message || `Intro audio file not found: ${introPath}`)
      }
      const introVol = Math.max(0, Math.min(1, req.intro.volume ?? 1))
      // Re-encode the intro at the target volume so we can safely concat it
      const introStaged = path.join(tempDir, 'intro_staged.mp3')
      await runFfmpeg([
        '-y', '-i', introPath,
        '-af', `aresample=44100,volume=${introVol.toFixed(2)}`,
        '-c:a', 'libmp3lame', '-b:a', '192k',
        introStaged,
      ], { timeoutMs: audioMergeTimeoutMs() })
      concatLines.push(escPath(introStaged))

      const introGap = Math.max(0, req.intro.gap_after ?? 2)
      if (introGap > 0) {
        const introGapFile = path.join(tempDir, 'intro_gap.mp3')
        await runFfmpeg([
          '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
          '-t', introGap.toString(),
          '-c:a', 'libmp3lame', '-b:a', '128k',
          introGapFile,
        ], { timeoutMs: audioMergeTimeoutMs() })
        concatLines.push(escPath(introGapFile))
      }
      // Probe the source, not the staged copy: same duration, and the source
      // is what the customer chose. A failed probe records null rather than 0
      // — an unknown length must not read as a zero-length intro.
      const introDur = Number(await getAudioDuration(introPath).catch(() => undefined))
      introRecord = {
        filename: path.basename(introPath),
        duration_sec: Number.isFinite(introDur) && introDur > 0 ? Math.round(introDur * 1000) / 1000 : null,
        gap_after_sec: introGap,
      }
      job.output_lines.push(`Intro prepended (${path.basename(introPath)}, volume ${Math.round(introVol * 100)}%, ${introGap}s gap)`)
    }

    for (let i = 0; i < chapterFiles.length; i++) {
      concatLines.push(escPath(chapterFiles[i]))
      // v1.0.224 — insert the silence gap only between DIFFERENT chapters,
      // never between the parts of one chapter (a long chapter is split into
      // _part1/_part2/… files). `validChapters` is parallel-indexed to
      // `chapterFiles` (the normalized copies preserve order), so derive the
      // chapter key from the original filename.
      // v1.0.317 — also handle the SAME-chapter case: insert the per-chunk
      // pause (chunkSilenceFile) so cloud TTS chunks don't run rushed into
      // each other at the chunker boundary. When chunk_silence_sec is 0
      // (default), chunkSilenceFile is undefined and behaviour is byte-for-
      // byte identical to v1.0.224.
      if (i < chapterFiles.length - 1) {
        const curKey = chapterKeyOf(path.basename(validChapters[i]), code)
        const nextKey = chapterKeyOf(path.basename(validChapters[i + 1]), code)
        if (curKey !== nextKey) {
          if (silenceFile) concatLines.push(escPath(silenceFile))
        } else {
          if (chunkSilenceFile) concatLines.push(escPath(chunkSilenceFile))
        }
      }
    }

    await fs.writeFile(concatListPath, concatLines.join('\n') + '\n')

    const narrationOnlyPath = path.join(tempDir, 'narration_only.mp3')
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatListPath,
      '-af', 'aresample=44100',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      narrationOnlyPath,
    ], { timeoutMs: audioMergeTimeoutMs() })

    const narrationDuration = await getAudioDuration(narrationOnlyPath)
    if (!narrationDuration) {
      throw new Error('Could not determine narration duration after concatenation')
    }
    job.output_lines.push(`Narration duration: ${narrationDuration.toFixed(1)}s`)
    job.progress = 50

    // Emit per-chapter duration sidecar. Workstream B's "align scenes
    // to chapter audio" path reads this so video assembly can play
    // chapter N's scene images during chapter N's narration. Best-
    // effort — a write failure here must never fail the merge job.
    // Probe the PRE-normalisation paths so the slugs match what
    // parseNarrationDocx produced ("Chapter_01" etc.) rather than the
    // tempdir `_normalized.mp3` filenames.
    type ChapterEntry = { slug: string; duration_s: number; source_file: string; source_files?: string[] }
    const chaptersForSidecar: ChapterEntry[] = []
    try {
      // v1.0.224 — GROUP parts by chapter. A long chapter split into
      // {code}_{slug}_part1.mp3 / _part2.mp3 becomes ONE section whose
      // duration is the SUM of its parts. This is what makes the stitcher's
      // per-section offsets line up with the per-chapter SRTs (the Subtitles
      // step writes one {code}_{slug}.srt per chapter, parts concatenated).
      const groups = new Map<string, ChapterEntry>()
      const order: string[] = []
      for (const p of validChapters) {
        const d = await getAudioDuration(p).catch(() => null)
        if (d == null) continue
        const filename = path.basename(p)
        const slug = chapterKeyOf(filename, code)
        let g = groups.get(slug)
        if (!g) {
          g = { slug, duration_s: 0, source_file: filename, source_files: [] }
          groups.set(slug, g)
          order.push(slug)
        }
        g.duration_s += d
        g.source_files!.push(filename)
      }
      // v1.0.317 — fold the inter-part silences into each chapter's duration
      // so the sidecar matches the chapter's REAL extent inside the merged
      // file (otherwise per-chapter SRT offsets drift behind by N*chunk_silence
      // for every N-part chapter). For a 23-part Chapter 04 with 0.5s pauses,
      // that's 11s of silence baked between parts — substantial.
      if (chunkSilenceSec > 0) {
        for (const g of groups.values()) {
          const partCount = g.source_files?.length ?? 1
          if (partCount > 1) g.duration_s += (partCount - 1) * chunkSilenceSec
        }
      }
      for (const slug of order) chaptersForSidecar.push(groups.get(slug)!)
      const sidecarPath = path.join(episodeDir, 'audio_chapters.json')
      // v1.0.140+ — Persist the gap_duration the merge actually used.
      // Subtitle stitching and video assembly read this to align their
      // timeline offsets with the actual merge spacing.
      await fs.writeFile(sidecarPath, JSON.stringify({
        sections: chaptersForSidecar,
        gap_duration_s: req.gap_duration,
        // v1.0.317 — persist the per-chunk pause so anything reading the
        // sidecar (subtitle derivation, video assembly) knows the chapter
        // durations already include inter-part silences. 0 / absent = legacy.
        chunk_silence_sec: chunkSilenceSec,
      }, null, 2))
      job.output_lines.push(
        `Wrote chapter-duration sidecar (audio_chapters.json): ${chaptersForSidecar.length} section(s), gap=${req.gap_duration}s` +
        (chunkSilenceSec > 0 ? `, chunk-pause=${chunkSilenceSec}s` : ''),
      )
    } catch (e: any) {
      job.output_lines.push(`Note: chapter-duration sidecar skipped (${e?.message || 'write error'})`)
    }

    // v1.0.81+: per-sentence timing sidecar (audio_sentences.json).
    // Drives sentence-aligned video assembly for formats that opt in
    // (e.g. reasons-explainer). Char-length-weighted apportionment from
    // the chapter durations we just measured — no provider-specific
    // dependency, so this works for ElevenLabs / fal / GenAIPro alike.
    // Best-effort: if narration parse fails or no chapters matched,
    // we skip silently. The video-assembly path falls back to chapter-
    // level pacing when this sidecar is absent.
    if (chaptersForSidecar.length > 0) {
      try {
        const { findNarrationFile } = await import('./audio.js')
        const { parseNarrationDocx } = await import('../lib/docx-parser.js')
        const { buildSentenceSidecar } = await import('../lib/sentence-timing.js')
        const narrationPath = await findNarrationFile(project_slug, episode_id)
        const sections = await parseNarrationDocx(narrationPath)
        const { sections: timedSections, unmatched_section_slugs } = buildSentenceSidecar(
          chaptersForSidecar.map(c => ({ slug: c.slug, duration_s: c.duration_s })),
          sections.map(s => ({ slug: s.slug, text: s.text })),
        )
        if (timedSections.length > 0) {
          const sentencesPath = path.join(episodeDir, 'audio_sentences.json')
          await fs.writeFile(
            sentencesPath,
            JSON.stringify({ schemaVersion: 1, sections: timedSections }, null, 2),
          )
          const totalSentences = timedSections.reduce((s, sec) => s + sec.sentences.length, 0)
          job.output_lines.push(
            `Wrote sentence-timing sidecar (audio_sentences.json): ` +
            `${timedSections.length} section(s), ${totalSentences} sentence(s)` +
            (unmatched_section_slugs.length ? `, ${unmatched_section_slugs.length} unmatched` : ''),
          )
        }
      } catch (e: any) {
        job.output_lines.push(`Note: sentence-timing sidecar skipped (${e?.message || 'write error'})`)
      }
    }

    // 5. Mix with music and/or noise
    const musicEnabled = req.music?.enabled && req.music.files.length > 0
    const noiseEnabled = req.background_noise?.enabled

    const writeMode = req.write_mode === 'new' ? 'new' : 'overwrite'
    const outputFilename = await resolveMergedOutputName(mergedDir, code, writeMode)
    const outputPath = path.join(mergedDir, outputFilename)

    // Track whether the mix completed so the finally block knows whether
    // the partial `outputPath` on disk is truncated garbage or a real
    // output. Before this flag, a watchdog-killed or cancelled run left a
    // half-written MP3 at the user-visible output path with no indication
    // it was broken — the same class of "silent partial artifact" bug as
    // video.ts's outputFile.
    let mixSucceeded = false
    try {
      const ambientEnabled = Array.isArray(req.ambient_tracks)
        && req.ambient_tracks.some(t => t?.enabled && t?.source_path)
      if (musicEnabled || noiseEnabled || ambientEnabled) {
        job.output_lines.push('Mixing audio layers...')
        await mixAudioLayers({
          narrationPath: narrationOnlyPath,
          narrationDuration,
          narrationVolume: req.narration_volume ?? 1.0,
          music: musicEnabled ? req.music! : undefined,
          noise: noiseEnabled ? req.background_noise! : undefined,
          ambientTracks: ambientEnabled ? req.ambient_tracks : undefined,
          outputPath,
          tempDir,
          job,
        })
      } else {
        // No music/noise/ambient. The mix path applies narration_volume via its
        // volume= filter, but this branch used to plain-copy the concatenated
        // narration — which was assembled WITHOUT any gain — so the voice-volume
        // control silently did nothing on voice-only merges (v1.0.385 fix).
        const narrVol = req.narration_volume ?? 1.0
        if (Math.abs(narrVol - 1.0) > 0.001) {
          job.output_lines.push(`No music/noise/ambient — applying voice volume ${Math.round(narrVol * 100)}%...`)
          await runFfmpeg([
            '-y', '-i', narrationOnlyPath,
            '-af', `volume=${narrVol.toFixed(2)}`,
            '-c:a', 'libmp3lame', '-b:a', '192k',
            outputPath,
          ], { timeoutMs: audioMergeTimeoutMs() })
        } else {
          job.output_lines.push('No music, noise, or ambient configured, copying narration...')
          await fs.copyFile(narrationOnlyPath, outputPath)
        }
      }
      mixSucceeded = true
    } finally {
      if (!mixSucceeded) {
        try {
          await fs.rm(outputPath, { force: true })
          job.output_lines.push(`Removed partial output: ${path.basename(outputPath)}`)
        } catch { /* ignore */ }
      }
    }

    job.progress = 95

    // 6. Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true })

    // 7. Log output
    const finalDuration = Number(await getAudioDuration(outputPath)) || 0
    const finalBytes = (await fs.stat(outputPath)).size
    job.output_lines.push(`Output: ${outputPath}`)
    job.output_lines.push(`Duration: ${finalDuration ? finalDuration.toFixed(1) + 's' : 'unknown'}`)
    job.output_dir = path.dirname(outputPath)

    // v1.3.2 — record what precedes the narration in this file, so nobody has
    // to play it to find out whether the intro is already in there.
    const musicLeadInSec = musicEnabled
      && req.music?.lead_in_enabled
      && Number(req.music?.lead_in_seconds) > 0
      ? Math.max(0, Number(req.music!.lead_in_seconds))
      : 0
    const opening = buildMergedAudioOpeningRecord({
      finalDurationSec: finalDuration,
      sections: chaptersForSidecar,
      gapSec: req.gap_duration,
      intro: introRecord,
      musicLeadInSec,
    })
    const leadInSec = opening.lead_in_sec
    job.output_lines.push(
      introRecord
        ? `Opening recorded: intro ${introRecord.filename}` +
          (introRecord.duration_sec !== null ? ` (${introRecord.duration_sec.toFixed(2)}s)` : '') +
          ` + ${introRecord.gap_after_sec}s gap` +
          (musicLeadInSec > 0 ? ` + ${musicLeadInSec}s music lead-in` : '') +
          ` — narration starts at ${leadInSec.toFixed(2)}s`
        : musicLeadInSec > 0
          ? `Opening recorded: no intro file, ${musicLeadInSec}s music lead-in — narration starts at ${leadInSec.toFixed(2)}s`
          : 'Opening recorded: no intro — narration only.',
    )
    await fs.writeFile(
      path.join(path.dirname(outputPath), `${code}_merged_audio.completion.json`),
      JSON.stringify({
        // v2 adds `opening`. Every v1 field keeps its meaning, so
        // `asset-status`'s verification (filename + bytes + duration) is
        // unchanged and no existing record is invalidated by the bump.
        schema_version: 2,
        output_filename: path.basename(outputPath),
        bytes: finalBytes,
        duration_sec: finalDuration,
        generated_at: new Date().toISOString(),
        opening,
      }, null, 2),
      'utf-8',
    )
    requireJobCompletion(job, {
      label: 'Audio assembly',
      expected: 1,
      completed: finalBytes > 0 && finalDuration > 0 ? 1 : 0,
      missing: finalBytes > 0 && finalDuration > 0 ? [] : [path.basename(outputPath)],
      invalid: finalBytes <= 0 ? ['output file is empty'] : finalDuration <= 0 ? ['output duration could not be verified'] : [],
      retry_hint: 'The invalid output will not count as complete. Retry after checking the source chapter audio.',
    })

    // A quality candidate is not "fixed" merely because the new chapter
    // bytes were selected.  The original mix must finish first, then its raw
    // candidate transcript can replace only the selected SRTs and rebuild the
    // timeline that downstream scene/video work reads.
    await refreshAudioQualityTimeline({
      job, projectSlug: project_slug, episodeId: code, episodeDir,
      audioDir: path.dirname(validChapters[0]!), mergedAudioDir: mergedDir,
    })

    // v1.0.107+ — when the request was pre-filled from the music-pool
    // cycler, record the actual use so the cursor advances + usage log
    // updates. The frontend tags `music_pool_track` on the request
    // when it accepted the cycler's pick; this fires once per success-
    // ful merge to keep the pool state honest. Non-fatal: a failure to
    // record doesn't undo the merge.
    const poolTrack = (req as any).music_pool_track
    if (typeof poolTrack === 'string' && poolTrack) {
      try {
        const { recordPick } = await import('../services/music-pool.js')
        await recordPick(project_slug, code, poolTrack)
        job.output_lines.push(`Music pool: recorded "${poolTrack}" as used for ${code}`)
      } catch (e: any) {
        job.output_lines.push(`⚠ Music pool record-pick failed: ${e.message}`)
      }
    }

    job.progress = 100

  } catch (err) {
    // Cleanup temp on error too
    try { await fs.rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  }
}

// ── Audio Layer Mixing ────────────────────────────────────────────────────

interface MixOptions {
  narrationPath: string
  narrationDuration: number
  narrationVolume: number
  music?: VideoMusicConfig
  noise?: VideoBackgroundNoise
  /** Parallel ambient layers — each plays simultaneously. Distinct
   *  from `music.files` which concatenates files into one long track. */
  ambientTracks?: AmbientTrack[]
  outputPath: string
  tempDir: string
  job: Job
}

/**
 * Build the per-frame `volume` expression for the music intro lead-in
 * (v1.0.397). Phases, by output time t:
 *   [0, leadIn)              → 1.0     full-volume intro
 *   [leadIn, leadIn+fade)    → linear ramp 1.0 → duckVol (smooth duck as the
 *                              narration begins)
 *   [leadIn+fade, leadIn+narrDur) → duckVol (music under narration)
 *   ≥ leadIn+narrDur         → postVol (after narration; usually trimmed off)
 * Pure + exported for unit coverage — the math is fiddly and FFmpeg can't run
 * in tests. `duckFade` is clamped by the caller (>0). Values are absolute
 * gains, fed to `volume='…':eval=frame`.
 */
export function buildMusicLeadInVolumeExpr(
  leadIn: number, duckFade: number, narrDur: number, duckVol: number, postVol: number,
): string {
  const L = leadIn.toFixed(3)
  const Lf = (leadIn + duckFade).toFixed(3)
  const narrEnd = (leadIn + narrDur).toFixed(3)
  const mv = duckVol.toFixed(3)
  const pv = postVol.toFixed(3)
  const df = duckFade.toFixed(3)
  return `if(lt(t,${L}),1.0,`
    + `if(lt(t,${Lf}),1.0+(${mv}-1.0)*(t-${L})/${df},`
    + `if(lt(t,${narrEnd}),${mv},${pv})))`
}

async function mixAudioLayers(opts: MixOptions): Promise<void> {
  const {
    narrationPath, narrationDuration, narrationVolume,
    music, noise, ambientTracks, outputPath, tempDir, job,
  } = opts

  // v1.0.397 — optional music "intro lead-in": the background music plays at
  // full volume for the first N seconds, then the narration begins (delayed by
  // N) as the music ducks. Only when music is present + the toggle is on.
  const leadIn = (music?.lead_in_enabled && (music.lead_in_seconds ?? 0) > 0)
    ? Math.max(0, music.lead_in_seconds as number)
    : 0
  const totalDur = narrationDuration + leadIn
  const inputs: string[] = []
  const filterParts: string[] = []
  const mixInputLabels: string[] = []

  // Input 0: narration
  inputs.push('-i', narrationPath)

  const narrVol = narrationVolume.toFixed(2)
  // Delay the voice by the lead-in so the music intro is heard first.
  const narrDelay = leadIn > 0
    ? `,adelay=${Math.round(leadIn * 1000)}|${Math.round(leadIn * 1000)}`
    : ''
  filterParts.push(
    `[0:a]aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${narrVol}${narrDelay}[narr]`,
  )
  mixInputLabels.push('[narr]')

  let inputIdx = 1

  // Input 1 (optional): background music
  if (music) {
    let musicInputPath: string

    const cleanedFiles = music.files.map(f => unescapeShellPath(f)!).filter(Boolean)

    if (cleanedFiles.length > 1) {
      // Concatenate multiple music files first
      job.output_lines.push(`  Concatenating ${cleanedFiles.length} music files...`)
      const musicListPath = path.join(tempDir, 'music_list.txt')
      const musicLines = cleanedFiles.map(f => escPath(f))
      await fs.writeFile(musicListPath, musicLines.join('\n') + '\n')

      const musicConcatPath = path.join(tempDir, 'music_concat.mp3')
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', musicListPath,
        '-af', 'aresample=44100',
        '-c:a', 'libmp3lame', '-b:a', '192k',
        musicConcatPath,
      ], { timeoutMs: audioMergeTimeoutMs() })
      musicInputPath = musicConcatPath
    } else {
      musicInputPath = cleanedFiles[0]!
    }

    // Loop music to fill duration
    inputs.push('-stream_loop', '-1', '-i', musicInputPath)

    const musicVol = music.volume.toFixed(2)
    const postNarrVol = music.post_narration_volume
    const boostRatio = musicVol !== '0.00'
      ? (postNarrVol / music.volume).toFixed(2)
      : '1.00'

    if (leadIn > 0) {
      // Lead-in "intro" (v1.0.397): one piecewise volume envelope plays the
      // track at full volume for `leadIn` seconds, then ducks (over a short
      // fade) to the during-narration volume exactly as the delayed narration
      // starts. Replaces the base-volume + post-boost chain used below. `:eval=
      // frame` makes the volume expression time-varying. Quoting protects the
      // commas in the expression from the filtergraph parser (same as the
      // existing `enable='gt(t,…)'` boost).
      const duckFade = Math.max(0.05, Math.min(0.6, leadIn / 2))
      const env = buildMusicLeadInVolumeExpr(
        leadIn, duckFade, narrationDuration, music.volume, music.post_narration_volume,
      )
      filterParts.push(
        `[${inputIdx}:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,` +
        `volume='${env}':eval=frame[bgm2]`,
      )
      job.output_lines.push(
        `  Music intro: first ${leadIn}s at full volume, then ducks to ${Math.round(music.volume * 100)}% as narration starts`,
      )
    } else {
      filterParts.push(
        `[${inputIdx}:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,` +
        `volume=${musicVol}[bgm]`,
      )

      // Boost music volume after narration ends
      filterParts.push(
        `[bgm]volume=enable='gt(t,${narrationDuration.toFixed(2)})':volume=${boostRatio}[bgm2]`,
      )
    }

    // Apply fade in/out
    let musicLabel = 'bgm2'
    if (music.fade_in > 0 || music.fade_out > 0) {
      const fadeFilters: string[] = []
      if (music.fade_in > 0) {
        fadeFilters.push(`afade=t=in:st=0:d=${music.fade_in}`)
      }
      if (music.fade_out > 0) {
        const fadeOutStart = Math.max(0, totalDur - music.fade_out)
        fadeFilters.push(`afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${music.fade_out}`)
      }
      filterParts.push(`[bgm2]${fadeFilters.join(',')}[bgm3]`)
      musicLabel = 'bgm3'
    }

    mixInputLabels.push(`[${musicLabel}]`)
    inputIdx++
  }

  // Input 2 (optional): ambient noise
  if (noise) {
    if (noise.mode === 'custom' && noise.custom_file) {
      // Custom noise file — loop to fill duration. Strip any bash-style
      // backslash escapes first (users often drag-paste from Terminal).
      const noisePath = unescapeShellPath(noise.custom_file)!
      inputs.push('-stream_loop', '-1', '-i', noisePath)
    } else {
      // Preset noise via lavfi
      const noiseColor = noise.preset.replace('-noise', '')
      inputs.push('-f', 'lavfi', '-i', `anoisesrc=color=${noiseColor}:r=44100`)
    }

    const noiseVol = noise.volume.toFixed(2)
    filterParts.push(
      `[${inputIdx}:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
      `aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,` +
      `volume=${noiseVol}[amb]`,
    )

    // Apply fade in/out
    let noiseLabel = 'amb'
    if (noise.fade_in > 0 || noise.fade_out > 0) {
      const fadeFilters: string[] = []
      if (noise.fade_in > 0) {
        fadeFilters.push(`afade=t=in:st=0:d=${noise.fade_in}`)
      }
      if (noise.fade_out > 0) {
        const fadeOutStart = Math.max(0, totalDur - noise.fade_out)
        fadeFilters.push(`afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${noise.fade_out}`)
      }
      filterParts.push(`[amb]${fadeFilters.join(',')}[amb2]`)
      noiseLabel = 'amb2'
    }

    mixInputLabels.push(`[${noiseLabel}]`)
    inputIdx++
  }

  // Multi-track ambient layers (v1.0.55+). Each enabled track adds
  // one parallel input — read, atrim to narration duration, volume,
  // optional fade — then participates in the final amix alongside
  // narration / music / noise. Distinct from `music.files`, which
  // concatenates files into one stream at one volume; ambient tracks
  // play simultaneously at their own volumes (rain UNDER fire UNDER
  // narration). Missing files are skipped with a warning, not fatal —
  // a half-configured row shouldn't kill the whole merge job.
  const liveAmbient = (ambientTracks || []).filter(t =>
    t && t.enabled && typeof t.source_path === 'string' && t.source_path.length > 0,
  )
  for (let i = 0; i < liveAmbient.length; i++) {
    const track = liveAmbient[i]!
    const trackPath = unescapeShellPath(track.source_path)!
    if (!existsSync(trackPath)) {
      job.output_lines.push(`  Ambient track skipped — file not found: ${path.basename(trackPath)}`)
      continue
    }
    if (track.loop !== false) inputs.push('-stream_loop', '-1')
    inputs.push('-i', trackPath)

    const trackVol = track.volume.toFixed(2)
    const baseLabel = `amb_${i}`
    filterParts.push(
      `[${inputIdx}:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
      `aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,` +
      `volume=${trackVol}[${baseLabel}]`,
    )

    let lastLabel = baseLabel
    if (track.fade_in > 0 || track.fade_out > 0) {
      const fadeFilters: string[] = []
      if (track.fade_in > 0) {
        fadeFilters.push(`afade=t=in:st=0:d=${track.fade_in}`)
      }
      if (track.fade_out > 0) {
        const fadeOutStart = Math.max(0, totalDur - track.fade_out)
        fadeFilters.push(`afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${track.fade_out}`)
      }
      const fadedLabel = `${baseLabel}_f`
      filterParts.push(`[${baseLabel}]${fadeFilters.join(',')}[${fadedLabel}]`)
      lastLabel = fadedLabel
    }

    mixInputLabels.push(`[${lastLabel}]`)
    inputIdx++
  }
  if (liveAmbient.length) {
    job.output_lines.push(`  Ambient tracks: ${liveAmbient.length} layer(s)`)
  }

  // amix all streams together
  const streamCount = mixInputLabels.length
  const mixInput = mixInputLabels.join('')
  filterParts.push(
    `${mixInput}amix=inputs=${streamCount}:duration=longest:dropout_transition=2,` +
    `aformat=channel_layouts=stereo:sample_fmts=fltp:sample_rates=44100[out]`,
  )

  const filterComplex = filterParts.join(';')

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    outputPath,
  ]

  job.output_lines.push(`  Streams: narration${music ? ' + music' : ''}${noise ? ' + noise' : ''}`)
  await runFfmpeg(args, { timeoutMs: audioMergeTimeoutMs() })
  job.output_lines.push('  Audio mixing complete')
}

// ── Scan Episode Audio Assets ─────────────────────────────────────────────

interface ScannedAudioAssets {
  chapters: Array<{ filename: string; path: string; label: string; duration?: number }>
  music_files: Array<{ filename: string; path: string; duration?: number }>
  merged_files: Array<{ filename: string; path: string; duration?: number }>
  episode_dir: string
  audio_dir: string | null
  merged_audio_dir: string | null
}

export async function scanEpisodeAudioAssets(
  slug: string,
  episodeId: string,
): Promise<ScannedAudioAssets> {
  const code = episodeId.toUpperCase()
  const projectDir = pm.getProjectDir(slug)
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!projectDir || !outputRoot) throw new Error('Project directory not found')

  const names = await resolveSubfolderNames(slug, code)
  const mergedAudioName = await resolveMergedAudioName(slug, code)

  const episodeDir = await findEpisodeDir(outputRoot, code)
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)

  // Level B (opt-in): audio + merged audio are heavy — route to the external
  // media root when configured, else the iCloud episodeDir as before.
  const mediaBase = (await mediaEpisodeBaseForCode(slug, code)) ?? episodeDir
  const audioDir = await resolveSubfolder(mediaBase, names.audio)
  const mergedAudioDir = await resolveSubfolder(mediaBase, mergedAudioName)

  const result: ScannedAudioAssets = {
    chapters: [],
    music_files: [],
    merged_files: [],
    episode_dir: episodeDir,
    audio_dir: audioDir,
    merged_audio_dir: mergedAudioDir,
  }

  // Scan chapter audio files
  if (audioDir) {
    const files = await safeReaddir(audioDir)
    for (const file of files) {
      if (!/\.mp3$/i.test(file)) continue

      // Skip files that look like full/merged narration and explicit alternates.
      if (/full|merged|narration_only/i.test(file) || !isActiveChapterAudioFilename(file)) continue

      const filePath = path.join(audioDir, file)
      const duration = await getAudioDuration(filePath)

      const label = file
        .replace(/^[A-Z]+\d+_/, '')
        .replace(/\.mp3$/i, '')
        .replace(/_/g, ' ')

      result.chapters.push({
        filename: file,
        path: filePath,
        label,
        duration,
      })
    }

    // Sort: Introduction first, then chapters numerically.
    result.chapters.sort((a, b) => compareChapterFilenames(a.filename, b.filename))
  }

  // Scan for music files in project root, episode dir, and music/ subdirs
  const musicLocations = [projectDir, episodeDir]
  const musicSubdir = path.join(projectDir, 'music')
  if (existsSync(musicSubdir)) musicLocations.push(musicSubdir)
  const episodeMusicDir = path.join(episodeDir, 'music')
  if (existsSync(episodeMusicDir)) musicLocations.push(episodeMusicDir)

  const seenMusicPaths = new Set<string>()
  for (const loc of musicLocations) {
    const files = await safeReaddir(loc)
    for (const file of files) {
      if (!/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file)) continue
      const fullPath = path.join(loc, file)
      if (seenMusicPaths.has(fullPath)) continue
      seenMusicPaths.add(fullPath)
      const duration = await getAudioDuration(fullPath)
      result.music_files.push({
        filename: file,
        path: fullPath,
        duration,
      })
    }
  }

  // Scan for existing merged audio files
  if (mergedAudioDir) {
    const files = await safeReaddir(mergedAudioDir)
    for (const file of files) {
      if (!/\.(mp3|wav|m4a)$/i.test(file)) continue
      // Skip temp directories
      if (file.startsWith('.tmp_')) continue
      const filePath = path.join(mergedAudioDir, file)
      const duration = await getAudioDuration(filePath)
      result.merged_files.push({
        filename: file,
        path: filePath,
        duration,
      })
    }
  }

  return result
}
