import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { createRequire } from 'module'
import * as pm from '../services/project-manager.js'
import { getKieCredits, getFalBalance, getElevenLabsBalance, getGenaiproBalance, getFishCredit, getDeepseekBalance, testApiKey } from '../services/utils.js'
import { MODEL_LABELS, SUPPORTED_MODELS, KNOWN_UNAVAILABLE_REASONS } from '../models/types.js'
import { getSessionUsage, getModelPricing } from '../services/usage-tracker.js'
import { getSessionStats } from '../services/session-tracker.js'
import { getFFmpegStatus, downloadFFmpeg, getInstallProgressState, _markInstallError } from '../services/ffmpeg-manager.js'
import { getLogDir, logLine } from '../services/logger.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

// Lazy-loaded so that route imports stay valid when the server runs
// outside Electron (e.g. test runners use `STORY_STUDIO_DISABLE_LISTEN=1`
// + tsx). The route handler below short-circuits with a clear message
// in that environment instead of crashing the import.
const requireFromHere = createRequire(import.meta.url)

export const router = Router()

// ── FFmpeg Status & Install ───────────────────────────────────────────────

router.get('/ffmpeg/status', async (_req, res) => {
  try {
    const status = await getFFmpegStatus()
    res.json(status)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'FFmpeg status check failed'))
  }
})

router.post('/ffmpeg/install', async (_req, res) => {
  // Refuse a parallel install — the in-memory progress state machine
  // can only track one in-flight install at a time, and downloads to
  // the same paths would race. The frontend should disable the button
  // while running, but this is the server-side guard.
  const current = getInstallProgressState()
  if (current.status === 'running') {
    return res.status(409).json({
      detail: 'FFmpeg install already in progress.',
      code: 'INSTALL_IN_PROGRESS',
    })
  }
  try {
    // downloadFFmpeg internally writes to the same shared state we
    // return from GET /ffmpeg/install-progress, so the frontend sees
    // live phase / percent / message updates while this POST is still
    // in flight.
    const ffmpegPath = await downloadFFmpeg()
    const status = await getFFmpegStatus()
    res.json({ ok: true, path: ffmpegPath, status })
  } catch (e: any) {
    // Mirror the failure into the polling state so a poll that lands
    // AFTER the POST resolves still sees the error (rather than the
    // stale 'running' state). downloadFFmpeg itself already logged the
    // structured `ffmpeg-install:* failed` entry via logLine.
    _markInstallError(e?.message || 'FFmpeg install failed')
    res.status(500).json(humanizeBackendError(e, 'FFmpeg install failed'))
  }
})

/**
 * Live install progress for the FFmpeg download flow. The frontend polls
 * this every second while POST /ffmpeg/install is in flight (or for a
 * couple of seconds after, to capture the terminal state).
 *
 * Returned shape mirrors `InstallProgressState` from ffmpeg-manager.
 */
router.get('/ffmpeg/install-progress', (_req, res) => {
  res.json(getInstallProgressState())
})

// Returns the most recent ffmpeg-install log entries from today's log file,
// suitable for the user to copy and paste back to support when an install
// fails. Filters by the `ffmpeg-install:*` message prefix that
// `downloadFFmpeg` writes — keeps the response focused instead of dumping
// the whole 5000-line server log.
//
// Returns the last 200 matching entries OR everything from the past hour,
// whichever is smaller. The 200-entry cap keeps the response usable even
// after a long debugging session with many retries.
router.get('/ffmpeg/install-log', async (_req, res) => {
  try {
    const logDir = getLogDir()
    const today = new Date().toISOString().slice(0, 10)
    const logPath = path.join(logDir, `server-${today}.log`)

    let raw = ''
    try {
      raw = await fs.readFile(logPath, 'utf-8')
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return res.json({ entries: [], path: logPath, message: 'No log file yet for today.' })
      }
      throw e
    }

    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const entries: Array<Record<string, any>> = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let parsed: any
      try { parsed = JSON.parse(line) } catch { continue }
      if (typeof parsed?.message !== 'string') continue
      if (!parsed.message.startsWith('ffmpeg-install')) continue
      // Drop entries older than 1h to keep the diagnostic focused on the
      // latest attempt. If a user ran `Install` 3 days ago and it worked,
      // those entries aren't useful to the current failure.
      const ts = parsed.ts ? Date.parse(parsed.ts) : 0
      if (ts && ts < oneHourAgo) continue
      entries.push(parsed)
    }

    // Cap at 200 most-recent entries.
    const trimmed = entries.slice(-200)
    res.json({ entries: trimmed, path: logPath, total: entries.length })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read install log'))
  }
})

