import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { buildVideoFrameFilter } from '../lib/video-frame-filter.js'
import {
  buildColorGradingFilters,
  buildGateEnable,
  buildLetterboxFilter,
  calculateLogoPosition,
  computeVignetteAngle,
} from '../lib/video-effects.js'
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
import type {
  BackgroundPlate, ForegroundDefaults, GenerateVideoRequest, Job, ScenePlan,
  TimelineAnchor, VideoBackgroundNoise, VideoChapterTitles, VideoChromaKeyConfig,
  VideoColorGrading, VideoFilmGrain, VideoFrameConfig, VideoIntroConfig,
  VideoLayout, VideoLetterbox, VideoLogoConfig, VideoMusicConfig, VideoOverlay,
  VideoOverlaysConfig, VideoOutroCard, VideoOutroConfig, VideoPostAudio,
  VideoSceneAnimation, VideoSubtitleConfig, VideoTimelineClip, VideoTitleCard,
  VideoTitleImageConfig, VideoVignetteConfig,
} from '../models/types.js'
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
  format?: 'mp4' | 'mov' | 'webm'
  codec?: 'h264' | 'h265'
  encoding_effort?: 'ultrafast' | 'medium' | 'slow' | 'hardware'
  music?: VideoMusicConfig
  background_noise?: VideoBackgroundNoise
  subtitles?: VideoSubtitleConfig
  export_settings?: { resolution?: '720p' | '1080p' | '1440p' | '4k'; fps?: number; crf?: number }
  transition?: { type?: string; duration?: number }
  frame?: VideoFrameConfig
  intro?: VideoIntroConfig
  outro?: VideoOutroConfig
  scene_animation?: VideoSceneAnimation
  chapter_titles?: VideoChapterTitles
  post_audio?: VideoPostAudio
  merged_audio_path?: string
  title_image?: VideoTitleImageConfig
  title_card?: VideoTitleCard
  outro_card?: VideoOutroCard
  timeline_clips?: VideoTimelineClip[]
  logo?: VideoLogoConfig
  color_grading?: VideoColorGrading
  vignette?: VideoVignetteConfig
  film_grain?: VideoFilmGrain
  letterbox?: VideoLetterbox
  chroma_key?: VideoChromaKeyConfig
  overlays?: VideoOverlaysConfig
  video_layout?: VideoLayout
  background_plate?: BackgroundPlate
  foreground_defaults?: ForegroundDefaults
  chapter_durations?: Array<{ slug: string; duration_s: number }>
  audio_gap?: number
  exclude_intro_from_effects?: boolean
}

interface RecipeAsset {
  id: string
  url: string
  sha256: string
  bytes: number
  /** Preserve the original media suffix so FFmpeg selects the right decoder. */
  extension: string
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

function isVideoPath(filePath: string): boolean {
  return /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(filePath)
}

function isStaticImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(filePath)
}

function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
}

function getStyleColor(style: string | undefined): string {
  const colors: Record<string, string> = { gold: 'gold', white: 'white', neon: '00ffcc', minimal: 'white@0.8' }
  return colors[style || ''] || 'white'
}

function getFontSize(size: string | undefined, height: number): number {
  const sizes: Record<string, number> = { small: height / 25, medium: height / 18, large: height / 12 }
  return Math.round(sizes[size || 'medium'] || sizes.medium!)
}

function getTextPosition(position: string | undefined, height: number): string {
  const positions: Record<string, string> = { top: String(Math.round(height * 0.08)), center: '(h-text_h)/2', bottom: String(Math.round(height * 0.85)) }
  return positions[position || 'center'] || positions.center!
}

export function remoteVideoAssemblyFallbackReasons(req: GenerateVideoRequest): string[] {
  const reasons: string[] = []
  if (req.scene_pool_mode && req.scene_pool_mode !== 'scene_plan') reasons.push('scene source is not the continuity Scene Plan')
  if (req.transition && req.transition !== 'none' && !getTransition(req.transition)?.xfade) {
    reasons.push(`unsupported transition "${req.transition}"`)
  }
  return reasons
}

