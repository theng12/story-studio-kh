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
  listProviderKeys, setApiKey, clearApiKey, SECRET_PROVIDERS, getApiKey,
} from '../services/app-secrets-store.js'
import {
  getServerModeSettingsSafe, setServerModeNetworking, setServerModeCredentials,
  setServerModeRateLimit,
  rotateServerModeSessionSecret,
  getYoutubeDefaults, setYoutubeDefaults,
  getLastSeenVersion, setLastSeenVersion,
  getScriptConcurrency, setScriptConcurrency,
  SCRIPT_CONCURRENCY_DEFAULT, SCRIPT_CONCURRENCY_MIN, SCRIPT_CONCURRENCY_MAX,
  getLocalBackend, setLocalBackend, getHubUrl, setHubUrl, DEFAULT_HUB_URL,
  getRenderWorkersEnabled, setRenderWorkersEnabled,
} from '../services/app-settings.js'
import { hubFleetStatus, hubHealth, hubStudios, hubStudioAction, isLoopbackHub } from '../lib/studiohub-client.js'
import { setLlmConcurrency } from '../services/job-queue.js'
import { testApiKey } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

// ── LLM-text generation concurrency (Settings → Performance) ───────────────
// How many text-gen jobs (script outline/expansion, metadata, image prompts,
// scene planning) run at once across all of them combined. Machine-level —
// reflects local LM Studio pool capacity. The queue applies it immediately.
router.get('/app-settings/script-concurrency', async (_req, res) => {
  try {
    res.json({
      value: await getScriptConcurrency(),
      default: SCRIPT_CONCURRENCY_DEFAULT,
      min: SCRIPT_CONCURRENCY_MIN,
      max: SCRIPT_CONCURRENCY_MAX,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load concurrency setting'))
  }
})

router.put('/app-settings/script-concurrency', async (req, res) => {
  const raw = (req.body || {}).value
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return res.status(400).json({ detail: 'value must be a number' })
  }
  try {
    const value = await setScriptConcurrency(raw)
    setLlmConcurrency(value)  // apply to the live queue without a restart
    res.json({ value, min: SCRIPT_CONCURRENCY_MIN, max: SCRIPT_CONCURRENCY_MAX })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save concurrency setting'))
  }
})

// ── Local generation backend (Settings → Local Models: Direct | Studio Hub) ─
// Per-machine choice of how the local Studio providers reach the fleet. GET
// also probes Hub liveness so the UI can show an online/offline dot. The
// optional X-Hub-Token lives in the app-secrets 'hub' bucket (via
// /app-settings/api-keys/hub) — not returned here, only whether one is set.
router.get('/app-settings/local-backend', async (_req, res) => {
  try {
    const [mode, hubUrl, token, renderWorkersEnabled] = await Promise.all([
      getLocalBackend(),
      getHubUrl(),
      getApiKey('hub').catch(() => ''),
      getRenderWorkersEnabled(),
    ])
    const [health, fleet] = await Promise.all([
      hubHealth(hubUrl),
      hubFleetStatus(hubUrl, token),
    ])
    res.json({
      local_backend: mode,
      hub_url: hubUrl,
      default_hub_url: DEFAULT_HUB_URL,
      hub_token_set: !!(token && token.trim()),
      render_workers_enabled: renderWorkersEnabled,
      hub_online: health.ok,
      hub_app_version: health.appVersion || null,
      hub_error: health.ok ? null : (health.error || null),
      hub_access_mode: isLoopbackHub(hubUrl) ? 'local' : 'token',
      hub_fleet_ready: fleet.ok && fleet.fleetTokenSet,
      hub_fleet_error: fleet.ok ? null : (fleet.error || null),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load local-backend setting'))
  }
})

router.put('/app-settings/local-backend', async (req, res) => {
  try {
    const body = req.body || {}
    if (body.local_backend !== undefined) {
      if (body.local_backend !== 'direct' && body.local_backend !== 'hub') {
        return res.status(400).json({ detail: "local_backend must be 'direct' or 'hub'" })
      }
      await setLocalBackend(body.local_backend)
    }
    if (body.hub_url !== undefined) {
      const url = typeof body.hub_url === 'string' ? body.hub_url.trim() : ''
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ detail: 'hub_url must start with http:// or https://' })
      }
      await setHubUrl(url)
    }
    if (body.render_workers_enabled !== undefined) {
      if (typeof body.render_workers_enabled !== 'boolean') {
        return res.status(400).json({ detail: 'render_workers_enabled must be a boolean' })
      }
      await setRenderWorkersEnabled(body.render_workers_enabled)
    }
    // Optional convenience: set/clear the Hub token in the same call.
    if (body.hub_token !== undefined) {
      const tok = typeof body.hub_token === 'string' ? body.hub_token.trim() : ''
      await setApiKey('hub', tok)
    }
    const [mode, hubUrl, token, renderWorkersEnabled] = await Promise.all([
      getLocalBackend(), getHubUrl(), getApiKey('hub').catch(() => ''), getRenderWorkersEnabled(),
    ])
    const [health, fleet] = await Promise.all([
      hubHealth(hubUrl),
      hubFleetStatus(hubUrl, token),
    ])
    res.json({
      ok: true,
      local_backend: mode,
      hub_url: hubUrl,
      hub_token_set: !!(token && token.trim()),
      render_workers_enabled: renderWorkersEnabled,
      hub_online: health.ok,
      hub_app_version: health.appVersion || null,
      hub_error: health.ok ? null : (health.error || null),
      hub_access_mode: isLoopbackHub(hubUrl) ? 'local' : 'token',
      hub_fleet_ready: fleet.ok && fleet.fleetTokenSet,
      hub_fleet_error: fleet.ok ? null : (fleet.error || null),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save local-backend setting'))
  }
})

// ── Studio Hub fleet control (ops) ─────────────────────────────────────────
// List the fleet's studios and start/stop/restart one from Settings. Restart is
// stop → brief pause → start (the Hub's lifecycle route only exposes start/stop).
router.get('/app-settings/hub/studios', async (_req, res) => {
  try {
    const [hubUrl, token] = await Promise.all([getHubUrl(), getApiKey('hub').catch(() => '')])
    const studios = await hubStudios(hubUrl, token)
    res.json({ studios })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not reach Studio Hub to list studios'))
  }
})

router.post('/app-settings/hub/studios/:id/:action', async (req, res) => {
  const { id, action } = req.params
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return res.status(400).json({ detail: 'action must be start, stop, or restart' })
  }
  try {
    const [hubUrl, token] = await Promise.all([getHubUrl(), getApiKey('hub').catch(() => '')])
    if (action === 'restart') {
      await hubStudioAction(hubUrl, token, id, 'stop')
      await new Promise((r) => setTimeout(r, 2500))
      return res.json(await hubStudioAction(hubUrl, token, id, 'start'))
    }
    res.json(await hubStudioAction(hubUrl, token, id, action))
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Studio action failed'))
  }
})

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
  if (body.digest !== undefined) {
    if (!body.digest || typeof body.digest !== 'object') {
      return res.status(400).json({ detail: 'digest must be an object' })
    }
    const dg = body.digest as Record<string, unknown>
    const dgPatch: { enabled?: boolean; time_local?: string; desktop_enabled?: boolean; telegram_enabled?: boolean; quiet_when_empty?: boolean } = {}
    if (dg.enabled !== undefined) {
      if (typeof dg.enabled !== 'boolean') {
        return res.status(400).json({ detail: 'digest.enabled must be a boolean' })
      }
      dgPatch.enabled = dg.enabled
    }
    if (dg.time_local !== undefined) {
      if (typeof dg.time_local !== 'string' || !/^\d{1,2}:\d{2}$/.test(dg.time_local)) {
        return res.status(400).json({ detail: 'digest.time_local must be a HH:MM string' })
      }
      dgPatch.time_local = dg.time_local
    }
    if (dg.desktop_enabled !== undefined) {
      if (typeof dg.desktop_enabled !== 'boolean') {
        return res.status(400).json({ detail: 'digest.desktop_enabled must be a boolean' })
      }
      dgPatch.desktop_enabled = dg.desktop_enabled
    }
    if (dg.telegram_enabled !== undefined) {
      if (typeof dg.telegram_enabled !== 'boolean') {
        return res.status(400).json({ detail: 'digest.telegram_enabled must be a boolean' })
      }
      dgPatch.telegram_enabled = dg.telegram_enabled
    }
    if (dg.quiet_when_empty !== undefined) {
      if (typeof dg.quiet_when_empty !== 'boolean') {
        return res.status(400).json({ detail: 'digest.quiet_when_empty must be a boolean' })
      }
      dgPatch.quiet_when_empty = dg.quiet_when_empty
    }
    ;(patch as any).digest = dgPatch
  }
  // v1.0.367 — per-event toggles.
  if (body.events !== undefined) {
    if (!body.events || typeof body.events !== 'object') {
      return res.status(400).json({ detail: 'events must be an object' })
    }
    const ev = body.events as Record<string, unknown>
    const evPatch: { pipeline_finished?: boolean; failures?: boolean; long_job?: boolean } = {}
    for (const k of ['pipeline_finished', 'failures', 'long_job'] as const) {
      if (ev[k] !== undefined) {
        if (typeof ev[k] !== 'boolean') {
          return res.status(400).json({ detail: `events.${k} must be a boolean` })
        }
        evPatch[k] = ev[k] as boolean
      }
    }
    ;(patch as any).events = evPatch
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
 * Build the daily digest right now and return what would be sent —
 * but DON'T actually fire the channels. Lets the Settings page show a
 * live preview of the digest body so the user sees the format before
 * committing to a daily fire schedule.
 */
router.get('/app-settings/notifications/digest-preview', async (_req, res) => {
  try {
    const [{ buildDigest }, { formatDigestMessage }] = await Promise.all([
      import('../services/digest-builder.js'),
      import('../services/digest-formatter.js'),
    ])
    const data = await buildDigest()
    const payload = formatDigestMessage(data)
    res.json({ payload, data })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to build digest preview'))
  }
})

/**
 * Manual fire — actually dispatches the digest via whichever channels
 * the user has enabled for it. Doesn't update last_fired_date so the
 * regular schedule still fires later that day. Used by the "Send now"
 * button in Settings.
 */
router.post('/app-settings/notifications/send-digest-now', async (_req, res) => {
  try {
    const { sendDigestNow } = await import('../services/digest-scheduler.js')
    const r = await sendDigestNow()
    res.json(r)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to send digest'))
  }
})

/**
 * Detect the user's chat id from the most recent message they sent
 * to their bot. Skips the manual "open getUpdates URL and read JSON"
 * step. Frontend pastes the bot token, clicks Detect, we hit
 * Telegram's getUpdates and return the latest chat that messaged
 * the bot. Empty result → friendly "send /start and try again" hint.
 */
router.post('/app-settings/notifications/telegram-detect-chat-id', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  let botToken = typeof body.bot_token === 'string' ? body.bot_token.trim() : ''
  if (!botToken) {
    const current = await getNotifierSettings()
    botToken = current.telegram?.bot_token || ''
  }
  if (!botToken) return res.status(400).json({ ok: false, error: 'Bot token is empty.' })
  try {
    const { detectTelegramChatId } = await import('../services/telegram-notifier.js')
    const r = await detectTelegramChatId(botToken)
    res.json(r)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to detect Telegram chat id'))
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

// ── Server mode (headless web UI) ──────────────────────────────────────────
//
// All four routes are gated by requireSession in server mode (loopback bypass
// allows local Electron on the Mac mini to manage settings). In default mode,
// requireSession isn't mounted so these are reachable from the desktop app
// directly. The user's flow is: launch the app locally on the Mac mini once,
// configure credentials + enable server mode here, quit, relaunch under
// launchd.

router.get('/app-settings/server-mode', async (_req, res) => {
  try {
    res.json(await getServerModeSettingsSafe())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load server-mode settings'))
  }
})

router.put('/app-settings/server-mode', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const patch: { enabled?: boolean; port?: number; bind?: string } = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ detail: 'enabled must be a boolean' })
    }
    patch.enabled = body.enabled
  }
  if (body.port !== undefined) {
    if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
      return res.status(400).json({ detail: 'port must be an integer between 1 and 65535' })
    }
    patch.port = body.port
  }
  if (body.bind !== undefined) {
    if (typeof body.bind !== 'string' || !body.bind.trim()) {
      return res.status(400).json({ detail: 'bind must be a non-empty string' })
    }
    patch.bind = body.bind.trim()
  }
  try {
    res.json(await setServerModeNetworking(patch))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save server-mode settings'))
  }
})

