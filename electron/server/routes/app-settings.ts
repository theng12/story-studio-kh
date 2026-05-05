/**
 * App-level (per-install) settings — not scoped to a project.
 *
 * Currently exposes notification preferences used by the Electron main
 * process's jobEvents subscriber (see electron/main.ts). Kept separate
 * from `settings.ts` (project-scoped) so a PUT to /app-settings/notifications
 * doesn't thread through a slug lookup.
 */

import { Router } from 'express'
import { getNotifierSettings, setNotifierSettings, DEFAULT_NOTIFIER_SETTINGS } from '../services/job-notifier.js'
import {
  listProviderKeys, setApiKey, clearApiKey, SECRET_PROVIDERS,
} from '../services/app-secrets-store.js'
import { testApiKey } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.get('/app-settings/notifications', async (_req, res) => {
  try {
    res.json(await getNotifierSettings())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load notification settings'))
  }
})

router.put('/app-settings/notifications', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const patch: {
    enabled?: boolean
    min_duration_ms?: number
    telegram?: { enabled?: boolean; bot_token?: string; chat_id?: string }
  } = {}

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ detail: 'enabled must be a boolean' })
    }
    patch.enabled = body.enabled
  }
  if (body.min_duration_ms !== undefined) {
    if (typeof body.min_duration_ms !== 'number' || !Number.isFinite(body.min_duration_ms) || body.min_duration_ms < 0) {
      return res.status(400).json({ detail: 'min_duration_ms must be a non-negative number (milliseconds)' })
    }
    patch.min_duration_ms = body.min_duration_ms
  }
  if (body.telegram !== undefined) {
    if (!body.telegram || typeof body.telegram !== 'object') {
      return res.status(400).json({ detail: 'telegram must be an object' })
    }
    const tg = body.telegram as Record<string, unknown>
    const tgPatch: { enabled?: boolean; bot_token?: string; chat_id?: string } = {}
    if (tg.enabled !== undefined) {
      if (typeof tg.enabled !== 'boolean') {
        return res.status(400).json({ detail: 'telegram.enabled must be a boolean' })
      }
      tgPatch.enabled = tg.enabled
    }
    if (tg.bot_token !== undefined) {
      if (typeof tg.bot_token !== 'string') {
        return res.status(400).json({ detail: 'telegram.bot_token must be a string' })
      }
      tgPatch.bot_token = tg.bot_token
    }
    if (tg.chat_id !== undefined) {
      if (typeof tg.chat_id !== 'string') {
        return res.status(400).json({ detail: 'telegram.chat_id must be a string' })
      }
      tgPatch.chat_id = tg.chat_id
    }
    patch.telegram = tgPatch as any
  }

  try {
    const saved = await setNotifierSettings(patch as any)
    res.json(saved)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save notification settings'))
  }
})

/**
 * Send a single test message to the Telegram chat configured here OR
 * the bot_token+chat_id supplied in the request body. Lets the user
 * confirm the bot is reachable BEFORE saving the credentials. Returns
 * the same shape sendTelegramMessage emits so the UI can show the
 * exact Telegram error description on failure.
 */
router.post('/app-settings/notifications/telegram-test', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  let botToken = typeof body.bot_token === 'string' ? body.bot_token.trim() : ''
  let chatId = typeof body.chat_id === 'string' ? body.chat_id.trim() : ''
  if (!botToken || !chatId) {
    const current = await getNotifierSettings()
    botToken = botToken || current.telegram?.bot_token || ''
    chatId = chatId || current.telegram?.chat_id || ''
  }
  if (!botToken) return res.status(400).json({ ok: false, error: 'Bot token is empty.' })
  if (!chatId) return res.status(400).json({ ok: false, error: 'Chat id is empty.' })
  try {
    const { sendTelegramTestMessage } = await import('../services/telegram-notifier.js')
    const r = await sendTelegramTestMessage(botToken, chatId)
    res.json(r)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to send Telegram test message'))
  }
})

router.get('/app-settings/notifications/defaults', (_req, res) => {
  res.json(DEFAULT_NOTIFIER_SETTINGS)
})

// ── App-level API keys ──────────────────────────────────────────────────────
//
// Provider keys live in `<userData>/app-secrets.json` (see
// `services/app-secrets-store.ts`). One key per provider. These routes
// replace the old `/projects/:slug/settings/api-keys` and
// `/projects/:slug/settings/accounts/...` family — keys are no longer
// project-scoped.

router.get('/app-settings/api-keys', async (_req, res) => {
  try {
    const rows = await listProviderKeys()
    res.json({ providers: rows, supported: SECRET_PROVIDERS })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load API keys'))
  }
})

router.put('/app-settings/api-keys/:providerId', async (req, res) => {
  const providerId = req.params.providerId
  if (!(SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    return res.status(404).json({ detail: `Unknown provider: ${providerId}` })
  }
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : ''
  if (!apiKey.trim()) {
    return res.status(400).json({ detail: 'apiKey is required' })
  }
  try {
    await setApiKey(providerId, apiKey)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save API key'))
  }
})

router.delete('/app-settings/api-keys/:providerId', async (req, res) => {
  const providerId = req.params.providerId
  if (!(SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    return res.status(404).json({ detail: `Unknown provider: ${providerId}` })
  }
  try {
    await clearApiKey(providerId)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to clear API key'))
  }
})

router.post('/app-settings/api-keys/:providerId/test', async (req, res) => {
  const providerId = req.params.providerId
  if (!(SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    return res.status(404).json({ detail: `Unknown provider: ${providerId}` })
  }
  // Allow caller to test a key BEFORE saving (req.body.apiKey) or to
  // re-test the currently-stored key (no body).
  let apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : ''
  if (!apiKey) {
    const { getApiKey } = await import('../services/app-secrets-store.js')
    apiKey = await getApiKey(providerId)
  }
  if (!apiKey) {
    return res.status(400).json({ valid: false, reachable: false, message: 'No API key configured' })
  }
  try {
    const result = await testApiKey(providerId, apiKey)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to test API key'))
  }
})
