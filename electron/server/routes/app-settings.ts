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
  listProviderKeys, setApiKey, clearApiKey, getApiKey,
} from '../services/app-secrets-store.js'
import {
  getServerModeSettingsSafe, setServerModeNetworking, setServerModeCredentials,
  setServerModeRateLimit,
  rotateServerModeSessionSecret,
  getYoutubeDefaults, setYoutubeDefaults,
  getLastSeenVersion, setLastSeenVersion,
  getGenStudioUrl, setGenStudioUrl, DEFAULT_GENSTUDIO_URL,
} from '../services/app-settings.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  listModelCapabilities as listGenStudioCapabilities,
  listChatModels as listGenStudioChatModels,
  listImageModels as listGenStudioImageModels,
  listMusicModels as listGenStudioMusicModels,
  listTranscriptionModels as listGenStudioTranscriptionModels,
  listVideoModels as listGenStudioVideoModels,
  listVoices as listGenStudioVoices,
  listTtsModels as listGenStudioTtsModels,
  setGenStudioVoiceSaved,
  listGenStudioVoiceLibrary,
  addGenStudioVoiceLibraryVoice,
  downloadVoicePreview as downloadGenStudioVoicePreview,
  GENSTUDIO_VOICE_LIBRARIES,
  getGenStudioAccountSnapshot,
  refreshGenStudioAdmission,
  GenStudioApiError,
} from '../lib/genstudio-client.js'

export const router = Router()
const CUSTOMER_SECRET_PROVIDERS = ['genstudio'] as const

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
    const rows = (await listProviderKeys()).filter(row => row.providerId === 'genstudio')
    res.json({ providers: rows, supported: CUSTOMER_SECRET_PROVIDERS })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load API keys'))
  }
})

router.put('/app-settings/api-keys/:providerId', async (req, res) => {
  const providerId = req.params.providerId
  if (!(CUSTOMER_SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    return res.status(410).json({ code: 'GENSTUDIO_ONLY', detail: 'Only a GenStudio API key can be configured.' })
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
  if (!(CUSTOMER_SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    return res.status(410).json({ code: 'GENSTUDIO_ONLY', detail: 'Only a GenStudio API key can be configured.' })
  }
  try {
    await clearApiKey(providerId)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to clear API key'))
  }
})

// The single externally-facing generation boundary.
router.get('/app-settings/genstudio', async (_req, res) => {
  try {
    res.json({ url: await getGenStudioUrl(), default_url: DEFAULT_GENSTUDIO_URL })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load GenStudio API setting'))
  }
})

router.put('/app-settings/genstudio', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (url && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ detail: 'url must start with http:// or https://' })
  }
  try {
    await setGenStudioUrl(url)
    res.json({ url: await getGenStudioUrl(), default_url: DEFAULT_GENSTUDIO_URL })
  } catch (e: any) {
    res.status(typeof e?.statusCode === 'number' ? e.statusCode : 500)
      .json(humanizeBackendError(e, 'Failed to save GenStudio API setting'))
  }
})

// Provider and engine identity are published by GenStudio and shown to the
// customer (AGENTS.md → "Provider Transparency"). They are display only:
// Story Studio never infers a provider from an id or a name, and never sends a
// provider field on a generation request. GenStudio owns routing entirely.

/** Ask for the key once, with the message every GenStudio route shares. */
async function requireGenStudioKey(res: any): Promise<string | null> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey.trim()) {
    res.status(400).json({ detail: 'Save a GenStudio KH API key in Settings → This Mac first.' })
    return null
  }
  return apiKey
}

