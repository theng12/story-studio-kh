import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { createRequire } from 'module'
import * as pm from '../services/project-manager.js'
import { listChatModels as listGenStudioChatModels } from '../lib/genstudio-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { getGenStudioUrl } from '../services/app-settings.js'
import { getSessionStats } from '../services/session-tracker.js'
import { getFFmpegStatus, downloadFFmpeg, getInstallProgressState, _markInstallError } from '../services/ffmpeg-manager.js'
import { getLogDir, logLine, flushLogLines } from '../services/logger.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()
const requireFromHere = createRequire(import.meta.url)

router.get('/ffmpeg/status', async (_req, res) => {
  try {
    res.json(await getFFmpegStatus())
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'FFmpeg status check failed'))
  }
})

router.post('/ffmpeg/install', async (_req, res) => {
  if (getInstallProgressState().status === 'running') {
    return res.status(409).json({ detail: 'FFmpeg install already in progress.', code: 'INSTALL_IN_PROGRESS' })
  }
  try {
    const existing = await getFFmpegStatus()
    if (existing.installed && existing.source === 'bundled') {
      return res.status(409).json({
        detail: `Bundled FFmpeg ${existing.version || ''} is already verified and ready. No download is needed.`,
        code: 'BUNDLED_FFMPEG_READY',
        status: existing,
      })
    }
    const installedPath = await downloadFFmpeg()
    res.json({ ok: true, path: installedPath, status: await getFFmpegStatus() })
  } catch (error: any) {
    _markInstallError(error?.message || 'FFmpeg install failed')
    res.status(500).json(humanizeBackendError(error, 'FFmpeg install failed'))
  }
})

router.get('/ffmpeg/install-progress', (_req, res) => res.json(getInstallProgressState()))

router.get('/ffmpeg/install-log', async (_req, res) => {
  try {
    const logPath = path.join(getLogDir(), `server-${new Date().toISOString().slice(0, 10)}.log`)
    // Log writes are buffered and land off the event loop now (see
    // services/logger.ts). This route exists to show someone the lines that were
    // just written, so it has to drain the buffer before reading — otherwise the
    // newest ffmpeg-install lines would be missing from precisely the view
    // someone opens to watch an install happen.
    await flushLogLines()
    let raw = ''
    try {
      raw = await fs.readFile(logPath, 'utf-8')
    } catch (error: any) {
      if (error.code === 'ENOENT') return res.json({ entries: [], path: logPath, message: 'No log file yet for today.' })
      throw error
    }
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const entries = raw.split('\n').flatMap(line => {
      try {
        const entry = JSON.parse(line)
        const timestamp = entry?.ts ? Date.parse(entry.ts) : 0
        return typeof entry?.message === 'string' && entry.message.startsWith('ffmpeg-install')
          && (!timestamp || timestamp >= oneHourAgo) ? [entry] : []
      } catch {
        return []
      }
    })
    res.json({ entries: entries.slice(-200), path: logPath, total: entries.length })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not read install log'))
  }
})

router.post('/app/restart', (_req, res) => {
  let electronApp: any
  try {
    electronApp = requireFromHere('electron').app
  } catch {
    return res.status(503).json({ ok: false, detail: 'Not running inside Electron — restart manually.' })
  }
  if (!electronApp || typeof electronApp.relaunch !== 'function') {
    return res.status(503).json({ ok: false, detail: 'Electron app handle unavailable.' })
  }
  res.json({ ok: true, message: 'Restarting…' })
  logLine('info', 'app:restart', { source: 'POST /app/restart' })
  setTimeout(() => {
    try {
      electronApp.relaunch()
      electronApp.exit(0)
    } catch (error: any) {
      logLine('error', 'app:restart-failed', { error: error?.message })
    }
  }, 200)
})

async function withGenStudioKey(): Promise<string> {
  return getApiKey('genstudio').catch(() => '')
}