router.put('/app-settings/server-mode/credentials', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const session_ttl_hours = typeof req.body?.session_ttl_hours === 'number'
    ? req.body.session_ttl_hours : undefined
  if (!username) return res.status(400).json({ detail: 'username is required' })
  if (!password || password.length < 8) {
    return res.status(400).json({ detail: 'password must be at least 8 characters' })
  }
  try {
    res.json(await setServerModeCredentials({ username, password, session_ttl_hours }))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save credentials'))
  }
})

router.put('/app-settings/server-mode/rate-limit', async (req, res) => {
  const n = Number(req.body?.login_max_attempts_per_minute)
  if (!Number.isFinite(n) || n < 1 || n > 1000) {
    return res.status(400).json({ detail: 'login_max_attempts_per_minute must be a number between 1 and 1000' })
  }
  try {
    res.json(await setServerModeRateLimit(n))
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Failed to update rate limit'))
  }
})

router.post('/app-settings/server-mode/rotate-sessions', async (_req, res) => {
  try {
    res.json(await rotateServerModeSessionSecret())
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Failed to rotate sessions'))
  }
})

// ── YouTube upload defaults (app-level) ─────────────────────────────────────
//
// New uploads inherit these when the per-project values aren't explicitly
// set. The Settings → YouTube section in the UI exposes the project-level
// values; falling back to these app defaults keeps a single source of
// truth across all of the user's channels.

