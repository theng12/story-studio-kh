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
  const onCleared = (clearedSlug: string) => {
    if (clearedSlug !== slug) return
    send('cleared', {})
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

router.get('/projects/:slug/jobs/:jobId', (req, res) => {
  const job = jq.getJob(req.params.jobId)
  if (!job || job.project_slug !== req.params.slug) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  res.json(job)
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
      const creditsPerImage = tierEntry?.credits ?? modelConfig?.credits_per_image ?? 1
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
      estimate.details = `${promptCount} ${kind} × ${creditsPerImage} credit${creditsPerImage > 1 ? 's' : ''} (${modelConfig?.label || model}${tierSuffix})`

      // Include current kie balance
      try {
        const { getKieCredits } = await import('../services/utils.js')
        const bal = await getKieCredits(config.kie_api_key)
        if (bal !== null) estimate.current_balance = bal
      } catch { /* skip */ }

    } else if (type === 'audio') {
      // Audio generation: character-count-based
      const model = params?.model || 'turbo-v2.5'
      const audioModel = config.audio_models?.[model]
      const costPer1k = audioModel?.cost_per_1k_chars || 0.05

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
      estimate.details = `~${charCount.toLocaleString()} chars × $${costPer1k}/1k (${audioModel?.label || model})`

      // Include current fal balance
      try {
        const { getFalBalance } = await import('../services/utils.js')
        const bal = await getFalBalance(config.fal_api_key)
        if (bal !== null) estimate.current_balance = bal
      } catch { /* skip */ }

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

  const filename = isThumbnails ? `${code}_Thumbnail_Prompts.docx` : `${code}_Scene_Prompts.docx`
  const fallback = `${code}_Image_Prompts.docx`

  // Search recursively for the file
  async function findFile(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const fp = path.join(dir, e.name)
        if (e.isFile() && (e.name === filename || e.name === fallback)) return fp
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

  const filename = `${code}_Script_Narration.docx`

  async function findFile(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const fp = path.join(dir, e.name)
        if (e.isFile() && e.name === filename) return fp
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
