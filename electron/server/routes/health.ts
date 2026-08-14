import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { createRequire } from 'module'
import * as pm from '../services/project-manager.js'
import {
  getGenStudioAccountSnapshot,
  GenStudioApiError,
  listChatModels as listGenStudioChatModels,
} from '../lib/genstudio-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { getSessionStats } from '../services/session-tracker.js'
import { getFFmpegStatus, downloadFFmpeg, getInstallProgressState, _markInstallError } from '../services/ffmpeg-manager.js'
import { getLogDir, logLine } from '../services/logger.js'
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
  if (!apiKey) return res.json([])
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
      available: model.available,
      disabled_reason: model.available
        ? null
        : (model.activation_blockers.join(' ') || 'This model is not currently available in GenStudio.'),
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
      structured_output_mode: model.structured_output_mode,
      // Preserve GenStudio's published pricing verbatim. The renderer shows
      // these as rates because an LLM total is unknowable before generation.
      input_credits_per_million_tokens: model.input_credits_per_million_tokens,
      output_credits_per_million_tokens: model.output_credits_per_million_tokens,
      minimum_credits: model.minimum_credits,
      price_version: model.price_version,
    }))
    res.json(models)
  } catch (error: any) {
    res.status(502).json(humanizeBackendError(error, 'Could not load the GenStudio chat catalog'))
  }
})

async function authoritativeUsage(res: any): Promise<void> {
  const apiKey = await withGenStudioKey()
  if (!apiKey) {
    res.status(400).json({ detail: 'Add the scoped GenStudio API key in Settings → This Mac.' })
    return
  }
  try {
    res.json(await getGenStudioAccountSnapshot(apiKey))
  } catch (error: any) {
    if (error instanceof GenStudioApiError && (error.status === 401 || error.status === 403)) {
      res.status(503).json({
        code: 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE',
        detail: 'This key cannot read GenStudio balance or settlement history. Story Studio will not estimate them locally.',
      })
      return
    }
    res.status(502).json(humanizeBackendError(error, 'Could not load authoritative GenStudio usage'))
  }
}

router.get('/usage', (_req, res) => authoritativeUsage(res))
router.get('/usage/rollup', (_req, res) => authoritativeUsage(res))

router.get('/projects/:slug/health', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  const apiKey = await withGenStudioKey()
  if (!apiKey) return res.json({ genstudio: { configured: false, online: false, detail: 'Add the scoped GenStudio API key.' } })
  try {
    const models = await listGenStudioChatModels(apiKey)
    res.json({ genstudio: { configured: true, online: true, available_chat_models: models.filter(model => model.available).length } })
  } catch (error: any) {
    res.json({ genstudio: { configured: true, online: false, detail: error?.message || 'GenStudio unavailable' } })
  }
})

router.get('/connectivity/precheck', async (_req, res) => {
  const apiKey = await withGenStudioKey()
  if (!apiKey) return res.json({ online: false, genstudio: false, detail: 'Scoped GenStudio API key is not configured.' })
  try {
    await listGenStudioChatModels(apiKey)
    res.json({ online: true, genstudio: true })
  } catch (error: any) {
    res.json({ online: false, genstudio: false, detail: error?.message || 'GenStudio unavailable' })
  }
})

async function testGenStudioKey(apiKey: string, res: any): Promise<void> {
  if (!apiKey) {
    res.status(400).json({ valid: false, reachable: false, message: 'A GenStudio API key is required.' })
    return
  }
  try {
    const models = await listGenStudioChatModels(apiKey)
    res.json({ valid: true, reachable: true, message: `GenStudio key works · ${models.filter(model => model.available).length} chat model(s) available.` })
  } catch (error: any) {
    res.json({ valid: false, reachable: !(error instanceof TypeError), message: error?.message || 'GenStudio key test failed.' })
  }
}

router.post('/test-key/:provider', async (req, res) => {
  if (req.params.provider !== 'genstudio') return res.status(410).json({ code: 'GENSTUDIO_ONLY', detail: 'Only GenStudio credentials are supported.' })
  await testGenStudioKey(typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '', res)
})

router.post('/projects/:slug/test-key/:provider', async (req, res) => {
  if (req.params.provider !== 'genstudio') return res.status(410).json({ code: 'GENSTUDIO_ONLY', detail: 'Only GenStudio credentials are supported.' })
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  await testGenStudioKey(await withGenStudioKey(), res)
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