/** Run the full unified Video Assembly on Render Studio. Every external file
 * becomes a checksummed Hub asset; workers only receive confined placeholders. */
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
  const adapted: Params = {
    episode_id: req.episode_id,
    title: (job.params as any).title,
    format: req.format || 'mp4',
    codec: req.codec,
    encoding_effort: req.encoding_effort,
    export_settings: {
      resolution: req.resolution,
      fps: req.fps,
      crf: QUALITY_TO_CRF[req.quality] || 23,
    },
    transition: { type: req.transition || 'none', duration: req.transition_duration || 0 },
    frame: req.frame,
    intro: req.intro,
    outro: req.outro,
    scene_animation: req.scene_animation,
    chapter_titles: req.chapter_titles,
    post_audio: req.post_audio,
    merged_audio_path: req.merged_audio_path,
    title_image: req.title_image,
    title_card: req.title_card,
    outro_card: req.outro_card,
    timeline_clips: req.timeline_clips,
    music: req.music,
    background_noise: req.background_noise,
    logo: req.logo,
    color_grading: req.color_grading,
    vignette: req.vignette,
    film_grain: req.film_grain,
    letterbox: req.letterbox,
    chroma_key: req.chroma_key,
    overlays: req.overlays,
    video_layout: req.video_layout,
    background_plate: req.background_plate,
    foreground_defaults: req.foreground_defaults,
    chapter_durations: req.chapter_durations,
    audio_gap: req.audio_gap,
    exclude_intro_from_effects: req.exclude_intro_from_effects,
    subtitles: req.subtitles,
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
  const introPath = params.intro?.enabled && params.intro.video_path ? params.intro.video_path : ''
  if (openingReserved > 0 && (!introPath || !existsSync(introPath))) {
    throw new Error(`Scene Plan reserves a ${openingReserved.toFixed(1)}s branded opening, but no intro video is enabled.`)
  }
  if (introPath && !existsSync(introPath)) throw new Error('Enabled intro video is missing. Choose a valid file or disable Intro before retrying.')
  const useTitleImage = !!params.title_image?.enabled && openingReserved <= 0 && !params.title_card?.enabled
  if (params.title_image?.enabled && openingReserved > 0) {
    job.output_lines.push('Render Studio: title image skipped because the branded opening owns the reserved opening window.')
  }
  const titlePath = useTitleImage ? params.title_image?.image_path || '' : ''
  if (titlePath && !existsSync(titlePath)) throw new Error('Enabled title image is missing. Choose a valid thumbnail or disable Title Image before retrying.')
  const titleDuration = titlePath ? Math.max(0.25, clamp(params.title_image?.duration, 0.25, 600, 5)) : 0
  const introDuration = introPath
    ? openingReserved || (await getAudioDuration(introPath)) || Math.max(0.25, clamp(params.intro?.duration, 0.25, 600, 5))
    : 0
  const coverage = inspectScenePlanCoverage({
    scenes: plan.scenes,
    total_duration_sec: audioDuration,
  }, { headCovered: openingReserved > 0 || !!introPath || !!titlePath || !!params.title_card?.enabled })
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
  const renderFormat = params.format || 'mp4'
  const [width, height, bitrate] = RESOLUTIONS[params.export_settings?.resolution || '1080p'] || RESOLUTIONS['1080p']!
  const fps = Math.round(clamp(params.export_settings?.fps, 1, 60, 30))
  const baseFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`

  const subtitlePath = params.subtitles?.srt_path || path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
  if (params.subtitles?.enabled && !existsSync(subtitlePath)) {
    throw new Error('Subtitles are enabled, but the stitched SRT is missing. Repair Subtitles and retry.')
  }
  const subtitlesOn = existsSync(subtitlePath) && params.subtitles?.enabled !== false
  const musicPaths = params.music?.enabled ? (params.music.files || []).filter(Boolean) : []
  for (const musicPath of musicPaths) {
    if (!existsSync(musicPath)) throw new Error(`Enabled music file is missing: ${path.basename(musicPath)}`)
  }
  const customNoisePath = params.background_noise?.enabled && params.background_noise.mode === 'custom'
    ? params.background_noise.custom_file || ''
    : ''
  if (customNoisePath && !existsSync(customNoisePath)) {
    throw new Error(`Enabled ambience file is missing: ${path.basename(customNoisePath)}`)
  }
  const outroPath = params.outro?.enabled ? params.outro.video_path || '' : ''
  if (outroPath && !existsSync(outroPath)) throw new Error('Enabled outro video is missing. Choose a valid file or disable Outro before retrying.')
  const titleCard = openingReserved > 0 ? undefined : (params.title_card?.enabled && params.title_card.text?.trim() ? params.title_card : undefined)
  const outroCard = params.outro_card?.enabled && params.outro_card.text?.trim() ? params.outro_card : undefined
  const titleCardBackground = titleCard?.background_media_path || ''
  const outroCardBackground = outroCard?.background_media_path || ''
  if (titleCardBackground && !existsSync(titleCardBackground)) throw new Error('Enabled title-card background media is missing.')
  if (outroCardBackground && !existsSync(outroCardBackground)) throw new Error('Enabled outro-card background media is missing.')
  const timelineClips = (params.timeline_clips || []).filter(clip => clip.enabled)
  for (const [index, clip] of timelineClips.entries()) {
    const sourcePath = clip.kind === 'static' ? clip.image_path : clip.video_path
    if (!sourcePath || !existsSync(sourcePath)) throw new Error(`Enabled timeline clip ${index + 1} is missing.`)
    if (clip.kind === 'static' && (!Number.isFinite(clip.duration_sec) || clip.duration_sec <= 0)) {
      throw new Error(`Static timeline clip ${index + 1} needs a positive duration.`)
    }
  }

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
    assets.push({
      id: preferredId,
      url: uploaded.url,
      sha256: uploaded.sha256,
      bytes: uploaded.bytes,
      extension: path.extname(filePath).toLowerCase(),
    })
    assetByPath.set(filePath, preferredId)
    job.output_lines.push(`Transferred ${assets.length} render asset(s)...`)
    return preferredId
  }

  let submitted = false
  let terminal = false
  try {
    const narrationId = await addAsset(audioPath, 'narration')
    const subtitleId = subtitlesOn ? await addAsset(subtitlePath, 'subtitles') : ''
    const musicIds = await Promise.all(musicPaths.map((musicPath, index) => addAsset(musicPath, `music-${index}`)))
    const customNoiseId = customNoisePath ? await addAsset(customNoisePath, 'ambient-custom') : ''
    const sceneIds: string[] = []
    const sceneIsClip: boolean[] = []
    for (let index = 0; index < plan.scenes.length; index++) {
      const clip = clipFor(plan.scenes[index]!)
      const useMotionClip = params.video_layout !== 'compilation' && !!clip
      sceneIsClip.push(useMotionClip)
      sceneIds.push(await addAsset(useMotionClip ? clip! : imageFor(plan.scenes[index]!.id), `scene-${index}`))
    }

    const introId = introPath ? await addAsset(introPath, 'intro') : ''
    const titleId = titlePath ? await addAsset(titlePath, 'title-image') : ''
    const titleCardBackgroundId = titleCardBackground ? await addAsset(titleCardBackground, 'title-card-background') : ''
    const outroId = outroPath ? await addAsset(outroPath, 'outro') : ''
    const outroCardBackgroundId = outroCardBackground ? await addAsset(outroCardBackground, 'outro-card-background') : ''
    const logoId = params.logo?.enabled && params.logo.image_path
      ? await addAsset(params.logo.image_path, 'logo')
      : ''
    const frameBackgroundId = params.frame?.enabled && params.frame.background_path
      ? await addAsset(params.frame.background_path, 'frame-background')
      : ''
    const timelineAssets = await Promise.all(timelineClips.map((clip, index) => {
      const sourcePath = clip.kind === 'static' ? clip.image_path : clip.video_path
      return addAsset(sourcePath, `timeline-${index}`)
    }))
    const userOverlayLayers: VideoOverlay[] = []
    if (params.overlays?.enabled) userOverlayLayers.push(...(params.overlays.layers || []).filter(layer => layer.enabled && layer.source_path))
    if (!userOverlayLayers.length && params.chroma_key?.enabled && params.chroma_key.source_path) {
      userOverlayLayers.push({
        id: 'legacy-chromakey', enabled: true, source_path: params.chroma_key.source_path,
        chroma_key: {
          color: params.chroma_key.color || '#00FF00',
          similarity: params.chroma_key.similarity ?? 0.15,
          blend: params.chroma_key.blend ?? 0.1,
        },
      })
    }
    for (const layer of userOverlayLayers) {
      if (!existsSync(layer.source_path)) throw new Error(`Enabled overlay \"${layer.id}\" is missing.`)
    }
    const overlayIds = await Promise.all(userOverlayLayers.map((layer, index) => addAsset(layer.source_path, `overlay-${index}`)))
    const compilationBackgroundPath = params.video_layout === 'compilation' ? params.background_plate?.source_path || '' : ''
    if (params.video_layout === 'compilation' && !compilationBackgroundPath) {
      throw new Error('Compilation layout needs a background plate.')
    }
    if (compilationBackgroundPath && !existsSync(compilationBackgroundPath)) {
      throw new Error('Compilation background plate is missing.')
    }
    const compilationBackgroundId = compilationBackgroundPath
      ? await addAsset(compilationBackgroundPath, 'compilation-background')
      : ''
    const renderOverlayLayers: Array<{ layer: VideoOverlay; assetId: string; sourcePath: string }> = userOverlayLayers.map((layer, index) => ({
      layer, assetId: overlayIds[index]!, sourcePath: layer.source_path,
    }))
    if (params.video_layout === 'compilation') {
      const defaults = params.foreground_defaults || {
        scale_pct: 0.5, position: 'center' as const,
        chroma_key: { color: '#FFFFFF', similarity: 0.15, blend: 0.1 },
      }
      const chapterDurations = params.chapter_durations || []
      if (!chapterDurations.length) throw new Error('Compilation layout needs chapter timing from Audio Assembly.')
      let offset = 0
      const count = Math.min(plan.scenes.length, chapterDurations.length)
      for (let index = 0; index < count; index++) {
        const chapter = chapterDurations[index]!
        const end = offset + chapter.duration_s + (index === count - 1 ? 0 : params.audio_gap || 0)
        renderOverlayLayers.unshift({
          assetId: sceneIds[index]!, sourcePath: imageFor(plan.scenes[index]!.id),
          layer: {
            id: `compilation-scene-${index + 1}`, enabled: true,
            source_path: imageFor(plan.scenes[index]!.id), opacity: 1, loop: false,
            scale_pct: defaults.scale_pct, position_anchor: defaults.position,
            chroma_key: defaults.chroma_key ? { ...defaults.chroma_key } : null,
            time_range: { start_s: offset, end_s: end },
          },
        })
        offset = end
      }
      job.output_lines.push(`Render Studio: compilation layout adds ${count} timed foreground(s).`)
    }

    const steps: Array<{ tool: 'ffmpeg'; args: string[] }> = []
    const recipeFiles: Array<{ name: string; content: string }> = []
    const encodeClip = ['-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps)]
    const buildTextCard = (
      card: VideoTitleCard | VideoOutroCard,
      kind: 'title' | 'outro',
      backgroundId: string,
    ): string => {
      const duration = Math.max(1, Number(card.duration) || (kind === 'title' ? 5 : 4))
      const output = `{{work:${kind}-text-card.mp4}}`
      const hasBackground = !!backgroundId
      const backgroundPath = kind === 'title' ? titleCardBackground : outroCardBackground
      const args = hasBackground
        ? ['-y', ...(isStaticImagePath(backgroundPath) ? ['-loop', '1'] : ['-stream_loop', '-1']), '-i', `{{asset:${backgroundId}}}`]
        : ['-y', '-f', 'lavfi', '-i', `color=c=${'background' in card ? (card.background === 'gradient' ? '#111827' : card.background === 'dark_blur' ? '#101014' : card.background || 'black') : 'black'}:s=${width}x${height}:r=${fps}:d=${duration}`]
      const filters = hasBackground ? [baseFilter] : ['setsar=1']
      const mainSize = Math.max(32, Math.round(height * (kind === 'title' ? 0.075 : 0.06)))
      const mainY = kind === 'title' && 'subtitle' in card && card.subtitle ? '(h-text_h)/2-40' : '(h-text_h)/2'
      filters.push(`drawtext=text='${escapeDrawtext(card.text || '')}':fontsize=${mainSize}:fontcolor=${getStyleColor(card.style)}:borderw=2:bordercolor=black@0.65:x=(w-text_w)/2:y=${mainY}`)
      if (kind === 'title' && 'subtitle' in card && card.subtitle?.trim()) {
        filters.push(`drawtext=text='${escapeDrawtext(card.subtitle)}':fontsize=${Math.max(22, Math.round(mainSize * 0.48))}:fontcolor=white:borderw=1:bordercolor=black@0.65:x=(w-text_w)/2:y=(h/2)+45`)
      }
      filters.push('format=yuv420p')
      steps.push({ tool: 'ffmpeg', args: [...args, '-vf', filters.join(','), '-t', duration.toFixed(3), ...encodeClip, '-an', output] })
      return output
    }
    const titleClip = titleCard
      ? buildTextCard(titleCard, 'title', titleCardBackgroundId)
      : titleId ? '{{work:title.mp4}}' : ''
    const outroCardClip = outroCard ? buildTextCard(outroCard, 'outro', outroCardBackgroundId) : ''
    const timelineByAnchor: Record<TimelineAnchor, string[]> = {
      before_intro: [], after_intro: [], after_scenes: [], after_outro: [],
    }
    const timelineDurations: Record<TimelineAnchor, number> = {
      before_intro: 0, after_intro: 0, after_scenes: 0, after_outro: 0,
    }
    for (let index = 0; index < timelineClips.length; index++) {
      const clip = timelineClips[index]!
      const asset = timelineAssets[index]!
      const output = `{{work:timeline-${index}.mp4}}`
      const duration = clip.kind === 'static'
        ? Math.max(0.25, clip.duration_sec)
        : Math.max(0.25, await getAudioDuration(clip.video_path) || 0.25)
      const input = clip.kind === 'static'
        ? ['-loop', '1', '-t', duration.toFixed(3), '-i', `{{asset:${asset}}}`]
        : ['-i', `{{asset:${asset}}}`]
      steps.push({ tool: 'ffmpeg', args: [
        '-y', ...input, '-vf', baseFilter, '-t', duration.toFixed(3), ...encodeClip, '-an', output,
      ] })
      timelineByAnchor[clip.anchor].push(output)
      timelineDurations[clip.anchor] += duration
    }
    if (introId) {
      steps.push({ tool: 'ffmpeg', args: [
        '-y', '-stream_loop', '-1', '-i', `{{asset:${introId}}}`, '-an',
        '-vf', baseFilter, '-t', introDuration.toFixed(3),
        ...encodeClip,
        '{{work:intro.mp4}}',
      ] })
    }
    if (titleId) {
      const titleInput = isStaticImagePath(titlePath)
        ? ['-loop', '1', '-t', titleDuration.toFixed(3), '-i', `{{asset:${titleId}}}`]
        : ['-stream_loop', '-1', '-i', `{{asset:${titleId}}}`]
      steps.push({ tool: 'ffmpeg', args: [
        '-y', ...titleInput, '-an', '-vf', baseFilter, '-t', titleDuration.toFixed(3),
        ...encodeClip,
        '{{work:title.mp4}}',
      ] })
    }
    const requestedScenes = (job.params as GenerateVideoRequest).scenes || []
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
      const scene = plan.scenes[index]!
      const requestedScene = requestedScenes.find(candidate => candidate.plan_scene_id === scene.id) || requestedScenes[index]
      const chapterTitles = params.chapter_titles
      let chapterTitleFilter = ''
      if (chapterTitles?.enabled && requestedScene?.title && requestedScene.show_title) {
        const titleDuration = Math.max(0.05, chapterTitles.duration || 3)
        const animationDuration = Math.max(0.05, Math.min(chapterTitles.animation_duration ?? 0.5, titleDuration / 2))
        const common = `drawtext=text='${escapeDrawtext(requestedScene.title)}':fontsize=${getFontSize(chapterTitles.font_size, height)}:fontcolor=${getStyleColor(chapterTitles.style)}:enable='lt(t,${titleDuration})':borderw=2:bordercolor=black@0.6`
        const y = getTextPosition(chapterTitles.position, height)
        let xy = `x=(w-text_w)/2:y=${y}`
        let alpha = ''
        if (chapterTitles.animation === 'fade-in-out') {
          alpha = `:alpha='if(lt(t,${animationDuration.toFixed(3)}),t/${animationDuration.toFixed(3)},if(lt(t,${(titleDuration - animationDuration).toFixed(3)}),1,(${titleDuration.toFixed(3)}-t)/${animationDuration.toFixed(3)}))'`
        } else if (chapterTitles.animation === 'slide-from-left') {
          xy = `x='if(lt(t,${animationDuration.toFixed(3)}),-text_w+((w+text_w)/2)*(t/${animationDuration.toFixed(3)}),(w-text_w)/2)':y=${y}`
        } else if (chapterTitles.animation === 'slide-from-right') {
          xy = `x='if(lt(t,${animationDuration.toFixed(3)}),w-((w+text_w)/2)*(t/${animationDuration.toFixed(3)}),(w-text_w)/2)':y=${y}`
        } else if (chapterTitles.animation === 'slide-up') {
          xy = `x=(w-text_w)/2:y='if(lt(t,${animationDuration.toFixed(3)}),h-(h-(${y}))*(t/${animationDuration.toFixed(3)}),${y})'`
        }
        chapterTitleFilter = `,${common}:${xy}${alpha}`
      }
      const args = sceneIsClip[index]
        ? ['-y', '-i', input, '-an', '-vf', `${baseFilter},tpad=stop_mode=clone:stop_duration=${duration}${chapterTitleFilter}`, '-t', duration]
        : isZoompanAnimation(animationType)
          ? ['-y', '-i', input, '-vf', `${stillFilter}${chapterTitleFilter}`, '-t', duration]
          : ['-y', '-loop', '1', '-t', duration, '-i', input, '-vf', `${stillFilter}${chapterTitleFilter}`]
      args.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps), output)
      steps.push({ tool: 'ffmpeg', args })
    }
    let sceneTimelineFiles = plan.scenes.map((_, index) => `{{work:scene-${index}.mp4}}`)
    if (params.video_layout === 'compilation') {
      const duration = audioDuration.toFixed(3)
      const input = isStaticImagePath(compilationBackgroundPath)
        ? ['-loop', '1', '-t', duration, '-i', `{{asset:${compilationBackgroundId}}}`]
        : ['-stream_loop', '-1', '-i', `{{asset:${compilationBackgroundId}}}`]
      steps.push({ tool: 'ffmpeg', args: [
        '-y', ...input, '-vf', baseFilter, '-t', duration, ...encodeClip, '-an', '{{work:compilation-background.mp4}}',
      ] })
      sceneTimelineFiles = ['{{work:compilation-background.mp4}}']
    } else if (transitionDuration > 0 && transition?.xfade) {
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
    if (outroId) {
      steps.push({ tool: 'ffmpeg', args: [
        '-y', '-i', `{{asset:${outroId}}}`, '-an', '-vf', baseFilter,
        ...encodeClip, '{{work:outro.mp4}}',
      ] })
    }
    const concatRows = [
      ...timelineByAnchor.before_intro.map(file => `file '${file}'`),
      ...(introId ? ["file '{{work:intro.mp4}}'"] : []),
      ...(titleClip ? [`file '${titleClip}'`] : []),
      ...timelineByAnchor.after_intro.map(file => `file '${file}'`),
      ...sceneTimelineFiles.map(file => `file '${file}'`),
      ...timelineByAnchor.after_scenes.map(file => `file '${file}'`),
      ...(postRoll > 0 ? ["file '{{work:post-tail.mp4}}'"] : []),
      ...(outroId ? ["file '{{work:outro.mp4}}'"] : []),
      ...timelineByAnchor.after_outro.map(file => `file '${file}'`),
      ...(outroCardClip ? [`file '${outroCardClip}'`] : []),
    ]
    const concat = concatRows.join('\n') + '\n'

    const titleVisualDuration = titleCard ? Math.max(1, Number(titleCard.duration) || 5) : titleDuration
    const outroCardDuration = outroCard ? Math.max(1, Number(outroCard.duration) || 4) : 0
    const outroDuration = outroPath ? Math.max(0, await getAudioDuration(outroPath) || 0) : 0
    const sceneBodyDuration = params.video_layout === 'compilation'
      ? audioDuration
      : durations.reduce((sum, duration) => sum + duration, 0)
    const preSceneDuration = timelineDurations.before_intro + introDuration + titleVisualDuration + timelineDurations.after_intro
    const effectEnd = preSceneDuration + sceneBodyDuration
    const totalDuration = preSceneDuration + sceneBodyDuration + timelineDurations.after_scenes + postRoll + outroDuration + timelineDurations.after_outro + outroCardDuration

    let musicInput = ''
    if (musicIds.length > 1) {
      const content = musicIds.map(id => `file '{{asset:${id}}}'`).join('\n') + '\n'
      recipeFiles.push({ name: 'music.txt', content })
      steps.push({ tool: 'ffmpeg', args: [
        '-y', '-f', 'concat', '-safe', '0', '-i', '{{work:music.txt}}', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '{{work:music.mp3}}',
      ] })
      musicInput = '{{work:music.mp3}}'
    } else if (musicIds[0]) {
      musicInput = `{{asset:${musicIds[0]}}}`
    }
    const finalArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', '{{work:scenes.txt}}', '-i', `{{asset:${narrationId}}}`]
    const extraAudioInputs: string[] = []
    const audioFilters: string[] = []
    const mixLabels = ['[a_narr]']
    let audioIndex = 2
    audioFilters.push(`[1:a]aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${clamp((job.params as any).narration_volume, 0, 2, 1)},apad=whole_dur=${totalDuration.toFixed(3)}[a_narr]`)
    if (musicInput) {
      extraAudioInputs.push('-stream_loop', '-1', '-i', musicInput)
      const volume = clamp(params.music?.volume, 0, 1, 0.3)
      const postNarrationVolume = clamp(params.music?.post_narration_volume, 0, 1, 0.6)
      const fadeIn = clamp(params.music?.fade_in, 0, 600, 0)
      const fadeOut = clamp(params.music?.fade_out, 0, 600, 0)
      let musicFilter = `[${audioIndex}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${volume}`
      if (fadeIn > 0) musicFilter += `,afade=t=in:d=${fadeIn}`
      if (fadeOut > 0) musicFilter += `,afade=t=out:st=${Math.max(0, totalDuration - fadeOut).toFixed(3)}:d=${fadeOut}`
      musicFilter += '[a_music]'
      audioFilters.push(musicFilter)
      audioFilters.push(`[a_music]volume=enable='gt(t,${audioDuration.toFixed(3)})':volume=${(postNarrationVolume / Math.max(volume, 0.01)).toFixed(4)}[a_music2]`)
      mixLabels.push('[a_music2]'); audioIndex++
    }
    if (params.background_noise?.enabled) {
      if (customNoiseId) extraAudioInputs.push('-stream_loop', '-1', '-i', `{{asset:${customNoiseId}}}`)
      else {
        const noise = params.background_noise.preset === 'pink-noise' ? 'pink' : params.background_noise.preset === 'brown-noise' ? 'brown' : 'white'
        extraAudioInputs.push('-f', 'lavfi', '-i', `anoisesrc=color=${noise}:r=44100:d=${totalDuration.toFixed(3)}`)
      }
      const volume = clamp(params.background_noise.volume, 0, 1, 0.15)
      const fadeIn = clamp(params.background_noise.fade_in, 0, 600, 0)
      const fadeOut = clamp(params.background_noise.fade_out, 0, 600, 0)
      let noiseFilter = `[${audioIndex}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${volume}`
      if (fadeIn > 0) noiseFilter += `,afade=t=in:d=${fadeIn}`
      if (fadeOut > 0) noiseFilter += `,afade=t=out:st=${Math.max(0, totalDuration - fadeOut).toFixed(3)}:d=${fadeOut}`
      audioFilters.push(`${noiseFilter}[a_noise]`)
      mixLabels.push('[a_noise]'); audioIndex++
    }
    if (mixLabels.length > 1) audioFilters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=2,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=44100[aout]`)
    else audioFilters.push('[a_narr]aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=44100[aout]')
    finalArgs.push(...extraAudioInputs)

    let nextVisualInput = audioIndex
    const frameBackgroundInput = frameBackgroundId ? nextVisualInput++ : -1
    if (frameBackgroundId) {
      const backgroundPath = params.frame?.background_path || ''
      finalArgs.push(...(isStaticImagePath(backgroundPath) ? ['-loop', '1'] : ['-stream_loop', '-1']), '-i', `{{asset:${frameBackgroundId}}}`)
    }
    const logoInput = logoId ? nextVisualInput++ : -1
    if (logoId) finalArgs.push('-loop', '1', '-i', `{{asset:${logoId}}}`)
    const overlayInputs: Array<{ layer: VideoOverlay; input: number }> = []
    for (const rendered of renderOverlayLayers) {
      const input = nextVisualInput++
      const loopArgs = isStaticImagePath(rendered.sourcePath)
        ? ['-loop', '1']
        : rendered.layer.loop === false ? [] : ['-stream_loop', '-1']
      finalArgs.push(...loopArgs, '-i', `{{asset:${rendered.assetId}}}`)
      overlayInputs.push({ layer: rendered.layer, input })
    }

    let subtitleFilter = ''
    if (subtitleId) {
      const style = params.subtitles?.style
      const precise = style?.position_x_pct != null || style?.position_y_pct != null
      if (style && ((style.animation && style.animation !== 'none') || precise)) {
        const { parseSrt, srtToAss } = await import('../lib/subtitle-builder.js')
        const cues = parseSrt(await fs.readFile(subtitlePath, 'utf-8'))
        if (cues.length) {
          recipeFiles.push({ name: 'subtitles.ass', content: srtToAss(cues, style, { width, height, animation: style.animation || 'none' }) })
          subtitleFilter = "ass=filename='{{work:subtitles.ass}}'"
        }
      }
      if (!subtitleFilter && style) {
        const { buildAssStyle } = await import('../lib/subtitle-builder.js')
        subtitleFilter = `subtitles=filename='{{asset:${subtitleId}}}':original_size=1920x1080:force_style='${buildAssStyle(style).replace(/'/g, "\\\\'")}'`
      }
    }
    const effectsStart = params.exclude_intro_from_effects ? preSceneDuration : 0
    const gateEnable = buildGateEnable(effectsStart, effectEnd)
    const videoFilters: string[] = []
    let videoLabel = '[0:v]'
    let labelCounter = 0
    const nextLabel = () => `[rv${labelCounter++}]`
    for (const { layer, input } of overlayInputs) {
      const parts: string[] = []
      if (typeof layer.scale_pct === 'number' && layer.scale_pct > 0) {
        const target = Math.max(2, Math.round(width * Math.min(0.95, layer.scale_pct)))
        parts.push(`scale=${target - (target % 2)}:-2`)
      } else if (layer.scale === 'cover' || !layer.scale) {
        parts.push(`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`)
      } else if (layer.scale === 'contain') {
        parts.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`)
      }
      if (layer.chroma_key) {
        const color = layer.chroma_key.color.startsWith('#') ? `0x${layer.chroma_key.color.slice(1)}` : layer.chroma_key.color
        parts.push(`chromakey=color=${color}:similarity=${clamp(layer.chroma_key.similarity, 0, 1, 0.15)}:blend=${clamp(layer.chroma_key.blend, 0, 1, 0.1)}`)
      }
      if ((layer.opacity ?? 1) < 1) parts.push(`format=rgba,colorchannelmixer=aa=${clamp(layer.opacity, 0, 1, 1)}`)
      const sourceLabel = nextLabel()
      videoFilters.push(parts.length ? `[${input}:v]${parts.join(',')}${sourceLabel}` : `[${input}:v]null${sourceLabel}`)
      let x = layer.position?.x || '0'
      let y = layer.position?.y || '0'
      if (layer.position_anchor) {
        const margin = Math.round(height * 0.04)
        if (layer.position_anchor === 'center') { x = '(W-w)/2'; y = '(H-h)/2' }
        if (layer.position_anchor === 'top-third') { x = '(W-w)/2'; y = '(H/3-h/2)' }
        if (layer.position_anchor === 'bottom-third') { x = '(W-w)/2'; y = '(2*H/3-h/2)' }
        if (layer.position_anchor === 'lower-right') { x = `W-w-${margin}`; y = `H-h-${margin}` }
        if (layer.position_anchor === 'lower-left') { x = String(margin); y = `H-h-${margin}` }
      }
      const gates: string[] = []
      const globalGate = /^:enable='([^']+)'$/.exec(gateEnable)
      if (globalGate?.[1]) gates.push(globalGate[1])
      if (layer.time_range?.end_s != null) gates.push(`between(t,${layer.time_range.start_s || 0},${layer.time_range.end_s})`)
      else if (layer.time_range?.start_s) gates.push(`gte(t,${layer.time_range.start_s})`)
      const output = nextLabel()
      videoFilters.push(`${videoLabel}${sourceLabel}overlay=${x}:${y}${gates.length ? `:enable='${gates.join('*')}'` : ''}${output}`)
      videoLabel = output
    }
    if (params.color_grading?.enabled) {
      const grade = buildColorGradingFilters(params.color_grading, gateEnable)
      if (grade) {
        const label = nextLabel()
        videoFilters.push(`${videoLabel}${grade}${label}`)
        videoLabel = label
      }
    }
    if (params.vignette?.enabled) {
      const label = nextLabel()
      const angle = computeVignetteAngle(params.vignette.strength ?? 0.7)
      videoFilters.push(`${videoLabel}vignette=angle=${angle.toFixed(4)}:mode=forward:eval=init${gateEnable}${label}`)
      videoLabel = label
    }
    if (params.film_grain?.enabled) {
      const label = nextLabel()
      videoFilters.push(`${videoLabel}noise=alls=${Math.round(clamp(params.film_grain.strength, 0, 100, 15))}:allf=t+u${gateEnable}${label}`)
      videoLabel = label
    }
    if (params.letterbox?.enabled) {
      const label = nextLabel()
      const letterbox = buildLetterboxFilter(videoLabel, label, width, height, params.letterbox.ratio, params.letterbox.color || 'black')
      if (letterbox) {
        videoFilters.push(letterbox)
        videoLabel = label
      }
    }
    const frameOn = params.frame?.enabled === true
    if (frameOn) {
      const frameLabel = nextLabel()
      videoFilters.push(...buildVideoFrameFilter({
        inputLabel: videoLabel, backgroundInputLabel: frameBackgroundInput >= 0 ? `[${frameBackgroundInput}:v]` : undefined,
        outputLabel: frameLabel, prefix: 'remoteframe', width, height, fps, config: params.frame!,
      }))
      videoLabel = frameLabel
    }
    if (subtitleFilter) {
      const label = nextLabel()
      videoFilters.push(`${videoLabel}${subtitleFilter}${label}`)
      videoLabel = label
    }
    if (logoInput >= 0 && params.logo) {
      const logoLabel = `[rvlogo]`
      const logoWidth = Math.round(width * clamp(params.logo.scale, 0.01, 1, 0.1))
      const position = calculateLogoPosition(params.logo.position, Math.round(clamp(params.logo.margin, 0, 500, 20)), params.logo.custom_x, params.logo.custom_y)
      videoFilters.push(`[${logoInput}:v]scale=${logoWidth}:-1,format=rgba,colorchannelmixer=aa=${clamp(params.logo.opacity, 0, 1, 1)}${logoLabel}`)
      const label = nextLabel()
      const logoGate = gateEnable || (params.logo.hide_during_intro ? `:enable='gt(t,10)'` : '')
      videoFilters.push(`${videoLabel}${logoLabel}overlay=${position.x}:${position.y}${logoGate}${label}`)
      videoLabel = label
    }
    // The final graph always maps a labelled video stream (even with no visual
    // adjustment) so stream-copy is invalid here. Re-encode deterministically.
    const needsVideoEncode = true
    const filters = [...videoFilters, `${videoLabel}null[vout]`, ...audioFilters]
    finalArgs.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]')
    if (needsVideoEncode && renderFormat === 'webm') finalArgs.push('-c:v', 'libvpx-vp9', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps))
    else if (needsVideoEncode && params.codec === 'h265') finalArgs.push('-c:v', 'libx265', '-crf', String(params.export_settings?.crf || 23), '-preset', params.encoding_effort === 'hardware' ? 'medium' : params.encoding_effort || 'medium', '-pix_fmt', 'yuv420p', '-r', String(fps))
    else if (needsVideoEncode) finalArgs.push('-c:v', '{{video_encoder}}', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-r', String(fps))
    else finalArgs.push('-c:v', 'copy')
    finalArgs.push('-c:a', renderFormat === 'webm' ? 'libopus' : 'aac', '-b:a', '192k', '-shortest')
    if (renderFormat !== 'webm') finalArgs.push('-movflags', '+faststart')
    finalArgs.push('{{output}}')
    steps.push({ tool: 'ffmpeg', args: finalArgs })

    job.output_lines.push(`Render Studio: queued ${plan.scenes.length} scenes (${width}x${height} @ ${fps}fps).`)
    const submittedJob = await hubSubmitJob(backend.hubUrl, backend.hubToken, {
      modality: 'render', model: 'episode-assembly-v1', label: `story-video-assembly:${episodeId}`,
      items: [{ prompt: episodeId, params: {
        workflow: 'video_assembly',
        recipe: { version: 1, output_extension: renderFormat, assets, files: [...recipeFiles, { name: 'scenes.txt', content: concat }], steps },
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
    const outPath = path.join(finalDir, `${episodeId.toUpperCase()}_final_video.${renderFormat}`)
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