function queryText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * The voice catalogue, always scoped to a model.
 *
 * `GET /v1/voices` on GenStudio REQUIRES `model_id` (ADR-0016: TTS is
 * model-first and voices are not portable across engines, so "every voice on
 * the account" is not a question it can answer). This route used to forward the
 * filter only when the caller supplied one, and an unscoped ask came back 422 —
 * which read as a broken voice catalogue rather than a missing selection.
 *
 * Story Studio now asks for the selection instead of forwarding a request it
 * knows will be refused. Same shape as the guard on the quote route below it.
 */
router.get('/app-settings/genstudio/voices', async (req, res) => {
  try {
    const apiKey = await requireGenStudioKey(res)
    if (!apiKey) return
    const modelId = queryText(req.query.model_id)
    if (!modelId) {
      return res.status(400).json({
        code: 'GENSTUDIO_TTS_MODEL_REQUIRED',
        detail: 'Choose a voice model first. GenStudio KH lists voices per model, '
          + 'so there is no voice catalogue to show until one is selected.',
      })
    }
    const voices = await listGenStudioVoices(apiKey, {
      modelId,
      collection: queryText(req.query.collection),
      search: queryText(req.query.search),
    })
    // GenStudio's model-scoped endpoint is authoritative. Keep one defensive
    // boundary check for rows that also publish their serving model: a row
    // explicitly naming a different model can never be offered for this one.
    // Rows from older catalogues that omit the field still inherit the scoped
    // endpoint's answer; nothing is inferred from provider or voice names.
    res.json({ voices: voices.filter(voice => !voice.tts_model_id || voice.tts_model_id === modelId) })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not load the GenStudio KH voice catalog'))
  }
})

/** The speech selection and pricing axis: model first, voices below it. */
router.get('/app-settings/genstudio/tts-models', async (_req, res) => {
  try {
    const apiKey = await requireGenStudioKey(res)
    if (!apiKey) return
    const { resolveTtsRequestBudget } = await import('../services/tts-request-plan.js')
    const models = await listGenStudioTtsModels(apiKey)
    res.json({
      // Every field on a row is GenStudio's except `planned_request_characters`,
      // which is Story Studio's own planning budget for that row — the enforced
      // boundary, so the page can state it without re-deriving the policy that
      // produced it. Recomputed on every catalogue read from the row beside it,
      // so it follows the model like everything else.
      models: models.map(model => ({
        ...model,
        planned_request_characters: resolveTtsRequestBudget(model).effective,
      })),
    })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not load GenStudio KH voice models'))
  }
})

/**
 * GenStudio owns the saved state. Both verbs return the refreshed voice row so
 * the client renders GenStudio's own `is_saved` instead of assuming the toggle
 * landed the way it was clicked.
 */
async function respondWithSavedState(req: any, res: any, saved: boolean) {
  try {
    const apiKey = await requireGenStudioKey(res)
    if (!apiKey) return
    const voiceId = String(req.params.voiceId || '').trim()
    if (!voiceId) return res.status(400).json({ detail: 'A voice id is required.' })
    // Throws unless GenStudio accepted the change, so reaching the next line
    // means the new saved state is GenStudio's, not an assumption.
    await setGenStudioVoiceSaved(apiKey, voiceId, saved)
    // Re-reading the catalogue is how the refreshed ROW is obtained, and that
    // read must carry a model — an unscoped `/v1/voices` is a 422 by design.
    // Without one the row is simply not re-read: the accepted state is still
    // reported, and no failing catalogue call is made to decorate it.
    const modelId = queryText(req.query?.model_id) || queryText(req.body?.model_id)
    const voice = modelId
      ? (await listGenStudioVoices(apiKey, { modelId })).find(entry => entry.id === voiceId) || null
      : null
    res.json({ voice, is_saved: voice?.is_saved ?? saved })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not update the saved state of this voice'))
  }
}

router.post('/app-settings/genstudio/voices/:voiceId/save', (req, res) => respondWithSavedState(req, res, true))
router.delete('/app-settings/genstudio/voices/:voiceId/save', (req, res) => respondWithSavedState(req, res, false))

/** The libraries GenStudio publishes, named after their providers. */
router.get('/app-settings/genstudio/voice-libraries', (_req, res) => {
  res.json({ libraries: GENSTUDIO_VOICE_LIBRARIES.map(({ id, label, provider_id }) => ({ id, label, provider_id })) })
})

router.get('/app-settings/genstudio/voice-libraries/:library', async (req, res) => {
  try {
    const apiKey = await requireGenStudioKey(res)
    if (!apiKey) return
    const page = Number(req.query.page)
    res.json(await listGenStudioVoiceLibrary(apiKey, String(req.params.library || ''), {
      search: queryText(req.query.search),
      page: Number.isFinite(page) ? page : 0,
    }))
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not browse this GenStudio KH voice library'))
  }
})

router.post('/app-settings/genstudio/voice-libraries/:library/add', async (req, res) => {
  try {
    const apiKey = await requireGenStudioKey(res)
    if (!apiKey) return
    const publicVoiceId = String(req.body?.public_voice_id || '').trim()
    if (!publicVoiceId) return res.status(400).json({ detail: 'A public voice id is required.' })
    res.json(await addGenStudioVoiceLibraryVoice(apiKey, String(req.params.library || ''), publicVoiceId))
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not add this voice to your GenStudio KH library'))
  }
})

/** Play a stored library sample. Never submits a TTS job, never spends credits. */
router.get('/app-settings/genstudio/voice-libraries/:library/:publicVoiceId/preview', async (req, res) => {
  try {
    const apiKey = await requireGenStudioKey(res)
    if (!apiKey) return
    const library = GENSTUDIO_VOICE_LIBRARIES.find(entry => entry.id === String(req.params.library || '').trim())
    if (!library) return res.status(404).json({ detail: 'GenStudio KH publishes no voice library by that name.' })
    const publicVoiceId = String(req.params.publicVoiceId || '').trim()
    if (!publicVoiceId) return res.status(400).json({ detail: 'A public voice id is required.' })
    const preview = await downloadGenStudioVoicePreview(
      apiKey,
      `${library.path}/${encodeURIComponent(publicVoiceId)}/preview`,
    )
    res.json({ audio_url: `data:${preview.mediaType};base64,${preview.bytes.toString('base64')}` })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not play this library voice sample'))
  }
})

// A whole-script quote endpoint used to live here. It was removed in favour of
// `POST /projects/:slug/episodes/:code/tts-quote`, which quotes the requests
// generation will actually submit — one per chunk, each separately billed —
// instead of pricing a single request that is never sent for any narration
// longer than the selected model's published boundary.

router.get('/app-settings/genstudio/models', async (_req, res) => {
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey) return res.status(400).json({ detail: 'Add a GenStudio KH API key first.' })
    res.json({ models: await listGenStudioCapabilities(apiKey) })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not load the GenStudio KH capability catalog'))
  }
})

