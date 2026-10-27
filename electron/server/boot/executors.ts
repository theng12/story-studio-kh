/**
 * Job executor bootstrap — wires each queue's executor to its generator.
 *
 * The queue is type-indexed, so every value in `JobType` needs a registered
 * executor before a job of that type can run. Registering here keeps the
 * wiring centralised — adding a new job type means one edit here, not a
 * grep across app.ts.
 */

import { initializeQueuePauseState, jobEvents, registerExecutor, resumeInterruptedJobsAtBoot, unregisteredJobTypes } from '../services/job-queue.js'
import {
  generateIntroductionOnly, generateChapterOnly,
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
import { startEpisodeRecovery } from '../services/episode-recovery.js'
import { startFinalRenderReconciler } from '../services/final-render-reconciler.js'
import { startYouTubeStatusSync } from '../services/youtube-status-sync.js'
import { invalidateForFinishedJob } from '../services/episode-status-cache.js'
import { settleAfterSuccess } from '../services/stale-failures.js'
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
import { generateIdeaCampaign } from '../generators/idea-campaign.js'
import { requireJobCompletion, completionErrorMessage } from '../services/job-completion.js'
import { registerJobCancellationAuditor, type JobCancellationAudit } from '../services/job-cancellation-auditors.js'
import { getAudioStatus } from '../services/audio-reconciler.js'
import { getImageStatus, getVideoStatus } from '../services/asset-status.js'
import { inspectSubtitleCompletion } from '../services/subtitle-completion.js'
import { inspectPromptCompletion } from '../services/prompt-completion.js'
import { inspectMetadataCompletion } from '../services/metadata-completion.js'
import {
  inspectChapterCompletion,
  inspectContextualCueCompletion,
  inspectExpandedScriptCompletion,
  inspectIntroductionCompletion,
  inspectOutlineCompletion,
  inspectScenePolishCompletion,
  readMusicScenePolishSnapshot,
  requestedChapterNumber,
  requestedChapterSelection,
  resolvedOutlineChapterCount,
  type ScenePolishProof,
} from '../services/text-completion.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { isResearchComplete } from '../lib/research-verification.js'
import { getLibraryDir } from '../services/music-library.js'
import { auditSceneClipCompletion, auditSceneImageCompletion } from '../services/scene-media-checkpoint.js'
import { auditScenePromptCompletion } from '../services/scene-prompt-checkpoint.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import { inspectBrollAssemblyOutput } from '../services/video-visual-source.js'
import fs from 'fs/promises'
import path from 'path'

function withoutDeliberateStillScenes(plan: any, ids: string[]): string[] {
  const scenesById = new Map<string, { motion_choice?: unknown }>(
    (Array.isArray(plan?.scenes) ? plan.scenes : [])
      .map((scene: any) => [String(scene?.id || ''), scene] as const),
  )
  // A frozen batch never changes its request boundary. A scene can, however,
  // be deliberately changed to Still while that batch is paused or recovering;
  // it no longer needs a motion asset or prompt. Missing rows stay in the audit
  // so a replan cannot turn an invalid saved request into a false completion.
  return ids.filter(id => scenesById.get(id)?.motion_choice !== 'still')
}

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

export async function auditSceneClips(job: any): Promise<'complete' | 'repair-required'> {
  const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, job.episode_id, paths.episode_dir)
  // A queued motion batch owns this frozen request boundary. In particular,
  // [] is an intentional off-scope snapshot, not a missing field that may
  // expand to whichever scenes happen to need clips after a later plan edit.
  const snapshotIds = Array.isArray(job.params?.motion_scene_ids)
    ? job.params.motion_scene_ids.map(String)
    : undefined
  const ids = snapshotIds ?? (Array.isArray(job.params?.scene_ids) && job.params.scene_ids.length
    ? job.params.scene_ids.map(String)
    : [job.params?.scene_id].filter(Boolean).map(String))
  if (!ids.length) return snapshotIds ? 'complete' : 'repair-required'
  const auditIds = snapshotIds === undefined
    ? ids
    : withoutDeliberateStillScenes(JSON.parse(await fs.readFile(planPath, 'utf8')), ids)
  if (!auditIds.length) return 'complete'
  const audit = await auditSceneClipCompletion(planPath, auditIds, job.output_dir || paths.video_assets_dir, {},
    { slug: job.project_slug, episodeId: job.episode_id, episodeDir: paths.episode_dir })
  return audit.completed === audit.expected ? 'complete' : 'repair-required'
}

