import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { buildVideoFrameFilter } from '../lib/video-frame-filter.js'
import { buildAnimationFilter, isZoompanAnimation } from '../lib/animation-filters.js'
import { buildVariableXfadeFilterComplex } from '../lib/transition-filters.js'
import { getTransition } from '../models/transitions.js'
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
import type { GenerateVideoRequest, Job, ScenePlan, VideoFrameConfig, VideoPostAudio, VideoSceneAnimation } from '../models/types.js'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { getRenderWorkersEnabled } from '../services/app-settings.js'
import { isCancelled } from '../services/job-queue.js'
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
  transition?: { type?: string; duration?: number }
  frame?: VideoFrameConfig
  intro?: { enabled?: boolean; video_path?: string; duration?: number }
  scene_animation?: VideoSceneAnimation
  post_audio?: VideoPostAudio
  merged_audio_path?: string
  title_image?: { enabled?: boolean; image_path?: string }
  title_card?: { enabled?: boolean }
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

export function remoteVideoAssemblyFallbackReasons(req: GenerateVideoRequest): string[] {
  const reasons: string[] = []
  if (req.scene_pool_mode && req.scene_pool_mode !== 'scene_plan') reasons.push('scene source is not the continuity Scene Plan')
  const format = req.format || 'mp4'
  if (format !== 'mp4') reasons.push(`${format.toUpperCase()} export`)
  if (req.transition && req.transition !== 'none' && !getTransition(req.transition)?.xfade) {
    reasons.push(`unsupported transition "${req.transition}"`)
  }
  if (req.title_image?.enabled || req.title_card?.enabled) reasons.push('title card/image')
  if (req.outro?.enabled || req.outro_card?.enabled) reasons.push('outro')
  if (req.timeline_clips?.some(clip => clip.enabled)) reasons.push('custom timeline clips')
  if (req.logo?.enabled) reasons.push('logo overlay')
  if (req.music?.enabled || req.background_noise?.enabled) reasons.push('music/background audio mix')
  if (req.color_grading?.enabled || req.vignette?.enabled || req.film_grain?.enabled || req.letterbox?.enabled) reasons.push('visual effects')
  if (req.chroma_key?.enabled || req.overlays?.enabled) reasons.push('overlay layers')
  if (req.video_layout === 'compilation') reasons.push('presentation/compilation layout')
  if (req.frame?.enabled && req.frame.background_path) reasons.push('presentation-frame media background')
  const subtitleStyle = req.subtitles?.style
  if (req.subtitles?.enabled && (
    (subtitleStyle?.animation && subtitleStyle.animation !== 'none')
    || subtitleStyle?.position_x_pct != null
    || subtitleStyle?.position_y_pct != null
  )) reasons.push('animated/precisely positioned subtitles')
  return reasons
}

/** Run the current six-step Video Assembly on Render Studio when every chosen
 * feature has a lossless worker equivalent. Unsupported features stay local
 * and are named in the job log instead of being silently omitted. */
export async function tryRunRemoteVideoAssembly(job: Job): Promise<boolean> {
  if (!await getRenderWorkersEnabled()) {
    job.output_lines.push('Render Studio: disabled in Settings; using this Mac.')
    return false
  }
  const req = job.params as GenerateVideoRequest
  const reasons = remoteVideoAssemblyFallbackReasons(req)
  if (reasons.length) {
    job.output_lines.push(`Render Studio fallback: using this Mac because the worker recipe does not yet support ${reasons.join(', ')}.`)
    return false
  }
  const style = req.subtitles?.style
  const adapted: Params = {
    episode_id: req.episode_id,
    export_settings: {
      resolution: req.resolution,
      fps: req.fps,
      crf: QUALITY_TO_CRF[req.quality] || 23,
    },
    transition: { type: req.transition || 'none', duration: req.transition_duration || 0 },
    frame: req.frame,
    intro: req.intro,
    scene_animation: req.scene_animation,
    post_audio: req.post_audio,
    merged_audio_path: req.merged_audio_path,
    title_image: req.title_image,
    title_card: req.title_card,
    subtitles: req.subtitles?.enabled ? {
      enabled: true,
      position: style?.position,
      font_size: style?.font_size_px,
      color: style?.color_hex,
      outline: style?.outline_px,
    } : { enabled: false },
  }
  return runRemoteVideoAssembly(job, adapted)
}

