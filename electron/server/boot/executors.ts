/**
 * Job executor bootstrap — wires each queue's executor to its generator.
 *
 * The queue is type-indexed, so every value in `JobType` needs a registered
 * executor before a job of that type can run. Registering here keeps the
 * wiring centralised — adding a new job type means one edit here, not a
 * grep across app.ts.
 */

import { initializeQueuePauseState, registerExecutor, resumeInterruptedJobsAtBoot, unregisteredJobTypes } from '../services/job-queue.js'
import {
  generateScriptOnly, generateIntroductionOnly, generateChapterOnly,
  generateOutlineOnly, generateExpandChapters,
} from '../generators/episode.js'
import { generateImages } from '../generators/images.js'
import { reconcileImages } from '../services/image-reconciler.js'
import { generateImagePrompts } from '../generators/image-prompts.js'
import { generateAudio } from '../generators/audio.js'
import { generateVideo as generateVideoAssembly } from '../generators/video.js'
import { generateAiVideo } from '../generators/ai-video.js'
import { generateAudioMerge } from '../generators/audio-merge.js'
import { generateMetadata } from '../generators/metadata.js'
import { generateSubtitlesTranscribe } from '../generators/subtitles.js'
import { generateYoutubeUpload } from '../generators/youtube-upload.js'
import { generateYoutubePlaylistUpdate } from '../generators/youtube-playlist-update.js'
import { generateThumbnailRefresh } from '../generators/youtube-thumbnail-refresh.js'
import { normalizeBroll } from '../generators/broll-normalize.js'
import { generateBrollAssemble } from '../generators/broll-assemble.js'
import { generateBrollSelection } from '../generators/broll-select.js'
import { generateBrollAutotag } from '../generators/broll-autotag.js'
import { generateImagePoolImages } from '../generators/image-pool-generate.js'
import { runResearchJob } from '../generators/research.js'
import { runScenePlanJob } from '../generators/scene-plan.js'
import { generateContextualCues } from '../generators/contextual-cues.js'
import { generateSceneImageJob } from '../generators/scene-image.js'
import { generateSceneClipJob, generateSceneClipsBatchJob } from '../generators/scene-clip.js'
import { runContinuityRenderJob } from '../generators/continuity-render.js'
import { generateCompositionTemplateJob } from '../generators/composition-template.js'
import { runExpressionMarkupJob } from '../services/audio-expression.js'
import { generateIdeaCampaign } from '../generators/idea-campaign.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { registerJobCancellationAuditor } from '../services/job-cancellation-auditors.js'
import { getAudioStatus } from '../services/audio-reconciler.js'
import { getImageStatus, getVideoStatus } from '../services/asset-status.js'
import { inspectSubtitleCompletion } from '../services/subtitle-completion.js'
import { auditSceneClipCompletion, auditSceneImageCompletion } from '../services/scene-media-checkpoint.js'
import { auditScenePromptCompletion } from '../services/scene-prompt-checkpoint.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import fs from 'fs/promises'
import path from 'path'

async function auditSceneImages(job: any): Promise<'complete' | 'repair-required'> {
  const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, job.episode_id, paths.episode_dir)
  const ids = Array.isArray(job.params?.scene_ids) && job.params.scene_ids.length
    ? job.params.scene_ids.map(String)
    : [job.params?.single_scene_id || job.params?.scene_id].filter(Boolean).map(String)
  if (!ids.length) return 'repair-required'
  const audit = await auditSceneImageCompletion(planPath, ids, [job.output_dir || path.join(paths.episode_dir, 'scene_images')])
  return audit.completed === audit.expected ? 'complete' : 'repair-required'
}

async function auditSceneClips(job: any): Promise<'complete' | 'repair-required'> {
  const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, job.episode_id, paths.episode_dir)
  const ids = Array.isArray(job.params?.scene_ids) && job.params.scene_ids.length
    ? job.params.scene_ids.map(String)
    : [job.params?.scene_id].filter(Boolean).map(String)
  if (!ids.length) return 'repair-required'
  const audit = await auditSceneClipCompletion(planPath, ids, job.output_dir || paths.video_assets_dir)
  return audit.completed === audit.expected ? 'complete' : 'repair-required'
}

