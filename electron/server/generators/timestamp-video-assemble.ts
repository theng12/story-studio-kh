/**
 * Timestamp-driven video assembler (v1.0.145+). Final step of the
 * timestamp-driven pipeline:
 *   research → script → audio → stitch subs → scene plan → scene review → ASSEMBLE
 *
 * Inputs:
 *   - scene_plan.json (approved scenes with image_path + start/end)
 *   - <episode_dir>/merged_audio/<largest>.mp3 (the merged narration)
 *   - subtitles/<code>_stitched.srt (optional — burned in if present)
 *
 * Output: <output_dir>/<code>_timestamp.mp4 where output_dir is the
 * external_final_video_root if configured (v1.0.130 pattern), else the
 * project tree's Video Assembly Output.
 *
 * ffmpeg approach: concat demuxer for video (each image looped for its
 * scene duration) + the merged audio as a separate input + optional
 * subtitles filter for burn-in. Single ffmpeg invocation, no per-scene
 * sub-renders — keeps it fast even for long episodes.
 *
 * Approval gate: refuses to render if scene_plan.stats.all_approved is
 * false. This is the v1.0.144 greenlight enforcement.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import { SCENE_IMAGES_SUBFOLDER } from './scene-image.js'
import type { Job, ScenePlan } from '../models/types.js'

interface TimestampAssembleParams {
  episode_id: string
  title?: string
}

const MIN_SCENE_DURATION_SEC = 0.5

export async function runTimestampVideoAssemble(job: Job): Promise<void> {
  const params = job.params as TimestampAssembleParams
  const { episode_id } = params
  if (!episode_id) throw new Error('episode_id is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)

  // ── Load + validate scene plan ────────────────────────────────────
  const planPath = path.join(paths.episode_dir, SCENE_PLAN_FILENAME)
  if (!existsSync(planPath)) {
    throw new Error('scene_plan.json missing — run Scene Plan first.')
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  if (!plan.scenes.length) throw new Error('scene_plan.json has no scenes')

  // Greenlight enforcement (v1.0.144 produced the flag; this is where
  // the assembler honours it).
  const notApproved = plan.scenes.filter(s => !s.approved)
  if (notApproved.length > 0) {
    throw new Error(
      `Refused to assemble — ${notApproved.length}/${plan.scenes.length} scene(s) not yet approved. ` +
      `Open Scene Review and approve every scene before rendering.`,
    )
  }

  // Verify every scene has a real image on disk.
  const imageDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
  const missingImages: string[] = []
  for (const s of plan.scenes) {
    const imgPath = path.join(imageDir, `${s.id}.png`)
    if (!existsSync(imgPath)) missingImages.push(`#${s.scene_index} (${s.id})`)
  }
  if (missingImages.length > 0) {
    throw new Error(`Missing images for: ${missingImages.join(', ')}. Regenerate before assembling.`)
  }

  // ── Locate merged audio ───────────────────────────────────────────
  if (!existsSync(paths.merged_audio_dir)) {
    throw new Error('merged audio dir missing — run Audio Assembly first.')
  }
  let audioPath: string | null = null
  let bestSize = 0
  const audioFiles = await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])
  for (const f of audioFiles) {
    if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
    const stat = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
    if (stat && stat.size > bestSize) {
      bestSize = stat.size
      audioPath = path.join(paths.merged_audio_dir, f)
    }
  }
  if (!audioPath) throw new Error('No merged audio file found in merged_audio dir.')

  // ── Optional stitched SRT for burn-in ─────────────────────────────
  const stitchedSrt = path.join(paths.subtitles_dir, `${episode_id.toUpperCase()}_stitched.srt`)
  const hasSubtitles = existsSync(stitchedSrt)

  job.output_lines.push(`Scenes: ${plan.scenes.length}, total ${plan.total_duration_sec.toFixed(1)}s`)
  job.output_lines.push(`Audio: ${path.basename(audioPath)}`)
  if (hasSubtitles) job.output_lines.push(`Subtitles: burning ${path.basename(stitchedSrt)}`)
  job.progress = 10

  // ── Resolve output dir (mirrors v1.0.130 broll pattern) ──────────
  const outFilename = `${episode_id.toUpperCase()}_timestamp.mp4`
  let finalDir = paths.video_dir
  try {
    const { ensureExternalFinalVideoDir, externalRootIsReachable } = await import('../services/external-video-store.js')
    // v1.0.264 — only use the external root when it ACTUALLY EXISTS on THIS
    // machine. A root configured on another Mac (e.g. /Users/<old-user>/…) is a
    // dead path here — using it makes ffmpeg fail with "No such file or
    // directory". Fall back to the in-project video folder + warn instead.
    const reach = await externalRootIsReachable()
    if (reach.ok) {
      const externalDir = await ensureExternalFinalVideoDir(job.project_slug, episode_id, params.title || '')
      if (externalDir) {
        finalDir = externalDir
        job.output_lines.push(`External final-video root → ${finalDir}`)
      }
    } else if (reach.root) {
      job.output_lines.push(
        `⚠ External final-video root not found on this machine (${reach.root}) — saving to the project folder instead. ` +
        `Update it in Settings → Storage if you want an external location.`,
      )
    }
  } catch (e: any) {
    job.output_lines.push(`External path resolve failed (${e?.message || e}); using project tree`)
  }
  // Create the target dir; if that fails (permissions / unmounted drive), fall
  // back to the in-project video folder so the export still completes.
  try {
    await fs.mkdir(finalDir, { recursive: true })
  } catch (e: any) {
    job.output_lines.push(`⚠ Couldn't create ${finalDir} (${e?.message || e}); falling back to the project folder.`)
    finalDir = paths.video_dir
    await fs.mkdir(finalDir, { recursive: true })
  }
  const outPath = path.join(finalDir, outFilename)
  const tempPath = path.join(finalDir, `.tmp-${Date.now()}-${outFilename}`)

  // Startup cleanup of stale temp orphans for this episode (1.0.130 pattern).
  try {
    const existing = await fs.readdir(finalDir).catch(() => [] as string[])
    for (const f of existing) {
      if (!f.startsWith('.tmp-') || !f.endsWith(outFilename)) continue
      const full = path.join(finalDir, f)
      if (full === tempPath) continue
      await fs.rm(full, { force: true }).catch(() => { /* best effort */ })
      job.output_lines.push(`Cleaned up stale temp file: ${f}`)
    }
  } catch { /* swallow */ }

  // ── Build concat-demuxer list ─────────────────────────────────────
  // The concat demuxer wants:
  //   file '/abs/path/image.png'
  //   duration 4.500
  //   ...
  //   file '/abs/path/last_image.png'    ← repeated, ffmpeg quirk
  //
  // Each scene's duration is the SRT-snapped end - start window.
  const concatLines: string[] = []
  for (const s of plan.scenes) {
    const imgPath = path.join(imageDir, `${s.id}.png`)
    const duration = Math.max(MIN_SCENE_DURATION_SEC, s.end_sec - s.start_sec)
    concatLines.push(`file '${imgPath.replace(/'/g, `'\\''`)}'`)
    concatLines.push(`duration ${duration.toFixed(3)}`)
  }
  // Final scene needs its file line repeated without a duration so the
  // concat demuxer doesn't truncate it.
  const last = plan.scenes[plan.scenes.length - 1]!
  concatLines.push(`file '${path.join(imageDir, `${last.id}.png`).replace(/'/g, `'\\''`)}'`)
  const concatListPath = path.join(finalDir, `.tmp-${Date.now()}-concat-list.txt`)
  await fs.writeFile(concatListPath, concatLines.join('\n') + '\n', 'utf-8')
  job.output_lines.push(`Built concat list with ${plan.scenes.length} scene(s)`)

  // ── ffmpeg invocation ─────────────────────────────────────────────
  // Args:
  //   -f concat -safe 0 -i concat-list.txt          (video from images)
  //   -i merged.mp3                                  (audio)
  //   -vf [scale + optional subtitles burn]
  //   -c:v libx264 -pix_fmt yuv420p -r 30
  //   -c:a aac -b:a 192k
  //   -shortest                                       (stop at audio end)
  //   -movflags +faststart
  //   tempPath
  const ffmpeg = await getFFmpegPath()
  function escapeForSubtitlesFilter(p: string): string {
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  }
  const vfilters: string[] = [
    'scale=1920:1080:force_original_aspect_ratio=decrease',
    'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
    'setsar=1',
  ]
  // v1.0.264 — the subtitles filter is brutal about special characters in the
  // path (spaces, parentheses, and especially apostrophes — e.g. an episode
  // titled "…Shackleton's Crew…"). Rather than escape the project path, copy the
  // SRT to a clean temp file (ASCII, no spaces/quotes) and burn THAT in. Avoids
  // the whole filtergraph-init class of failures regardless of the project path.
  let subsTempPath = ''
  if (hasSubtitles) {
    subsTempPath = path.join(os.tmpdir(), `ssk-subs-${Date.now()}.srt`)
    await fs.copyFile(stitchedSrt, subsTempPath)
    vfilters.push(`subtitles='${escapeForSubtitlesFilter(subsTempPath)}'`)
  }
  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-i', audioPath,
    '-vf', vfilters.join(','),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    tempPath,
  ]

  job.output_lines.push('Encoding…')
  try {
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
  } catch (err) {
    // Error-path cleanup (1.0.130 pattern).
    await fs.rm(tempPath, { force: true }).catch(() => {})
    await fs.rm(concatListPath, { force: true }).catch(() => {})
    if (subsTempPath) await fs.rm(subsTempPath, { force: true }).catch(() => {})
    throw err
  }

  // Atomic rename + concat-list cleanup on success.
  await fs.rename(tempPath, outPath)
  await fs.rm(concatListPath, { force: true }).catch(() => {})
  if (subsTempPath) await fs.rm(subsTempPath, { force: true }).catch(() => {})
  const stat = await fs.stat(outPath)
  job.output_lines.push(`Done → ${outFilename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  job.output_dir = finalDir
}
