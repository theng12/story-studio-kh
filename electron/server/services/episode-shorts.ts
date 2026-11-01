import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { callAi } from '../lib/ai-client.js'
import { JSON_OBJECT_OUTPUT_CONTRACT } from '../lib/json-output-contract.js'
import { parseSrt, type SrtCue } from '../lib/subtitle-builder.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { getMediaInfo } from '../lib/ffmpeg-validation.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import type { Job } from '../models/types.js'
import * as pm from './project-manager.js'
import * as jq from './job-queue.js'
import { getIdeas } from './idea-manager.js'
import { resolveEpisodePathsByCode } from './utils.js'
import { resolveTranscriptSrtPath } from './subtitle-correction.js'
import { findYouTubeSourceVideoPath } from './youtube-source-video.js'
import { videoAssemblySourceStampPath } from './video-visual-source.js'
import { resolveExactPreset } from './preset-authority.js'

export interface ShortMoment { start: number; end: number; title: string; reason: string }
export function shortsPerEpisode(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0
}

export function validateShortMoments(raw: string, cues: SrtCue[], count: number): ShortMoment[] {
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { throw new Error('Shorts selection is not valid JSON. Retry to choose passages again.') }
  const rows = parsed?.shorts
  if (!Array.isArray(rows) || rows.length !== count) throw new Error(`Shorts selection must contain exactly ${count} passages.`)
  const valid = cues.filter(c => Number.isFinite(c.start_sec) && Number.isFinite(c.end_sec) && c.end_sec > c.start_sec && c.text.trim())
  if (!valid.length) throw new Error('The stitched transcript contains no timed passages.')
  const min = Math.min(...valid.map(c => c.start_sec)), max = Math.max(...valid.map(c => c.end_sec))
  const nearest = (value: number, points: number[]) => points.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a)
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < i; j++) {
    if (typeof rows[i]?.start === 'number' && typeof rows[i]?.end === 'number' && rows[i].start < rows[j]?.end && rows[j]?.start < rows[i].end) throw new Error(`Short ${i + 1} overlaps Short ${j + 1}.`)
  }
  const result: ShortMoment[] = rows.map((row: any, index: number) => {
    const label = `Short ${index + 1}`
    if (typeof row?.start !== 'number' || typeof row?.end !== 'number' || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < min || row.end > max || row.end <= row.start) throw new Error(`${label} has invalid or out-of-range timestamps.`)
    if (typeof row.title !== 'string' || !row.title.trim() || typeof row.reason !== 'string' || !row.reason.trim()) throw new Error(`${label} needs a title and reason.`)
    if (row.end - row.start < 20 || row.end - row.start > 58) throw new Error(`${label} must be 20–58 seconds.`)
    const start = nearest(row.start, valid.map(c => c.start_sec)), end = nearest(row.end, valid.map(c => c.end_sec))
    if (end - start < 20 || end - start > 58) throw new Error(`${label} is ${Math.round((end - start) * 100) / 100}s after snapping; it must be 20–58 seconds.`)
    return { start, end, title: row.title.trim(), reason: row.reason.trim() }
  })
  for (let i = 0; i < result.length; i++) for (let j = 0; j < i; j++) {
    if (result[i]!.start < result[j]!.end && result[j]!.start < result[i]!.end) throw new Error(`Short ${i + 1} overlaps Short ${j + 1}.`)
  }
  return result
}

export async function narrationOffset(finalPath: string, code: string): Promise<number> {
  const stat = await fs.stat(finalPath)
  let stamp: any
  try { stamp = JSON.parse(await fs.readFile(videoAssemblySourceStampPath(finalPath, code), 'utf8')) } catch { throw new Error('The final video has no recorded narration timing. Render it again before making Shorts.') }
  if (stamp.final_video?.size !== stat.size || stamp.final_video?.mtime_ms !== Math.round(stat.mtimeMs) || typeof stamp.narration_offset_sec !== 'number' || !Number.isFinite(stamp.narration_offset_sec) || stamp.narration_offset_sec < 0) throw new Error('The final video narration timing is missing or belongs to another render. Render it again before making Shorts.')
  return stamp.narration_offset_sec
}

export async function verifyShort(file: string, duration: number, probe = getMediaInfo): Promise<string | null> {
  try {
    const info = await probe(file)
    if (!info.hasVideo || info.width !== 1080 || info.height !== 1920) return 'wrong video size (expected 1080x1920)'
    if (!info.hasAudio) return 'audio is missing'
    if (!Number.isFinite(info.durationSec) || info.durationSec <= 0) return 'duration is missing'
    if (Math.abs(info.durationSec - duration) > 0.5 || (info.videoDurationSec !== undefined && Math.abs(info.videoDurationSec - duration) > 0.5)) return 'duration does not match the selected passage'
    return null
  } catch (error: any) { return `missing or unreadable (${error?.message || error})` }
}

