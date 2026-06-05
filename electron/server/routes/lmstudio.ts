/**
 * LM Studio (local LLM) settings routes — v1.0.280+.
 *
 * Sibling of /imagestudio/* (routes/images.ts) and /voicestudio/* (routes/audio.ts).
 * Powers the Settings → Local Models → "LM Studio" panel (a shared
 * <EndpointListEditor route-prefix="/lmstudio">):
 *   GET  /lmstudio/base-url   — read configured URL + default
 *   PUT  /lmstudio/base-url   — persist URL (per-Mac via app-secrets)
 *   POST /lmstudio/test       — reachability + loaded-model count in one call
 *   GET  /lmstudio/models     — live list of model ids the server has loaded
 *
 * The base URL is stored in the app-secrets `lmstudio` bucket (the "apiKey"
 * slot carries the URL — there's no real secret; the server is on the user's
 * own machine). callAi resolves it for `lmstudio:` model ids.
 */

import { Router } from 'express'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { parseEndpoints } from '../lib/endpoint-pool.js'

export const router = Router()

const lmFirst = (stored: string | null | undefined): string => parseEndpoints(stored)[0] || ''

router.get('/lmstudio/base-url', async (_req, res) => {
  try {
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { DEFAULT_LMSTUDIO_BASE_URL } = await import('../lib/lmstudio-client.js')
    const { getEndpointLabels } = await import('../services/app-settings.js')
    const stored = await getApiKey('lmstudio')
    const labels = await getEndpointLabels('lmstudio')
    res.json({ baseUrl: stored || '', defaultBaseUrl: DEFAULT_LMSTUDIO_BASE_URL, labels })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read LM Studio base URL'))
  }
})

router.put('/lmstudio/base-url', async (req, res) => {
  try {
    const raw = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
    if (!raw) return res.status(400).json({ detail: 'baseUrl is required' })
    // Accept one or more endpoints (comma/space separated). Chat uses the
    // first; the list shape keeps parity with the image/voice editors.
    const urls = parseEndpoints(raw)
    if (!urls.length) return res.status(400).json({ detail: 'baseUrl is required' })
    for (const u of urls) {
      if (!/^https?:\/\//i.test(u)) {
        return res.status(400).json({ detail: `Each URL must start with http:// or https:// — got "${u}"` })
      }
    }
    const cleanedUrls = urls.map(u => u.replace(/\/+$/, ''))
    const cleaned = cleanedUrls.join(', ')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { setEndpointLabelsForUrls } = await import('../services/app-settings.js')
    await setApiKey('lmstudio', cleaned)
    const labels = await setEndpointLabelsForUrls('lmstudio', cleanedUrls, req.body?.labels)
    res.json({ ok: true, baseUrl: cleaned, labels })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not save LM Studio base URL'))
  }
})

router.post('/lmstudio/test', async (req, res) => {
  try {
    const { health, DEFAULT_LMSTUDIO_BASE_URL } = await import('../lib/lmstudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const incoming = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
    const baseUrl = lmFirst(incoming) || lmFirst(await getApiKey('lmstudio')) || DEFAULT_LMSTUDIO_BASE_URL
    if (!baseUrl) {
      return res.json({ ok: false, error: 'No LM Studio URL set. Enter your server URL above and Save, then Test.' })
    }
    const h = await health(baseUrl)
    if (!h.ok) {
      return res.json({ ok: false, baseUrl, error: h.error || 'Could not reach LM Studio' })
    }
    res.json({
      ok: true,
      baseUrl,
      modelCount: h.modelCount || 0,
      models: (h.models || []).slice(0, 50),
    })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message || String(e) })
  }
})

router.get('/lmstudio/models', async (_req, res) => {
  try {
    const { listModels } = await import('../lib/lmstudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const baseUrl = lmFirst(await getApiKey('lmstudio'))
    if (!baseUrl) return res.json({ models: [] })
    const models = await listModels(baseUrl)
    res.json({ models })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list LM Studio models'))
  }
})