// Quit + relaunch the Electron app. Used by the FFmpeg install flow:
// after a fresh install the renderer process keeps a stale ffmpeg-not-
// found cache for some operations until the whole app reloads, so the
// safest UX is "restart now". Also used after the user installs ffmpeg
// externally (brew) and clicks Re-check status to a positive result —
// `app.relaunch()` ensures every cached path is invalidated.
//
// We send the response BEFORE calling exit so the client gets the
// confirmation; otherwise the connection drops mid-request and the UI
// would surface a confusing network error. The relaunch fires on the
// next tick.
router.post('/app/restart', (_req, res) => {
  let electronApp: any
  try {
    electronApp = requireFromHere('electron').app
  } catch {
    // Server is running outside Electron (tests, headless dev). Tell
    // the caller it's a no-op so they can show "you'll need to restart
    // manually" instead of pretending we did anything.
    return res.status(503).json({ ok: false, detail: 'Not running inside Electron — restart manually.' })
  }
  if (!electronApp || typeof electronApp.relaunch !== 'function') {
    return res.status(503).json({ ok: false, detail: 'Electron app handle unavailable.' })
  }

  res.json({ ok: true, message: 'Restarting…' })
  logLine('info', 'app:restart', { source: 'POST /app/restart' })

  // Give the response time to flush before the process exits. 200ms is
  // enough on localhost for the browser to receive + parse the JSON
  // and trigger its post-restart UI updates.
  setTimeout(() => {
    try {
      electronApp.relaunch()
      electronApp.exit(0)
    } catch (e: any) {
      logLine('error', 'app:restart-failed', { error: e?.message })
    }
  }, 200)
})