export async function auditScenePlanOutput(job: any): Promise<JobCancellationAudit> {
  const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, job.episode_id, paths.episode_dir)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  const params = job.params || {}
  // The model-free timeline step. `stage: 'timeline'` is the page's own "Build
  // timeline" request; a Pipeline run omits `stage` (it owes prompts too) and the
  // repair flags re-prompt saved scenes. Auditing a timeline-only run for visual
  // prompts judged it against output it is deliberately not asked to produce, so
  // a correct timeline failed its own completion proof. Its proof is the
  // timeline: real, forward-running scene timings and the record that a timeline
  // was built.
  const timelineOnly = params.stage === 'timeline'
    && !params.regenerate_prompt_scene_id && !params.regenerate_prompt_scene_ids?.length && !params.regenerate_empty_prompts
    && !params.regenerate_motion_prompt_scene_id && !params.regenerate_empty_motion_prompts
    && !params.replan_scene_id
  if (timelineOnly) {
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : []
    const usable = scenes.filter((scene: any) =>
      Number.isFinite(scene?.start_sec) && Number.isFinite(scene?.end_sec)
      && Number(scene.end_sec) > Number(scene.start_sec))
    return usable.length > 0 && !!plan?.timeline_built_at ? 'complete' : 'repair-required'
  }
  const stage: 'visual' | 'motion' = params.stage === 'motion' || params.regenerate_empty_motion_prompts
    || params.regenerate_motion_prompt_scene_id
    ? 'motion'
    : 'visual'
  const motionSnapshotIds = stage === 'motion' && Array.isArray(params.motion_scene_ids)
    ? params.motion_scene_ids.map(String)
    : undefined
  const singleId = stage === 'motion'
    ? params.regenerate_motion_prompt_scene_id
    : params.regenerate_prompt_scene_id || params.replan_scene_id
  const selectedIds = stage === 'visual' && Array.isArray(params.regenerate_prompt_scene_ids) && params.regenerate_prompt_scene_ids.length
    ? params.regenerate_prompt_scene_ids.map(String)
    : undefined
  const ids = motionSnapshotIds ?? selectedIds ?? (singleId
    ? [String(singleId)]
    : (Array.isArray(plan?.scenes) ? plan.scenes : [])
      .filter((scene: any) => stage === 'visual' || (!!scene?.visual_prompt?.trim() && scene?.motion_mode !== 'still'))
      .map((scene: any) => String(scene?.id || ''))
      .filter(Boolean))
  if (!ids.length) return motionSnapshotIds ? 'complete' : 'repair-required'
  const auditIds = motionSnapshotIds === undefined
    ? ids
    : withoutDeliberateStillScenes(plan, ids)
  if (!auditIds.length) return 'complete'
  const audit = await auditScenePromptCompletion(planPath, auditIds, stage)
  if (audit.missing_ids.length === 0) return 'complete'
  // Name the scenes at fault. The same formatter the generator's own completion proof uses, so the
  // post-restart reconciliation says what the run itself would have said instead of the generic
  // "needs repair" sentence (Nature EP0014, 2026-10-19: 383 scenes, every visual prompt blank).
  return {
    verdict: 'repair-required',
    detail: completionErrorMessage({
      label: stage === 'motion' ? 'Scene plan motion prompts' : 'Scene plan visual prompts',
      expected: audit.completed_ids.length + audit.missing_ids.length,
      completed: audit.completed_ids.length,
      missing: audit.missing_ids,
      item_name: stage === 'motion' ? 'motion prompt' : 'visual prompt',
      issues: audit.issues,
      retry_hint: 'Retry rewrites only those scenes; every prompt already saved is kept.',
    }),
  }
}

