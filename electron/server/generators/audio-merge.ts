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
import { resolveSubfolderNames } from '../services/utils.js'
import { runFfmpeg, getAudioDuration, formatConcatFileLine } from '../lib/ffmpeg-utils.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import type {
  AudioMergeRequest, Job,
  VideoMusicConfig, VideoBackgroundNoise,
} from '../models/types.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { resolveAssetPath, isPortablePath } from '../services/path-resolver.js'
import { checkAssetAvailability } from '../lib/sync-safe.js'

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
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

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
      path.join(pm.getProjectDir(slug) || path.join(pm.PROJECTS_ROOT, slug), 'project.json'), 'utf-8',
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
 * - 'overwrite': always `{code}_merged_audio.mp3` (replaces existing v1)
 * - 'new': pick the next `{code}_merged_audio_vN.mp3` that doesn't exist
 */
async function resolveMergedOutputName(
  dir: string, code: string, mode: 'overwrite' | 'new',
): Promise<string> {
  const base = `${code}_merged_audio`
  if (mode === 'overwrite') return `${base}.mp3`
  const existing = await safeReaddir(dir)
  const re = new RegExp(`^${code}_merged_audio(?:_v(\\d+))?\\.mp3$`)
  let max = 0
  for (const f of existing) {
    const m = f.match(re)
    if (!m) continue
    const v = m[1] ? parseInt(m[1], 10) : 1
    if (v > max) max = v
  }
  const next = Math.max(2, max + 1) // first "new" is v2, since base = v1
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

// ── Main Generator ────────────────────────────────────────────────────────

export async function generateAudioMerge(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as AudioMergeRequest
  const code = episode_id.toUpperCase()

  // Batch pipeline support: if the caller queued this job without an
  // explicit chapter list (e.g. as part of a chained audio → audio_merge
  // run where the chapters don't exist yet at chain-submission time),
  // auto-resolve them from disk now that the preceding audio step has
  // finished. scanEpisodeAudioAssets returns the same sorted list the
  // interactive Audio-Merge page shows.
  if (!Array.isArray(req.chapters) || req.chapters.length === 0) {
    job.output_lines.push('No chapter list provided — auto-scanning audio folder…')
    const scanned = await scanEpisodeAudioAssets(project_slug, episode_id)
    if (!scanned.chapters.length) {
      throw new Error(`No audio chapters found for ${code}. Run the Audio step first.`)
    }
    req.chapters = scanned.chapters.map(c => c.path)
    job.output_lines.push(`Auto-resolved ${req.chapters.length} chapter(s) from disk`)
  }

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

  // Expand portable asset paths (`${PROJECT}`, `${TERRANASH}`, …) to absolute
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

  const episodeDir = await findEpisodeDir(outputRoot, code)
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)

  const mergedAudioName = await resolveMergedAudioName(project_slug, code)
  const mergedDir = await resolveSubfolder(episodeDir, mergedAudioName)
    || path.join(episodeDir, mergedAudioName)
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

    // Build concat list file
    const concatListPath = path.join(tempDir, 'concat_list.txt')
    const concatLines: string[] = []

    // Optional intro: prepend to the front with a configurable gap after it
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
      job.output_lines.push(`Intro prepended (${path.basename(introPath)}, volume ${Math.round(introVol * 100)}%, ${introGap}s gap)`)
    }

    for (let i = 0; i < chapterFiles.length; i++) {
      concatLines.push(escPath(chapterFiles[i]))
      // Insert silence between chapters (not after the last one)
      if (i < chapterFiles.length - 1 && silenceFile) {
        concatLines.push(escPath(silenceFile))
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
    try {
      type ChapterEntry = { slug: string; duration_s: number; source_file: string }
      const chapters: ChapterEntry[] = []
      for (const p of validChapters) {
        const d = await getAudioDuration(p).catch(() => null)
        if (d == null) continue
        const filename = path.basename(p)
        const baseNoExt = filename.replace(/\.[^.]+$/, '')
        // Strip the episode-code prefix ("TN0143_") so the slug is the
        // bare section name. startsWith check keeps slug intact for any
        // unusual filenames that don't follow the convention.
        const slug = baseNoExt.startsWith(`${code}_`)
          ? baseNoExt.slice(code.length + 1)
          : baseNoExt
        chapters.push({ slug, duration_s: d, source_file: filename })
      }
      const sidecarPath = path.join(episodeDir, 'audio_chapters.json')
      await fs.writeFile(sidecarPath, JSON.stringify({ sections: chapters }, null, 2))
      job.output_lines.push(
        `Wrote chapter-duration sidecar (audio_chapters.json): ${chapters.length} section(s)`,
      )
    } catch (e: any) {
      job.output_lines.push(`Note: chapter-duration sidecar skipped (${e?.message || 'write error'})`)
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
      if (musicEnabled || noiseEnabled) {
        job.output_lines.push('Mixing audio layers...')
        await mixAudioLayers({
          narrationPath: narrationOnlyPath,
          narrationDuration,
          narrationVolume: req.narration_volume ?? 1.0,
          music: musicEnabled ? req.music! : undefined,
          noise: noiseEnabled ? req.background_noise! : undefined,
          outputPath,
          tempDir,
          job,
        })
      } else {
        // No music/noise — just copy narration to output
        job.output_lines.push('No music or noise configured, copying narration...')
        await fs.copyFile(narrationOnlyPath, outputPath)
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
    const finalDuration = await getAudioDuration(outputPath)
    job.output_lines.push(`Output: ${outputPath}`)
    job.output_lines.push(`Duration: ${finalDuration ? finalDuration.toFixed(1) + 's' : 'unknown'}`)
    job.output_dir = path.dirname(outputPath)

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
  outputPath: string
  tempDir: string
  job: Job
}

async function mixAudioLayers(opts: MixOptions): Promise<void> {
  const {
    narrationPath, narrationDuration, narrationVolume,
    music, noise, outputPath, tempDir, job,
  } = opts

  const totalDur = narrationDuration
  const inputs: string[] = []
  const filterParts: string[] = []
  const mixInputLabels: string[] = []

  // Input 0: narration
  inputs.push('-i', narrationPath)

  const narrVol = narrationVolume.toFixed(2)
  filterParts.push(
    `[0:a]aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${narrVol}[narr]`,
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

    filterParts.push(
      `[${inputIdx}:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
      `aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,` +
      `volume=${musicVol}[bgm]`,
    )

    // Boost music volume after narration ends
    filterParts.push(
      `[bgm]volume=enable='gt(t,${narrationDuration.toFixed(2)})':volume=${boostRatio}[bgm2]`,
    )

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

  const audioDir = await resolveSubfolder(episodeDir, names.audio)
  const mergedAudioDir = await resolveSubfolder(episodeDir, mergedAudioName)

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

      // Skip files that look like full/merged narration
      if (/full|merged|narration_only/i.test(file)) continue

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

    // Sort: Introduction first, then chapters numerically
    result.chapters.sort((a, b) => {
      const aIsIntro = /intro/i.test(a.filename)
      const bIsIntro = /intro/i.test(b.filename)
      if (aIsIntro && !bIsIntro) return -1
      if (!aIsIntro && bIsIntro) return 1
      const aNum = a.filename.match(/chapter[_\s]*(\d+)/i)
      const bNum = b.filename.match(/chapter[_\s]*(\d+)/i)
      if (aNum && bNum) return parseInt(aNum[1]) - parseInt(bNum[1])
      if (aNum && !bNum) return 1
      if (!aNum && bNum) return -1
      return a.filename.localeCompare(b.filename, undefined, { numeric: true })
    })
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