// Serve available AI models to the frontend (with key availability).
//
// v1.0.129+ — Key resolution is now consistent across providers. Earlier
// versions only checked per-project config (`config.<provider>_api_key`)
// for openai/anthropic/kie and showed "(no key)" in the dropdown when
// the key only lived in the app-level secrets store. The user IS using
// the app-level store (via App Settings → API Keys) for every provider
// today, so any model showed "(no key)" unless they ALSO duplicated the
// key into project config — confusing and undocumented behaviour. Now:
//   1. Try the app-level secrets store via getApiKey(providerId) first.
//   2. Fall back to per-project config field if no app-level key set
//      (preserves backwards compatibility with old projects that have
//      the key inlined in their config.json).
router.get('/models', async (req, res) => {
  const slug = req.query.project as string

  // App-level secrets — present regardless of project context.
  const { getApiKey } = await import('../services/app-secrets-store.js')
  const appOpenai = await getApiKey('openai').catch(() => '')
  const appKie = await getApiKey('kie').catch(() => '')
  const appDeepseek = await getApiKey('deepseek').catch(() => '')
  const appOpenrouter = await getApiKey('openrouter').catch(() => '')

  // Per-project fallback for backwards compat (only openai/kie are stored
  // per-project; deepseek/openrouter are app-level only).
  let cfgOpenai = ''
  let cfgKie = ''
  if (slug) {
    const config = await pm.getConfig(slug)
    if (config) {
      cfgOpenai = config.openai_api_key || ''
      cfgKie = config.kie_api_key || ''
    }
  }

  const hasKeys: Record<string, boolean> = {
    openai: !!(appOpenai || cfgOpenai),
    kie: !!(appKie || cfgKie),
    deepseek: !!appDeepseek,
    openrouter: !!appOpenrouter,
  }

  // v1.0.283 — vision-capable model detection. We can't query a "capabilities"
  // endpoint generically — every provider does it differently — so we keep a
  // hardcoded list of KNOWN vision-capable cloud model id patterns. The frontend
  // uses `supports_vision` to gate model pickers for image-aware workflows.
  //
  // For LOCAL LM Studio models we set `supports_vision: true` unconditionally:
  // we have no reliable way to detect capability from the model slug alone
  // (`gemma-3-4b-it` could be the text-only variant or the vision variant),
  // and the user (in the v1.0.283 design discussion) explicitly said most of
  // their local models are vision-capable. If a non-vision local model gets
  // an image, the LM Studio server returns a clear error which surfaces to
  // the user — no silent failure.
  function isVisionCapableCloud(id: string): boolean {
    const m = id.toLowerCase()
    if (m === 'gpt-4o' || m.startsWith('gpt-4o-')) return true
    if (m === 'gpt-4-turbo' || m.startsWith('gpt-4-turbo-')) return true
    if (m.startsWith('gpt-5')) return true     // GPT-5 family multimodal-by-default
    if (m.startsWith('gpt-4.1')) return true   // GPT-4.1 family same
    if (m.includes('vision')) return true       // gpt-4-vision-preview & friends
    if (m.startsWith('claude-3') || m.startsWith('claude-sonnet') || m.startsWith('claude-opus')) return true
    if (m.startsWith('gemini-')) return true
    return false
  }

  // v1.0.498 — cost tier per model so the picker can tab into
  // Local / Cloud (free) / Cloud (paid) and the user avoids accidentally
  // spending on a paid API. Every static cloud provider (OpenAI, DeepSeek,
  // OpenRouter-direct) uses the user's own paid key → 'paid'. Chat Studio
  // models are tagged below from the catalog (local / free / paid).
  type CostTier = 'local' | 'free' | 'paid'

  const models: Array<{
    id: string; label: string; provider: string; available: boolean;
    disabled_reason: string | null; hint: string | null;
    supports_vision: boolean; cost_tier: CostTier;
    min_unified_memory_gb?: number; is_reasoning?: boolean
  }> = Object.entries(MODEL_LABELS).map(([id, label]) => ({
    id,
    label,
    provider: SUPPORTED_MODELS[id],
    available: hasKeys[SUPPORTED_MODELS[id]] ?? false,
    disabled_reason: KNOWN_UNAVAILABLE_REASONS[id] ?? null,
    hint: null,
    supports_vision: isVisionCapableCloud(id),
    cost_tier: 'paid',
  }))

  // v1.0.280+ — dynamically surface LOCAL LM Studio models. When the user has
  // configured an LM Studio URL, query the running server's /v1/models and add
  // one row per loaded model (id `lmstudio:<slug>`, provider 'lmstudio', free).
  // Best-effort + short timeout — if the server is off, we simply add nothing
  // (rather than blocking the whole picker). Mirrors the dynamic image/voice
  // local-model surfacing.
  try {
    const lmBaseRaw = await getApiKey('chatstudio').catch(() => '')
    const { getHubBackend, hubCatalog } = await import('../lib/studiohub-client.js')
    const hub = await getHubBackend()
    let entries: Array<{
      id: string; label: string; cloud: boolean; provider_key?: string;
      provider_name?: string; free?: boolean; key_set?: boolean;
      min_unified_memory_gb?: number; recommended_hardware?: string;
      best_for?: string; is_reasoning?: boolean
    }> = []
    if (hub.mode === 'hub' && hub.hubUrl) {
      try {
        const rows = await hubCatalog(hub.hubUrl, hub.hubToken, 'chat')
        const seen = new Set<string>()
        for (const row of rows) {
          if (!row?.repo || seen.has(row.repo)) continue
          const cloud = !!row.is_cloud
          const runnable = cloud ? row.cloud_credentials_ok !== false : !!row.hub_cached
          if (!runnable) continue
          seen.add(row.repo)
          entries.push({
            id: row.repo,
            label: row.label || row.repo,
            cloud,
            provider_key: row.cloud_provider,
            provider_name: row.cloud_provider_label,
            free: row.requires_billing !== true,
            key_set: row.cloud_credentials_ok !== false,
            min_unified_memory_gb: Number(row.min_unified_memory_gb) || undefined,
            recommended_hardware: row.recommended_hardware,
            best_for: row.best_for,
            is_reasoning: row.is_reasoning === true,
          })
        }
      } catch { /* Hub unavailable: direct pool remains the emergency fallback. */ }
    }
    if (!entries.length && lmBaseRaw) {
      // v1.0.497 — catalog instead of the raw /v1/models dump: Chat Studio now
      // proxies free cloud LLM providers (OpenRouter / NVIDIA / Groq / Gemini /
      // HF Router / …) and its /v1/models lists ~450 upstream models. The
      // catalog keeps all LOCAL models + each provider's CURATED cloud list,
      // split into two picker groups (chatstudio / chatstudio-cloud). Providers
      // without a key configured surface disabled with a "add key in Chat
      // Studio" reason (Image Studio v1.0.477 precedent). Union across ALL
      // configured endpoints so a sleeping endpoints[0] doesn't empty the list.
      const { listCatalogPooled } = await import('../lib/chatstudio-client.js')
      entries = await listCatalogPooled(lmBaseRaw, 2000)
    }
    for (const e of entries) {
        const needsKey = e.cloud && e.key_set === false
        // Tier: local MLX → 'local'; cloud free tier → 'free'; cloud paid → 'paid'.
        const tier: CostTier = !e.cloud ? 'local' : (e.free === false ? 'paid' : 'free')
        const provName = e.provider_name || e.provider_key || 'cloud'
        models.push({
          id: `chatstudio:${e.id}`,
          label: e.cloud
            ? `${e.label} [${provName}]`
            : `${e.label} [Chat Studio · local]`,
          provider: e.cloud ? 'chatstudio-cloud' : 'chatstudio',
          available: !needsKey,
          disabled_reason: needsKey
            ? `Add your ${provName} API key in Chat Studio first${tier === 'free' ? ' (free tier available)' : ''}.`
            : null,
          hint: e.cloud
            ? (tier === 'paid'
                ? `Paid cloud API proxied through Chat Studio (${provName}) — uses your ${provName} credits.`
                : `Free cloud API proxied through Chat Studio (${provName}).`)
            : [e.best_for, e.recommended_hardware, e.is_reasoning
                ? 'Reasoning model: may spend more output tokens before the final answer.' : '']
                .filter(Boolean).join(' '),
          // v1.0.283 — see isVisionCapableCloud comment above; Chat Studio
          // models assumed vision-capable per user preference.
          supports_vision: true,
          cost_tier: tier,
          min_unified_memory_gb: e.min_unified_memory_gb,
          is_reasoning: e.is_reasoning,
        })
    }
  } catch { /* server off / unreachable — surface nothing, don't block */ }

  res.json(models)
})

