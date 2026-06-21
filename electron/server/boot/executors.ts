/**
 * Job executor bootstrap — wires each queue's executor to its generator.
 *
 * The queue is type-indexed, so every value in `JobType` needs a registered
 * executor before a job of that type can run. Registering here keeps the
 * wiring centralised — adding a new job type means one edit here, not a
 * grep across app.ts.
 */

import { registerExecutor, setLlmConcurrency } from '../services/job-queue.js'
import { getScriptConcurrency } from '../services/app-settings.js'
import {
  generateScriptOnly, generateIntroductionOnly, generateChapterOnly,
  generateOutlineOnly, generateExpandChapters,
} from '../generators/episode.js'
import { generateImages } from '../generators/images.js'
import { reconcileImages } from '../services/image-reconciler.js'
import { reconcileVideos } from '../services/video-reconciler.js'
import { generateImagePrompts } from '../generators/image-prompts.js'
import { generateAudio } from '../generators/audio.js'
import { generateVideo as generateVideoAssembly } from '../generators/video.js'
import { generateAiVideo } from '../generators/ai-video.js'
import { generateAudioMerge } from '../generators/audio-merge.js'
import { generateMetadata } from '../generators/metadata.js'
import { generateSubtitlesTranscribe } from '../generators/subtitles.js'
import { generateYoutubeUpload } from '../generators/youtube-upload.js'
import { generateYoutubePlaylistUpdate } from '../generators/youtube-playlist-update.js'
import { normalizeBroll } from '../generators/broll-normalize.js'
import { generateBrollAssemble } from '../generators/broll-assemble.js'
import { generateBrollAutotag } from '../generators/broll-autotag.js'
import { fetchBroll } from '../generators/broll-fetch.js'
import { generateImagePoolImages } from '../generators/image-pool-generate.js'
import { runResearchJob } from '../generators/research.js'
import { runScenePlanJob } from '../generators/scene-plan.js'
import { generateSceneImageJob } from '../generators/scene-image.js'
import { runTimestampVideoAssemble } from '../generators/timestamp-video-assemble.js'
import { runContinuityRenderJob } from '../generators/continuity-render.js'
import { runPromptDirectorJob } from '../generators/prompt-director.js'
import { generateCompositionTemplateJob } from '../generators/composition-template.js'
import { runExpressionMarkupJob } from '../services/audio-expression.js'

export function registerAllExecutors(): void {
  // Level B — fail-loud guard for jobs that WRITE into the media-routed heavy
  // subfolders (05 Scene Images / 06 Thumbnails / 07-08 Audio / 10 Video). For
  // a project with an external media_root, this throws a clear error if the
  // drive/token isn't available instead of silently writing back into iCloud.
  // No-op for non-split projects. NOTE: scene_image_generate / continuity_render
  // are intentionally NOT guarded — they write to `episode_dir/scene_images`,
  // which is not media-routed.
  const guardMedia = (fn: (job: any) => Promise<unknown>) => async (job: any): Promise<void> => {
    const { assertMediaRootReady } = await import('../services/media-root.js')
    await assertMediaRootReady(job.project_slug)
    await fn(job)
  }
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
  registerExecutor('images', guardMedia(generateImages))
  registerExecutor('scene_images', guardMedia(generateImages))
  registerExecutor('thumb_images', guardMedia(generateImages))
  // Repair = recover already-paid-for results from the provider's stored
  // task records. Wraps `reconcileImages` so the existing job-queue lifecycle
  // (cancel / retry / log streaming) covers it just like a normal generation.
  registerExecutor('images_repair', guardMedia(async (job) => {
    const episodeId = (job.params as any)?.episode_id || job.episode_id
    const rawPool = (job.params as any)?.pool
    const pool = rawPool === 'scenes' || rawPool === 'thumbnails' ? rawPool : 'all'
    await reconcileImages(job.project_slug, episodeId, job, pool)
  }))
  // Same shape as images_repair — delegates the per-provider dispatch
  // (kie-video / fal-video) to the reconciler itself.
  registerExecutor('video_repair', guardMedia(async (job) => {
    const episodeId = (job.params as any)?.episode_id || job.episode_id
    await reconcileVideos(job.project_slug, episodeId, job)
  }))
  registerExecutor('audio', guardMedia(generateAudio))
  registerExecutor('audio_merge', guardMedia(generateAudioMerge))
  registerExecutor('metadata', generateMetadata)
  registerExecutor('video', guardMedia(generateAiVideo))
  registerExecutor('video_assembly', guardMedia(generateVideoAssembly))
  registerExecutor('subtitles_transcribe', generateSubtitlesTranscribe)
  registerExecutor('youtube_upload', generateYoutubeUpload)
  registerExecutor('youtube_playlist_update', generateYoutubePlaylistUpdate)
  // v1.0.89+: B-Roll pipeline. Re-encodes one stock clip to 1080p at the
  // pool's target fps (24 or 30) so Video Assembly can concat-demux for
  // speed instead of running a per-frame filtergraph at render time.
  registerExecutor('broll_normalize', normalizeBroll)
  registerExecutor('broll_assemble', guardMedia(generateBrollAssemble))
  registerExecutor('broll_autotag', generateBrollAutotag)
  // v1.0.122+: B-Roll Fetch — downloads one Pexels/Pixabay clip into a
  // pool + writes the provenance sidecar. Search routes live in
  // routes/broll-fetch.ts; the per-pool queue endpoint lives in
  // routes/broll-pools.ts alongside normalize/autotag.
  registerExecutor('broll_fetch', fetchBroll)
  // v1.0.410+ — generate stills into an Image Pool (grow the pool).
  registerExecutor('image_pool_generate', generateImagePoolImages)
  // v1.0.142+ — Research phase for the timestamp-driven pipeline.
  registerExecutor('research_run', runResearchJob)
  // v1.0.143+ — Scene planner for the timestamp-driven pipeline.
  registerExecutor('scene_plan_run', runScenePlanJob)
  // v1.0.144+ — Per-scene image generator (one job per scene).
  registerExecutor('scene_image_generate', generateSceneImageJob)
  registerExecutor('continuity_render', runContinuityRenderJob)
  // v1.0.260 — Prompt Director: rewrites scene prompts into the explainer
  // composition (guide-at-side + framed subject) per the Visual Recipe.
  registerExecutor('prompt_director', runPromptDirectorJob)
  // v1.0.260 — generate the composition LAYOUT template image from a prompt.
  registerExecutor('composition_generate', generateCompositionTemplateJob)
  // v1.0.145+ — Final ffmpeg assembler for the timestamp-driven pipeline.
  registerExecutor('timestamp_video_assemble', guardMedia(runTimestampVideoAssemble))
  // v1.0.386 — Fish S2 expression "Tag all" — background LLM markup over every
  // section (survives leaving the Audio Generator page).
  registerExecutor('expression_markup', runExpressionMarkupJob)

  // Load the saved LLM-text concurrency (Settings → Performance) into the
  // queue. Fire-and-forget: the queue defaults to 2 until this resolves
  // (a few ms), and the PUT route applies live changes without a restart.
  void getScriptConcurrency()
    .then(setLlmConcurrency)
    .catch(e => console.warn('[boot] failed to load script_concurrency:', e?.message))
}