const QUALITY_TO_CRF: Record<string, number> = { compact: 32, fast: 28, medium: 23, high: 18 }

async function validateMainCopy(filePath: string, expectedDuration: number): Promise<void> {
  const ffprobe = await getFFprobePath()
  await new Promise<void>((resolve, reject) => {
    const process = spawn(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
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
        const streams = Array.isArray(parsed.streams) ? parsed.streams : []
        if (!streams.some((stream: any) => stream.codec_type === 'video')) {
          return reject(new Error('Returned video has no video stream'))
        }
        if (!streams.some((stream: any) => stream.codec_type === 'audio')) {
          return reject(new Error('Returned video has no audio stream'))
        }
        const duration = Number(parsed.format?.duration)
        if (!Number.isFinite(duration) || duration < Math.max(0.5, expectedDuration - 1)) {
          return reject(new Error(
            `Returned video is incomplete (${Number.isFinite(duration) ? duration.toFixed(1) : 'unknown'}s; expected ${expectedDuration.toFixed(1)}s).`,
          ))
        }
        resolve()
      } catch (error) { reject(error) }
    })
  })
}

/**
 * Offload unified Video Assembly when a healthy render worker is available.
 * Returns false before any transfer starts when local assembly should be used.
 */
async function runRemoteVideoAssembly(job: Job, params: Params): Promise<boolean> {
  const episodeId = params.episode_id
  if (!episodeId) return false
  if (!await getRenderWorkersEnabled()) return false
  const backend = await getHubBackend()
  if (backend.mode !== 'hub' || !backend.hubUrl) {
    job.output_lines.push('Render Studio: Studio Hub is not the active backend; using this Mac.')
    return false
  }
  try {
    const studios = await hubStudios(backend.hubUrl, backend.hubToken)
    if (!studios.some(studio => studio.modality === 'render' && studio.status === 'up')) {
      job.output_lines.push('Render Studio: no online render worker is available; using this Mac.')
      return false
    }
  } catch (error: any) {
    job.output_lines.push(`Render Studio: Studio Hub worker check failed (${error?.message || error}); using this Mac.`)
    return false
  }

  const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('scene_plan.json missing - run Scene Plan first.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  if (!plan.scenes.length) throw new Error('scene_plan.json has no scenes')
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

  let audioPath = params.merged_audio_path && existsSync(params.merged_audio_path)
    ? params.merged_audio_path
    : ''
  let audioSize = audioPath ? (await fs.stat(audioPath)).size : 0
  if (!audioPath) {
    for (const name of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
      if (!/\.(mp3|wav|m4a)$/i.test(name) || name.startsWith('.tmp_')) continue
      const candidate = path.join(paths.merged_audio_dir, name)
      const stat = await fs.stat(candidate).catch(() => null)
      if (stat && stat.size > audioSize) { audioPath = candidate; audioSize = stat.size }
    }
  }
  if (!audioPath) throw new Error('No merged audio file found.')
  const audioDuration = await getAudioDuration(audioPath)
  if (!audioDuration) throw new Error('Could not read merged audio duration.')
  const openingReserved = Math.max(0, Number(plan.opening_reserved_sec) || 0)
  if ((params.title_image?.enabled || params.title_card?.enabled) && openingReserved <= 0) {
    job.output_lines.push('Render Studio fallback: this episode uses a standalone title image; using this Mac for exact title timing.')
    return false
  }
  const coverage = inspectScenePlanCoverage({
    scenes: plan.scenes,
    total_duration_sec: audioDuration,
  }, { headCovered: openingReserved > 0 })
  if (coverage.blockingUncoveredSec > COVERAGE_FAIL_SEC) {
    throw new Error(`Narration has ${coverage.blockingUncoveredSec.toFixed(1)}s without a planned scene. Repair Scene Plan coverage first.`)
  }

  const durations = plan.scenes.map((scene, index) => {
    const start = scene.start_sec
    const end = index === plan.scenes.length - 1 ? audioDuration : plan.scenes[index + 1]!.start_sec
    return Math.max(0.5, end - start)
  })
  const transition = params.transition?.type && params.transition.type !== 'none'
    ? getTransition(params.transition.type)
    : null
  const transitionDuration = transition?.xfade && durations.length > 1
    ? Math.min(
        Math.max(0.1, Number(params.transition?.duration) || 1.5),
        Math.max(0.1, Math.min(...durations) - 0.1),
      )
    : 0
  const postAudio = params.post_audio
  const postRoll = postAudio?.behavior === 'fade-to-black'
    ? Math.max(0, postAudio.fade_duration || 5)
    : postAudio?.behavior === 'black-screen' || postAudio?.behavior === 'hold-last-scene'
      ? Math.max(0, postAudio.tail_seconds ?? 4)
      : 0
  const totalDuration = audioDuration + postRoll
  const [width, height, bitrate] = RESOLUTIONS[params.export_settings?.resolution || '1080p'] || RESOLUTIONS['1080p']!
  const fps = Math.round(clamp(params.export_settings?.fps, 1, 60, 30))
  const baseFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`

  const stitchedSrt = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
  if (params.subtitles?.enabled && !existsSync(stitchedSrt)) {
    throw new Error('Subtitles are enabled, but the stitched SRT is missing. Repair Subtitles and retry.')
  }
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

    let introId = ''
    if (openingReserved > 0) {
      if (!params.intro?.enabled || !params.intro.video_path || !existsSync(params.intro.video_path)) {
        throw new Error(`Scene Plan reserves a ${openingReserved.toFixed(1)}s branded opening, but no intro video is enabled.`)
      }
      introId = await addAsset(params.intro.video_path, 'intro')
    }

    const steps: Array<{ tool: 'ffmpeg'; args: string[] }> = []
    if (introId) {
      steps.push({ tool: 'ffmpeg', args: [
        '-y', '-stream_loop', '-1', '-i', `{{asset:${introId}}}`, '-an',
        '-vf', baseFilter, '-t', openingReserved.toFixed(3),
        '-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps),
        '{{work:intro.mp4}}',
      ] })
    }
    for (let index = 0; index < plan.scenes.length; index++) {
      const duration = (durations[index]! + transitionDuration).toFixed(3)
      const input = `{{asset:${sceneIds[index]}}}`
      const output = `{{work:scene-${index}.mp4}}`
      const animation = params.scene_animation || {
        type: 'none', zoom_start: 100, zoom_end: 108, parallax_direction: 'right',
        parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103,
      }
      const animationType = animation.type || 'none'
      const stillFilter = buildAnimationFilter({
        type: animationType, params: animation, w: width, h: height, fps,
        duration: Number(duration),
      }).concat([`fps=${fps}`, 'format=yuv420p']).join(',')
      const args = sceneIsClip[index]
        ? ['-y', '-i', input, '-an', '-vf', `${baseFilter},tpad=stop_mode=clone:stop_duration=${duration}`, '-t', duration]
        : isZoompanAnimation(animationType)
          ? ['-y', '-i', input, '-vf', stillFilter, '-t', duration]
          : ['-y', '-loop', '1', '-t', duration, '-i', input, '-vf', stillFilter]
      args.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps), output)
      steps.push({ tool: 'ffmpeg', args })
    }
    let sceneTimelineFiles = plan.scenes.map((_, index) => `{{work:scene-${index}.mp4}}`)
    if (transitionDuration > 0 && transition?.xfade) {
      const chunkSize = 24
      const xfaded: string[] = []
      for (let start = 0; start < plan.scenes.length; start += chunkSize) {
        const count = Math.min(chunkSize, plan.scenes.length - start)
        const output = `{{work:xfade-${xfaded.length}.mp4}}`
        const windowDurations = durations.slice(start, start + count)
        const windowSum = windowDurations.reduce((sum, value) => sum + value, 0)
        const args = ['-y']
        for (let offset = 0; offset < count; offset++) {
          args.push('-i', `{{work:scene-${start + offset}.mp4}}`)
        }
        if (count === 1) {
          args.push('-t', windowSum.toFixed(3), '-an')
        } else {
          const filter = buildVariableXfadeFilterComplex({
            inputDurations: windowDurations.map(value => value + transitionDuration),
            transitionDuration,
            xfadeKeywords: Array(count - 1).fill(transition.xfade),
          })
          args.push('-filter_complex', filter, '-map', '[vout]', '-t', windowSum.toFixed(3), '-an')
        }
        args.push(
          '-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p',
          '-r', String(fps), output,
        )
        steps.push({ tool: 'ffmpeg', args })
        xfaded.push(output)
      }
      sceneTimelineFiles = xfaded
      job.output_lines.push(
        `Render Studio: ${transition.label} crossfades in ${xfaded.length} safe chunk(s)` +
        (xfaded.length > 1 ? ` (${xfaded.length - 1} chunk-boundary hard cut(s)).` : '.'),
      )
    }
    if (postRoll > 0) {
      const tailOutput = '{{work:post-tail.mp4}}'
      if (postAudio?.behavior === 'black-screen') {
        steps.push({ tool: 'ffmpeg', args: [
          '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${postRoll.toFixed(3)}`,
          '-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', tailOutput,
        ] })
      } else {
        const lastInput = `{{asset:${sceneIds[sceneIds.length - 1]}}}`
        const fade = postAudio?.behavior === 'fade-to-black'
          ? `,fade=t=out:st=0:d=${postRoll.toFixed(3)}` : ''
        const lastInputArgs = sceneIsClip[sceneIsClip.length - 1]
          ? ['-stream_loop', '-1', '-i', lastInput]
          : ['-loop', '1', '-t', postRoll.toFixed(3), '-i', lastInput]
        steps.push({ tool: 'ffmpeg', args: [
          '-y', ...lastInputArgs,
          '-vf', `${baseFilter}${fade}`, '-c:v', '{{video_encoder}}', '-b:v', bitrate,
          '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', postRoll.toFixed(3), tailOutput,
        ] })
      }
    }
    const concatRows = [
      ...(introId ? ["file '{{work:intro.mp4}}'"] : []),
      ...sceneTimelineFiles.map(file => `file '${file}'`),
      ...(postRoll > 0 ? ["file '{{work:post-tail.mp4}}'"] : []),
    ]
    const concat = concatRows.join('\n') + '\n'

    const finalArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', '{{work:scenes.txt}}', '-i', `{{asset:${narrationId}}}`]
    const extraAudioInputs: string[] = []
    const audioFilters: string[] = []
    const mixLabels = ['[a_narr]']
    let audioIndex = 2
    const hasBeds = !!(musicId || ambientId)
    audioFilters.push(`[1:a]aresample=async=1,apad=whole_dur=${totalDuration.toFixed(3)}[a_narr]`)
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
    else audioFilters.push('[a_narr]anull[aout]')
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
      filters.push(...audioFilters)
      finalArgs.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]')
      finalArgs.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps))
    } else if (subtitleFilter) {
      finalArgs.push('-filter_complex', [`[0:v]${subtitleFilter}[vout]`, ...audioFilters].join(';'), '-map', '[vout]', '-map', '[aout]')
      finalArgs.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps))
    } else {
      finalArgs.push('-filter_complex', audioFilters.join(';'), '-map', '0:v', '-map', '[aout]')
      finalArgs.push('-c:v', 'copy')
    }
    finalArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', '{{output}}')
    steps.push({ tool: 'ffmpeg', args: finalArgs })

    job.output_lines.push(`Render Studio: queued ${plan.scenes.length} scenes (${width}x${height} @ ${fps}fps).`)
    const submittedJob = await hubSubmitJob(backend.hubUrl, backend.hubToken, {
      modality: 'render', model: 'episode-assembly-v1', label: `story-video-assembly:${episodeId}`,
      items: [{ prompt: episodeId, params: {
        workflow: 'video_assembly',
        recipe: { version: 1, assets, files: [{ name: 'scenes.txt', content: concat }], steps },
      } }],
    })
    submitted = true
    const status = await hubPollBatch(backend.hubUrl, backend.hubToken, submittedJob.batch_id, {
      timeoutMs: 12 * 60 * 60_000,
      isCancelled: () => isCancelled(job.job_id),
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
    await validateMainCopy(outPath, totalDuration)
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