// Session usage stats
router.get('/usage', (_req, res) => {
  res.json(getSessionUsage())
})

router.get('/usage/pricing', (_req, res) => {
  res.json(getModelPricing())
})

/** Cross-session cost rollup, sourced from the on-disk JSONL history.
 *  Powers the Cost dashboard. Date params are inclusive YYYY-MM-DD. */
router.get('/usage/rollup', async (req, res) => {
  try {
    const { getUsageRollup } = await import('../services/usage-tracker.js')
    const since = typeof req.query.since === 'string' ? req.query.since : undefined
    const until = typeof req.query.until === 'string' ? req.query.until : undefined
    const r = await getUsageRollup({ since, until })
    res.json(r)
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to load usage rollup' })
  }
})

// Dashboard stats
router.get('/projects/:slug/dashboard-stats', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Not found' })

  const fsP = await import('fs/promises')
  const pathMod = await import('path')
  const im = await import('../services/idea-manager.js')
  const { isCloudEvictedPlaceholder } = await import('../lib/http-retry.js')

  const ideas = await im.getIdeas(slug)
  const accepted = ideas.filter(i => i.status === 'accepted')

  // Count completed assets by scanning folders. Counters are mutated from
  // parallel async tasks below — safe in single-threaded JS (each `++` is
  // synchronous; awaits between them yield, but the increment itself can't
  // be interrupted by another task).
  let scriptsGenerated = 0, scenePromptsGenerated = 0, thumbPromptsGenerated = 0
  let imagesGenerated = 0, thumbsGenerated = 0, audioGenerated = 0, descsGenerated = 0
  let totalImageFiles = 0, totalAudioFiles = 0
  const episodesReady = 0  // Tagging removed — ready status computed on frontend
  let icloud_skipped = 0
  let scan_partial = false

  // Hard cap on the whole-tree walk. iCloud-backed projects can hang on
  // OS-level sync requests for tens of seconds per evicted file; without a
  // bound here, the dashboard fetch could block the user's first project
  // entry for minutes. When we hit this, we surface what we've counted so
  // far + a `scan_partial: true` flag so the UI can warn and offer a retry.
  const SCAN_TIMEOUT_MS = 25_000
  const scanDeadline = Date.now() + SCAN_TIMEOUT_MS

  async function scanEpisodes(dir: string): Promise<void> {
    if (Date.now() > scanDeadline) { scan_partial = true; return }
    // Cheap defensive probe for an iCloud placeholder at this directory.
    // Keeps the readdir below from blocking on a sync fetch we can't
    // recover from inside the request lifecycle. The placeholder format
    // (`.{name}.icloud`) is per-file in iCloud's design, but checking is
    // a single ENOENT-fast stat — no harm if it always misses.
    try {
      if (await isCloudEvictedPlaceholder(dir)) { icloud_skipped++; return }
    } catch { /* probe is best-effort */ }
    let entries: import('fs').Dirent[]
    try {
      entries = await fsP.readdir(dir, { withFileTypes: true })
    } catch { return }
    // Process every entry in parallel. Each branch is independent
    // I/O — collapsing the sequential await chain into a Promise.all
    // turns ~800 stat/readdir calls (80 episodes × ~10 subfolders) from
    // serial latency into the slowest-path latency. On local SSD that's
    // 5s → ~0.5s; on iCloud projects with placeholder cache hits it's
    // 30s+ → bound by the slowest single subfolder.
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return
      if (Date.now() > scanDeadline) { scan_partial = true; return }
      const fp = pathMod.join(dir, entry.name)
      if (/^[A-Z]{2,}\d{2,} - /.test(entry.name)) {
        // Episode folder — read the subfolder list, then process each
        // asset subfolder in parallel.
        let subs: string[]
        try { subs = await fsP.readdir(fp) }
        catch { return }
        await Promise.all(subs.map(async (sub) => {
          if (Date.now() > scanDeadline) { scan_partial = true; return }
          const cleanSub = sub.toLowerCase()
          const subPath = pathMod.join(fp, sub)
          try {
            const stat = await fsP.stat(subPath)
            if (!stat.isDirectory()) return
            const files = await fsP.readdir(subPath)
            const hasTextArtifact = (fl: string[]) => fl.some(f => f.endsWith('.md') || f.endsWith('.docx'))
            if ((cleanSub.endsWith('script') || cleanSub.includes('01 script')) && !cleanSub.includes('prompt') && !cleanSub.includes('description')) {
              if (hasTextArtifact(files)) scriptsGenerated++
            }
            if (cleanSub.includes('scene prompt')) {
              if (hasTextArtifact(files)) scenePromptsGenerated++
            }
            if (cleanSub.includes('thumbnail prompt')) {
              if (hasTextArtifact(files)) thumbPromptsGenerated++
            }
            if (cleanSub.includes('scene image') || cleanSub.includes('background image')) {
              const imgs = files.filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
              if (imgs.length) imagesGenerated++
              totalImageFiles += imgs.length
            }
            if ((cleanSub.includes('thumbnail image') || cleanSub.includes('thumbnails')) && !cleanSub.includes('prompt')) {
              const imgs = files.filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
              if (imgs.length) thumbsGenerated++
              totalImageFiles += imgs.length
            }
            if (cleanSub.includes('audio')) {
              const auds = files.filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
              if (auds.length) audioGenerated++
              totalAudioFiles += auds.length
            }
            if (cleanSub.includes('description')) {
              if (files.some(f => f.endsWith('.txt'))) descsGenerated++
            }
          } catch {}
        }))
      } else {
        await scanEpisodes(fp)
      }
    }))
  }

  const scanStart = Date.now()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (outputRoot) await scanEpisodes(outputRoot)
  const scan_duration_ms = Date.now() - scanStart

  // Time saved estimates (minutes)
  const TIME_PER_SCRIPT = 120       // 2 hours to write manually
  const TIME_PER_SCENE_PROMPTS = 30 // 30 min to write scene prompts
  const TIME_PER_THUMB_PROMPTS = 15 // 15 min to write thumbnail prompts
  const TIME_PER_IMAGE = 10         // 10 min per image (finding/creating)
  const TIME_PER_AUDIO_CHAPTER = 15 // 15 min recording + editing
  const TIME_PER_DESC = 20          // 20 min to write YouTube description

  const timeSavedMin =
    scriptsGenerated * TIME_PER_SCRIPT +
    scenePromptsGenerated * TIME_PER_SCENE_PROMPTS +
    thumbPromptsGenerated * TIME_PER_THUMB_PROMPTS +
    totalImageFiles * TIME_PER_IMAGE +
    totalAudioFiles * TIME_PER_AUDIO_CHAPTER +
    descsGenerated * TIME_PER_DESC

  const usage = getSessionUsage()
  const sessionStats = await getSessionStats(slug)

  res.json({
    ideas: { total: ideas.length, accepted: accepted.length, new: ideas.filter(i => i.status === 'new').length },
    episodes: { total: accepted.length, ready: episodesReady },
    assets: {
      scripts: scriptsGenerated,
      scene_prompts: scenePromptsGenerated,
      thumb_prompts: thumbPromptsGenerated,
      images: imagesGenerated,
      thumbnails: thumbsGenerated,
      audio: audioGenerated,
      descriptions: descsGenerated,
      total_image_files: totalImageFiles,
      total_audio_files: totalAudioFiles,
    },
    time_saved: { minutes: timeSavedMin, hours: Math.round(timeSavedMin / 60 * 10) / 10 },
    session: {
      api_cost: usage.total_cost,
      calls: usage.entries,
      current: sessionStats.current,
      previous: sessionStats.previous,
      all_time: sessionStats.all_time,
    },
    // Scan diagnostics: surface to the UI so it can warn about partial
    // results (iCloud syncing, timeout, etc.). The frontend renders a
    // "still downloading" banner when scan_partial is true and lets the
    // user retry once iCloud catches up.
    scan: {
      duration_ms: scan_duration_ms,
      partial: scan_partial,
      icloud_skipped,
    },
  })
})

