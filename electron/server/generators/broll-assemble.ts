/**
 * B-Roll video assembly executor — concatenates clips from the per-
 * episode selection sidecar, mixes narration + B-Roll audio + bg music
 * (when present), and renders a single 1920×1080 MP4.
 *
 * Pipeline:
 *   1. Read the selection sidecar (must exist; /broll/assemble validates).
 *   2. Build an FFmpeg filtergraph:
 *      a. For each clip: pick normalized variant if available
 *         (.broll-normalized/<filename>) for fast concat; else use
 *         original and scale/fps in the filtergraph at render time.
 *      b. Trim each clip to its target_duration. For pacing=timed where
 *         segment > native, loop the clip. For pacing=rotate the cap is
 *         already ≤ native so trim is straightforward.
 *      c. Concat all video segments.
 *      d. Mix audio: narration full + B-Roll audio at broll_volume/100
 *         (when broll_volume > 0; omit B-Roll audio entirely when 0).
 *      e. Burn subtitles if a project SRT exists for this episode.
 *   3. Encode H.264 CRF 20 + AAC, write to <episode>/video/.
 *   4. Append usage log entries (one per unique clip in the sequence)
 *      and truncate to keep the last N where N = broll_lookback * 3
 *      (3× headroom so a lookback of 10 doesn't lose history after 11
 *      episodes if the user bumps it later).
 *
 * Minimum-viable scope here: no transitions library, no Ken Burns, no
 * overlay layers. Those plug into the existing video_assembly path's
 * controls in Phase 3.5+.
 */
import path from 'path'
import { existsSync } from 'fs'
import fsp from 'fs/promises'
import { spawn } from 'child_process'
import * as pm from '../services/project-manager.js'
import * as bp from '../services/broll-pool-manager.js'
import * as jq from '../services/job-queue.js'
import { getSelectionSidecar } from '../services/broll-selection-sidecar.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { getFFmpegPath, getFFprobePath } from '../services/ffmpeg-manager.js'
import type { Job, BrollUsageEntry } from '../models/types.js'

/**
 * Probe whether a file contains an audio stream. Used to decide between
 * a real audio trim filter (clip has audio) and an anullsrc silence
 * generator (clip has no audio) when building the amix branch. Falls
 * back to false on any probe error — silence is the safer default.
 */
async function hasAudioStream(filePath: string): Promise<boolean> {
  const ffprobe = await getFFprobePath()
  return new Promise((resolve) => {
    const proc = spawn(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ])
    let stdout = ''
    proc.stdout.on('data', (d) => stdout += String(d))
    proc.on('error', () => resolve(false))
    proc.on('close', () => resolve(stdout.trim() === 'audio'))
  })
}

/** Look for a burnable subtitle file in the episode's subtitles dir.
 *  Prefer SRT (drawtext-style overlay support is widest); fall back to
 *  ASS or VTT. Returns null when nothing burnable exists. */
async function findSubtitlePath(subtitlesDir: string): Promise<string | null> {
  if (!existsSync(subtitlesDir)) return null
  const files = await fsp.readdir(subtitlesDir).catch(() => [] as string[])
  // Preference order matches the existing video assembly path's behaviour.
  const priorities = [/\.srt$/i, /\.ass$/i, /\.vtt$/i]
  for (const re of priorities) {
    const hit = files.find(f => re.test(f) && !f.startsWith('.tmp_'))
    if (hit) return path.join(subtitlesDir, hit)
  }
  return null
}

interface AssembleParams {
  episode_id: string
  title: string
  broll_volume: number
}

