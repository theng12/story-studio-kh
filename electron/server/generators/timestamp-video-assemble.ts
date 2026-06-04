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
  /** v1.0.265 — optional A/V controls (all additive; absent = current behavior). */
  music?: { path?: string; volume?: number; fade?: number }
  ambient?: { path?: string; volume?: number; fade?: number }
  subtitles?: { enabled?: boolean; position?: 'bottom' | 'center' | 'top'; font_size?: number; color?: string; outline?: number }
  export_settings?: { resolution?: '720p' | '1080p' | '1440p' | '4k'; fps?: number; crf?: number }
  transition?: { type?: 'none' | 'crossfade' | 'fadeblack' | 'dissolve'; duration?: number }
}

const MIN_SCENE_DURATION_SEC = 0.5

// v1.0.265 — export resolution presets (w, h). Default 1080p matches the prior
// hardcoded 1920×1080.
const RES_PRESETS: Record<string, [number, number]> = {
  '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '4k': [3840, 2160],
}
// Map a UI transition type → xfade keyword. 'crossfade' = a straight dissolve.
const XFADE_KEYWORD: Record<string, string> = {
  crossfade: 'fade', fadeblack: 'fadeblack', dissolve: 'dissolve',
}

/** SRT/ASS force_style alignment (libass legacy SSA numbering). */
function alignmentFor(pos: string): number {
  if (pos === 'top') return 6
  if (pos === 'center') return 10
  return 2 // bottom-center (default)
}
/** #RRGGBB → ASS &HAABBGGRR (opaque). Falls back to white on bad input. */
function hexToAssColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '')
  if (!m) return '&H00FFFFFF'
  const rr = m[1]!.slice(0, 2), gg = m[1]!.slice(2, 4), bb = m[1]!.slice(4, 6)
  return `&H00${bb}${gg}${rr}`.toUpperCase()
}

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

  const ffmpeg = await getFFmpegPath()
  function escapeForSubtitlesFilter(p: string): string {
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  }
  const clamp = (v: any, lo: number, hi: number, dflt: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
  }

  // ── Resolve A/V controls (v1.0.265 — all opt-in; absent = prior behavior) ──
  const [W, H] = RES_PRESETS[params.export_settings?.resolution || '1080p'] || RES_PRESETS['1080p']!
  const fps = Math.round(clamp(params.export_settings?.fps, 1, 60, 30))
  const crf = Math.round(clamp(params.export_settings?.crf, 0, 51, 20))

  const subsOn = hasSubtitles && params.subtitles?.enabled !== false
  const musicPath = params.music?.path && existsSync(params.music.path) ? params.music.path : ''
  if (params.music?.path && !musicPath) job.output_lines.push(`⚠ Music file not found: ${params.music.path} — skipping.`)
  const ambientPath = params.ambient?.path && existsSync(params.ambient.path) ? params.ambient.path : ''
  if (params.ambient?.path && !ambientPath) job.output_lines.push(`⚠ Ambient file not found: ${params.ambient.path} — skipping.`)
  const musicVol = clamp(params.music?.volume, 0, 2, 0.15)
  const ambientVol = clamp(params.ambient?.volume, 0, 2, 0.12)
  const musicFade = clamp(params.music?.fade, 0, 15, 2)
  const ambientFade = clamp(params.ambient?.fade, 0, 15, 2)
  const hasBeds = !!(musicPath || ambientPath)

  const durOf = (s: ScenePlan['scenes'][number]) => Math.max(MIN_SCENE_DURATION_SEC, s.end_sec - s.start_sec)
  const totalDur = Math.max(1, plan.scenes.reduce((a, s) => a + durOf(s), 0))

  const transType = params.transition?.type && params.transition.type !== 'none' ? params.transition.type : 'none'
  const xfadeKw = XFADE_KEYWORD[transType]
  const transDur = clamp(params.transition?.duration, 0.1, 3, 0.5)
  // xfade needs ≥2 scenes; otherwise fall back to the (faster) concat path.
  const useXfade = !!xfadeKw && plan.scenes.length >= 2
  if (useXfade && plan.scenes.length > 60) {
    job.output_lines.push(`Note: transitions re-encode ${plan.scenes.length} image inputs with overlaps — this is slower + heavier than hard cuts.`)
  }

  // Subtitle burn fragment (copy SRT to a clean temp path; force_style for
  // placement/size/colour). v1.0.264 temp-copy avoids path-escaping failures.
  let subsTempPath = ''
  let subFragment = ''
  if (subsOn) {
    subsTempPath = path.join(os.tmpdir(), `ssk-subs-${Date.now()}.srt`)
    await fs.copyFile(stitchedSrt, subsTempPath)
    const sp = params.subtitles || {}
    const style = [
      `Alignment=${alignmentFor(sp.position || 'bottom')}`,
      `FontSize=${Math.round(clamp(sp.font_size, 8, 96, 24))}`,
      `PrimaryColour=${hexToAssColor(sp.color || '#FFFFFF')}`,
      `Outline=${Math.round(clamp(sp.outline, 0, 6, 2))}`,
    ].join(',')
    subFragment = `subtitles='${escapeForSubtitlesFilter(subsTempPath)}':force_style='${style}'`
    job.output_lines.push(`Subtitles: ${sp.position || 'bottom'}, size ${Math.round(clamp(sp.font_size, 8, 96, 24))}`)
  }

  job.output_lines.push(`Export: ${W}×${H} @ ${fps}fps (crf ${crf})${useXfade ? ` · ${transType} ${transDur}s` : ''}${hasBeds ? ' · with audio bed(s)' : ''}`)

  // ── Build the ffmpeg invocation ───────────────────────────────────
  // Three shapes, picked by which controls are on:
  //   simple    — concat demuxer + -vf (the proven default path)
  //   beds only — concat demuxer video + -filter_complex audio mix
  //   xfade     — per-image inputs + xfade chain (+ optional audio mix)
  const vBase = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`

  // Concat list (used by the non-xfade paths).
  let concatListPath = ''
  if (!useXfade) {
    const concatLines: string[] = []
    for (const s of plan.scenes) {
      const imgPath = path.join(imageDir, `${s.id}.png`)
      concatLines.push(`file '${imgPath.replace(/'/g, `'\\''`)}'`)
      concatLines.push(`duration ${durOf(s).toFixed(3)}`)
    }
    const last = plan.scenes[plan.scenes.length - 1]!
    concatLines.push(`file '${path.join(imageDir, `${last.id}.png`).replace(/'/g, `'\\''`)}'`)
    concatListPath = path.join(finalDir, `.tmp-${Date.now()}-concat-list.txt`)
    await fs.writeFile(concatListPath, concatLines.join('\n') + '\n', 'utf-8')
    job.output_lines.push(`Built concat list with ${plan.scenes.length} scene(s)`)
  }

  // Audio-mix fragment + map target (shared by beds-enabled paths). narrIdx is
  // the narration input's index; beds (music/ambient) follow it.
  const narrIdx = useXfade ? plan.scenes.length : 1
  function buildAudioMix(): { fc: string; map: string; extraInputs: string[] } {
    if (!hasBeds) return { fc: '', map: `${narrIdx}:a`, extraInputs: [] }
    const extraInputs: string[] = []
    const parts: string[] = [`[${narrIdx}:a]aresample=async=1[a_narr]`]
    const mixLabels = ['[a_narr]']
    let idx = narrIdx + 1
    if (musicPath) {
      extraInputs.push('-i', musicPath)
      parts.push(`[${idx}:a]aloop=loop=-1:size=2147483647,atrim=0:${totalDur.toFixed(3)},volume=${musicVol},afade=t=in:st=0:d=${musicFade},afade=t=out:st=${Math.max(0, totalDur - musicFade).toFixed(3)}:d=${musicFade}[a_mus]`)
      mixLabels.push('[a_mus]'); idx++
    }
    if (ambientPath) {
      extraInputs.push('-i', ambientPath)
      parts.push(`[${idx}:a]aloop=loop=-1:size=2147483647,atrim=0:${totalDur.toFixed(3)},volume=${ambientVol},afade=t=in:st=0:d=${ambientFade},afade=t=out:st=${Math.max(0, totalDur - ambientFade).toFixed(3)}:d=${ambientFade}[a_amb]`)
      mixLabels.push('[a_amb]'); idx++
    }
    parts.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:duration=first[aout]`)
    return { fc: parts.join(';'), map: '[aout]', extraInputs }
  }

  const audio = buildAudioMix()
  let args: string[]

  if (!useXfade && !hasBeds) {
    // SIMPLE — the proven default path (now parameterized for export + subs).
    const vf = subFragment ? `${vBase},${subFragment}` : vBase
    args = [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-i', audioPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tempPath,
    ]
  } else if (!useXfade) {
    // CONCAT video + audio mix → filter_complex.
    const vOut = subFragment ? `[0:v]${vBase},${subFragment}[vout]` : `[0:v]${vBase}[vout]`
    const fc = [vOut, audio.fc].filter(Boolean).join(';')
    args = [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-i', audioPath,
      ...audio.extraInputs,
      '-filter_complex', fc, '-map', '[vout]', '-map', audio.map,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tempPath,
    ]
  } else {
    // XFADE — per-image inputs + variable-offset crossfade chain. Each input is
    // its window + the transition duration so the dissolve overlaps WITHOUT
    // stealing time: xfade offset = the scene's cumulative window start, so each
    // scene still begins on its timestamp. Total ≈ audio length (-shortest trims).
    const imageInputs: string[] = []
    const vParts: string[] = []
    let cum = 0
    const starts: number[] = []
    for (let i = 0; i < plan.scenes.length; i++) {
      const s = plan.scenes[i]!
      starts.push(cum)
      cum += durOf(s)
      imageInputs.push('-loop', '1', '-t', (durOf(s) + transDur).toFixed(3), '-i', path.join(imageDir, `${s.id}.png`))
      vParts.push(`[${i}:v]${vBase},fps=${fps},format=yuv420p,settb=AVTB[v${i}]`)
    }
    // Chain xfades; offset of the i-th boundary = start time of scene i+1.
    let prev = 'v0'
    for (let i = 0; i < plan.scenes.length - 1; i++) {
      const isLast = i === plan.scenes.length - 2
      const out = (isLast && !subFragment) ? 'vout' : `xf${i}`
      vParts.push(`[${prev}][v${i + 1}]xfade=transition=${xfadeKw}:duration=${transDur}:offset=${starts[i + 1]!.toFixed(3)}[${out}]`)
      prev = out
    }
    if (subFragment) vParts.push(`[${prev}]${subFragment}[vout]`)
    const fc = [vParts.join(';'), audio.fc].filter(Boolean).join(';')
    args = [
      '-y', ...imageInputs, '-i', audioPath, ...audio.extraInputs,
      '-filter_complex', fc, '-map', '[vout]', '-map', audio.map,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tempPath,
    ]
  }

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
    if (concatListPath) await fs.rm(concatListPath, { force: true }).catch(() => {})
    if (subsTempPath) await fs.rm(subsTempPath, { force: true }).catch(() => {})
    throw err
  }

  // Atomic rename + temp cleanup on success.
  await fs.rename(tempPath, outPath)
  if (concatListPath) await fs.rm(concatListPath, { force: true }).catch(() => {})
  if (subsTempPath) await fs.rm(subsTempPath, { force: true }).catch(() => {})
  const stat = await fs.stat(outPath)
  job.output_lines.push(`Done → ${outFilename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  job.output_dir = finalDir
}
