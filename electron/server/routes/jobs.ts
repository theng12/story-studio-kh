import { Router } from 'express'
import * as jq from '../services/job-queue.js'
import * as pm from '../services/project-manager.js'
import { getModelPricing } from '../services/usage-tracker.js'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { validateBody } from '../lib/validate.js'
import { EstimateCostSchema } from '../schemas/index.js'
import type { Job } from '../models/types.js'

export const router = Router()

// ── Job stream (SSE) ────────────────────────────────────────────────────────
/**
 * GET /projects/:slug/jobs/stream
 *
 * Server-Sent Events feed of queue state changes scoped to a single project.
 * Replaces the old 3-second poll in `useJobs` — the client sees transitions
 * the instant the queue emits them.
 *
 * On connect we push one `snapshot` event carrying the current full list +
 * stats, then stream `update`/`cleared` events as they happen. A 15-second
 * keep-alive comment (`: ping`) keeps the socket from being reaped by
 * overly-aggressive proxies. Both `jobEvents` listeners and the keepalive
 * are torn down on `req.close` so we don't leak EventEmitter subscriptions
 * when the browser navigates away.
 */
router.get('/projects/:slug/jobs/stream', async (req, res) => {
  const { slug } = req.params

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Disable Nginx/Nitro proxy buffering so events flush immediately.
    'X-Accel-Buffering': 'no',
  })
  // Tell EventSource to retry after 5s on disconnect.
  res.write('retry: 5000\n\n')

  function send(eventName: string, payload: unknown) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  // Initial snapshot so late-subscribing clients don't miss state that's
  // already in the queue.
  try {
    const snapshot = {
      jobs: await jq.getJobs(slug),
      stats: jq.getQueueStats(slug),
    }
    send('snapshot', snapshot)
  } catch (e) {
    // If the snapshot errors we still keep the connection open — incremental
    // updates will eventually populate the client's view.
    console.error('[jobs/stream] snapshot error:', e)
  }

  const onUpdate = (job: Job) => {
    if (job.project_slug !== slug) return
    send('update', job)
  }
  const onCleared = (event: jq.JobsClearedEvent) => {
    if (event.project_slug !== slug) return
    send('cleared', event)
  }
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)

  const keepalive = setInterval(() => {
    // SSE comment — ignored by the parser but keeps intermediaries alive.
    res.write(': ping\n\n')
  }, 15000)

  req.on('close', () => {
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
})

router.get('/projects/:slug/jobs', async (req, res) => {
  const jobsList = await jq.getJobs(req.params.slug)
  const stats = jq.getQueueStats(req.params.slug)
  res.json({ jobs: jobsList, stats })
})

// ── App-level jobs (broll_normalize, broll_autotag, etc.) ─────────────
//
// Per-project jobs filter by `project_slug` exact match in getJobs().
// App-level infrastructure jobs (B-Roll normalize / auto-tag, anything
// queued with project_slug='_app_') never showed up in any project's
// jobs panel — they were invisible to the user. v1.0.91+: separate
// endpoint + SSE stream surfaces them so the B-Roll Library page (and
// future app-level surfaces) can render their own jobs panel without
// polluting the per-project view.
const APP_SLUG = '_app_'

router.get('/jobs/app', async (_req, res) => {
  const jobsList = await jq.getJobs(APP_SLUG)
  const stats = jq.getQueueStats(APP_SLUG)
  res.json({ jobs: jobsList, stats })
})

// v1.0.131+ — IMPORTANT: /jobs/app/stream MUST be registered BEFORE
// /jobs/app/:jobId. Express dispatches routes in registration order;
// the wildcard `:jobId` would match a literal `stream` and the handler
// would look up a (nonexistent) job called "stream", returning 404 to
// every EventSource the frontend opens. That 404 then trips the SSE
// auto-retry loop (~every 5s) and the user sees a never-ending stream
// of `Failed to load resource: …jobs/app/stream:1 (Not Found)` console
// errors. Reordered + reserved-word guard so a future re-reorder fails
// cleanly instead of silently regressing.
router.get('/jobs/app/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  function send(eventName: string, payload: unknown) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  try {
    send('snapshot', {
      jobs: await jq.getJobs(APP_SLUG),
      stats: jq.getQueueStats(APP_SLUG),
    })
  } catch (e) {
    console.error('[jobs/app/stream] snapshot error:', e)
  }
  const onUpdate = (job: Job) => {
    if (job.project_slug !== APP_SLUG) return
    send('update', job)
  }
  const onCleared = (event: jq.JobsClearedEvent) => {
    if (event.project_slug !== APP_SLUG) return
    send('cleared', event)
  }
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
})