router.get('/app-settings/genstudio/chat-models', async (_req, res) => {
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey) return res.status(400).json({ detail: 'Add a GenStudio KH API key first.' })
    const models = await listGenStudioChatModels(apiKey)
    res.json({ models })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not load GenStudio KH chat models'))
  }
})

router.get('/app-settings/genstudio/video-models', async (_req, res) => {
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey) return res.status(400).json({ detail: 'Add a GenStudio KH API key first.' })
    const models = await listGenStudioVideoModels(apiKey)
    res.json({ models })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not load GenStudio KH video models'))
  }
})

router.get('/app-settings/genstudio/transcription-models', async (_req, res) => {
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey.trim()) {
      return res.status(400).json({ detail: 'Save a GenStudio KH API key in Settings → This Mac first.' })
    }
    const models = await listGenStudioTranscriptionModels(apiKey)
    res.json({ models })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(
      e,
      'Could not load GenStudio KH transcription models. Ensure the saved key includes audio:transcribe.',
    ))
  }
})

router.get('/app-settings/genstudio/image-models', async (_req, res) => {
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey.trim()) {
      return res.status(400).json({ detail: 'Save a GenStudio KH API key in Settings → This Mac first.' })
    }
    const models = await listGenStudioImageModels(apiKey)
    res.json({ models })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(
      e,
      'Could not load GenStudio KH image models. Ensure the saved key includes images:generate.',
    ))
  }
})

router.get('/app-settings/genstudio/music-models', async (_req, res) => {
  try {
    const apiKey = await requireGenStudioKey(res)
    if (!apiKey) return
    res.json({ models: await listGenStudioMusicModels(apiKey) })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not load GenStudio KH music models'))
  }
})

router.get('/app-settings/genstudio/admission', async (_req, res) => {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) return res.status(400).json({ detail: 'Add a GenStudio API key first.' })
  try {
    res.json(await refreshGenStudioAdmission(apiKey))
  } catch (error: any) {
    if (error instanceof GenStudioApiError && (error.status === 401 || error.status === 403)) {
      return res.status(503).json({
        code: 'GENSTUDIO_ADMISSION_SCOPE_UNAVAILABLE',
        detail: 'The saved GenStudio key is invalid or missing usage:read for account admission capacity. ' +
          'Use a GenStudio key with usage:read (all-access keys already include it), then save and test it again.',
      })
    }
    res.status(502).json(humanizeBackendError(error, 'Could not load GenStudio account admission capacity'))
  }
})

