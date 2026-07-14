import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { buildVideoFrameFilter } from '../lib/video-frame-filter.js'
import {
  getHubBackend,
  hubApiBase,
  hubDeleteRenderAsset,
  hubDownloadRenderResult,
  hubHeaders,
  hubPollBatch,
  hubStudios,
  hubSubmitJob,
  hubUploadRenderAsset,
  hubWorkerReachableUrl,
} from '../lib/studiohub-client.js'
import type { Job, ScenePlan, VideoFrameConfig } from '../models/types.js'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { getRenderWorkersEnabled } from '../services/app-settings.js'
import { inspectScenePlanCoverage, COVERAGE_FAIL_SEC } from '../services/scene-planner.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { ensureExternalFinalVideoDir, externalRootIsReachable } from '../services/external-video-store.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir } from './scene-image.js'
import { resolveVideoAssetsDir } from './scene-clip.js'

interface Params {
  episode_id: string
  title?: string
  music?: { path?: string; volume?: number; fade?: number }
  ambient?: { path?: string; volume?: number; fade?: number }
  subtitles?: { enabled?: boolean; position?: 'bottom' | 'center' | 'top'; font_size?: number; color?: string; outline?: number }
  export_settings?: { resolution?: '720p' | '1080p' | '1440p' | '4k'; fps?: number; crf?: number }
  transition?: { type?: 'none' | 'crossfade' | 'fadeblack' | 'dissolve'; duration?: number }
  frame?: VideoFrameConfig
  auto_approve?: boolean
}

interface RecipeAsset {
  id: string
  url: string
  sha256: string
  bytes: number
}