// /jobs/app/:jobId — must come AFTER /jobs/app/stream (see comment on the
// stream route). The reserved-word guard below makes a future re-reorder
// regression fail loudly instead of silently 404-looping the SSE again.
router.get('/jobs/app/:jobId', (req, res) => {
  if (req.params.jobId === 'stream') {
    // Should be unreachable — Express picks the literal '/jobs/app/stream'
    // route ahead of this wildcard. Surface a 500 with a clear diagnostic
    // if it ever DOES land here so the route-order regression is obvious.
    return res.status(500).json({
      detail: 'Route order regression: /jobs/app/stream is being shadowed by /jobs/app/:jobId. ' +
              'Re-check routes/jobs.ts — the stream handler must be registered first.',
    })
  }
  const job = jq.getJob(req.params.jobId)
  if (!job || job.project_slug !== APP_SLUG) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  res.json(job)
})

router.delete('/jobs/app', async (_req, res) => {
  const count = await jq.clearFinished(APP_SLUG)
  res.json({ ok: true, cleared: count })
})

router.get('/projects/:slug/jobs/:jobId', (req, res) => {
  const job = jq.getJob(req.params.jobId)
  if (!job || job.project_slug !== req.params.slug) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  res.json(job)
})

// Queue-level Retry fallback. Specialized generator pages may still use their
// own healing endpoints, but every registered job type remains recoverable
// even when a newer executor has not yet been added to a frontend map.
router.post('/projects/:slug/jobs/:jobId/retry', (req, res) => {
  const job = jq.retryTerminalJob(req.params.slug, req.params.jobId)
  res.status(202).json({ ok: true, job })
})

router.delete('/projects/:slug/jobs/:jobId', (req, res) => {
  if (!jq.cancelJob(req.params.jobId)) {
    return res.status(400).json({ detail: 'Job not found or not cancellable' })
  }
  res.json({ ok: true })
})

// Clear all finished (done/error/cancelled) jobs
router.delete('/projects/:slug/jobs', async (req, res) => {
  const count = await jq.clearFinished(req.params.slug)
  res.json({ ok: true, cleared: count })
})

// ── Cost estimation ────────────────────────────────────────────────────────

interface CostEstimate {
  estimated_cost: number | string
  cost_unit: string       // 'USD' | 'credits'
  estimated_duration: string
  details: string
  current_balance?: number | string
}

// Duration estimates (seconds)
const DURATION_PER_1K_WORDS = 60       // ~1 min per 1000 output words for LLM
const DURATION_PER_IMAGE = 15          // ~15 seconds per image generation
const DURATION_PER_5K_CHARS_AUDIO = 60 // ~1 min per 5000 chars for TTS