router.get('/models', async (_req, res) => {
  const apiKey = await withGenStudioKey()
  // v1.4.202 — an empty ARRAY used to be the answer for "no key configured",
  // which the pickers cannot tell apart from "the catalogue is genuinely empty".
  // `/account` twelve lines below already answers a missing key with a 400 and a
  // sentence the customer can act on; this endpoint was the only one in the file
  // that spelled "I don't know" as an empty list (AGENTS.md §6).
  if (!apiKey) {
    return res.status(400).json({ detail: 'Add a Gateway API Key in Settings → This Mac.' })
  }
  try {
    const models = (await listGenStudioChatModels(apiKey)).map(model => ({
      id: model.id,
      // The catalogue's own name, unadorned. Story Studio used to append
      // "[GenStudio KH]" here, which every LLM picker then repeated in a group
      // header and a per-row badge — three statements of a gateway that serves
      // every model in the app, crowding out the one thing the row is for.
      label: model.display_name,
      provider: 'genstudio',
      provider_name: model.provider_name || null,
      cost_tier: model.cost_tier,
      ...(model.chargeable === undefined ? {} : { chargeable: model.chargeable }),
      locked: model.locked,
      lock_reason: model.lock_reason,
      available: model.available,
      // The gateway's own reasons, which is what `disabled_reason` below joins
      // into a sentence. The two fields that used to sit here
      // (`availability_reason`, `available_again_at`) described a temporary
      // absence no catalogue has published since the old GenStudio; a job's
      // retry window is the fact that replaced them, and it rides on the job.
      disabled_reason: model.available
        ? null
        : (model.activation_blockers.join(' ') || 'This model is not currently available in the Gateway.'),
      hint: model.description || null,
      // The live GenStudio catalog is the capability authority. This is used
      // by reference-guided thumbnail prompts to keep text-only models out of
      // the picker once an image reference is attached.
      supports_vision: model.supports_vision,
      // Published live per model. The UI derives its output-allowance options
      // and its available-input estimate from these two numbers — Story Studio
      // holds no context window, output ceiling, or character cap of its own.
      context_window_tokens: model.context_window_tokens,
      max_output_tokens: model.max_output_tokens,
      // Whose number that is. Forwarded for the same reason every other published
      // field is: the page that shows the allowance must be able to say whether the
      // *model* stated it, and it cannot reconstruct that here.
      max_output_tokens_source: model.max_output_tokens_source,
      structured_output_mode: model.structured_output_mode,
      // Preserve GenStudio's published pricing verbatim. The renderer shows
      // these as rates because an LLM total is unknowable before generation.
      input_credits_per_million_tokens: model.input_credits_per_million_tokens,
      output_credits_per_million_tokens: model.output_credits_per_million_tokens,
      // The undiscounted rates, when GenStudio is applying a sale to this
      // account. Forwarded for the same reason the rates above are: the picker
      // shows the price with the full price struck through, and it can only do
      // that with both numbers. Null means no sale, and the picker then shows
      // one price rather than a discount tag on no discount.
      standard_input_credits_per_million_tokens: model.standard_input_credits_per_million_tokens,
      standard_output_credits_per_million_tokens: model.standard_output_credits_per_million_tokens,
      minimum_credits: model.minimum_credits,
      price_version: model.price_version,
      // Which shelf the product sells on, and the offer that shelf carries.
      // This whitelist is why the retirement schedule never reached the picker
      // for weeks — the fields arrived on every catalogue row and were dropped
      // here. Both of these are grouping and copy the picker cannot reconstruct
      // from anything else on the row, so they travel whole.
      queue_class: model.queue_class,
      relaxed_queue_hint: model.relaxed_queue_hint,
      // GenStudio's data disclosure, forwarded verbatim. The picker shows the
      // sentence GenStudio publishes; Story Studio never writes one of its own,
      // because a softened copy would change what the customer agreed to.
      discount: model.discount,
      discount_disclaimer: model.discount_disclaimer,
      // GenStudio's published retirement schedule, forwarded whole. This
      // whitelist is why it never reached the picker: the fields arrived on
      // every catalogue row and were dropped here, so the only retirement the
      // app could describe was one that had already happened.
      //
      // `retires_at` is the date the customer needs — the moment the product
      // stops being available to them — and `replacement_model_id` is resolved
      // to a display name in the picker, never shown as an id.
      deprecation_warning: model.deprecation_warning,
      deprecation_warning_at: model.deprecation_warning_at,
      scheduled_retirement_at: model.scheduled_retirement_at,
      upstream_shutdown_at: model.upstream_shutdown_at,
      retires_at: model.retires_at,
      replacement_model_id: model.replacement_model_id,
    }))
    res.json(models)
  } catch (error: any) {
    res.status(502).json(humanizeBackendError(error, 'Could not load the Gateway chat catalog'))
  }
})

/**
 * Is the Gateway answering at all? The sidebar and header ask this every 20 s, so it is the cheapest
 * question there is: no key, no catalogue, just the Gateway's own unauthenticated `/health`. Any HTTP
 * answer means the app is running (a 404 from a gateway without `/health` still proves that); only a
 * refused/timed-out connection is "not reachable". Before this the app could only say whether its OWN
 * engine was up, so a stopped or restarting Gateway showed "Story Studio online" while nothing could run.
 */
router.get('/gateway/status', async (_req, res) => {
  const url = await getGenStudioUrl()
  try {
    await fetch(`${url.trim().replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(4_000) })
    res.json({ reachable: true, url })
  } catch {
    res.json({ reachable: false, url })
  }
})

router.get('/projects/:slug/dashboard-stats', async (req, res) => {
  const config = await pm.getConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Not found' })
  const { getIdeas } = await import('../services/idea-manager.js')
  const ideas = await getIdeas(req.params.slug)
  const session = await getSessionStats(req.params.slug)
  res.json({
    ideas: { total: ideas.length, accepted: ideas.filter(idea => idea.status === 'accepted').length, new: ideas.filter(idea => idea.status === 'new').length },
    session: { current: session.current, previous: session.previous, all_time: session.all_time },
  })
})