/** Re-use the producer's concrete final/narration proof during recovery. */
export async function auditBrollAssemblyOutput(job: any): Promise<'complete' | 'repair-required'> {
  try {
    const inspection = await inspectBrollAssemblyOutput({
      project_slug: job.project_slug,
      episode_id: job.episode_id,
      title: job.title || '',
      output_dir: typeof job.output_dir === 'string' ? job.output_dir : undefined,
    })
    if (inspection.complete) return 'complete'
    job.output_lines?.push(`${inspection.reason} ${inspection.retry_hint}`.trim())
  } catch (error: any) {
    job.output_lines?.push(`B-Roll completion proof could not be read (${error?.message || error}). Retry B-Roll Assembly.`)
  }
  return 'repair-required'
}

/** Every planned music request saved at least one non-empty track into the library. */
export async function auditMusicLibraryTopUp(job: any): Promise<'complete' | 'repair-required'> {
  const saved: unknown[] = Array.isArray(job.result?.saved_tracks) ? job.result.saved_tracks : []
  const requests = Number(job.result?.requests)
  if (!saved.length || !Number.isFinite(requests) || requests < 1 || saved.length < requests) return 'repair-required'
  const dir = await getLibraryDir(job.project_slug)
  if (!dir) return 'repair-required'
  for (const name of saved) {
    if (typeof name !== 'string' || !name || name !== path.basename(name)) return 'repair-required'
    const stat = await fs.stat(path.join(dir, name)).catch(() => null)
    if (!stat?.isFile() || stat.size <= 0) return 'repair-required'
  }
  return 'complete'
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
    const known = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const status = await getImageStatus(job.project_slug, job.episode_id, 'thumbnails', known, { treeFallback: true })
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
  // Audit 2026-10-02 — `music_generate` had none, so cancelling a running top-up answered 409
  // REMOTE_CANCELLATION_NOT_SUPPORTED and the Hub finished the render anyway. The proof it can
  // give is the one its own generator writes: every request it planned saved at least one track
  // that is still in the library folder. A job that stopped half way has fewer tracks than
  // requests, so it stays repair-required rather than being called complete.
  registerJobCancellationAuditor('music_generate', auditMusicLibraryTopUp)
  // Group 1.1b — `broll_assemble` had no auditor at all, so a truncated video
  // (the generator encodes `-shortest`) reported Done over a cut-off render.
  registerJobCancellationAuditor('broll_assemble', auditBrollAssemblyOutput)
  registerJobCancellationAuditor('video', async job => {
    const status = await getVideoStatus(job.project_slug, job.episode_id)
    return status.total > 0 && status.present === status.total ? 'complete' : 'repair-required'
  })
  // NEW-02 — the text job types that had no auditor at all. A restart that
  // removed the executor could leave a SETTLED provider task with nothing able
  // to verify the local output, so the job failed loudly (DS-02). That is
  // honest, but it is an error for work that may be complete. Each auditor
  // reuses the same proof its generator already used, so "complete" still means
  // verified output rather than a settled provider task (AGENTS.md §8), and an
  // unreadable or partial artifact stays repair-required.
  registerJobCancellationAuditor('image_prompts', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const audit = await inspectPromptCompletion(paths.thumb_prompts_dir, job.episode_id, 'thumbnail')
    return audit.authoritative && audit.complete ? 'complete' : 'repair-required'
  })
  registerJobCancellationAuditor('metadata', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const audit = await inspectMetadataCompletion(paths.metadata_dir, job.episode_id)
    return audit.authoritative && audit.complete ? 'complete' : 'repair-required'
  })
  registerJobCancellationAuditor('research_run', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const { jsonPath } = await resolveResearchPaths(paths.episode_dir, job.episode_id)
    try {
      const research = JSON.parse(await fs.readFile(jsonPath, 'utf-8'))
      return isResearchComplete(research) ? 'complete' : 'repair-required'
    } catch { return 'repair-required' }
  })
  // The six WRITING types that had no auditor at all. The queue's
  // provider-settlement path asks the auditor BEFORE it offers to pick a
  // settled writing job up again, so without one it failed the job loudly
  // ("no completion audit is registered for this job type") and the resume
  // never happened — even when the text was already on disk. Each auditor
  // below proves ONE type's OWN artifact; they deliberately do not share a
  // generic "is there a file" guess (AGENTS.md §8).
  registerJobCancellationAuditor('outline_only', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    // The count the run was ACTUALLY asked for: its own completion
    // declaration first, the request's chapter count as the fallback (see
    // `resolvedOutlineChapterCount` for the generator's resolution chain).
    const audit = await inspectOutlineCompletion(paths.script_dir, job.episode_id, resolvedOutlineChapterCount(job))
    return audit.complete ? 'complete' : 'repair-required'
  })
  registerJobCancellationAuditor('expand_chapters', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const audit = await inspectExpandedScriptCompletion(
      paths.script_dir,
      job.episode_id,
      requestedChapterSelection(job.params),
    )
    return audit.complete ? 'complete' : 'repair-required'
  })
  registerJobCancellationAuditor('introduction-only', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const audit = await inspectIntroductionCompletion(paths.script_dir, job.episode_id)
    return audit.complete ? 'complete' : 'repair-required'
  })
  registerJobCancellationAuditor('chapter-only', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const audit = await inspectChapterCompletion(paths.script_dir, job.episode_id, requestedChapterNumber(job.params))
    return audit.complete ? 'complete' : 'repair-required'
  })
  registerJobCancellationAuditor('contextual_cues', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const planPath = await resolveScenePlanPath(job.project_slug, job.episode_id, paths.episode_dir)
    const audit = await inspectContextualCueCompletion(planPath)
    return audit.complete ? 'complete' : 'repair-required'
  })
  registerJobCancellationAuditor('music_scene_polish', async job => {
    const { readEpisodeDoc, readMusicScenePolishRun } = await import('../services/music-episode-store.js')
    const { validateMusicScenePolishArtifact } = await import('../services/text-completion.js')
    const slug = job.project_slug
    // The same episode the generator wrote to (`params.episode_id` first).
    const code = String((job.params as any)?.episode_id || job.episode_id || '').toUpperCase()
    // The run's OWN artifact decides. A prompt on the episode document is not
    // proof that this run wrote it: the same field is what the owner edits by
    // hand and what an earlier polish left behind, so "the document is fresh
    // and its prompts are not empty" would accept an unrelated fresh save and
    // a partial save alike. The episode-side artifact names the scenes this
    // run asked for and the exact text it produced for each, and the document
    // has to carry exactly those texts.
    const record = readMusicScenePolishSnapshot(job)
    if (record.state !== 'valid') return 'repair-required'
    const ref = record.ref
    if (ref.project_slug !== slug || ref.episode_code.toUpperCase() !== code) return 'repair-required'
    const artifact = await readMusicScenePolishRun(slug, code, ref.run_id).catch(() => null)
    if (!artifact) return 'repair-required'
    if (validateMusicScenePolishArtifact({ artifact, ref, jobId: job.job_id })) return 'repair-required'
    const doc = await readEpisodeDoc(slug, code).catch(() => null)
    if (!doc) return 'repair-required'
    const audit = inspectScenePolishCompletion({
      promptOverrides: doc.prompt_overrides,
      artifact,
      result: (job.result ?? null) as ScenePolishProof['result'],
    })
    return audit.complete
      ? 'complete'
      : {
        verdict: 'repair-required',
        detail: audit.detail || 'The polished prompts on the episode are not this run\'s output.',
      }
  })
  // Idea Campaign — reuse the generator's own completion proof (idea-campaign.ts:338-359): the
  // campaign is complete when the project holds at least the clamped wanted count of ideas under
  // this EXACT campaign_id. Read-only: it never writes the job, the batch record or its
  // idempotency_key, so a later Retry still collects the accepted request by key with no second
  // POST. The submitting/unknown outcome is deliberately not solved here — job-control.ts:290
  // classifies uncertain submission as return-later before any auditor is consulted.
  registerJobCancellationAuditor('idea_campaign', async job => {
    const campaignId = typeof job.params?.campaign_id === 'string' ? job.params.campaign_id : ''
    if (!campaignId.trim()) return 'repair-required'
    const wanted = Math.max(1, Math.min(100, Math.round(Number(job.params?.count) || 0)))
    const { getIdeas } = await import('../services/idea-manager.js')
    const ideas = await getIdeas(job.project_slug)
    const completed = Array.isArray(ideas)
      ? ideas.filter(idea => idea.campaign_id === campaignId).length
      : 0
    return completed >= wanted ? 'complete' : 'repair-required'
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
  registerExecutor('introduction-only', generateIntroductionOnly)
  registerExecutor('chapter-only', generateChapterOnly)
  // v1.0.72+: outline-first chunked flow. outline_only builds the outline
  // and persists the sidecar with outline_approved_at: null (or set when
  // auto_approve: true is on the params). expand_chapters reads the
  // approved sidecar and expands all-or-selected chapters with per-entry
  // word-count overrides.
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
    // Music format phase 1: the Song Pool's generator rides the same job type (lane, label, audit).
    if ((job.params as any)?.song_pool === true) {
      const { generateSongPool } = await import('../generators/song-pool-generate.js')
      return generateSongPool(job)
    }
    const { generateMusicLibraryTracks } = await import('../generators/music-generate.js')
    await generateMusicLibraryTracks(job)
  }))
  registerExecutor('music_video', guardMedia(async (job) => {
    const { generateMusicVideo } = await import('../generators/music-video.js')
    await generateMusicVideo(job)
  }))
  registerExecutor('music_episode_build', guardMedia(async (job) => {
    const { generateMusicEpisodeBuild } = await import('../generators/music-episode-build.js')
    await generateMusicEpisodeBuild(job)
  }))
  registerExecutor('music_scene_polish', async (job) => {
    const { generateMusicScenePolish } = await import('../generators/music-scene-polish.js')
    await generateMusicScenePolish(job)
  })
  registerExecutor('audio', guardMedia(generateAudio))
  registerExecutor('audio_merge', guardMedia(generateAudioMerge))
  registerExecutor('metadata', generateMetadata)
  registerExecutor('video', guardMedia(generateAiVideo))
  registerExecutor('video_assembly', guardMedia(generateVideoAssembly))
  registerExecutor('subtitles_transcribe', generateSubtitlesTranscribe)
  registerExecutor('youtube_upload', generateYoutubeUpload)
  registerExecutor('youtube_playlist_update', generateYoutubePlaylistUpdate)
  // Posts a finished episode to the Facebook / Instagram / TikTok accounts the
  // owner ticked for that upload. Opt-in: an empty tick list posts nothing.
  registerExecutor('social_publish', async (job) => {
    const { generateSocialPublish } = await import('../generators/social-publish.js')
    await generateSocialPublish(job)
  })
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
  // Still Posts (2026-10-27) — one writing request per batch; the picture job is separate so a
  // Retry of one never repeats the other.
  registerExecutor('still_post_write', async (job) => {
    const { generateStillPostsWrite } = await import('../generators/still-posts.js')
    await generateStillPostsWrite(job)
  })
  registerExecutor('still_post_render', guardMedia(async (job) => {
    const { generateStillPostsRender } = await import('../generators/still-posts.js')
    await generateStillPostsRender(job)
  }))

  const missingExecutors = unregisteredJobTypes()
  if (missingExecutors.length) {
    throw new Error(`Job executor registration incomplete: ${missingExecutors.join(', ')}`)
  }

  // A finished job refreshes its episode's status right away (Board, lists).
  if (!jobEvents.listeners('update').includes(invalidateForFinishedJob)) jobEvents.on('update', invalidateForFinishedJob)
  // …and settles older failed rows whose files that run has now made.
  if (!jobEvents.listeners('update').includes(settleAfterSuccess)) jobEvents.on('update', settleAfterSuccess)

  if (options.loadSettings !== false) {
    void initializeQueuePauseState()
      .then(() => resumeInterruptedJobsAtBoot())
      .then(() => startFinalRenderReconciler())
      .then(() => startEpisodeRecovery())
      // Follows accepted uploads to "ready" without anyone pressing a button.
      .then(() => startYouTubeStatusSync())
      .catch(e => console.warn('[boot] failed to initialize durable queue state:', e?.message))
    // The durable recovery scan is chained after queue-hold restoration above,
    // so a user-paused queue cannot race and start work during app boot.
  }
}