router.post('/projects/:slug/estimate-cost', validateBody(EstimateCostSchema), async (req, res) => {
  const { slug } = req.params
  const { type, params } = req.body

  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const pricing = getModelPricing()
  const estimate: CostEstimate = {
    estimated_cost: 0,
    cost_unit: 'USD',
    estimated_duration: '< 1 min',
    details: '',
  }

  try {
    if (type === 'script') {
      // Script generation: token-based cost
      const model = params?.model || 'gpt-4o-mini'
      const totalWords = params?.total_words || (params?.length ? params.length * 150 : 5000)
      const mp = pricing[model] || { input: 5.0, output: 15.0 }

      // Estimate: ~2000 input tokens (prompt + standards), output ≈ words / 0.75
      const inputTokens = 3000
      const outputTokens = Math.ceil(totalWords / 0.75)
      const cost = (inputTokens * mp.input + outputTokens * mp.output) / 1_000_000
      const durationSec = Math.ceil((totalWords / 1000) * DURATION_PER_1K_WORDS)

      estimate.estimated_cost = Math.round(cost * 10000) / 10000
      estimate.cost_unit = 'USD'
      estimate.estimated_duration = formatDuration(durationSec)
      estimate.details = `~${totalWords.toLocaleString()} words, ~${outputTokens.toLocaleString()} output tokens (${model})`

    } else if (type === 'scene_images' || type === 'thumb_images' || type === 'images') {
      // Image generation: credits-based.
      // type === 'images' means both scenes + thumbnails (unified page "Both" mode).
      const model = params?.model || 'grok-imagine'
      const modelConfig = config.image_models?.[model]
      // Local Image Studio models are free (Apple-Silicon compute). They're
      // surfaced dynamically (`imagestudio:<repo>`) so they aren't in the
      // saved catalog — detect by id/provider, not by a config lookup, and
      // force $0 so the cost dialog reads "Free" instead of defaulting to 1
      // credit/image for an unknown model.
      const isLocalImage = model.startsWith('imagestudio:')
        || model.startsWith('imagestudio-')
        || (modelConfig as any)?.provider === 'imagestudio'
      // v1.0.234 — direct/token-billed image providers (OpenAI Images API,
      // OpenRouter Gemini): billed on the user's own provider account by tokens,
      // not kie credits. Don't show a kie-credit figure.
      const directProvider = (modelConfig as any)?.provider
      const isOpenAiImage = directProvider === 'openai-image' || directProvider === 'openrouter-image'
      const directBillLabel = directProvider === 'openrouter-image' ? 'OpenRouter' : 'OpenAI'
      // Tier-aware pricing: variable-priced models (nano-banana-2,
      // ideogram-v3, etc.) carry a `tiers[]` array. The request can name
      // a tier via params.tier; absent → default_tier → credits_per_image.
      // Flat-priced models ignore params.tier silently.
      const requestedTier: string | undefined = typeof params?.tier === 'string' ? params.tier : undefined
      const tiers = (modelConfig as any)?.tiers as { id: string; label: string; credits: number }[] | undefined
      const tierEntry = Array.isArray(tiers)
        ? (tiers.find(t => t.id === requestedTier)
            ?? tiers.find(t => t.id === (modelConfig as any)?.default_tier))
        : undefined
      const creditsPerImage = (isLocalImage || isOpenAiImage) ? 0 : (tierEntry?.credits ?? modelConfig?.credits_per_image ?? 1)
      const wantThumbs = type === 'thumb_images'
      const wantBoth = type === 'images'

      // Count prompts from file (or use a rough default)
      let promptCount = params?.prompt_count || 0
      if (!promptCount && params?.episode_id) {
        if (wantBoth) {
          // Both scenes and thumbnails
          const scenes = await countPromptsFromFile(slug, params.episode_id, false)
          const thumbs = await countPromptsFromFile(slug, params.episode_id, true)
          promptCount = scenes + thumbs
        } else {
          promptCount = await countPromptsFromFile(slug, params.episode_id, wantThumbs)
        }
      }
      if (!promptCount) promptCount = wantBoth ? 9 : wantThumbs ? 3 : 6

      const totalCredits = promptCount * creditsPerImage
      const durationSec = promptCount * DURATION_PER_IMAGE

      estimate.estimated_cost = totalCredits
      estimate.cost_unit = 'credits'
      estimate.estimated_duration = formatDuration(durationSec)
      const kind = wantBoth ? 'image(s) (scenes + thumbnails)' : wantThumbs ? 'thumbnail(s)' : 'scene(s)'
      const tierSuffix = tierEntry ? ` · ${tierEntry.label}` : ''
      estimate.details = isLocalImage
        ? `${promptCount} ${kind} · Free — local Image Studio model (no per-image cost)`
        : isOpenAiImage
          ? `${promptCount} ${kind} · billed on your ${directBillLabel} account (token-based — see the ${directBillLabel} dashboard)`
          : `${promptCount} ${kind} × ${creditsPerImage} credit${creditsPerImage > 1 ? 's' : ''} (${modelConfig?.label || model}${tierSuffix})`

      // Include current kie balance (kie cloud models only — local/OpenAI have none).
      if (!isLocalImage && !isOpenAiImage) {
        try {
          const { getKieCredits } = await import('../services/utils.js')
          const bal = await getKieCredits(config.kie_api_key)
          if (bal !== null) estimate.current_balance = bal
        } catch { /* skip */ }
      }

    } else if (type === 'audio') {
      // Audio generation: character-count-based
      const model = params?.model || 'turbo-v2.5'
      const audioModel = config.audio_models?.[model]
      // Local Voice Studio models are free. Detect by id/provider and force
      // $0. Also note: cost_per_1k_chars of 0 is a VALID free price — use a
      // typeof check, not `|| 0.05`, so an explicit 0 isn't coerced to 0.05.
      const isLocalAudio = model.startsWith('voicestudio-')
        || (audioModel as any)?.provider === 'voicestudio'
      const costPer1k = isLocalAudio
        ? 0
        : (typeof audioModel?.cost_per_1k_chars === 'number' ? audioModel.cost_per_1k_chars : 0.05)

      // Try to get character count from narration file
      let charCount = params?.char_count || 0
      if (!charCount && params?.episode_id) {
        charCount = await countNarrationChars(slug, params.episode_id)
      }
      if (!charCount) charCount = 15000 // default estimate

      const cost = (charCount / 1000) * costPer1k
      const durationSec = Math.ceil((charCount / 5000) * DURATION_PER_5K_CHARS_AUDIO)

      estimate.estimated_cost = Math.round(cost * 100) / 100
      estimate.cost_unit = 'USD'
      estimate.estimated_duration = formatDuration(durationSec)
      estimate.details = isLocalAudio
        ? `~${charCount.toLocaleString()} chars · Free — local Voice Studio model (no per-character cost)`
        : `~${charCount.toLocaleString()} chars × $${costPer1k}/1k (${audioModel?.label || model})`

      // Include current fal balance (cloud models only — local has no balance).
      if (!isLocalAudio) {
        try {
          const { getFalBalance } = await import('../services/utils.js')
          const bal = await getFalBalance(config.fal_api_key)
          if (bal !== null) estimate.current_balance = bal
        } catch { /* skip */ }
      }

    } else if (type === 'scene_prompts' || type === 'thumb_prompts' || type === 'metadata') {
      // Prompt/metadata generation: token-based
      const model = params?.model || 'gpt-4o'
      const mp = pricing[model] || { input: 2.5, output: 10.0 }

      const inputTokens = 3000  // prompt + context
      const outputTokens = type === 'metadata' ? 1500 : 2000
      const cost = (inputTokens * mp.input + outputTokens * mp.output) / 1_000_000
      const durationSec = type === 'metadata' ? 30 : 30

      estimate.estimated_cost = Math.round(cost * 10000) / 10000
      estimate.cost_unit = 'USD'
      estimate.estimated_duration = formatDuration(durationSec)
      estimate.details = `~${(inputTokens + outputTokens).toLocaleString()} tokens (${model})`

    } else if (type === 'youtube_upload' || type === 'youtube_metadata_update' || type === 'youtube_playlist_update') {
      // YouTube API quota — units, not USD. The default daily allotment
      // per Cloud project is 10,000 units (Google's setting, not ours).
      // Per-action quota cost (verified against Google's quota table):
      //   videos.insert       → 1600
      //   videos.update       → 50
      //   playlistItems.insert → 50
      //   thumbnails.set      → 50  (charged on fresh-upload only)
      // For bulk actions the UI passes count = number of episodes in
      // the batch; we multiply so the dialog shows the aggregate impact
      // before the user clicks Confirm.
      const count = Math.max(1, Number(params?.count) || 1)
      const perAction = type === 'youtube_upload'
        ? 1650 // insert + thumbnails.set on the same row
        : 50   // metadata or playlist
      const totalUnits = perAction * count
      const verb = type === 'youtube_upload'
        ? 'upload'
        : type === 'youtube_metadata_update'
          ? 'metadata update'
          : 'playlist update'
      // Each action takes ~3-15s end-to-end depending on video size /
      // network. Use an average for the duration estimate; bulk runs
      // mostly in parallel via the queue, but show serial worst-case
      // so the user isn't surprised if the queue is backed up.
      const perActionSec = type === 'youtube_upload' ? 30 : 5
      estimate.estimated_cost = totalUnits
      estimate.cost_unit = 'YouTube quota units'
      estimate.estimated_duration = formatDuration(perActionSec * count)
      estimate.details = count === 1
        ? `1 ${verb} × ${perAction} units`
        : `${count} ${verb}s × ${perAction} units = ${totalUnits} units total`

    } else if (type === 'video') {
      // Video generation: local FFmpeg — no API cost, just time estimate
      const sceneCount = params?.scenes?.length || 10

      // Estimate actual video duration from narration/duration settings
      let videoDuration = 60 // fallback
      if (params?.merged_audio_path) {
        // Use merged audio duration if available
        const { getAudioDuration } = await import('../lib/ffmpeg-utils.js')
        const dur = await getAudioDuration(params.merged_audio_path)
        if (dur) videoDuration = dur + 30 // narration + ~30s post-audio extension
      } else if (params?.duration?.mode === 'custom') {
        const min = params.duration.min_duration || 0
        const max = params.duration.max_duration || 0
        videoDuration = max || min || 60
      } else if (params?.narration_chapters?.length) {
        // Sum chapter durations if available (rough estimate: ~3min per chapter)
        videoDuration = params.narration_chapters.length * 180
      }

      const resMultiplier: Record<string, number> = { '720p': 1, '1080p': 2, '1440p': 3.5, '4k': 6 }
      const qualityMultiplier: Record<string, number> = { fast: 0.5, medium: 1, high: 2 }
      const resMult = resMultiplier[params?.resolution || '1080p'] || 2
      const qualMult = qualityMultiplier[params?.quality || 'high'] || 2
      // Processing time: roughly 0.3× real-time per resolution/quality multiplier
      const processingTimeSec = Math.ceil(videoDuration * resMult * qualMult * 0.3)

      const videoMins = Math.round(videoDuration / 60)
      estimate.estimated_cost = 0
      estimate.cost_unit = 'free (local)'
      estimate.estimated_duration = formatDuration(processingTimeSec)
      estimate.details = `${sceneCount} scenes, ~${videoMins}min video at ${params?.resolution || '1080p'} ${params?.quality || 'high'}`
    }
  } catch (e: any) {
    estimate.details = `Unable to estimate: ${e.message}`
  }

  res.json(estimate)
})

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `~${seconds}s`
  const mins = Math.ceil(seconds / 60)
  return mins === 1 ? '~1 min' : `~${mins} min`
}