router.get('/app-settings/youtube-defaults', async (_req, res) => {
  try {
    res.json(await getYoutubeDefaults())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load YouTube defaults'))
  }
})

router.put('/app-settings/youtube-defaults', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const patch: { default_mark_as_ai_generated?: boolean; default_yt_category_id?: number } = {}
  if (body.default_mark_as_ai_generated !== undefined) {
    if (typeof body.default_mark_as_ai_generated !== 'boolean') {
      return res.status(400).json({ detail: 'default_mark_as_ai_generated must be a boolean' })
    }
    patch.default_mark_as_ai_generated = body.default_mark_as_ai_generated
  }
  if (body.default_yt_category_id !== undefined) {
    const n = typeof body.default_yt_category_id === 'number'
      ? body.default_yt_category_id : Number(body.default_yt_category_id)
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ detail: 'default_yt_category_id must be a positive integer' })
    }
    patch.default_yt_category_id = n
  }
  try {
    res.json(await setYoutubeDefaults(patch))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save YouTube defaults'))
  }
})

// ── What's New / version tracking ───────────────────────────────────────────
//
// last_seen_version stores the version the user last dismissed the What's
// New modal for. The frontend uses this to decide whether to auto-show
// the modal on launch (when current version > last seen). Per-machine.

router.get('/app-settings/last-seen-version', async (_req, res) => {
  try {
    res.json({ last_seen_version: await getLastSeenVersion() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read last-seen version'))
  }
})

router.put('/app-settings/last-seen-version', async (req, res) => {
  const v = typeof req.body?.version === 'string' ? req.body.version.trim() : ''
  if (!v) return res.status(400).json({ detail: 'version is required' })
  try {
    await setLastSeenVersion(v)
    res.json({ last_seen_version: v })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save last-seen version'))
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