router.get('/app-settings/genstudio/usage', async (_req, res) => {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) return res.status(400).json({ detail: 'Add a GenStudio API key first.' })
  try {
    res.json(await getGenStudioAccountSnapshot(apiKey))
  } catch (error: any) {
    if (error instanceof GenStudioApiError && (error.status === 401 || error.status === 403)) {
      return res.status(503).json({
        code: 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE',
        detail: 'The saved GenStudio key is invalid or missing usage:read for account balance and settlement history. ' +
          'Use a GenStudio key with usage:read (all-access keys already include it), then save and test it again. ' +
          'Story Studio will not estimate or reconstruct credits locally.',
      })
    }
    res.status(502).json(humanizeBackendError(error, 'Could not load authoritative GenStudio credit data'))
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
// New modal for. The frontend auto-shows the modal on launch when the current
// version is simply DIFFERENT from this one (`!==`), never when it is greater.
// That is deliberate: versions are strings, and "1.4.10" > "1.4.9" is false to
// a string comparison, so an ordering test would silently stop showing What's
// New from the tenth patch onward. Inequality is digit-count-agnostic. Do not
// "fix" this into a `>`. Per-machine.

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
  if (!(CUSTOMER_SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    return res.status(410).json({ code: 'GENSTUDIO_ONLY', detail: 'Only a GenStudio API key can be tested.' })
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
    if (providerId === 'genstudio') {
      const baseUrl = await getGenStudioUrl()
      const root = baseUrl.replace(/\/+$/, '')
      const headers = { Authorization: `Bearer ${apiKey}` }
      const probes: { path: string; scope: string; label: string; expected: number }[] = [
        { path: '/v1/models', scope: 'models:read', label: 'model catalog', expected: 200 },
        { path: '/v1/transcription/models', scope: 'audio:transcribe', label: 'transcription catalog', expected: 200 },
        { path: '/v1/image/models', scope: 'images:generate', label: 'image catalog', expected: 200 },
        { path: '/v1/videos/models', scope: 'videos:generate', label: 'video catalog', expected: 200 },
        { path: '/v1/music/models', scope: 'music:generate', label: 'music catalog', expected: 200 },
        { path: '/v1/jobs/story-studio-key-probe', scope: 'tts:generate', label: 'TTS job access', expected: 404 },
        { path: '/v1/chat/responses/story-studio-key-probe', scope: 'chat:generate', label: 'LLM job access', expected: 404 },
        { path: '/v1/images/story-studio-key-probe', scope: 'images:generate', label: 'image job access', expected: 404 },
        { path: '/v1/transcriptions/story-studio-key-probe', scope: 'audio:transcribe', label: 'transcription job access', expected: 404 },
        { path: '/v1/videos/story-studio-key-probe', scope: 'videos:generate', label: 'video job access', expected: 404 },
        // Safe read-only proof. Phase 1 deliberately has no non-debit endpoint
        // that can prove content:purchase, so the purchase scope stays
        // required-but-unverified until the customer explicitly buys a pack.
        { path: '/v1/content/account', scope: 'content:read', label: 'Content Store account', expected: 200 },
      ]

      // `GET /v1/voices` REQUIRES `model_id` (ADR-0016: TTS is model-first, and
      // a voice list not scoped to a model is not answerable because voices are
      // not portable across engines). This probe used to ask for it unscoped and
      // expect 200; GenStudio answers 422 by design, so a perfectly healthy key
      // was reported as broken. Scope it by a real published model id instead.
      //
      // The id is read from the account's own live catalogue — never inferred
      // from a model name — and when the account publishes no TTS models there
      // is nothing to scope by, so the voice probe is SKIPPED rather than
      // failed. A skipped probe is honest; a manufactured one is not.
      const ttsCatalogResponse = await fetch(`${root}/v1/tts/models`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      })
      if (ttsCatalogResponse.status === 401 || ttsCatalogResponse.status === 403) {
        return res.json({
          valid: false,
          reachable: true,
          message: 'The GenStudio API key is invalid or is missing voices:read.',
        })
      }
      if (ttsCatalogResponse.status !== 200) {
        return res.json({
          valid: false,
          reachable: true,
          message: `GenStudio voice model catalog returned HTTP ${ttsCatalogResponse.status}. Check the API URL and key.`,
        })
      }
      const ttsCatalog = await ttsCatalogResponse.json().catch(() => null)
      const probeModelId = Array.isArray(ttsCatalog)
        ? ttsCatalog.map((row: any) => (typeof row?.id === 'string' ? row.id.trim() : '')).find(Boolean) || ''
        : ''
      if (probeModelId) {
        probes.push({
          path: `/v1/voices?model_id=${encodeURIComponent(probeModelId)}`,
          scope: 'voices:read',
          label: 'voice catalog',
          expected: 200,
        })
      }

      for (const probe of probes) {
        const response = await fetch(`${root}${probe.path}`, {
          headers,
          signal: AbortSignal.timeout(8_000),
        })
        if (response.status === 401 || response.status === 403) {
          return res.json({
            valid: false,
            reachable: true,
            message: `The GenStudio API key is invalid or is missing ${probe.scope}.`,
          })
        }
        if (response.status !== probe.expected) {
          return res.json({
            valid: false,
            reachable: true,
            message: `GenStudio ${probe.label} returned HTTP ${response.status}. Check the API URL and key.`,
          })
        }
      }
      const usageProbe = await fetch(`${root}/v1/account/overview`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      })
      const usageAvailable = usageProbe.status === 200
      return res.json({
        valid: true,
        reachable: true,
        usage_available: usageAvailable,
        content_store: {
          read_scope: 'verified',
          purchase_scope: 'required_unverified',
        },
        warning: usageAvailable ? null : 'Generation scopes work, but GenStudio did not accept this key for usage:read. Balance and exact settlement history remain unavailable; Story Studio will not calculate them locally.',
        message: 'Key works for GenStudio catalogs and TTS, transcription, image, LLM, music, and video job access.',
      })
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to test API key'))
  }
})