router.get('/projects/:slug/health', async (req, res) => {
  const config = await pm.getConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  // Fish Audio + DeepSeek keys live in the per-machine app-secrets store (short
  // ids), not the legacy per-project config fields — resolve them there.
  const { getApiKey } = await import('../services/app-secrets-store.js')
  const [fishKey, deepseekKey] = await Promise.all([getApiKey('fishaudio'), getApiKey('deepseek')])

  const [kieCredits, falBalance, elevenLabsBalance, genaiproBalance, fishCredit, deepseekBalance] = await Promise.all([
    getKieCredits(config.kie_api_key),
    getFalBalance(config.fal_api_key),
    getElevenLabsBalance((config as any).elevenlabs_api_key || ''),
    getGenaiproBalance((config as any).genaipro_api_key || ''),
    getFishCredit(fishKey),
    getDeepseekBalance(deepseekKey),
  ])

  res.json({
    status: 'ok',
    credits: {
      kie: kieCredits, fal: falBalance, elevenlabs: elevenLabsBalance, genaipro: genaiproBalance,
      fishaudio: fishCredit, deepseek: deepseekBalance,
    },
    api_keys: {
      kie: !!config.kie_api_key,
      fal: !!config.fal_api_key,
      openai: !!config.openai_api_key,
      elevenlabs: !!(config as any).elevenlabs_api_key,
      genaipro: !!(config as any).genaipro_api_key,
      fishaudio: !!fishKey,
      deepseek: !!deepseekKey,
    },
  })
})

