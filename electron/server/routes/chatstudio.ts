/**
 * Chat Studio (local MLX LLM) settings routes. Replaces the LM Studio routes.
 *
 * Sibling of /imagestudio/* and /voicestudio/*. Powers the Settings → Local
 * Models → "Chat Studio" panel (a shared <EndpointListEditor route-prefix="/chatstudio">):
 *   GET  /chatstudio/base-url   — read configured URL + default
 *   PUT  /chatstudio/base-url   — persist URL(s) (per-Mac via app-secrets)
 *   POST /chatstudio/test       — reachability + available-model count
 *   GET  /chatstudio/models     — live list of model ids the server(s) have
 *
 * The base URL is stored in the app-secrets `chatstudio` bucket (the "apiKey"
 * slot carries the URL — there's no real secret; the server is on the user's
 * own machine). callAi resolves it for `chatstudio:` model ids.
 */

import { Router } from 'express'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { parseEndpoints } from '../lib/endpoint-pool.js'

export const router = Router()

const csFirst = (stored: string | null | undefined): string => parseEndpoints(stored)[0] || ''

router.get('/chatstudio/base-url', async (_req, res) => {
  try {
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { DEFAULT_CHATSTUDIO_BASE_URL } = await import('../lib/chatstudio-client.js')
    const { getEndpointLabels, getDisabledEndpoints } = await import('../services/app-settings.js')
    const stored = await getApiKey('chatstudio')
    const labels = await getEndpointLabels('chatstudio')
    const disabled = await getDisabledEndpoints('chatstudio')
    res.json({ baseUrl: stored || '', defaultBaseUrl: DEFAULT_CHATSTUDIO_BASE_URL, labels, disabled })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read Chat Studio base URL'))
  }
})

router.put('/chatstudio/base-url', async (req, res) => {
  try {
    const raw = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
    if (!raw) return res.status(400).json({ detail: 'baseUrl is required' })
    // Accept one or more endpoints (comma/space separated). Chat dispatches
    // across the pool; the list shape keeps parity with the image/voice editors.
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
    const { setEndpointLabelsForUrls, setDisabledEndpointsForUrls } = await import('../services/app-settings.js')
    const { setDisabledEndpoints } = await import('../lib/endpoint-pool.js')
    await setApiKey('chatstudio', cleaned)
    const labels = await setEndpointLabelsForUrls('chatstudio', cleanedUrls, req.body?.labels)
    const disabled = await setDisabledEndpointsForUrls('chatstudio', cleanedUrls, req.body?.disabled)
    setDisabledEndpoints('chatstudio', disabled)
    res.json({ ok: true, baseUrl: cleaned, labels, disabled })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not save Chat Studio base URL'))
  }
})

router.post('/chatstudio/test', async (req, res) => {
  try {
    const { health, DEFAULT_CHATSTUDIO_BASE_URL } = await import('../lib/chatstudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const incoming = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
    const baseUrl = csFirst(incoming) || csFirst(await getApiKey('chatstudio')) || DEFAULT_CHATSTUDIO_BASE_URL
    if (!baseUrl) {
      return res.json({ ok: false, error: 'No Chat Studio URL set. Enter your server URL above and Save, then Test.' })
    }
    const h = await health(baseUrl)
    if (!h.ok) {
      return res.json({ ok: false, baseUrl, error: h.error || 'Could not reach Chat Studio' })
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

router.get('/chatstudio/models', async (_req, res) => {
  try {
    // Union across ALL endpoints (not just the first) so a sleeping endpoints[0]
    // doesn't make the model list look empty.
    const { listModelsPooled } = await import('../lib/chatstudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { getHubBackend, hubChatRootBase } = await import('../lib/studiohub-client.js')
    // In Hub mode the picker should surface the FLEET's chat models (via the
    // Hub's OpenAI-compatible gateway, same id shape). If the Hub is down or
    // lists nothing, fall back to the direct pool — mirroring generation's
    // auto-fallback so the picker always shows models that will actually run.
    const hub = await getHubBackend()
    let models: string[] = []
    if (hub.mode === 'hub' && hub.hubUrl) {
      models = await listModelsPooled(hubChatRootBase(hub.hubUrl)).catch(() => [])
    }
    if (!models.length) {
      const stored = await getApiKey('chatstudio')
      if (stored) models = await listModelsPooled(stored)
    }
    res.json({ models })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list Chat Studio models'))
  }
})