const RESOLUTIONS: Record<string, [number, number, string]> = {
  '720p': [1280, 720, '4M'],
  '1080p': [1920, 1080, '8M'],
  '1440p': [2560, 1440, '14M'],
  '4k': [3840, 2160, '35M'],
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function alignmentFor(position: string): number {
  return position === 'top' ? 6 : position === 'center' ? 10 : 2
}

function hexToAssColor(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex || '')
  if (!match) return '&H00FFFFFF'
  const value = match[1]!
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`.toUpperCase()
}

async function validateMainCopy(filePath: string): Promise<void> {
  const ffprobe = await getFFprobePath()
  await new Promise<void>((resolve, reject) => {
    const process = spawn(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height',
      '-of', 'json', filePath,
    ])
    let stdout = ''
    let stderr = ''
    process.stdout.on('data', data => { stdout += String(data) })
    process.stderr.on('data', data => { stderr += String(data) })
    process.on('error', reject)
    process.on('close', code => {
      if (code !== 0) return reject(new Error(`Returned video failed ffprobe: ${stderr.slice(-400)}`))
      try {
        const parsed = JSON.parse(stdout)
        if (!parsed.streams?.length) return reject(new Error('Returned video has no video stream'))
        resolve()
      } catch (error) { reject(error) }
    })
  })
}

/**
 * Offload the timestamp assembler when a healthy render worker is available.
 * Returns false before any transfer starts when local assembly should be used.
 */
export async function tryRunRemoteTimestampAssemble(job: Job): Promise<boolean> {
  const params = job.params as Params
  const episodeId = params.episode_id
  if (!episodeId) return false
  if (!await getRenderWorkersEnabled()) return false
  if (params.transition?.type && params.transition.type !== 'none') {
    job.output_lines.push('Remote render skipped: transitions currently use the local assembler.')
    return false
  }

  const backend = await getHubBackend()
  if (backend.mode !== 'hub' || !backend.hubUrl) return false
  try {
    const studios = await hubStudios(backend.hubUrl, backend.hubToken)
    if (!studios.some(studio => studio.modality === 'render' && studio.status === 'up')) return false
  } catch {
    return false
  }

  const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('scene_plan.json missing - run Scene Plan first.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  if (!plan.scenes.length) throw new Error('scene_plan.json has no scenes')
  if (params.auto_approve === true) {
    let changed = false
    for (const scene of plan.scenes) {
      if (!scene.approved) { scene.approved = true; changed = true }
    }
    if (changed) await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
  }
  const unapproved = plan.scenes.filter(scene => !scene.approved)
  if (unapproved.length) throw new Error(`${unapproved.length} scene(s) still need approval before rendering.`)

  const namedSceneDir = await resolveSceneImagesDir(job.project_slug, episodeId.toUpperCase(), paths.episode_dir)
  const legacySceneDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
  const imageFor = (id: string) => {
    const named = path.join(namedSceneDir, `${id}.png`)
    return existsSync(named) ? named : path.join(legacySceneDir, `${id}.png`)
  }
  const clipsDir = await resolveVideoAssetsDir(job.project_slug, episodeId.toUpperCase(), paths.episode_dir)
  const clipFor = (scene: ScenePlan['scenes'][number]): string | null => {
    if (scene.motion_choice === 'pending' || scene.motion_choice === 'still') return null
    if (typeof scene.rendered_motion_prompt === 'string' && scene.rendered_motion_prompt !== (scene.motion_prompt || '')) return null
    if (typeof scene.image_version === 'string' && scene.clip_source_image_version !== scene.image_version) return null
    const candidate = path.join(clipsDir, `${scene.id}.mp4`)
    return existsSync(candidate) ? candidate : null
  }
  for (const scene of plan.scenes) {
    if (!existsSync(imageFor(scene.id))) throw new Error(`Missing image for scene ${scene.scene_index}.`)
  }

  let audioPath = ''
  let audioSize = 0
  for (const name of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
    if (!/\.(mp3|wav|m4a)$/i.test(name) || name.startsWith('.tmp_')) continue
    const candidate = path.join(paths.merged_audio_dir, name)
    const stat = await fs.stat(candidate).catch(() => null)
    if (stat && stat.size > audioSize) { audioPath = candidate; audioSize = stat.size }
  }
  if (!audioPath) throw new Error('No merged audio file found.')
  const audioDuration = await getAudioDuration(audioPath)
  if (!audioDuration) throw new Error('Could not read merged audio duration.')
  const coverage = inspectScenePlanCoverage({
    scenes: plan.scenes,
    total_duration_sec: audioDuration,
  }, { headCovered: false })
  if (coverage.blockingUncoveredSec > COVERAGE_FAIL_SEC) {
    throw new Error(`Narration has ${coverage.blockingUncoveredSec.toFixed(1)}s without a planned scene. Repair Scene Plan coverage first.`)
  }

  const durations = plan.scenes.map((scene, index) => {
    const start = index === 0 ? 0 : scene.start_sec
    const end = index === plan.scenes.length - 1 ? audioDuration : plan.scenes[index + 1]!.start_sec
    return Math.max(0.5, end - start)
  })
  const totalDuration = durations.reduce((sum, value) => sum + value, 0)
  const [width, height, bitrate] = RESOLUTIONS[params.export_settings?.resolution || '1080p'] || RESOLUTIONS['1080p']!
  const fps = Math.round(clamp(params.export_settings?.fps, 1, 60, 30))
  const baseFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`

  const stitchedSrt = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
  const subtitlesOn = existsSync(stitchedSrt) && params.subtitles?.enabled !== false
  const musicPath = params.music?.path && existsSync(params.music.path) ? params.music.path : ''
  const ambientPath = params.ambient?.path && existsSync(params.ambient.path) ? params.ambient.path : ''

  const workerHubUrl = await hubWorkerReachableUrl(backend.hubUrl, backend.hubToken)
  const uploadedIds: string[] = []
  const assets: RecipeAsset[] = []
  const assetByPath = new Map<string, string>()
  const addAsset = async (filePath: string, preferredId: string): Promise<string> => {
    const existing = assetByPath.get(filePath)
    if (existing) return existing
    const uploaded = await hubUploadRenderAsset(
      backend.hubUrl, workerHubUrl, backend.hubToken, filePath)
    uploadedIds.push(uploaded.assetId)
    assets.push({ id: preferredId, url: uploaded.url, sha256: uploaded.sha256, bytes: uploaded.bytes })
    assetByPath.set(filePath, preferredId)
    job.output_lines.push(`Transferred ${assets.length} render asset(s)...`)
    return preferredId
  }

  let submitted = false
  let terminal = false
  try {
    const narrationId = await addAsset(audioPath, 'narration')
    const subtitleId = subtitlesOn ? await addAsset(stitchedSrt, 'subtitles') : ''
    const musicId = musicPath ? await addAsset(musicPath, 'music') : ''
    const ambientId = ambientPath ? await addAsset(ambientPath, 'ambient') : ''
    const sceneIds: string[] = []
    const sceneIsClip: boolean[] = []
    for (let index = 0; index < plan.scenes.length; index++) {
      const clip = clipFor(plan.scenes[index]!)
      sceneIsClip.push(!!clip)
      sceneIds.push(await addAsset(clip || imageFor(plan.scenes[index]!.id), `scene-${index}`))
    }

    const steps: Array<{ tool: 'ffmpeg'; args: string[] }> = []
    for (let index = 0; index < plan.scenes.length; index++) {
      const duration = durations[index]!.toFixed(3)
      const input = `{{asset:${sceneIds[index]}}}`
      const output = `{{work:scene-${index}.mp4}}`
      const args = sceneIsClip[index]
        ? ['-y', '-i', input, '-an', '-vf', `${baseFilter},tpad=stop_mode=clone:stop_duration=${duration}`, '-t', duration]
        : ['-y', '-loop', '1', '-t', duration, '-i', input, '-vf', baseFilter]
      args.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps), output)
      steps.push({ tool: 'ffmpeg', args })
    }
    const concat = plan.scenes.map((_, index) => `file '{{work:scene-${index}.mp4}}'`).join('\n') + '\n'

    const finalArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', '{{work:scenes.txt}}', '-i', `{{asset:${narrationId}}}`]
    const extraAudioInputs: string[] = []
    const audioFilters: string[] = []
    const mixLabels = ['[a_narr]']
    let audioIndex = 2
    const hasBeds = !!(musicId || ambientId)
    if (hasBeds) audioFilters.push('[1:a]aresample=async=1[a_narr]')
    if (musicId) {
      extraAudioInputs.push('-i', `{{asset:${musicId}}}`)
      const volume = clamp(params.music?.volume, 0, 2, 0.15)
      const fade = clamp(params.music?.fade, 0, 15, 2)
      audioFilters.push(`[${audioIndex}:a]aloop=loop=-1:size=2147483647,atrim=0:${totalDuration.toFixed(3)},volume=${volume},afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, totalDuration - fade).toFixed(3)}:d=${fade}[a_music]`)
      mixLabels.push('[a_music]'); audioIndex++
    }
    if (ambientId) {
      extraAudioInputs.push('-i', `{{asset:${ambientId}}}`)
      const volume = clamp(params.ambient?.volume, 0, 2, 0.12)
      const fade = clamp(params.ambient?.fade, 0, 15, 2)
      audioFilters.push(`[${audioIndex}:a]aloop=loop=-1:size=2147483647,atrim=0:${totalDuration.toFixed(3)},volume=${volume},afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, totalDuration - fade).toFixed(3)}:d=${fade}[a_ambient]`)
      mixLabels.push('[a_ambient]')
    }
    if (hasBeds) audioFilters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:duration=first[aout]`)
    finalArgs.push(...extraAudioInputs)

    let subtitleFilter = ''
    if (subtitleId) {
      const settings = params.subtitles || {}
      const style = [
        `Alignment=${alignmentFor(settings.position || 'bottom')}`,
        `FontSize=${Math.round(clamp(settings.font_size, 8, 96, 24))}`,
        `PrimaryColour=${hexToAssColor(settings.color || '#FFFFFF')}`,
        `Outline=${Math.round(clamp(settings.outline, 0, 6, 2))}`,
      ].join(',')
      subtitleFilter = `subtitles='{{asset:${subtitleId}}}':force_style='${style}'`
    }
    const frameOn = params.frame?.enabled === true
    if (frameOn) {
      const filters = [`[0:v]${subtitleFilter || 'null'}[framepre]`]
      filters.push(...buildVideoFrameFilter({
        inputLabel: '[framepre]', outputLabel: '[vout]', prefix: 'remoteframe',
        width, height, fps, config: params.frame!,
      }))
      if (hasBeds) filters.push(...audioFilters)
      finalArgs.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', hasBeds ? '[aout]' : '1:a')
      finalArgs.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps))
    } else if (subtitleFilter) {
      if (hasBeds) {
        finalArgs.push('-filter_complex', [`[0:v]${subtitleFilter}[vout]`, ...audioFilters].join(';'), '-map', '[vout]', '-map', '[aout]')
      } else {
        finalArgs.push('-vf', subtitleFilter)
      }
      finalArgs.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps))
    } else {
      if (hasBeds) finalArgs.push('-filter_complex', audioFilters.join(';'), '-map', '0:v', '-map', '[aout]')
      finalArgs.push('-c:v', 'copy')
    }
    finalArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', '{{output}}')
    steps.push({ tool: 'ffmpeg', args: finalArgs })

    job.output_lines.push(`Render Studio: queued ${plan.scenes.length} scenes (${width}x${height} @ ${fps}fps).`)
    const submittedJob = await hubSubmitJob(backend.hubUrl, backend.hubToken, {
      modality: 'render', model: 'episode-assembly-v1', label: `storystudio:${episodeId}`,
      items: [{ prompt: episodeId, params: {
        recipe: { version: 1, assets, files: [{ name: 'scenes.txt', content: concat }], steps },
      } }],
    })
    submitted = true
    const status = await hubPollBatch(backend.hubUrl, backend.hubToken, submittedJob.batch_id, {
      timeoutMs: 12 * 60 * 60_000,
      onProgress: value => {
        const item = value.items?.[0]
        if (item?.state === 'running') job.output_lines[job.output_lines.length - 1] = 'Render Studio: rendering locally on worker...'
      },
    })
    terminal = true
    const result = status.items?.[0]
    if (!result || result.state !== 'done' || !result.sha256) {
      throw new Error(result?.error || 'Render Studio did not return a completed video.')
    }

    let finalDir = paths.video_dir
    const reach = await externalRootIsReachable().catch(() => ({ ok: false, root: '' }))
    if (reach.ok) finalDir = await ensureExternalFinalVideoDir(job.project_slug, episodeId, params.title || '') || finalDir
    await fs.mkdir(finalDir, { recursive: true })
    const outPath = path.join(finalDir, `${episodeId.toUpperCase()}_final_video.mp4`)
    const proxyUrl = `${hubApiBase(backend.hubUrl)}/jobs/${submittedJob.batch_id}/items/0/artifact`
    await hubDownloadRenderResult(proxyUrl, backend.hubToken, outPath, result.sha256)
    await validateMainCopy(outPath)
    const ack = await fetch(`${hubApiBase(backend.hubUrl)}/jobs/${submittedJob.batch_id}/items/0/ack`, {
      method: 'POST', headers: hubHeaders(backend.hubToken), signal: AbortSignal.timeout(30_000),
    })
    if (!ack.ok) throw new Error(`Main copy verified, but worker receipt acknowledgement failed (${ack.status}).`)
    job.output_dir = finalDir
    const stat = await fs.stat(outPath)
    if (!stat.isFile() || stat.size <= 0) throw new Error('Verified render download is empty.')
    job.output_lines.push(`Done via Render Studio -> ${path.basename(outPath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${result.encoder || 'verified encoder'})`)
    return true
  } finally {
    // Assets are safe to remove from Hub only after a terminal worker result.
    // Before submission, no worker can reference them, so cleanup is safe too.
    if (!submitted || terminal) {
      await Promise.all(uploadedIds.map(id => hubDeleteRenderAsset(backend.hubUrl, backend.hubToken, id)))
    }
  }
}