export async function auditScenePlanOutput(job: any): Promise<'complete' | 'repair-required'> {
  const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, job.episode_id, paths.episode_dir)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  const params = job.params || {}
  const stage: 'visual' | 'motion' = params.stage === 'motion' || params.regenerate_empty_motion_prompts
    || params.regenerate_motion_prompt_scene_id
    ? 'motion'
    : 'visual'
  const singleId = stage === 'motion'
    ? params.regenerate_motion_prompt_scene_id
    : params.regenerate_prompt_scene_id || params.replan_scene_id
  const ids = singleId
    ? [String(singleId)]
    : (Array.isArray(plan?.scenes) ? plan.scenes : [])
      .filter((scene: any) => stage === 'visual' || (!!scene?.visual_prompt?.trim() && scene?.motion_mode !== 'still'))
      .map((scene: any) => String(scene?.id || ''))
      .filter(Boolean)
  if (!ids.length) return 'repair-required'
  const audit = await auditScenePromptCompletion(planPath, ids, stage)
  return audit.missing_ids.length === 0 ? 'complete' : 'repair-required'
}

/** Register only producer-specific completion proofs; no generic file guess. */
function registerCancellationAuditors(): void {
  registerJobCancellationAuditor('audio', async job => {
    try {
      const status = await getAudioStatus(job.project_slug, job.episode_id)
      return status.expected.length > 0 && status.missing.length === 0 ? 'complete' : 'repair-required'
    } catch { return 'repair-required' }
  })
  registerJobCancellationAuditor('subtitles_transcribe', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const status = await inspectSubtitleCompletion(paths.episode_dir, paths.subtitles_dir, job.episode_id, { require_per_section: true })
    return status.complete ? 'complete' : 'repair-required'
  })
  // v1.4.41 — `thumb_images` is the only surviving member of the old image
  // trio. `images` and `scene_images` were registered here for years but
  // nothing could enqueue them: `POST /generate/images` assigns `thumb_images`
  // for mode 'thumbs' and returns 410 "Legacy Scene Images generation is
  // retired" for anything else.
  registerJobCancellationAuditor('thumb_images', async job => {
    const status = await getImageStatus(job.project_slug, job.episode_id, 'thumbnails')
    const parts = [status.thumbnails].filter(Boolean)
    return parts.length > 0 && parts.every(part => part!.total > 0 && part!.missing.length === 0) ? 'complete' : 'repair-required'
  })
  for (const type of ['scene_image_generate', 'continuity_render'] as const) {
    registerJobCancellationAuditor(type, auditSceneImages)
  }
  registerJobCancellationAuditor('composition_generate', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const file = path.join(paths.episode_dir, 'img2img-references', 'composition.png')
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile() || stat.size <= 0) return 'repair-required'
    try { await assertDecodableImage(file, 'Composition template') }
    catch { return 'repair-required' }
    return 'complete'
  })
  registerJobCancellationAuditor('image_pool_generate', async job => {
    const { getPool } = await import('../services/broll-pool-manager.js')
    const pool = await getPool(String(job.params?.pool_id || ''))
    const runId = String(job.params?.run_id || '')
    const variants = Math.max(1, Math.min(4, Math.floor(Number(job.params?.variants) || 1)))
    const promptCount = Array.isArray(job.params?.prompts) ? job.params.prompts.length : 0
    if (!pool || !runId || !promptCount) return 'repair-required'
    const recovery = job.params?.genstudio_recovery
    const assets = recovery?.version === 1 && recovery?.route === 'genstudio' && recovery?.assets
      ? recovery.assets as Record<string, { operation?: string; state?: string; output_path?: string }>
      : null
    if (!assets) return 'repair-required'
    const expected = Array.from({ length: promptCount * variants }, (_, index) => (
      `gen-${runId}-${String(index + 1).padStart(4, '0')}.png`
    ))
    for (const filename of expected) {
      const asset = assets[filename]
      const outputPath = asset?.output_path
      if (asset?.operation !== 'image' || !['accepted', 'succeeded'].includes(String(asset.state)) || typeof outputPath !== 'string') return 'repair-required'
      if (path.resolve(outputPath) !== path.resolve(pool.folder_path, filename)) return 'repair-required'
      const stat = await fs.stat(outputPath).catch(() => null)
      if (!stat?.isFile() || stat.size <= 0) return 'repair-required'
      try { await assertDecodableImage(outputPath, `Image pool asset ${filename}`) }
      catch { return 'repair-required' }
    }
    return 'complete'
  })
  for (const type of ['scene_clip_generate', 'scene_clips_batch'] as const) {
    registerJobCancellationAuditor(type, auditSceneClips)
  }
  registerJobCancellationAuditor('scene_plan_run', auditScenePlanOutput)
  registerJobCancellationAuditor('video', async job => {
    const status = await getVideoStatus(job.project_slug, job.episode_id)
    return status.total > 0 && status.present === status.total ? 'complete' : 'repair-required'
  })
}