async function countPromptsFromFile(slug: string, episodeId: string, isThumbnails: boolean): Promise<number> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return 0

  // Accept .md (current) and legacy .docx, separate file or old combined.
  const stem = isThumbnails ? `${code}_Thumbnail_Prompts` : `${code}_Scene_Prompts`
  const names = new Set([
    `${stem}.md`, `${stem}.docx`,
    `${code}_Image_Prompts.md`, `${code}_Image_Prompts.docx`,
  ])

  // Search recursively for the file
  async function findFile(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const fp = path.join(dir, e.name)
        if (e.isFile() && names.has(e.name)) return fp
        if (e.isDirectory()) {
          const found = await findFile(fp)
          if (found) return found
        }
      }
    } catch { /* skip */ }
    return null
  }

  const file = await findFile(outputRoot)
  if (!file) return 0

  try {
    const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
    const parsed = await parseImagePromptsDocx(file)
    return isThumbnails ? parsed.thumbnails.length : parsed.scenes.length
  } catch { return 0 }
}

async function countNarrationChars(slug: string, episodeId: string): Promise<number> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return 0

  const narrationNames = new Set([`${code}_Script_Narration.md`, `${code}_Script_Narration.docx`])

  async function findFile(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const fp = path.join(dir, e.name)
        if (e.isFile() && narrationNames.has(e.name)) return fp
        if (e.isDirectory()) {
          const found = await findFile(fp)
          if (found) return found
        }
      }
    } catch { /* skip */ }
    return null
  }

  const file = await findFile(outputRoot)
  if (!file) return 0

  try {
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const sections = await parseNarrationDocx(file)
    return sections.reduce((sum, s) => sum + s.text.length, 0)
  } catch { return 0 }
}