// ── Connectivity precheck ─────────────────────────────────────────────────
//
// Purpose: distinguish "key is wrong" from "can't reach the provider." Without
// this, the API-key Test path (utils.ts::testApiKey) returns the same
// "Invalid key or network error" message for a bad key and for a DNS-broken
// LAN / captive portal / corporate firewall. A user on a broken network burns
// 10 minutes re-pasting correct keys before realising the problem is upstream.
//
// Design:
// - Concurrent GETs to the provider base hosts we actually talk to.
// - 3-second per-host timeout; all probes run in parallel via Promise.allSettled.
// - Any HTTP response — even 401 / 403 / 404 — counts as "reachable." We don't
//   send credentials; we only care about DNS + TCP + TLS. Providers that
//   require auth will 401 and that still proves the host is live.
// - Response shape lets the UI show either a yellow "some unreachable" banner
//   or a red "nothing reachable" one.
//
// Only called on the wizard path and on explicit user action (Settings →
// Diagnose connectivity, or the Test-all button). Not a startup check —
// blocking every launch on network-health would be obnoxious for users who
// are briefly offline.
router.get('/connectivity/precheck', async (_req, res) => {
  const PROVIDERS = [
    { host: 'api.openai.com',    probeUrl: 'https://api.openai.com/v1/models',    label: 'OpenAI' },
    { host: 'api.deepseek.com',  probeUrl: 'https://api.deepseek.com/models',     label: 'DeepSeek' },
    { host: 'openrouter.ai',     probeUrl: 'https://openrouter.ai/api/v1/models', label: 'OpenRouter' },
    { host: 'api.kie.ai',        probeUrl: 'https://api.kie.ai/api/v1/chat/credit', label: 'kie.ai' },
    { host: 'queue.fal.run',     probeUrl: 'https://queue.fal.run/',              label: 'fal.ai' },
    { host: 'api.elevenlabs.io', probeUrl: 'https://api.elevenlabs.io/v1/user/subscription', label: 'ElevenLabs' },
    { host: 'genaipro.io',       probeUrl: 'https://genaipro.io/api/v1/labs/task', label: 'GenAIPro' },
  ] as const
  const started = Date.now()
  const results = await Promise.allSettled(PROVIDERS.map(async (p) => {
    // GET rather than HEAD — a number of these providers return 405 or hang
    // on HEAD requests, which would mislabel reachable hosts as down.
    const r = await fetch(p.probeUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
      // Don't follow redirects — a 301/302 from a reachable host is still
      // proof of reachability and we don't want to spend budget chasing it.
      redirect: 'manual',
    })
    return r.status
  }))
  const reachable: Array<{ host: string; label: string; status: number }> = []
  const unreachable: Array<{ host: string; label: string; reason: string }> = []
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i]
    const r = results[i]
    if (r.status === 'fulfilled') {
      reachable.push({ host: p.host, label: p.label, status: r.value })
    } else {
      const err: any = r.reason
      // Normalize the error to something the UI can show without exposing
      // stack traces or node internals.
      let reason = 'network error'
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') reason = 'timeout'
      else if (typeof err?.cause?.code === 'string') reason = err.cause.code // e.g. ENOTFOUND, ECONNREFUSED
      else if (typeof err?.code === 'string') reason = err.code
      else if (typeof err?.message === 'string') reason = err.message.slice(0, 120)
      unreachable.push({ host: p.host, label: p.label, reason })
    }
  }
  res.json({ reachable, unreachable, elapsed_ms: Date.now() - started })
})