export function registerAllExecutors(options: { loadSettings?: boolean } = {}): void {
  registerCancellationAuditors()
  // Level B — fail-loud guard for jobs that WRITE into the media-routed heavy
  // subfolders (05 Scene Images / 06 Thumbnails / 07-08 Audio / 10 Video). For
  // a project with an external media_root, this throws a clear error if the
  // drive/token isn't available instead of silently writing back into iCloud.
  // No-op for non-split projects. NOTE: scene_image_generate / continuity_render
  // are intentionally NOT guarded — they write to `episode_dir/scene_images`,
  // which is not media-routed.
  const guardMedia = (fn: (job: any) => Promise<unknown>) => async (job: any): Promise<import('../services/job-queue.js').JobExecutorResult> => {
    const { assertMediaRootReady } = await import('../services/media-root.js')
    await assertMediaRootReady(job.project_slug)
    return await fn(job) as import('../services/job-queue.js').JobExecutorResult
  }
  registerExecutor('idea_campaign', generateIdeaCampaign)
  // Legacy `'script'` executor (the coupled generateEpisode) was removed
  // in M1. Script and introduction are now two independent job types.
  registerExecutor('script-only', generateScriptOnly)
  registerExecutor('introduction-only', generateIntroductionOnly)
  registerExecutor('chapter-only', generateChapterOnly)
  // v1.0.72+: outline-first chunked flow. outline_only builds the outline
  // and persists the sidecar with outline_approved_at: null (or set when
  // auto_approve: true is on the params). expand_chapters reads the
  // approved sidecar and expands all-or-selected chapters with per-entry
  // word-count overrides. The legacy script-only path stays for now —
  // Phase 3 of the refactor will route it through these instead.
  registerExecutor('outline_only', generateOutlineOnly)
  registerExecutor('expand_chapters', generateExpandChapters)
  registerExecutor('image_prompts', generateImagePrompts)
  registerExecutor('thumb_images', guardMedia(generateImages))
  // Repair = recover already-paid-for results from the provider's stored
  // task records. Wraps `reconcileImages` so the existing job-queue lifecycle
  // (cancel / retry / log streaming) covers it just like a normal generation.
  registerExecutor('images_repair', guardMedia(async (job) => {
    const episodeId = (job.params as any)?.episode_id || job.episode_id
    const rawPool = (job.params as any)?.pool
    const pool = rawPool === 'scenes' || rawPool === 'thumbnails' ? rawPool : 'all'
    const result = await reconcileImages(job.project_slug, episodeId, job, pool)
    if (result.total_expected === 0) throw new Error('No expected images were found to repair. Generate prompts first, then use Generate missing.')
    job.result = result
    const unresolved = [...result.scene_results, ...result.thumb_results]
      .filter(item => item.status !== 'recovered' && item.status !== 'skipped_ok')
      .map(item => item.filename)
    requireJobCompletion(job, {
      label: 'Image repair', expected: result.total_expected,
      completed: result.recovered + result.skipped_ok, missing: unresolved,
      retry_hint: 'Recovered files were saved. Items without a task result need fresh generation.',
    })
  }))
  // v1.4.37 — tops up a channel's music library. guardMedia because it writes
  // audio files into the project folder like every other media generator.
  registerExecutor('music_generate', guardMedia(async (job) => {
    const { generateMusicLibraryTracks } = await import('../generators/music-generate.js')
    await generateMusicLibraryTracks(job)
  }))
  registerExecutor('music_video', guardMedia(async (job) => {
    const { generateMusicVideo } = await import('../generators/music-video.js')
    await generateMusicVideo(job)
  }))
  registerExecutor('audio', guardMedia(generateAudio))
  registerExecutor('audio_merge', guardMedia(generateAudioMerge))
  registerExecutor('metadata', generateMetadata)
  registerExecutor('video', guardMedia(generateAiVideo))
  registerExecutor('video_assembly', guardMedia(generateVideoAssembly))
  registerExecutor('subtitles_transcribe', generateSubtitlesTranscribe)
  registerExecutor('youtube_upload', generateYoutubeUpload)
  registerExecutor('youtube_playlist_update', generateYoutubePlaylistUpdate)
  registerExecutor('youtube_thumbnail_refresh', generateThumbnailRefresh)
  // v1.0.89+: B-Roll pipeline. Re-encodes one stock clip to 1080p at the
  // pool's target fps (24 or 30) so Video Assembly can concat-demux for
  // speed instead of running a per-frame filtergraph at render time.
  registerExecutor('broll_normalize', normalizeBroll)
  registerExecutor('broll_select', generateBrollSelection)
  registerExecutor('broll_assemble', guardMedia(generateBrollAssemble))
  // v1.0.410+ — generate stills into an Image Pool (grow the pool).
  registerExecutor('image_pool_generate', generateImagePoolImages)
  // v1.0.142+ — Research phase for the timestamp-driven pipeline.
  registerExecutor('research_run', runResearchJob)
  // v1.0.143+ — Scene planner for the timestamp-driven pipeline.
  registerExecutor('scene_plan_run', runScenePlanJob)
  registerExecutor('contextual_cues', generateContextualCues)
  // v1.0.144+ — Per-scene image generator (one job per scene).
  registerExecutor('scene_image_generate', generateSceneImageJob)
  // v1.0.470 — Phase 2: per-scene image-to-video clip. Heavy media → guarded.
  registerExecutor('scene_clip_generate', guardMedia(generateSceneClipJob))
  registerExecutor('scene_clips_batch', guardMedia(generateSceneClipsBatchJob))
  registerExecutor('continuity_render', runContinuityRenderJob)
  // v1.0.260 — generate the composition LAYOUT template image from a prompt.
  registerExecutor('composition_generate', generateCompositionTemplateJob)
  // v1.0.386 — Fish S2 expression "Tag all" — background LLM markup over every
  // section (survives leaving the Audio Generator page).
  registerExecutor('expression_markup', runExpressionMarkupJob)

  const missingExecutors = unregisteredJobTypes()
  if (missingExecutors.length) {
    throw new Error(`Job executor registration incomplete: ${missingExecutors.join(', ')}`)
  }

  if (options.loadSettings !== false) {
    void initializeQueuePauseState()
      .then(() => resumeInterruptedJobsAtBoot())
      .catch(e => console.warn('[boot] failed to initialize durable queue state:', e?.message))
    // The durable recovery scan is chained after queue-hold restoration above,
    // so a user-paused queue cannot race and start work during app boot.
  }
}
