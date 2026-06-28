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
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir } from './scene-image.js'
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
  /**
   * v1.0.363 — set by the unattended Pipeline when "run all the way to final
   * video" is selected. There's no human at Scene Review to greenlight scenes,
   * so the assembler auto-approves every scene that already has a rendered
   * image. Absent / false keeps the manual greenlight gate (the page never
   * sends this — it pre-flights approval on the route).
   */
  auto_approve?: boolean
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
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) {
    throw new Error('scene_plan.json missing — run Scene Plan first.')
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  if (!plan.scenes.length) throw new Error('scene_plan.json has no scenes')

  // Pipeline auto-approve (v1.0.363). When the Pipeline drives this step in
  // "run all the way to final video" mode there's no human at Scene Review to
  // greenlight scenes — so honour the explicit `auto_approve` signal by
  // greenlighting every scene, persisting the plan, then continuing into the
  // gates below. The missing-image check still guards against an incomplete
  // render, so this trusts the render without skipping safety.
  if (params.auto_approve === true) {
    let approvedNow = 0
    for (const s of plan.scenes) {
      if (!s.approved) { s.approved = true; approvedNow++ }
    }
    if (approvedNow > 0) {
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
      job.output_lines.push(`Auto-approved ${approvedNow}/${plan.scenes.length} scene(s) (pipeline run).`)
    }
  }

  // Greenlight enforcement (v1.0.144 produced the flag; this is where
  // the assembler honours it).
  const notApproved = plan.scenes.filter(s => !s.approved)
  if (notApproved.length > 0) {
    throw new Error(
      `Refused to assemble — ${notApproved.length}/${plan.scenes.length} scene(s) not yet approved. ` +
      `Open Scene Review and approve every scene before rendering.`,
    )
  }

  // Verify every scene has a real image on disk. v1.0.457 — images now live in
  // the unified named folder; resolve each per-scene (named first, legacy flat
  // fallback) so both consolidated and not-yet-consolidated episodes assemble.
  const namedSceneDir = await resolveSceneImagesDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  const legacySceneDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
  const imgFor = (id: string): string => {
    const n = path.join(namedSceneDir, `${id}.png`)
    return existsSync(n) ? n : path.join(legacySceneDir, `${id}.png`)
  }
  const missingImages: string[] = []
  for (const s of plan.scenes) {
    if (!existsSync(imgFor(s.id))) missingImages.push(`#${s.scene_index} (${s.id})`)
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
  // Clamp the transition so it never meets/exceeds the shortest scene window —
  // an overlap >= a window produces negative offsets / overlapping blends.
  const minWin = plan.scenes.reduce((m, s) => Math.min(m, durOf(s)), Infinity)
  const transDur = Math.min(clamp(params.transition?.duration, 0.1, 3, 0.5), Math.max(0.1, minWin - 0.1))
  // xfade needs ≥2 scenes; otherwise fall back to the (faster) concat path.
  const useXfade = !!xfadeKw && plan.scenes.length >= 2

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
      const imgPath = imgFor(s.id)
      concatLines.push(`file '${imgPath.replace(/'/g, `'\\''`)}'`)
      concatLines.push(`duration ${durOf(s).toFixed(3)}`)
    }
    const last = plan.scenes[plan.scenes.length - 1]!
    concatLines.push(`file '${imgFor(last.id).replace(/'/g, `'\\''`)}'`)
    concatListPath = path.join(finalDir, `.tmp-${Date.now()}-concat-list.txt`)
    await fs.writeFile(concatListPath, concatLines.join('\n') + '\n', 'utf-8')
    job.output_lines.push(`Built concat list with ${plan.scenes.length} scene(s)`)
  }

  // Audio-mix fragment + map target (shared by beds-enabled paths). The final
  // mux always has ONE video input (input 0) — images-concat for hard cuts, or
  // the concatenated transition chunks — so narration is always input 1, and
  // beds (music/ambient) follow it.
  const narrIdx = 1
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

  // Reusable ffmpeg runner with live progress + cancel handling.
  async function runFfmpeg(ffargs: string[], progressLabel = ''): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, ffargs)
      let stderr = ''
      proc.stderr.on('data', (d) => {
        const s = String(d); stderr += s
        const tMatch = /time=([\d:.]+)/.exec(s)
        if (tMatch) {
          const line = `  ${progressLabel}progress: ${tMatch[1]}`
          const last = job.output_lines[job.output_lines.length - 1] || ''
          if (!last.startsWith(`  ${progressLabel}progress:`)) job.output_lines.push(line)
          else job.output_lines[job.output_lines.length - 1] = line
        }
      })
      proc.on('error', reject)
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)))
      const cw = setInterval(() => { if (jq.isCancelled(job.job_id)) { proc.kill('SIGTERM'); clearInterval(cw) } }, 500)
      proc.on('close', () => clearInterval(cw))
    })
  }

  const chunkFiles: string[] = []
  let chunkListPath = ''
  try {
    // ── Transitions: render in CHUNKS (a single N-input xfade graph fails past
    // ~200 inputs — confirmed on 277 scenes). Each chunk is its own xfade pass at
    // the export size, encoded near-lossless (crf 18) as an intermediate; chunk
    // seams are hard cuts. Skipped entirely when transitions are off.
    if (useXfade) {
      const CHUNK = 60
      job.output_lines.push(`Transitions on (${transType} ${transDur}s) — rendering ${plan.scenes.length} scene(s) in chunks of ${CHUNK}.`)
      const chunkCount = Math.ceil(plan.scenes.length / CHUNK)
      for (let c = 0; c < chunkCount; c++) {
        if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
        const slice = plan.scenes.slice(c * CHUNK, c * CHUNK + CHUNK)
        const chunkPath = path.join(finalDir, `.tmp-${Date.now()}-chunk-${c}.mp4`)
        chunkFiles.push(chunkPath)
        if (slice.length === 1) {
          // Lone trailing scene — a still at the export size (no xfade possible).
          await runFfmpeg([
            '-y', '-loop', '1', '-t', durOf(slice[0]!).toFixed(3), '-i', imgFor(slice[0]!.id),
            '-vf', `${vBase},fps=${fps},format=yuv420p`,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), chunkPath,
          ], `chunk ${c + 1}/${chunkCount} `)
          continue
        }
        const inputs: string[] = []
        const vp: string[] = []
        let lcum = 0; const lstarts: number[] = []
        for (let i = 0; i < slice.length; i++) {
          lstarts.push(lcum); lcum += durOf(slice[i]!)
          inputs.push('-loop', '1', '-t', (durOf(slice[i]!) + transDur).toFixed(3), '-i', imgFor(slice[i]!.id))
          vp.push(`[${i}:v]${vBase},fps=${fps},format=yuv420p,settb=AVTB[v${i}]`)
        }
        // Variable-offset xfade chain (local to the chunk). offset of the i-th
        // boundary = next scene's window start − transDur, so the dissolve
        // completes on its timestamp and the chunk length == sum of its windows.
        let prev = 'v0'
        for (let i = 0; i < slice.length - 1; i++) {
          const out = (i === slice.length - 2) ? 'vout' : `xf${i}`
          const offset = Math.max(0, lstarts[i + 1]! - transDur)
          vp.push(`[${prev}][v${i + 1}]xfade=transition=${xfadeKw}:duration=${transDur}:offset=${offset.toFixed(3)}[${out}]`)
          prev = out
        }
        await runFfmpeg([
          '-y', ...inputs, '-filter_complex', vp.join(';'), '-map', '[vout]',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), chunkPath,
        ], `chunk ${c + 1}/${chunkCount} `)
      }
      chunkListPath = path.join(finalDir, `.tmp-${Date.now()}-chunklist.txt`)
      await fs.writeFile(chunkListPath, chunkFiles.map(f => `file '${f.replace(/'/g, `'\\''`)}'`).join('\n') + '\n', 'utf-8')
    }

    // ── Final mux: ONE video input (images-concat for hard cuts, or the
    // transition chunks) + subtitles + narration/beds. The chunk videos are
    // already scaled, so the video is stream-copied unless subtitles must be
    // burned; images always need scale+encode.
    job.output_lines.push('Encoding…')
    const videoInput = useXfade
      ? ['-f', 'concat', '-safe', '0', '-i', chunkListPath]
      : ['-f', 'concat', '-safe', '0', '-i', concatListPath]
    const needScale = !useXfade
    const reencodeVideo = needScale || !!subFragment
    const finalArgs: string[] = ['-y', ...videoInput, '-i', audioPath, ...audio.extraInputs]
    if (reencodeVideo) {
      const vchain = [needScale ? vBase : '', subFragment].filter(Boolean).join(',')
      if (hasBeds) {
        finalArgs.push('-filter_complex', [`[0:v]${vchain}[vout]`, audio.fc].join(';'), '-map', '[vout]', '-map', audio.map)
      } else {
        finalArgs.push('-vf', vchain) // 2 inputs → auto-maps video[0] + narration[1]
      }
      finalArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps))
    } else {
      // Transitions + no subtitles → copy the already-encoded chunk video.
      if (hasBeds) finalArgs.push('-filter_complex', audio.fc, '-map', '0:v', '-map', audio.map)
      finalArgs.push('-c:v', 'copy')
    }
    finalArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tempPath)
    await runFfmpeg(finalArgs)
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    if (concatListPath) await fs.rm(concatListPath, { force: true }).catch(() => {})
    if (chunkListPath) await fs.rm(chunkListPath, { force: true }).catch(() => {})
    for (const f of chunkFiles) await fs.rm(f, { force: true }).catch(() => {})
    if (subsTempPath) await fs.rm(subsTempPath, { force: true }).catch(() => {})
    throw err
  }

  // Atomic rename + temp cleanup on success.
  await fs.rename(tempPath, outPath)
  if (concatListPath) await fs.rm(concatListPath, { force: true }).catch(() => {})
  if (chunkListPath) await fs.rm(chunkListPath, { force: true }).catch(() => {})
  for (const f of chunkFiles) await fs.rm(f, { force: true }).catch(() => {})
  if (subsTempPath) await fs.rm(subsTempPath, { force: true }).catch(() => {})
  const stat = await fs.stat(outPath)
  job.output_lines.push(`Done → ${outFilename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  job.output_dir = finalDir
}
