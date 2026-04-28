/**
 * Job executor bootstrap — wires each queue's executor to its generator.
 *
 * The queue is type-indexed, so every value in `JobType` needs a registered
 * executor before a job of that type can run. Registering here keeps the
 * wiring centralised — adding a new job type means one edit here, not a
 * grep across app.ts.
 */

import { registerExecutor } from '../services/job-queue.js'
import { generateScriptOnly, generateIntroductionOnly, generateChapterOnly } from '../generators/episode.js'
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

export function registerAllExecutors(): void {
  // Legacy `'script'` executor (the coupled generateEpisode) was removed
  // in M1. Script and introduction are now two independent job types.
  registerExecutor('script-only', generateScriptOnly)
  registerExecutor('introduction-only', generateIntroductionOnly)
  registerExecutor('chapter-only', generateChapterOnly)
  registerExecutor('image_prompts', generateImagePrompts)
  registerExecutor('images', generateImages)
  registerExecutor('scene_images', generateImages)
  registerExecutor('thumb_images', generateImages)
  // Repair = recover already-paid-for results from the provider's stored
  // task records. Wraps `reconcileImages` so the existing job-queue lifecycle
  // (cancel / retry / log streaming) covers it just like a normal generation.
  registerExecutor('images_repair', async (job) => {
    const episodeId = (job.params as any)?.episode_id || job.episode_id
    await reconcileImages(job.project_slug, episodeId, job)
  })
  // Same shape as images_repair — delegates the per-provider dispatch
  // (genaipro-veo / kie-video / fal-video) to the reconciler itself.
  registerExecutor('video_repair', async (job) => {
    const episodeId = (job.params as any)?.episode_id || job.episode_id
    await reconcileVideos(job.project_slug, episodeId, job)
  })
  registerExecutor('audio', generateAudio)
  registerExecutor('audio_merge', generateAudioMerge)
  registerExecutor('metadata', generateMetadata)
  registerExecutor('video', generateAiVideo)
  registerExecutor('video_assembly', generateVideoAssembly)
  registerExecutor('subtitles_transcribe', generateSubtitlesTranscribe)
  registerExecutor('youtube_upload', generateYoutubeUpload)
  registerExecutor('youtube_playlist_update', generateYoutubePlaylistUpdate)
}