// Wizard-time raw-key test — runs before the project exists, so we can't
// resolve the key from secrets. Body carries the key directly. Same
// `{ valid, reachable, message }` shape as the slug-scoped endpoint so both
// callers share one pill UI.
router.post('/test-key/:provider', async (req, res) => {
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : ''
  if (!apiKey) return res.status(400).json({ detail: 'apiKey is required' })
  const result = await testApiKey(req.params.provider, apiKey)
  res.json(result)
})

router.post('/projects/:slug/test-key/:provider', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const { resolveApiKey } = await import('../services/secrets-accounts.js')
  // Optional query arg — when specified, tests that specific account's key;
  // otherwise falls back to the provider's default account.
  const accountId = typeof req.query.account_id === 'string' ? req.query.account_id : undefined

  let apiKey = ''
  try {
    const resolved = await resolveApiKey(req.params.slug, req.params.provider, accountId)
    apiKey = resolved?.apiKey ?? ''
  } catch (e: any) {
    return res.status(e?.code === 'unknown_provider' ? 400 : 404).json({
      detail: e?.message ?? 'Unable to resolve key',
    })
  }

  const result = await testApiKey(req.params.provider, apiKey)
  res.json(result)
})

// ── Local server pool status (Voice Studio + Image Studio) ─────────────────
// One-shot health probe of every configured local-modal endpoint so the UI can
// show "N of M Macs online" at a glance. Per-machine (no project) — reads the
// app-secrets URL lists. Each probe has its own short timeout and runs in
// parallel; an unreachable Mac just counts as offline (never throws).
router.get('/local-servers/status', async (_req, res) => {
  try {
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { parseEndpoints, healthyEndpoints } = await import('../lib/endpoint-pool.js')
    const { health: voiceHealth } = await import('../lib/voicestudio-client.js')
    const { health: imgHealth } = await import('../lib/imagestudio-client.js')

    const vsUrls = parseEndpoints(await getApiKey('voicestudio').catch(() => ''))
    const isUrls = parseEndpoints(await getApiKey('imagestudio').catch(() => ''))

    const [vs, is] = await Promise.all([
      healthyEndpoints(vsUrls, async (u) => (await voiceHealth(u)).ok),
      healthyEndpoints(isUrls, async (u) => (await imgHealth(u, 4000)).ok),
    ])

    const shape = (urls: string[], healthy: string[]) => ({
      online: healthy.length,
      total: urls.length,
      endpoints: urls.map(u => ({ url: u, online: healthy.includes(u) })),
    })
    res.json({
      voicestudio: shape(vsUrls, vs.healthy),
      imagestudio: shape(isUrls, is.healthy),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to check local servers'))
  }
})