export function trashPreviousShorts(dir: string, projectDir: string, slug: string): void {
  if (existsSync(dir)) moveToTrashSync(dir, path.join(trashRootFor(dir, projectDir, slug), 'shorts', path.basename(path.dirname(dir)), 'shorts'), 'shorts')
}

export async function enqueueEpisodeShorts(slug: string, code: string, count: number): Promise<Job> {
  return withLock(`episode-shorts:${slug}:${code.toUpperCase()}`, async () => {
    if (!pm.getProjectDir(slug)) throw Object.assign(new Error('Channel not found.'), { statusCode: 404 })
    const existing = (await jq.getJobs(slug, { type: 'episode_shorts' })).find(j => j.episode_id.toUpperCase() === code.toUpperCase() && ['queued', 'running', 'paused'].includes(j.status))
    if (existing) return existing
    return jq.enqueueOrRun({ project_slug: slug, episode_id: code.toUpperCase(), type: 'episode_shorts', title: 'Episode Shorts', params: { count } })
  })
}

export async function autoEnqueueEpisodeShorts(job: Job, slug: string, code: string): Promise<void> {
  const config = await pm.getConfig(slug)
  const count = shortsPerEpisode((config as any)?.shorts_per_episode)
  if (!count) return
  if ((job.result as any)?.final_check_error === true || (job.result as any)?.final_check?.passed !== true) throw new Error('the final check did not pass')
  const queued = await enqueueEpisodeShorts(slug, code, count)
  job.output_lines.push(`Shorts job ${queued.job_id} queued for ${count} passage(s).`)
}

