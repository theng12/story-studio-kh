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
import { findEpisodeDir as findEpisodeDirByTitle } from '../lib/folder-resolver.js'
import { spawn } from 'child_process'
import * as pm from '../services/project-manager.js'
import { trackChild } from '../services/job-queue.js'
import { resolveSubfolderNames, resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import { runFfmpeg, getAudioDuration, formatConcatFileLine, appendCappedTail } from '../lib/ffmpeg-utils.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { MIX_LIMITER, type LoudnessTarget } from '../lib/final-loudness.js'
import { channelLoudnessTarget, levelAndCheck, mergedAudioMasterPath } from '../lib/level-audio.js'
import { closingTailFromPostAudio, resolveProjectClosingTail, type ClosingTailRequest } from '../lib/closing-tail.js'
import { buildMusicBed, MUSIC_REFERENCE_LUFS } from '../lib/music-bed.js'
import { measureLoudness } from './music-episode-build.js'
import type {
  AudioMergeRequest, Job,
  VideoMusicConfig, VideoBackgroundNoise, AmbientTrack, VideoClosingMusic,
} from '../models/types.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { resolveAssetPath, isPortablePath } from '../services/path-resolver.js'
import { checkAssetAvailability } from '../lib/sync-safe.js'
import { closingTailRemixInProgress, CLOSING_TAIL_REMIX_IN_PROGRESS } from '../services/closing-tail-remix-admission.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { chapterKeyOf, inspectChapterAudioReadiness, type ChapterAudioReadiness } from '../services/audio-workflow-readiness.js'
import { safetyGate, safetyMode } from '../services/safety-checks.js'
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

/**
 * The episode's folder, preferring the exact "{code} - {title}" one. A code-only match took the
 * first same-code folder, so a renumber leftover (Boundless "EP0100 - How Aztec Star Watchers…",
 * now EP0116) beside the real EP0100 left Audio Assembly with no chapters while Audio counted
 * 21/21 in the titled folder (2026-10-10).
 */
async function findEpisodeDir(slug: string, outputRoot: string, code: string): Promise<string | null> {
  const { getIdeas } = await import('../services/idea-manager.js')
  const titleHint = (await getIdeas(slug, 'accepted').catch(() => []))
    .find(idea => idea.episode_code === code)?.title || undefined
  return findEpisodeDirByTitle(outputRoot, code, { titleHint })
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

// One chapter-file key for Audio status and Audio Assembly (strips the code, `_normalized`, `_partN`/`_vN`).
export { chapterKeyOf }

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

/**
 * The split chapters whose every expected `_partN` file is on disk, by chapter slug, in part order.
 * Readiness is the proof (it predicts the parts generation writes and checks each is present), so a
 * first assembly can join them although no chapter record exists yet (episodes made with
 * no_overwrite write none).
 */
export function provenPartSets(readiness: Pick<ChapterAudioReadiness, 'expected_files' | 'present_files'>, code: string): Record<string, string[]> {
  const present = new Set(readiness.present_files)
  const sets: Record<string, string[]> = {}
  for (const file of readiness.expected_files) {
    if (/_part\d+\.mp3$/i.test(file)) (sets[chapterKeyOf(file, code)] ??= []).push(file)
  }
  return Object.fromEntries(Object.entries(sets).filter(([, files]) => files.length > 1 && files.every(file => present.has(file))))
}

export async function generateAudioMerge(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as AudioMergeRequest
  const code = episode_id.toUpperCase()

  // A closing-tail re-mix of this episode writes the same files (it carries `closing_tail_sec_cap`).
  if (!(Number(req.closing_tail_sec_cap) > 0) && closingTailRemixInProgress(project_slug, code)) {
    throw new Error(CLOSING_TAIL_REMIX_IN_PROGRESS)
  }

  // One file per chapter: an episode still holding split `_partN` narration
  // gets each complete chapter joined first (a quality refresh keeps the exact
  // files its repair selected).
  if (!req.audio_quality_refresh) {
    const { consolidateEpisodeParts } = await import('../services/chapter-parts.js')
    await consolidateEpisodeParts(project_slug, code, line => job.output_lines.push(line))
  }

  // Submission routes preflight this too, but Pipeline jobs can enqueue
  // internally and files may change while a job waits. Re-prove the complete
  // base set immediately before FFmpeg starts. This is read-only; the selected
  // sidecar map below remains the source authority for a promoted `_vN` file.
  let readiness = await inspectChapterAudioReadiness(project_slug, code)
  // The merge publishes `audio_chapters.json` naming exactly the files it concatenates, and the next
  // reader (Subtitles, the Audio Editor page) joins any split chapter that record names, replacing it
  // with a newer file and so making this very merge stale. With loose parts and no chapter record the
  // join above had nothing to go on, so join the proven part sets now, re-check, and build the master
  // from the single chapter file the record will keep.
  if (!req.audio_quality_refresh) {
    const proven = provenPartSets(readiness, code)
    if (Object.keys(proven).length) {
      const { consolidateEpisodeParts } = await import('../services/chapter-parts.js')
      const joined = await consolidateEpisodeParts(project_slug, code, line => job.output_lines.push(line), proven)
      if (joined.length) readiness = await inspectChapterAudioReadiness(project_slug, code)
    }
  }
  if (!readiness.ready) {
    // 1.4.300 — "All chapter audio present": Block stops as before; Off and Warn join the chapters
    // that are there (nothing at all still stops).
    const blocked = new Error(`Audio Assembly is blocked: ${readiness.issues.join(' ')}`)
    if (!readiness.present_files.length || await safetyMode(project_slug, 'chapter_audio_present') === 'block') throw blocked
    await safetyGate(project_slug, 'chapter_audio_present', job,
      `${readiness.missing_files.length} chapter audio file(s) are missing (${readiness.missing_files.join(', ')}). Story joins the narration from the chapters that are there.`)
    const missing = new Set(readiness.missing_files)
    readiness = { ...readiness, ready: true, expected_files: readiness.expected_files.filter(file => !missing.has(file)) }
  }

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
      if (!requiredRefresh && !containsAlternate) return []
      // 1.4.300 — a chosen take's file is gone: Off/Warn join the rest of the chosen map.
      if (requiredRefresh || missing.length === candidate.length
        || await safetyMode(project_slug, 'chapter_audio_present') === 'block') {
        throw new Error(`Audio Assembly cannot use its authoritative selected audio map: ${message}`)
      }
      await safetyGate(project_slug, 'chapter_audio_present', job, `The chosen narration map lists ${message}. Story joins the narration from the files that are there.`)
      return candidate.filter(file => existsSync(file))
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
  // Music Pool without a named track (a Pipeline batch): the same pick the page shows, recorded after a good merge.
  if (req.music?.enabled && !req.music_pool_track) {
    const { pickPoolMusic } = await import('../services/music-pool.js')
    const pool = await pickPoolMusic(project_slug, code, req.music)
    if (pool) {
      req.music = pool.music
      req.music_pool_track = pool.track.filename
      job.output_lines.push(`Music pool: "${pool.track.filename}" for ${code} (${pool.reason}).`)
    } else if (!req.music.files?.length) {
      job.output_lines.push('Background music is on, but the Music Pool has no track to give (empty, all switched off, or set to manual); merging without music.')
    }
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

  const episodeDir = await findEpisodeDir(project_slug, outputRoot, code)
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
    let introPath = introEnabled && req.intro ? unescapeShellPath(req.intro.file)! : ''
    if (introPath) {
      const avail = checkAssetAvailability(introPath, 'intro.file')
      if (avail.status !== 'available') {
        // The user explicitly enabled an intro, and losing it silently would surprise them. The
        // message already tells them to trigger the iCloud download when that's the cause.
        // 1.4.300 — "Intro audio file found": Block stops as before; Off and Warn assemble without it.
        const message = avail.message || `Intro audio file not found: ${introPath}`
        if (await safetyMode(project_slug, 'intro_audio') === 'block') throw new Error(message)
        await safetyGate(project_slug, 'intro_audio', job, `${message} Story assembles the narration without the intro.`)
        introPath = ''
      }
    }
    if (introPath && req.intro) {
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
    const musicEnabled = req.music?.enabled && (req.music.files?.length ?? 0) > 0
    const noiseEnabled = req.background_noise?.enabled

    // The closing tail — the music that plays AFTER the spoken content ends.
    // Its length and its music controls both come from the `post_audio` block
    // of the render this audio is for (see lib/closing-tail.ts): the one the
    // request carries (Pipeline run, closing-tail re-mix), else the episode's
    // own saved Video Assembly choice. ONE source of truth, so the mix and the
    // picture the renderer draws under it cannot disagree. Only background music can carry it, so a merge with no music
    // bakes none and says so rather than leaving a silence unexplained.
    const savedClosingTail = req.closing_post_audio
      ? closingTailFromPostAudio(req.closing_post_audio)
      : await resolveProjectClosingTail(project_slug, code)
    const tailCap = Number(req.closing_tail_sec_cap)
    const requestedClosingTail = tailCap > 0 && savedClosingTail.seconds > tailCap
      ? { ...savedClosingTail, seconds: tailCap }
      : savedClosingTail
    const closingTail: ClosingTailRequest = musicEnabled ? requestedClosingTail : { seconds: 0 }
    if (closingTail.seconds > 0) {
      job.output_lines.push(
        `Closing tail: the background music continues for ${closingTail.seconds}s after the narration, `
        + 'then fades out (Video Assembly\'s post-audio tail).',
      )
    } else if (requestedClosingTail.seconds > 0) {
      job.output_lines.push(
        `Closing tail: this channel asks for ${requestedClosingTail.seconds}s after the narration, but no background `
        + 'music is selected, so that tail stays silent — the picture is still held/black for it.',
      )
    }

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
    // 1.4.281 — the mix is levelled here, to the channel's target, and kept lossless next to the MP3
    // (`{name}.master.flac`): Video Assembly uses that master, so a level problem shows up now, before
    // any video work, and the final video's AAC is not encoded from an MP3.
    let rawMixPath = path.join(tempDir, 'merged_raw.flac')
    const masterPath = mergedAudioMasterPath(outputPath)
    try {
      const ambientEnabled = Array.isArray(req.ambient_tracks)
        && req.ambient_tracks.some(t => t?.enabled && t?.source_path)
      if (musicEnabled || noiseEnabled || ambientEnabled) {
        job.output_lines.push('Mixing audio layers...')
        await mixAudioLayers({
          narrationPath: narrationOnlyPath,
          narrationDuration,
          closingTail,
          narrationVolume: req.narration_volume ?? 1.0,
          music: musicEnabled ? req.music! : undefined,
          noise: noiseEnabled ? req.background_noise! : undefined,
          ambientTracks: ambientEnabled ? req.ambient_tracks : undefined,
          outputPath: rawMixPath,
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
            '-c:a', 'flac', '-sample_fmt', 's16',
            rawMixPath,
          ], { timeoutMs: audioMergeTimeoutMs() })
        } else {
          job.output_lines.push('No music, noise, or ambient configured: the narration is the mix.')
          rawMixPath = narrationOnlyPath
        }
      }
      await levelMergedAudio({
        raw: rawMixPath,
        master: masterPath, mp3: outputPath,
        loudness: await channelLoudnessTarget(project_slug), tempDir, lines: job.output_lines, slug: project_slug,
      })
      mixSucceeded = true
    } finally {
      if (!mixSucceeded) {
        try {
          await fs.rm(masterPath, { force: true })
          await fs.rm(`${masterPath}.kept`, { force: true })
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
      closingTailSec: closingTail.seconds,
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
        // 1.4.281 — the levelled lossless master Video Assembly mixes from (mergedAudioMaster).
        master_filename: path.basename(masterPath),
        /**
         * Seconds of music the mix carries AFTER the narration (0 for a merge
         * with no bed, and for every record written before this field existed).
         * The renderer draws the matching hold/black picture for exactly this
         * long and adds no second pad, and every reader asking "how long is the
         * narration" subtracts it — `duration_sec` is the whole file, tail and
         * all, and stays the physical fact `asset-status` verifies.
         */
        closing_tail_sec: closingTail.seconds,
        /**
         * Whether the mix carries a background music bed (1.4.352). `closing_tail_sec` 0 cannot say:
         * it is 0 both for a merge with no bed and for a bed mixed before a closing was saved. A record
         * without this field (older merges) says nothing — `mergedBackgroundMusic` reads that as
         * unknown, never as "no bed".
         */
        background_music: !!musicEnabled,
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
    const poolTrack = req.music_pool_track
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

/**
 * 1.4.281 — level the merged mix (`raw`) into its lossless master and write the MP3 from that master.
 * The master's peak is checked as the final video's AAC ships it (levelAndCheck); a mix that cannot
 * reach the target fails Audio Assembly, before any video work.
 */
export async function levelMergedAudio(opts: {
  raw: string; master: string; mp3: string; loudness: LoudnessTarget; tempDir: string; lines: string[]
  /** 1.4.300 — the channel whose "silent narration" safety check applies (Block by default). */
  slug?: string
}): Promise<void> {
  const { raw, master, mp3, loudness, tempDir, lines } = opts
  const measured = await measureLoudness(raw)
  // A silent merge used to carry on and fail only after the whole Video Assembly render.
  if (opts.slug && (measured.lufs === null || measured.lufs <= -69)) {
    const { safetyGate } = await import('../services/safety-checks.js')
    await safetyGate(opts.slug, 'silent_narration', { output_lines: lines },
      'The merged narration is silent or its level cannot be read. Check the chapter audio and re-narrate the silent part.')
  }
  await levelAndCheck({
    measured,
    write: level => runFfmpeg(['-y', '-i', raw, '-vn', '-af', `${level}aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=44100`,
      '-c:a', 'flac', master], { timeoutMs: audioMergeTimeoutMs() }),
    output: master, loudness, tempDir, lines, what: 'merged audio',
  })
  await runFfmpeg(['-y', '-i', master, '-c:a', 'libmp3lame', '-b:a', '192k', mp3], { timeoutMs: audioMergeTimeoutMs() })
  lines.push(`Lossless master kept: ${path.basename(master)}`)
}

// ── Audio Layer Mixing ────────────────────────────────────────────────────

interface MixOptions {
  narrationPath: string
  narrationDuration: number
  /**
   * The closing tail: how long the music continues after the narration, and the
   * controls the owner set for it. Absent / 0 = the historical mix, which stops
   * where the narration does.
   */
  closingTail?: ClosingTailRequest
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
 * The tail's own mix numbers, from the preset's `closing_music` block and the
 * Audio Assembly music settings it reuses. Pure and exported so the defaults can
 * be pinned without running FFmpeg.
 *
 * The levels are the SAME two the mix already speaks: `musicVolume` is the bed
 * under the voice (the ducked level) and `postNarrationVolume` is the level it
 * returns to once the voice stops — the normal BGM level. `volume` is a
 * percentage of that normal level, so 100 (and an absent block) means "exactly
 * what Audio Assembly already set", which is what makes the defaults sound right
 * with nothing touched.
 */
export function resolveClosingTailParams(opts: {
  tailSec: number
  /** The bed's level once the voice stops — the normal BGM level. */
  postNarrationVolume: number
  /** The Audio Assembly music's own fade-out, the fallback for the tail's. */
  musicFadeOut: number
  closing?: VideoClosingMusic
}): {
  /** How long the tail runs. */
  tailSec: number
  /** The level the bed holds over the tail, after the duck release. */
  level: number
  /** Seconds to rise from `musicVolume` to `level`. 0 = the historical step. */
  duckReleaseSec: number
  /** Seconds of fade-out over the end of the tail. */
  fadeOutSec: number
} {
  const tailSec = Math.max(0, Number(opts.tailSec) || 0)
  const percent = Number(opts.closing?.volume)
  const scale = Number.isFinite(percent) ? Math.max(0, percent) / 100 : 1
  const release = Number(opts.closing?.duck_release_sec)
  const fade = Number(opts.closing?.fade_out_sec)
  return {
    tailSec,
    level: Math.max(0, Math.min(1, opts.postNarrationVolume * scale)),
    // Never longer than the tail itself, or the rise would still be climbing
    // when the fade-out starts.
    duckReleaseSec: Math.min(
      tailSec,
      Number.isFinite(release) ? Math.max(0, release) : DEFAULT_DUCK_RELEASE_SEC,
    ),
    fadeOutSec: Math.min(
      tailSec,
      Number.isFinite(fade) && fade > 0
        ? Math.max(0, fade)
        : (opts.musicFadeOut > 0 ? opts.musicFadeOut : DEFAULT_TAIL_FADE_OUT_SEC),
    ),
  }
}

/** The duck release when nothing is set: long enough to hear as a rise, short
 *  enough that the tail is at its level almost immediately. */
export const DEFAULT_DUCK_RELEASE_SEC = 1.5
/** The tail's fade-out when neither the tail block nor the music sets one. */
export const DEFAULT_TAIL_FADE_OUT_SEC = 5

/**
 * Build the per-frame `volume` expression for the music bed. Phases, by output
 * time t (`narrEnd = leadIn + narrDur`):
 *   [0, leadIn)              → 1.0     full-volume intro (music lead-in only)
 *   [leadIn, leadIn+fade)    → linear ramp 1.0 → duckVol (smooth duck as the
 *                              narration begins)
 *   [leadIn+fade, narrEnd)   → duckVol (music under narration)
 *   [narrEnd, +release)      → linear ramp duckVol → postVol (the duck release,
 *                              so the bed rises back as the voice stops rather
 *                              than jumping)
 *   ≥ narrEnd+release        → postVol (the closing tail's level)
 * Pure + exported for unit coverage — the math is fiddly and FFmpeg can't run
 * in tests. `duckFade` is clamped by the caller (>0). Values are absolute
 * gains, fed to `volume='…':eval=frame`.
 *
 * `leadIn = 0` emits no intro phase (there is no music intro to duck from), and
 * `release = 0` emits no ramp, which is byte-identical to the pre-2026-10-19
 * expression every existing merge used.
 */
export function buildMusicLeadInVolumeExpr(
  leadIn: number, duckFade: number, narrDur: number, duckVol: number, postVol: number,
  releaseSec = 0,
): string {
  const narrEnd = leadIn + narrDur
  const mv = duckVol.toFixed(3)
  const pv = postVol.toFixed(3)
  const release = Math.max(0, releaseSec)
  const afterVoice = release > 0
    ? `if(lt(t,${(narrEnd + release).toFixed(3)}),`
      + `${mv}+(${pv}-${mv})*(t-${narrEnd.toFixed(3)})/${release.toFixed(3)},${pv})`
    : pv
  const underVoice = `if(lt(t,${narrEnd.toFixed(3)}),${mv},${afterVoice})`
  if (!(leadIn > 0)) return underVoice
  const L = leadIn.toFixed(3)
  const Lf = (leadIn + duckFade).toFixed(3)
  const df = duckFade.toFixed(3)
  return `if(lt(t,${L}),1.0,`
    + `if(lt(t,${Lf}),1.0+(${mv}-1.0)*(t-${L})/${df},`
    + `${underVoice}))`
}

/**
 * The one definition of how long the merged mix runs: the narration, the music
 * lead-in that precedes it, and the closing tail that follows it.
 *
 * Everything in the filter graph is trimmed to this number — the bed, the noise,
 * the ambient layers — so the mix ends exactly where the video's picture does.
 * The narration itself is shorter (it is delayed by the lead-in), which is why
 * `amix=duration=longest` produces this length rather than the narration's.
 */
export function mergedMixDurationSec(
  narrationSec: number, leadInSec: number, closingTailSec: number,
): number {
  return (Number(narrationSec) || 0)
    + Math.max(0, Number(leadInSec) || 0)
    + Math.max(0, Number(closingTailSec) || 0)
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
  // The closing tail is music-only: with no bed there is nothing to carry past
  // the narration, and the mix stops where it always did.
  const closingTail: ClosingTailRequest = music ? (opts.closingTail ?? { seconds: 0 }) : { seconds: 0 }
  const totalDur = mergedMixDurationSec(narrationDuration, leadIn, closingTail.seconds)
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
    const cleanedFiles = music.files.map(f => unescapeShellPath(f)!).filter(Boolean)
    // 1.4.270 — every track levelled (cached), crossfaded joins, a loop point that never hard-cuts.
    const musicInputPath = await buildMusicBed(cleanedFiles, tempDir, line => job.output_lines.push(line))
    // The volume setting is the bed's level relative to the narration as it plays: 100% = as loud as
    // the voice, 11% = 19 dB under it. Measured, so it holds for any voice and any narration volume.
    const narrationLufs = (await measureLoudness(narrationPath, { truePeak: false })).lufs
    const bedOffsetDb = narrationLufs !== null && narrationLufs > -69
      ? narrationLufs + 20 * Math.log10(Math.max(narrationVolume, 0.01)) - MUSIC_REFERENCE_LUFS
      : 0
    job.output_lines.push(`  Music bed: ${Math.round(music.volume * 100)}% = ${(20 * Math.log10(Math.max(music.volume, 0.001))).toFixed(1)} dB `
      + `relative to the narration${narrationLufs !== null ? ` (narration ${narrationLufs.toFixed(1)} LUFS)` : ''}.`)

    // Loop music to fill duration. `buildMusicBed` already joins the tracks with
    // equal-power crossfades and makes the joined bed loopable (its end
    // crossfades into its start), so the bed never runs out and never hard-cuts:
    // a tail longer than the track keeps playing the same bed, not silence.
    inputs.push('-stream_loop', '-1', '-i', musicInputPath)

    const postNarrVol = music.post_narration_volume
    // The tail's own numbers: its level, the rise back out of the duck, and the
    // fade-out at the end. `closing_tail_sec` is the length the renderer draws.
    const tail = resolveClosingTailParams({
      tailSec: closingTail.seconds,
      postNarrationVolume: postNarrVol,
      musicFadeOut: music.fade_out || 0,
      closing: closingTail.music,
    })

    if (leadIn > 0) {
      // Lead-in "intro" (v1.0.397): one piecewise volume envelope plays the
      // track at full volume for `leadIn` seconds, then ducks (over a short
      // fade) to the during-narration volume exactly as the delayed narration
      // starts. `:eval=frame` makes the volume expression time-varying. Quoting
      // protects the commas in the expression from the filtergraph parser.
      const duckFade = Math.max(0.05, Math.min(0.6, leadIn / 2))
      const env = buildMusicLeadInVolumeExpr(
        leadIn, duckFade, narrationDuration, music.volume, tail.level, tail.duckReleaseSec,
      )
      filterParts.push(
        `[${inputIdx}:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${bedOffsetDb.toFixed(2)}dB,` +
        `volume='${env}':eval=frame[bgm2]`,
      )
      job.output_lines.push(
        `  Music intro: first ${leadIn}s at full volume, then ducks to ${Math.round(music.volume * 100)}% as narration starts`,
      )
    } else {
      // No music intro: the same envelope with no intro phase. It carries the
      // duck release too, so the bed rises back as the last word lands instead
      // of jumping the instant the voice stops.
      const env = buildMusicLeadInVolumeExpr(
        0, 0, narrationDuration, music.volume, tail.level, tail.duckReleaseSec,
      )
      filterParts.push(
        `[${inputIdx}:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${bedOffsetDb.toFixed(2)}dB,` +
        `volume='${env}':eval=frame[bgm2]`,
      )
    }

    // Fade the bed in and out — the music never starts or stops with a cut.
    // Over a TAIL the out-fade is the closing fade the owner set, on a smooth
    // (quarter-sine) curve; without one it keeps the historical 2 s / 3 s
    // linear pair, so an existing episode re-merges byte-for-byte as before.
    const fadeIn = Math.max(2, music.fade_in || 0)
    const fadeOut = tail.tailSec > 0 ? tail.fadeOutSec : Math.max(3, music.fade_out || 0)
    const fadeCurve = tail.tailSec > 0 ? ':curve=qsin' : ''
    filterParts.push(
      `[bgm2]afade=t=in:st=0:d=${fadeIn},`
      + `afade=t=out:st=${Math.max(0, totalDur - fadeOut).toFixed(2)}:d=${fadeOut}${fadeCurve}[bgm3]`,
    )
    const musicLabel = 'bgm3'

    if (tail.tailSec > 0) {
      job.output_lines.push(
        `  Closing tail: music continues ${tail.tailSec}s past the narration at `
        + `${Math.round(tail.level * 100)}% of the normal BGM level, rising out of the duck over `
        + `${tail.duckReleaseSec}s and fading out over the last ${tail.fadeOutSec}s.`,
      )
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

  // amix all streams together. normalize=0 keeps each layer at the volume its setting names (amix's
  // default divides every input by the number of inputs: a 150% voice became 75% under music). The
  // limiter (delay-compensated, no auto-level) only touches peaks over -1 dBFS so the louder sum cannot clip.
  const streamCount = mixInputLabels.length
  const mixInput = mixInputLabels.join('')
  filterParts.push(
    `${mixInput}amix=inputs=${streamCount}:duration=longest:dropout_transition=2:normalize=0,` +
    `${MIX_LIMITER},aformat=channel_layouts=stereo:sample_fmts=fltp:sample_rates=44100[out]`,
  )

  const filterComplex = filterParts.join(';')

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:a', 'flac', '-sample_fmt', 's16',  // lossless: it is levelled next (levelMergedAudio)
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

  const episodeDir = await findEpisodeDir(slug, outputRoot, code)
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
    // The active source map (audio_chapters.json) owns which bytes a chapter uses. A
    // regenerate under a new request boundary leaves the old single file beside the new
    // `_partN` files; listing both put Chapter 12 into the merge twice (Dreamlands E2E,
    // 2026-10-03). Chapters the map does not name keep the plain directory scan.
    const { resolveActiveSubtitleChapterSources } = await import('./subtitles.js')
    const activeSources = await resolveActiveSubtitleChapterSources(episodeDir, audioDir).catch(() => null)
    const activeBySlug = new Map((activeSources || []).map(source => [source.slug.toLowerCase(), new Set(source.files)]))
    for (const file of files) {
      // Hidden files (a join in progress) are never chapters.
      if (!/\.mp3$/i.test(file) || file.startsWith('.')) continue

      // Skip files that look like full/merged narration and explicit alternates.
      if (/full|merged|narration_only/i.test(file) || !isActiveChapterAudioFilename(file)) continue
      const active = activeBySlug.get(chapterKeyOf(file, code).toLowerCase())
      if (active && !active.has(file)) continue

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