export async function generateBrollAssemble(job: Job): Promise<void> {
  const { project_slug, episode_id } = job
  const { title, broll_volume = 0 } = job.params as AssembleParams

  const sidecar = await getSelectionSidecar(project_slug, episode_id, title)
  if (!sidecar || !sidecar.selection?.length) {
    throw new Error('No B-Roll selection sidecar — run /broll/pick before assembling.')
  }
  const pool = await bp.getPool(sidecar.pool_id)
  if (!pool) throw new Error(`Pool '${sidecar.pool_id}' missing from registry`)
  if (!existsSync(pool.folder_path)) {
    throw new Error(`Pool folder offline — plug in the SSD at ${pool.folder_path} before rendering.`)
  }

  job.output_lines.push(`Pool: ${pool.name} (${pool.folder_path})`)
  job.output_lines.push(`Selection: ${sidecar.selection.length} clip(s) · pacing=${sidecar.pacing_mode}`)

  // Resolve each clip's on-disk path. Prefer normalized variant for
  // concat performance; fall back to the original with filtergraph
  // scaling at render time. The renderer below uses one consistent
  // filtergraph approach for all clips regardless of normalization
  // state, so mixing in this batch is harmless.
  const clipPaths: Array<{ src: string; duration: number; normalized: boolean }> = []
  for (const entry of sidecar.selection) {
    const normalized = path.join(bp.normalizedSubdir(pool.folder_path), entry.filename)
    const original = path.join(pool.folder_path, entry.filename)
    if (existsSync(normalized)) {
      clipPaths.push({ src: normalized, duration: entry.target_duration, normalized: true })
    } else if (existsSync(original)) {
      clipPaths.push({ src: original, duration: entry.target_duration, normalized: false })
    } else {
      throw new Error(`Clip missing from pool folder: ${entry.filename}`)
    }
  }

  // Narration audio: find merged or single-file. Same logic as the
  // selector's duration probe; we re-walk here so a sidecar generated
  // pre-merge but assembled post-merge picks up the merged file.
  const paths = await resolveEpisodePaths(project_slug, episode_id, title || '')
  const narrationPath = await findNarrationPath(paths.merged_audio_dir, paths.audio_dir)
  if (!narrationPath) throw new Error('No narration audio found — generate audio (and merge if multi-chapter) first.')

  // Output path. video_dir might not exist yet; create it.
  await fsp.mkdir(paths.video_dir, { recursive: true })
  const outFilename = `${episode_id}_BRoll.mp4`
  const outPath = path.join(paths.video_dir, outFilename)
  const tempPath = path.join(paths.video_dir, `.tmp-${Date.now()}-${outFilename}`)

  // ── Probe each clip for audio presence ────────────────────────────
  // amix needs every input stream to actually exist; clips without an
  // audio track get a generated silence stream of the same target
  // duration so concat + amix work uniformly.
  const clipHasAudio: boolean[] = []
  if (broll_volume > 0) {
    for (const c of clipPaths) clipHasAudio.push(await hasAudioStream(c.src))
  }

  // ── Subtitle burn-in (optional) ────────────────────────────────────
  // Mirrors the existing video-assembly path's behaviour — picks up an
  // SRT / ASS / VTT in the episode's subtitles_dir and burns it into
  // the final video. Path needs single quotes escaped for ffmpeg's
  // subtitles filter (its parser is finicky about colons in macOS paths).
  const subPath = await findSubtitlePath(paths.subtitles_dir)
  function escapeForSubtitlesFilter(p: string): string {
    // ffmpeg's subtitles filter interprets `:` as an argument separator
    // unless the path is wrapped + colons escaped. Backslash-escape both.
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  }

  // ── Build the filtergraph ──────────────────────────────────────────
  //
  // Video chain (always):
  //   [N:v] trim=duration=Tn,setpts=PTS-STARTPTS,
  //         scale=1920:1080:force_original_aspect_ratio=decrease,
  //         pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1 [vN]
  //   concat=n=N:v=1:a=0 -> [vbase]
  //   [vbase] subtitles='...' -> [vout]   (only when an SRT exists)
  //
  // Audio chain (broll_volume == 0):
  //   maps narration input directly — no filtergraph audio work.
  //
  // Audio chain (broll_volume > 0):
  //   per clip with audio:  [N:a] atrim=duration=D,asetpts=PTS-STARTPTS [aN]
  //   per clip without:     anullsrc=cl=stereo:r=44100,atrim=duration=D [aN]
  //   concat audio:         [a0][a1]...[aN] concat=n=N:v=0:a=1 [aconcat]
  //   duck:                 [aconcat] volume=VOL [aducked]
  //   mix in narration:     [aducked][narration_a] amix=inputs=2:duration=longest:dropout_transition=0 [aout]
  const targetFps = pool.fps_target
  const filterParts: string[] = []
  for (let i = 0; i < clipPaths.length; i++) {
    const c = clipPaths[i]!
    filterParts.push(
      `[${i}:v]trim=duration=${c.duration},setpts=PTS-STARTPTS,` +
      `scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=${targetFps},setsar=1[v${i}]`,
    )
  }
  const concatLabels = clipPaths.map((_, i) => `[v${i}]`).join('')
  // Pick the final video label — adds a subtitles step when a sub file exists.
  let finalVideoLabel = '[vout]'
  if (subPath) {
    filterParts.push(`${concatLabels}concat=n=${clipPaths.length}:v=1:a=0[vbase]`)
    filterParts.push(`[vbase]subtitles='${escapeForSubtitlesFilter(subPath)}'[vout]`)
  } else {
    filterParts.push(`${concatLabels}concat=n=${clipPaths.length}:v=1:a=0[vout]`)
  }

  const narrationInputIdx = clipPaths.length // first non-clip input
  const args: string[] = ['-y']
  for (const c of clipPaths) args.push('-i', c.src)
  args.push('-i', narrationPath)

  // Build the audio filtergraph branch only when we're actually mixing
  // B-Roll audio in. Below volume 1% it's inaudible vs the narration
  // floor — fall through to narration-only to skip the amix overhead.
  const wantMix = broll_volume >= 1
  let audioMapTarget = `${narrationInputIdx}:a`
  if (wantMix) {
    for (let i = 0; i < clipPaths.length; i++) {
      const c = clipPaths[i]!
      if (clipHasAudio[i]) {
        filterParts.push(`[${i}:a]atrim=duration=${c.duration},asetpts=PTS-STARTPTS[a${i}]`)
      } else {
        filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${c.duration}[a${i}]`)
      }
    }
    const aConcatLabels = clipPaths.map((_, i) => `[a${i}]`).join('')
    filterParts.push(`${aConcatLabels}concat=n=${clipPaths.length}:v=0:a=1[aconcat]`)
    filterParts.push(`[aconcat]volume=${(broll_volume / 100).toFixed(3)}[aducked]`)
    filterParts.push(`[aducked][${narrationInputIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]`)
    audioMapTarget = '[aout]'
  }

  args.push('-filter_complex', filterParts.join(';'))
  args.push('-map', finalVideoLabel)
  args.push('-map', audioMapTarget)
  // Encoder
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', String(targetFps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest', // stop when narration ends (clips already pad past it)
    '-movflags', '+faststart',
    tempPath,
  )

  if (wantMix) {
    const withAudio = clipHasAudio.filter(Boolean).length
    job.output_lines.push(
      `B-Roll audio: ${broll_volume}% (mixed under narration). ` +
      `${withAudio}/${clipPaths.length} clip(s) have audio; rest filled with silence.`,
    )
  } else {
    job.output_lines.push(`B-Roll audio: muted (narration-only mix)`)
  }
  if (subPath) {
    job.output_lines.push(`Subtitles: burning ${path.basename(subPath)} into the final frame.`)
  }
  job.output_lines.push(`Encoding ${clipPaths.length} clip(s) → ${outFilename}…`)

  const ffmpeg = await getFFmpegPath()
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args)
    let stderr = ''
    proc.stderr.on('data', (d) => {
      const s = String(d)
      stderr += s
      const tMatch = /time=([\d:.]+)/.exec(s)
      if (tMatch) {
        const last = job.output_lines[job.output_lines.length - 1] || ''
        if (!last.startsWith('  progress:')) job.output_lines.push(`  progress: ${tMatch[1]}`)
        else job.output_lines[job.output_lines.length - 1] = `  progress: ${tMatch[1]}`
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))
    })
    const cancelWatcher = setInterval(() => {
      if (jq.isCancelled(job.job_id)) { proc.kill('SIGTERM'); clearInterval(cancelWatcher) }
    }, 500)
    proc.on('close', () => clearInterval(cancelWatcher))
  })

  // Atomic rename so a half-encoded file never appears as final.
  await fsp.rename(tempPath, outPath)
  const stat = await fsp.stat(outPath)
  job.output_lines.push(`Done → ${outFilename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  job.output_dir = paths.video_dir

  // Append usage log (per-channel) — for cross-episode repeat avoidance.
  await appendUsageLog(project_slug, episode_id, sidecar.selection)
}

async function findNarrationPath(mergedDir: string, audioDir: string): Promise<string | null> {
  const candidates: Array<{ p: string }> = []
  if (existsSync(mergedDir)) {
    const files = await fsp.readdir(mergedDir).catch(() => [])
    for (const f of files) if (/\.(mp3|wav|m4a)$/i.test(f) && !f.startsWith('.tmp_')) candidates.push({ p: path.join(mergedDir, f) })
  }
  if (!candidates.length && existsSync(audioDir)) {
    const files = await fsp.readdir(audioDir).catch(() => [])
    for (const f of files) if (/\.mp3$/i.test(f) && !f.startsWith('.tmp_')) candidates.push({ p: path.join(audioDir, f) })
  }
  if (!candidates.length) return null
  // Prefer the largest file as a proxy for "the full / merged track."
  let best: { p: string; size: number } | null = null
  for (const c of candidates) {
    const stat = await fsp.stat(c.p).catch(() => null)
    if (!stat) continue
    if (!best || stat.size > best.size) best = { p: c.p, size: stat.size }
  }
  return best?.p || null
}

async function appendUsageLog(
  slug: string,
  episodeCode: string,
  selection: Array<{ filename: string; sha256: string }>,
): Promise<void> {
  const cfg = await pm.getConfig(slug)
  if (!cfg) return
  const existing: BrollUsageEntry[] = Array.isArray((cfg as any).broll_usage_log)
    ? (cfg as any).broll_usage_log
    : []
  const now = new Date().toISOString()
  // One entry per unique sha in this selection — duplicates within one
  // sequence don't need separate log entries.
  const seen = new Set<string>()
  const additions: BrollUsageEntry[] = []
  for (const s of selection) {
    if (seen.has(s.sha256)) continue
    seen.add(s.sha256)
    additions.push({ clip_sha: s.sha256, clip_filename: s.filename, episode_code: episodeCode, used_at: now })
  }
  // Truncate to 3× the configured lookback (default 30 entries) so a
  // future lookback bump still has history to consult.
  const cap = Math.max(30, ((cfg as any).broll_lookback ?? 10) * 3)
  const merged = [...existing, ...additions].slice(-cap)
  await pm.updateConfig(slug, { broll_usage_log: merged } as any)
}