export function shortCutArgs(source: string, file: string, moment: ShortMoment, offset: number): string[] {
  return ['-hide_banner', '-nostdin', '-ss', String(moment.start + offset), '-i', source, '-t', String(moment.end - moment.start), '-filter_complex', '[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:10[blur];[fg]scale=1080:-2[fit];[blur][fit]overlay=(W-w)/2:(H-h)/2[v]', '-map', '[v]', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', file]
}

export async function generateEpisodeShorts(job: Job): Promise<void> {
  const slug = job.project_slug, code = job.episode_id.toUpperCase()
  const count = shortsPerEpisode(job.params?.count)
  if (!count) throw new Error('Shorts count must be a whole number from 1 to 3.')
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new Error('Channel not found.')
  const paths = await resolveEpisodePathsByCode(slug, code)
  const ideas = await getIdeas(slug, 'accepted')
  const title = ideas.find(i => i.episode_code === code)?.title || ''
  const source = await findYouTubeSourceVideoPath(paths, slug, code, title)
  if (!source) throw new Error(`No finished final video found for ${code}. Render the episode first.`)
  const { readStoredFinalCheck } = await import('../lib/final-video-check.js')
  const check = await readStoredFinalCheck(source)
  if (!check || check.stale || !check.result.passed) throw new Error('The final video has not passed its current Final Check. Run Final Check before making Shorts.')
  const offset = await narrationOffset(source, code)
  const transcript = await resolveTranscriptSrtPath({ subtitles_dir: paths.subtitles_dir, script_dir: paths.script_dir, episode_code: code })
  const raw = await fs.readFile(transcript, 'utf8').catch(() => '')
  const cues = parseSrt(raw).filter(c => c.text.trim() && c.end_sec > c.start_sec)
  if (!cues.length) throw new Error(`No timed transcript found for ${code}. Stitch subtitles first.`)
  let stitch: any
  try { stitch = JSON.parse(await fs.readFile(path.join(paths.subtitles_dir, `${code}_stitched.srt.json`), 'utf8')) } catch { throw new Error('The transcript has no recorded audio timing. Re-stitch subtitles before making Shorts.') }
  const { resolveEpisodeIntroLeadIn } = await import('../lib/intro-lead-in.js')
  const lead = await resolveEpisodeIntroLeadIn(paths.episode_dir, paths.merged_audio_dir, code)
  if (lead.status !== 'measured' || stitch.lead_in_status !== 'measured' || stitch.lead_in_merged_file !== lead.merged_filename || typeof stitch.lead_in_sec !== 'number' || Math.abs(stitch.lead_in_sec - lead.seconds) > 0.05) throw new Error('The transcript timing cannot be matched to the current merged audio. Re-stitch subtitles and render the episode again before making Shorts.')
  const config = await pm.getConfig(slug)
  const { preset, missingReason } = resolveExactPreset(config, 'scene_plan_presets', ['scene_plan_last_preset_scene-plan', 'scene_plan_last_preset'], undefined, 'Scene Plan')
  const model = typeof preset?.data?.model === 'string' ? preset.data.model.trim() : ''
  if (!model) throw new Error(missingReason || 'The active Scene Plan preset has no writing model. Choose one in Scene Plan and retry.')
  const sourceInfo = await getMediaInfo(source)
  if (!sourceInfo.hasVideo || !sourceInfo.hasAudio) throw new Error('The final video must have both video and audio.')
  const sourceStat = await fs.stat(source)
  const dir = path.join(paths.episode_dir, 'shorts'), manifestPath = path.join(dir, 'shorts.json')
  let manifest: any = null
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) } catch { /* a fresh run selects passages */ }
  const retry = job.params?.shorts_retry === true && manifest?.source?.size === sourceStat.size && manifest?.source?.mtime_ms === sourceStat.mtimeMs && manifest?.offset === offset && Array.isArray(manifest?.shorts) && manifest.shorts.length === count
  let moments: ShortMoment[]
  if (retry) {
    moments = validateShortMoments(JSON.stringify({ shorts: manifest.shorts }), cues, count)
  } else {
    const text = cues.map(c => `${c.start_sec.toFixed(3)}-${c.end_sec.toFixed(3)} ${c.text}`).join('\n')
    const response = await callAi(model, `Choose ${count} self-contained, non-overlapping passages of 20–58 seconds for vertical Shorts. Return JSON only: {"shorts":[{"start":number,"end":number,"title":"short title","reason":"one line"}]}. Times must be transcript cue boundaries.`, text, {}, false, { slug, jobId: job.job_id, outputContract: JSON_OBJECT_OUTPUT_CONTRACT })
    moments = validateShortMoments(response, cues, count)
    for (const [i, moment] of moments.entries()) if (moment.end + offset > sourceInfo.durationSec + 0.01) throw new Error(`Short ${i + 1} ends beyond the final video after applying its opening offset.`)
    trashPreviousShorts(dir, projectDir, slug)
    await fs.mkdir(dir, { recursive: true })
    await writeJsonAtomic(manifestPath, { source: { size: sourceStat.size, mtime_ms: sourceStat.mtimeMs }, offset, shorts: moments })
    job.params.shorts_retry = true
    await jq.checkpointJobState(job)
  }
  for (const [i, moment] of moments.entries()) if (moment.end + offset > sourceInfo.durationSec + 0.01) throw new Error(`Short ${i + 1} ends beyond the final video after applying its opening offset.`)
  const failures: string[] = []
  for (const [index, moment] of moments.entries()) {
    const file = path.join(dir, `${code}-short-${index + 1}.mp4`), duration = moment.end - moment.start
    if (retry && await verifyShort(file, duration) === null) continue
    if (existsSync(file)) moveToTrashSync(file, path.join(trashRootFor(dir, projectDir, slug), 'shorts', code, path.basename(file)), 'shorts')
    try {
      await runFfmpeg(shortCutArgs(source, file, moment, offset))
      const problem = await verifyShort(file, duration)
      if (problem) failures.push(`${path.basename(file)}: ${problem}`)
    } catch (error: any) { failures.push(`${path.basename(file)}: ${error?.message || error}`) }
  }
  if (failures.length) throw new Error(`Shorts incomplete: ${failures.join('; ')}. Retry keeps verified clips and repairs the rest.`)
  const finalStat = await fs.stat(source)
  if (finalStat.size !== sourceStat.size || finalStat.mtimeMs !== sourceStat.mtimeMs) throw new Error('The final video changed while Shorts were being cut. Retry from the new final.')
  job.output_dir = dir
  job.result = { shorts: moments, source: { size: sourceStat.size, mtime_ms: sourceStat.mtimeMs } }
  job.output_lines.push(`${count} Shorts verified in ${dir}.`)

  // Upload the Shorts, if this channel asked for it.
  //
  // This is an EXTRA step, never a condition of the Shorts being done. The
  // clips are on disk and verified at this point, and that is the job's
  // success — so a refusal ("no publish date", "the date has passed") and a
  // failed upload are both LINES in the log, and neither fails the Shorts or
  // the episode.
  await uploadShortsAfterVerification(job, slug, code)
}

/**
 * Send an episode's verified Shorts to YouTube when the channel asked for it.
 *
 * The API route triggers the same underlying step for one episode
 * (`uploadShortsForEpisode`); this wrapper is the job's own, so whatever the
 * upload does it lands in the SHORTS job's log rather than in a throwaway
 * response nobody keeps.
 */
export async function uploadShortsAfterVerification(job: Job, slug: string, code: string): Promise<void> {
  try {
    const { uploadShortsForEpisode } = await import('./shorts-uploader.js')
    const report = await uploadShortsForEpisode(slug, code)
    for (const line of report.lines) job.output_lines.push(line)
    if (report.reason && !report.outcomes.length) job.output_lines.push(`Shorts upload: ${report.reason}`)
    job.result = { ...(job.result || {}), shorts_upload: {
      mode: report.mode, uploaded: report.uploaded, upload_failed: report.upload_failed,
      ...(report.reason ? { reason: report.reason } : {}),
    } }
  } catch (error: any) {
    // A failure to even START the upload is still not a failed Shorts job.
    // It is loud, and the clips are exactly where they were.
    const message = `Shorts upload did not run: ${error?.message || error}. The Shorts are saved and verified.`
    job.output_lines.push(message)
    job.result = { ...(job.result || {}), shorts_upload: { upload_failed: true, error: message } }
  }
}
