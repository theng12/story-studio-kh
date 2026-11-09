/**
 * Electron main process.
 * Starts the Express backend server and opens the frontend in a BrowserWindow.
 */

// MUST stay the first import — sets UV_THREADPOOL_SIZE before any module
// touches the filesystem (see boot-env.ts for why).
import './boot-env.js'
import { app as electronApp, BrowserWindow, Menu, Notification, dialog, shell } from 'electron'
import { app as expressApp } from './server/app.js'
import http from 'http'
import path from 'path'
import fs from 'fs'
import v8 from 'v8'
import os from 'os'
import { fileURLToPath } from 'url'
import {
  drainJobPersistenceForShutdown,
  killAllTrackedChildren,
  jobEvents,
  getQueueStats,
  findJobs,
} from './server/services/job-queue.js'
import { reapFfmpegOrphans } from './server/services/orphan-reaper.js'
import { projectsRoot, migrateLegacyProjects } from './server/services/project-manager.js'
import { getRunningFlagPath, patchLastSession } from './server/services/last-session.js'
import { isServerMode, getServerModeConfig } from './server/lib/server-mode.js'
import { DEV_BACKEND_PORT } from './server/lib/dev-backend.js'
import { applyServerTimeouts } from './server/lib/server-timeouts.js'
import { startLogPruning } from './server/services/logger.js'
import { bootstrapServerModeFromEnv } from './server/services/app-settings.js'
import { isAllowedApplicationNavigation, isSafeExternalUrl } from './server/lib/security.js'
import { redactSecrets } from './server/lib/redact-secrets.js'
import { OWNER_WINDOW_HEADER, ownerWindowSecret } from './server/lib/auth-session.js'
import {
  aggregateBatch, isBatchComplete, shouldNotifyForSingleJob,
  formatBatchMessage, formatSingleJobMessage, formatFailureMessage, getBatchId,
  getNotifierSettings, formatQuitWarning, formatApprovalWaitMessage,
  summarizeBatchEpisodes,
} from './server/services/job-notifier.js'
import { isQuittingForUpdate } from './server/services/app-update.js'
import { unlockCredentials } from './server/lib/safe-storage.js'
import type { Job } from './server/models/types.js'
import type { BatchEpisodeOutcome } from './server/services/job-notifier.js'

// ── Single-instance lock ────────────────────────────────────────────────────
// Two copies of the app would both embed an Express server writing to the
// same userData/projects/ directory — our per-path mutex is in-process, so a
// second process would race on jobs.json and config.json. Grab the lock
// before any other init; if we don't get it, wake the existing window and
// exit. Must run BEFORE any app.whenReady() or server bootstrap.
const gotLock = electronApp.requestSingleInstanceLock()
if (!gotLock) {
  // Another instance is already running — let it handle the user.
  electronApp.quit()
  process.exit(0)
}

// ── Main-process heap headroom (v1.0.510) ───────────────────────────────────
// The Express backend runs IN this main process. A burst of base64 image
// uploads (scene-review upload-image buffers raw body + parsed string +
// decoded Buffer per request) can spike the main-process JS heap. On
// 2026-07-04 it reached V8's default old-space limit and aborted with
// EXC_BREAKPOINT — a heap OOM aborts V8 directly, BYPASSING our
// uncaughtException handler, so nothing was logged. Give the isolate more
// room (default 4 GB; override with SS_MAX_OLD_SPACE_MB). Must run before the
// app is ready. The memory watchdog below records aggregate counters only;
// heap snapshots are intentionally disabled because they can contain secrets
// and customer prompts or assets.
{
  const mb = Math.max(1024, Number(process.env.SS_MAX_OLD_SPACE_MB) || 4096)
  electronApp.commandLine.appendSwitch('js-flags', `--max-old-space-size=${mb}`)
}
electronApp.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !electronApp.isPackaged

let mainWindow: BrowserWindow | null = null
let server: http.Server | null = null

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Server mode (headless on the LAN/tailnet): bind a fixed port on a
    // network-accessible interface so the URL is stable for bookmarking.
    // Default mode (Electron desktop): random port on loopback as before —
    // each launch picks a free port to avoid collisions when the user has
    // multiple installs (dev + packaged) running simultaneously.
    const cfg = getServerModeConfig()
    let port: number
    let bind: string
    if (cfg) {
      port = cfg.port
      bind = cfg.bind
    } else {
      // Dev binds a known port so Nuxt's `/api` devProxy can find it —
      // both sides read DEV_BACKEND_PORT, see lib/dev-backend.ts. Packaged
      // stays on 0 (random free port).
      port = isDev ? DEV_BACKEND_PORT : 0
      bind = '127.0.0.1'
    }
    server = http.createServer(expressApp)
    // Ceilings on genuinely stuck sockets. This server shipped with none at
    // all, so a connection waiting on work that never finished stayed open for
    // the life of the app. Every value is owner-editable and every default
    // clears the app's real long-running requests — see lib/server-timeouts.ts.
    void applyServerTimeouts(server)
    // Old log files are swept on a timer here, not inside the request logger
    // where the sweep used to live.
    startLogPruning()
    server.listen(port, bind, () => {
      const address = server!.address()
      const actualPort = typeof address === 'object' ? address!.port : port
      console.log(`Backend running on http://${bind}:${actualPort}${cfg ? ' [server mode]' : ''}`)
      resolve(actualPort)
    })
    server.on('error', reject)
  })
}

async function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Story Studio KH',
    backgroundColor: '#0f1117',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: isDev,
      // Marker preload — sets `window.electron` so the renderer can refuse to
      // run when a user accidentally opens http://localhost:3001/ in Chrome.
      // See electron/preload.cjs and frontend/app.vue for the other half.
      preload: path.join(__dirname, '..', 'preload.cjs'),
    },
  })
  // The owner-only Trash actions trust this window by a per-boot secret it sends to
  // loopback only (auth-session.ts `isOwnerRequest`); the page itself never sees it.
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url)
    const own = ['127.0.0.1', 'localhost'].includes(url.hostname) && (url.pathname.startsWith('/api/trash/') || url.pathname.startsWith('/api/app-settings/server-mode/'))
    callback({ requestHeaders: own ? { ...details.requestHeaders, [OWNER_WINDOW_HEADER]: ownerWindowSecret() } : details.requestHeaders })
  })

  if (isDev) {
    // In dev, load Nuxt dev server
    await mainWindow.loadURL('http://localhost:3000')
    // Open DevTools in dev mode
    // mainWindow.webContents.openDevTools()
  } else {
    // In production, serve static files from the Express server.
    const frontendPath = path.join(__dirname, '..', '..', 'frontend', '.output', 'public')
    console.log(`[production] frontendPath = ${frontendPath}`)

    // Verify the path exists
    const fs = await import('fs')
    const indexExists = fs.existsSync(path.join(frontendPath, 'index.html'))
    console.log(`[production] index.html exists: ${indexExists}`)

    const express = await import('express')

    // Security headers are installed on the Express app before every route in
    // server/app.ts, so they cover API responses and this static renderer.

    // ── Static SPA serving ────────────────────────────────────────────
    // v1.0.111 — cached read of index.html (no transform). The previous
    // version (v1.0.110) used `res.sendFile`, which under the hood streams
    // via `fs.createReadStream` — historically flaky inside Electron's
    // ASAR archive (packaged production builds shipped a blank window).
    // `fs.readFileSync` is the known-good ASAR access pattern; we read
    // once at boot and reuse the buffer.
    //
    // The BrowserBlock-era meta-tag injection is gone (the frontend now
    // derives server-mode state from window.location.hostname — see
    // useServerMode.ts) so there's no transform happening; just a plain
    // cached read.
    const indexPath = path.join(frontendPath, 'index.html')
    let cachedIndexHtml: string | null = null
    try {
      cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8')
      console.log(`[production] preloaded index.html (${cachedIndexHtml.length} bytes)`)
    } catch (e) {
      console.warn(`[production] could not preload index.html: ${(e as Error).message}`)
    }

    function sendIndex(_req: any, res: any, fallback: () => void) {
      if (cachedIndexHtml === null) return fallback()
      res.type('html').send(cachedIndexHtml)
    }

    expressApp.get(['/', '/index.html'], (req, res) => {
      sendIndex(req, res, () => res.status(404).end())
    })

    // `redirect: false` — without it, express.static issues HTTP 301 to add a
    // trailing slash whenever a request path matches a directory in the build
    // output (e.g. `GET /login` → `GET /login/`, because Nuxt emits
    // `login/index.html`). The trailing slash then broke the "already on
    // /login" guard in useApi.ts and caused a redirect loop in remote-browser
    // sessions (v1.0.112 incident). useApi now normalises trailing slashes
    // defensively, but disabling the redirect altogether keeps URLs canonical
    // and avoids the SPA loading from `/foo/` for routes whose code expects
    // `/foo` — one source of truth.
    expressApp.use(express.default.static(frontendPath, { dotfiles: 'allow', redirect: false }))

    // SPA fallback — Express 5 / path-to-regexp v8 removed bare '*' wildcards
    expressApp.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      if (req.path.startsWith('/api/')) return next()
      sendIndex(req, res, next)
    })

    // Global error handler.
    //
    // v1.0.113 — surface the actual error in the renderer in production, not
    // the bare-text "Internal server error" mask. The prior version sent a
    // string body that the browser rendered as text, leaving the user staring
    // at a window with three words and no path forward. Now we send a small
    // HTML page with the method/path/message/stack inline, plus a reload
    // button, so the user (a) sees what broke, (b) can copy-paste it to me
    // for debugging, and (c) can retry without quitting the app. We also
    // mirror to console.error AND the daily request log so the symptom is
    // captured wherever the user looks.
    expressApp.use((err: any, req: any, res: any, _next: any) => {
      const msg = redactSecrets(String(err?.message || err || 'unknown'))
      const incident = `ss-${Date.now().toString(36)}`
      console.error('[express-error]', incident, req.method, req.path, '→', msg)
      if (res.headersSent) return
      const safeMsg = msg.replace(/[<>&]/g, (c) =>
        c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;')
      res.status(500).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Internal error · Story Studio KH</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif;
         background: #0f1117; color: #e8e8ea; margin: 0; padding: 40px;
         min-height: 100vh; box-sizing: border-box; }
  h1 { color: #f87171; font-size: 18px; margin: 0 0 12px; }
  .meta { color: #888; font-size: 12px; margin-bottom: 16px; }
  pre { background: rgba(255,255,255,0.06); padding: 12px 14px;
        border-radius: 6px; overflow: auto; font-size: 12px;
        white-space: pre-wrap; word-break: break-word; }
  a { display: inline-block; margin-top: 18px; padding: 8px 16px;
      font-size: 13px; text-decoration: none; background: #6ea8fe;
      color: #0f1117; border-radius: 6px; font-weight: 600; }
</style></head>
<body>
  <h1>Internal server error</h1>
  <div class="meta">${req.method} ${req.path}</div>
  <pre>${safeMsg}</pre>
  <div class="meta">Reference: ${incident}</div>
  <a href="/">Reload</a>
</body></html>`)
    })

    await mainWindow.loadURL(`http://127.0.0.1:${port}`)
  }

  // ── Navigation lockdown ──────────────────────────────────────────────────
  // Pop-ups (target=_blank etc.) go to the OS browser, not a new Electron
  // window. Navigating the main window itself is only allowed to our own
  // origins — anything else (a malicious link in provider output, a user
  // clicking an untrusted URL) is redirected to the OS browser so the
  // renderer can't be hijacked into becoming a browser for a foreign site.
  const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ])
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const guardNavigation = (event: Electron.Event, targetUrl: string) => {
    if (isAllowedApplicationNavigation(targetUrl, allowedOrigins)) return
    event.preventDefault()
    if (isSafeExternalUrl(targetUrl)) void shell.openExternal(targetUrl)
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  // A page with unsaved edits asks to confirm unload (beforeunload). Without this handler
  // Electron cancels a reload or window close silently, which looks like a frozen app.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    // Marker so a SIGTERM-timeout log can show an unsaved-edits modal was open; no data.
    console.log('[shutdown] beforeunload prompt opening')
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Stay', 'Discard and leave'],
      defaultId: 0,
      cancelId: 0,
      message: 'You have unsaved edits on this page.',
      detail: 'Leaving now discards them.',
    })
    if (choice === 1) event.preventDefault()
  })

  // Deny every permission request by default (camera, mic, geolocation,
  // notifications, etc.) — this is a content-creation app that doesn't need
  // them. Clipboard read/write IS legitimate (Ideas "Paste from LLM" copies
  // the prompt and reads the pasted JSON), so allowlist those two.
  const ALLOWED_PERMS = new Set(['clipboard-read', 'clipboard-sanitized-write'])
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(ALLOWED_PERMS.has(perm as string))
  })
  // Electron also consults a synchronous "check" path for some APIs
  // (navigator.clipboard among them). Without this second hook, writeText()
  // silently rejects on DMG/packaged builds even though the async handler
  // above would permit it.
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, perm) => {
    return ALLOWED_PERMS.has(perm as string)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function buildMenu() {
  const logsDir = path.join(electronApp.getPath('userData'), 'logs')
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(process.platform === 'darwin' ? [{
          label: 'Unlock credentials…',
          click: () => {
            try {
              unlockCredentials()
              void dialog.showMessageBox({ type: 'info', message: 'Keychain access is available.', detail: 'You can retry the action that needed your credentials.' })
            } catch (error) {
              void dialog.showMessageBox({ type: 'error', message: 'Credentials are still unavailable.', detail: `${String((error as Error).message)} Choose Always Allow in the Keychain dialog when you are ready. Nothing was replaced.` })
            }
          },
        }] : []),
        {
          label: 'Show Logs',
          click: () => {
            try { fs.mkdirSync(logsDir, { recursive: true }) } catch {}
            void shell.openPath(logsDir)
          },
        },
        {
          label: 'Show User Data',
          click: () => { void shell.openPath(electronApp.getPath('userData')) },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── OS notifications on job / batch completion ─────────────────────────────
// Subscribes to the queue's `jobEvents.update` stream. For every job that
// hits a terminal state we decide — via the pure helpers in job-notifier.ts —
// whether to pop a system notification:
//   • pipeline_batch_id jobs: aggregate across the whole batch; fire once
//     when the last member settles.
//   • non-batch jobs: fire when wall-clock elapsed ≥ min_duration_ms.
// Dedup guards stop us firing twice per batch / job even if a later event
// (e.g. recordAccountUsed on a finished job) re-emits `update`.
const notifiedBatches = new Set<string>()
const notifiedJobs = new Set<string>()

function focusMainWindowToJobs(slug: string): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  // Navigate in-place via the Nuxt router. Full-page-reload loses no
  // persisted state (projects, preferences live on disk) and is simpler
  // than adding a preload script for IPC-based route pushes.
  const target = `/projects/${encodeURIComponent(slug)}/jobs`
  mainWindow.webContents
    .executeJavaScript(
      `try { window.location.assign(${JSON.stringify(target)}) } catch(e) {}`,
      true,
    )
    .catch(() => { /* renderer unavailable — window was closed */ })
}

function popNotification(
  payload: { title: string; body: string },
  slug: string,
): void {
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({
      title: payload.title,
      body: payload.body,
      silent: false,
    })
    n.on('click', () => focusMainWindowToJobs(slug))
    n.show()
  } catch (e) {
    // Notification construction can throw on sandboxed builds with missing
    // entitlements. Log but never let it escalate into an unhandled
    // rejection that kills the main process.
    logCrash('notification', e)
  }
}

/**
 * Dispatch a single notification to every enabled channel. Desktop
 * (Electron Notification) is governed by `settings.enabled`; Telegram
 * by `settings.telegram?.enabled` plus a non-empty bot_token + chat_id.
 * Both run independently — turn one off, the other still fires.
 */
async function dispatchNotification(
  payload: { title: string; body: string },
  slug: string,
  settings: import('./server/services/job-notifier.js').NotifierSettings,
): Promise<void> {
  if (settings.enabled) popNotification(payload, slug)

  const tg = settings.telegram
  if (tg?.enabled && tg.bot_token && tg.chat_id) {
    try {
      const { sendTelegramMessage, formatTelegramText } = await import('./server/services/telegram-notifier.js')
      const text = formatTelegramText(payload)
      const r = await sendTelegramMessage(tg.bot_token, tg.chat_id, text, { parseMode: 'HTML' })
      if (!r.ok) logCrash('telegram-notifier', new Error(`Telegram send failed: ${r.error || `HTTP ${r.status}`}`))
    } catch (e) {
      logCrash('telegram-notifier', e)
    }
  }
}

/**
 * The episode's authoritative title, from the same idea store record that
 * named its folder (resolveEpisodeTitleByCode) — '' when the store has no
 * record for the code. Never guessed from the job: an unknown title leaves
 * the stable episode code in the message standing alone (owner request
 * 2026-10-18 — name the episode the ping is about, not just its code).
 */
async function episodeTitleFor(job: Pick<Job, 'project_slug' | 'episode_id'>): Promise<string> {
  const code = (job.episode_id || '').trim()
  if (!code) return ''
  try {
    const { resolveEpisodeTitleByCode } = await import('./server/services/utils.js')
    return await resolveEpisodeTitleByCode(job.project_slug, code)
  } catch { return '' }
}

/** Per-episode outcomes for a finished batch; one idea-store read for the
 *  whole batch (the facts cache is created per call). */
async function batchEpisodeOutcomes(slug: string, batchJobs: Job[]): Promise<BatchEpisodeOutcome[]> {
  const codes = [...new Set(batchJobs.map(j => (j.episode_id || '').trim()).filter(Boolean))]
  const titles = new Map<string, string>()
  try {
    const { createProjectFactsCache, resolveEpisodeTitleByCode } = await import('./server/services/utils.js')
    const cache = createProjectFactsCache(slug)
    for (const code of codes) titles.set(code, await resolveEpisodeTitleByCode(slug, code, cache))
  } catch { /* codes survive; titles stay '' */ }
  return summarizeBatchEpisodes(batchJobs, titles)
}

function installJobNotifier(): void {
  jobEvents.on('update', (job: Job) => {
    // Only act on terminal transitions. `update` also fires for queued→
    // running, live-output ticks, and account-attribution writes.
    if (job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled') return

    ;(async () => {
      const settings = await getNotifierSettings().catch(() => null)
      if (!settings) return
      // Each channel has its own enabled flag now (v1.0.60+). Bail
      // only when ALL channels are off — otherwise we'd silence the
      // Telegram side just because the desktop side was muted.
      const anyChannelOn = settings.enabled
        || !!(settings.telegram?.enabled && settings.telegram.bot_token && settings.telegram.chat_id)
      if (!anyChannelOn) return

      // Resolve a friendly project label so notifications carry the channel
      // name instead of just "Pipeline finished".
      // Falls back to slug when the project meta lookup fails (e.g.
      // project deleted between job submission and completion ping).
      let projectLabel: string | undefined
      try {
        const { getProject } = await import('./server/services/project-manager.js')
        const meta = await getProject(job.project_slug)
        projectLabel = meta?.name || job.project_slug
      } catch { projectLabel = job.project_slug }

      // v1.0.367 — per-event toggles. Channels (above) decide WHERE; these
      // decide WHICH events fire. getNotifierSettings always populates events.
      const events = settings.events || { pipeline_finished: true, failures: true, long_job: true }
      const batchId = getBatchId(job)

      // 1. Immediate failure ping — any job (incl. batch members), no duration
      //    gate. Deduped via notifiedJobs so it fires at most once per job.
      if (events.failures && job.status === 'error' && !notifiedJobs.has(job.job_id)) {
        notifiedJobs.add(job.job_id)
        await dispatchNotification(formatFailureMessage(job, projectLabel, await episodeTitleFor(job)), job.project_slug, settings)
      }

      // 1b. Scene Review waiting on the owner (it needs him, like a failure does).
      // The title is resolved only when the ping will actually fire; the gate
      // above stays a pure check.
      let approvalWait = formatApprovalWaitMessage(job, projectLabel)
      if (events.failures && approvalWait && !notifiedJobs.has(`approval:${job.job_id}`)) {
        notifiedJobs.add(`approval:${job.job_id}`)
        approvalWait = formatApprovalWaitMessage(job, projectLabel, await episodeTitleFor(job)) ?? approvalWait
        await dispatchNotification(approvalWait, job.project_slug, settings)
      }

      // 2. Batch summary — once per batch, when every job in it is terminal.
      if (batchId) {
        if (events.pipeline_finished && !notifiedBatches.has(batchId)) {
          const allJobs = await findJobs(job.project_slug, other => getBatchId(other as Job) === batchId).catch(() => [] as Job[])
          const stats = aggregateBatch(allJobs, batchId)
          if (isBatchComplete(stats)) {
            notifiedBatches.add(batchId)
            // Name the episodes the run touched: a batch's jobs are chained
            // steps, so only the grouped per-episode view says which episode
            // the summary is about (owner request 2026-10-18).
            const episodes = await batchEpisodeOutcomes(job.project_slug, allJobs).catch(() => [] as BatchEpisodeOutcome[])
            await dispatchNotification(formatBatchMessage(stats, projectLabel, episodes), job.project_slug, settings)
          }
        }
        return
      }

      // 3. Long single (non-batch) job. Errors are handled by the failure
      //    ping above, so this covers done/cancelled that ran ≥ the threshold.
      if (notifiedJobs.has(job.job_id)) return
      const wantsLongJobPing = events.long_job
        && (job.status === 'done' || job.status === 'cancelled')
        && !!(job.started_at && job.finished_at)
        && (Date.parse(job.finished_at) - Date.parse(job.started_at)) >= settings.min_duration_ms
      if (wantsLongJobPing) {
        notifiedJobs.add(job.job_id)
        await dispatchNotification(formatSingleJobMessage(job, projectLabel, await episodeTitleFor(job)), job.project_slug, settings)
      }
    })().catch((e) => logCrash('job-notifier', e))
  })
}

// ── Global crash handlers ──────────────────────────────────────────────────
// Without these, an async error that escapes a route handler or provider
// client terminates the whole Electron app with no log and no dialog —
// the user sees the window vanish. Capture, log, and surface to the user
// so crashes are debuggable instead of ghost-disappearances.
//
// v1.0.71+: every step here is wrapped in a try/catch that swallows
// errors. The crash handler itself MUST NOT throw — if it does, the
// uncaughtException listener re-fires for the new error and we end up
// in an infinite crash loop spamming the dialog (literal user report:
// "write EPIPE" repeating 3+ times in 12 seconds because console.error
// failed to write to stdout, which became a new uncaughtException).
function logCrash(source: string, err: unknown) {
  let message = ''
  try {
    message = redactSecrets(err instanceof Error ? (err.stack || err.message) : String(err))
  } catch { /* coercion failed, give up on a useful message */ }
  // console.error writes to stdout/stderr. If the launching shell has
  // closed those pipes (Electron child detached, terminal closed, etc.)
  // the write throws EPIPE — and EPIPE thrown FROM the crash handler
  // would re-fire `uncaughtException` and loop. Swallow it.
  try { console.error(`[main:${source}]`, message) } catch { /* pipe closed */ }
  try {
    const logsDir = path.join(electronApp.getPath('userData'), 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      source: `main-process:${source}`,
      message,
    }) + '\n'
    fs.appendFileSync(path.join(logsDir, `main-${new Date().toISOString().slice(0, 10)}.log`), line)
  } catch { /* best effort — never crash the crash handler */ }
}

/**
 * v1.0.510 — main-process memory watchdog. Diagnostic + early-warning for the
 * heap-OOM class of crash (which aborts V8 before any JS handler runs, so it's
 * otherwise invisible). Logs aggregate heap/RSS counters every 60s. Heap
 * snapshots are intentionally forbidden: they can contain API keys, customer
 * prompts, and asset buffers and therefore are not safe support artifacts.
 */
function startMemoryWatchdog(): void {
  const logsDir = path.join(electronApp.getPath('userData'), 'logs')
  const tick = () => {
    try {
      const mem = process.memoryUsage()
      const limit = v8.getHeapStatistics().heap_size_limit || 0
      const pct = limit ? mem.heapUsed / limit : 0
      const mb = (n: number) => Math.round(n / 1048576)
      // Lightweight heartbeat — grep `mem-watch` in main-*.log to see the climb.
      try {
        fs.mkdirSync(logsDir, { recursive: true })
        fs.appendFileSync(
          path.join(logsDir, `main-${new Date().toISOString().slice(0, 10)}.log`),
          JSON.stringify({
            ts: new Date().toISOString(), level: 'info', source: 'main-process:mem-watch',
            heapUsedMb: mb(mem.heapUsed), heapLimitMb: mb(limit), rssMb: mb(mem.rss),
            externalMb: mb(mem.external), pct: Math.round(pct * 100),
          }) + '\n',
        )
      } catch { /* best effort */ }
    } catch { /* never let the watchdog crash the app */ }
  }
  const timer = setInterval(tick, 60_000)
  timer.unref?.()  // don't keep the event loop alive on shutdown
  tick()           // one immediate reading at boot
}

/**
 * Some errors are routine I/O hiccups, not bugs:
 *   • EPIPE on stdout/stderr — usually means a downstream pipe (terminal,
 *     parent shell, log forwarder) closed its read end. Benign.
 *   • ECONNRESET on a long-lived stream — peer hung up.
 *   • ECANCELED — explicit AbortController cancel.
 * Showing a modal dialog for these would train users to dismiss the
 * dialog without reading it. Log silently and move on.
 */
function isBenignIoError(err: any): boolean {
  if (!err) return false
  const code = err.code || err?.cause?.code
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ECANCELED'
}

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err)
  if (isBenignIoError(err)) return  // log only, don't dialog
  if (electronApp.isReady()) {
    try {
      dialog.showErrorBox(
        'Story Studio encountered an error',
        'An unexpected error occurred. Check Help → Show Logs for details.\n\n' +
          String((err as any)?.message || err),
      )
    } catch { /* dialog itself failed; we already logged */ }
  }
  // Don't exit — one route handler's bug shouldn't kill the user's whole session.
})

process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason)
  // Rejections are almost always recoverable (one request failed); never exit.
})

// ── Unclean-shutdown detection ─────────────────────────────────────────────
// We drop a `running.flag` file the moment the main process boots, then erase
// it from the normal `before-quit` handler. If the flag is still on disk at
// the next boot, the previous run died without firing before-quit — i.e.
// kill -9, Activity Monitor → Force Quit, OOM, or a hard renderer crash.
// Surface it to the operator so they can check for jobs that were mid-render
// and may have left half-written output behind. Synchronous fs deliberately:
// arming the flag must complete before the user sees a window.
function detectAndArmRunningFlag(): boolean {
  const flagPath = getRunningFlagPath()
  let wasUnclean = false
  try {
    if (fs.existsSync(flagPath)) wasUnclean = true
  } catch { /* best effort */ }
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true })
    fs.writeFileSync(flagPath, String(process.pid))
  } catch (e) {
    // If the flag can't be written, the next launch can't detect a crash —
    // log but don't block startup. The user still gets the app.
    logCrash('running-flag-write', e)
  }
  return wasUnclean
}

function clearRunningFlag(): void {
  try {
    const flagPath = getRunningFlagPath()
    if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath)
  } catch (e) {
    // Swallow — clearing during shutdown is best-effort. Worst case: the next
    // launch fires a false unclean-shutdown banner, which is dismissible.
    logCrash('running-flag-clear', e)
  }
}

void electronApp.whenReady().then(async () => {
  try {
    buildMenu()
    // One-time migration from legacy dev project locations. This used to run
    // as a side effect of importing project-manager.ts, which meant every
    // test process — and any tool that transitively pulled in a service —
    // ran a directory-copying migration against the developer's real projects
    // folder. It now has exactly one call site per real boot: here for
    // Electron, and the standalone-listen branch of server/app.ts for dev via
    // tsx. No-op once the `.legacy-migration-done` marker exists.
    try {
      migrateLegacyProjects()
    } catch (e) {
      logCrash('legacy-projects-migration', e)
    }
    // Arm the flag and notice if the previous run left one behind. Done
    // before the server / window come up so the renderer's first
    // GET /api/last-session already sees the unclean_shutdown bit.
    const wasUnclean = detectAndArmRunningFlag()
    if (wasUnclean) {
      try {
        await patchLastSession({ unclean_shutdown: true, unclean_shutdown_dismissed: false })
      } catch (e) {
        logCrash('last-session-mark-unclean', e)
      }
    }
    // Server-mode bootstrap from env vars: if STORY_STUDIO_INITIAL_USERNAME +
    // STORY_STUDIO_INITIAL_PASSWORD are set and no credentials exist yet,
    // persist them. One-shot; on subsequent boots the existing credentials
    // win and the env vars are silently ignored. Lets a launchd-managed
    // first install land pre-configured without ever needing the GUI.
    if (isServerMode()) {
      try {
        const r = await bootstrapServerModeFromEnv()
        if (r.bootstrapped) console.log('[server-mode] bootstrapped credentials from STORY_STUDIO_INITIAL_* env vars')
        else if (r.reason && r.reason !== 'env vars not set' && r.reason !== 'credentials already present') {
          console.warn(`[server-mode] bootstrap skipped: ${r.reason}`)
        }
      } catch (e) {
        logCrash('server-mode-bootstrap', e)
      }
    }
    const port = await startServer()
    // ── Boot-time orphan reap (defence-in-depth) ─────────────────────────
    // If the previous run was force-quit, FFmpeg children are still alive
    // and writing to project output dirs. Kill them BEFORE the window
    // opens so the user doesn't see a "failed" job whose file is still
    // growing. macOS-only; no-ops on other platforms.
    try {
      // v1.0.515 — also reap preview-cache renders (userData) and scene-prep
      // chunk encoders (os tmpdir): their argv never mentions PROJECTS_ROOT,
      // so crashes used to leave them running forever as zombies.
      const result = await reapFfmpegOrphans([
        projectsRoot(),
        path.join(electronApp.getPath('userData'), 'preview-cache'),
        path.join(os.tmpdir(), 'story-studio-kh'),
      ])
      if (result.scanned && result.reaped.length > 0) {
        for (const o of result.reaped) {
          console.log(`[orphan-reap] Killed leaked ffmpeg pid=${o.pid} cmd=${o.command}`)
        }
        console.log(`[orphan-reap] Stopped ${result.reaped.length} orphan ffmpeg process(es) from a previous session.`)
      } else if (!result.scanned && result.reason) {
        console.log(`[orphan-reap] ${result.reason}`)
      }
    } catch (e) {
      logCrash('orphan-reap', e)
    }
    await createWindow(port)
    if (isShuttingDown) return
    // ── Notifications ─────────────────────────────────────────────────────
    // Subscribe to the queue's event bus so long-running single jobs and
    // completed batches pop an OS notification. Runs after createWindow so
    // the click handler has a window to focus. See job-notifier.ts.
    installJobNotifier()

    // ── Memory watchdog (v1.0.510) ───────────────────────────────────────
    // A heap OOM aborts V8 directly (EXC_BREAKPOINT), bypassing our
    // uncaughtException handler — so the 2026-07-04 crash left no JS log. This
    // Logs aggregate heap/RSS every 60s so a climb is visible without writing
    // privacy-sensitive heap snapshots.
    startMemoryWatchdog()

    // YouTube sign-in about to lapse (7-day Testing-status apps): same channels as job notices.
    try {
      const { setYouTubeNoticeDispatcher } = await import('./server/services/youtube-status-sync.js')
      const { getNotifierSettings } = await import('./server/services/job-notifier.js')
      setYouTubeNoticeDispatcher(async notice => dispatchNotification(notice, 'youtube', await getNotifierSettings()))
    } catch (e) {
      logCrash('youtube-notice', e)
    }

    // Daily digest scheduler (v1.0.62+). Ticks every minute; fires
    // the digest at the user's configured local time once per day.
    // Wired with a dispatcher that fans out to whichever channels
    // (desktop / telegram) the user enabled for the digest specifically.
    try {
      const { startDigestScheduler } = await import('./server/services/digest-scheduler.js')
      startDigestScheduler(async (payload, opts) => {
        if (opts.desktop) popNotification(payload, 'digest')
        if (opts.telegram) {
          const settings = await (await import('./server/services/job-notifier.js')).getNotifierSettings()
          const tg = settings.telegram
          if (tg?.bot_token && tg.chat_id) {
            const { sendTelegramMessage, formatTelegramText } = await import('./server/services/telegram-notifier.js')
            const r = await sendTelegramMessage(tg.bot_token, tg.chat_id, formatTelegramText(payload), { parseMode: 'HTML' })
            if (!r.ok) logCrash('digest-telegram', new Error(`Telegram digest send failed: ${r.error || `HTTP ${r.status}`}`))
          }
        }
      })
    } catch (e) {
      logCrash('digest-scheduler', e)
    }

    try {
      const { startWeeklyResultsScheduler } = await import('./server/services/youtube-weekly-results.js')
      startWeeklyResultsScheduler()
    } catch (e) {
      logCrash('youtube-weekly-results', e)
    }

    // 1.4.285 — idea supply running low. Opt-in per channel (idea_upgrades.supply_alerts); sends
    // only when a channel's status gets worse, at most once per channel per day. Hourly is plenty.
    try {
      const { runIdeaSupplyAlerts } = await import('./server/services/idea-supply.js')
      const { runAutoGrow } = await import('./server/services/topic-pack-grow.js')
      const { getNotifierSettings } = await import('./server/services/job-notifier.js')
      const send = async (payload: { title: string; body: string }, slug: string) => dispatchNotification(payload, slug, await getNotifierSettings())
      // 1.4.293 — then grow opted-in Topic Pack channels that run low (idea_upgrades.grow_packs), once a day at most.
      const check = () => void runIdeaSupplyAlerts(send)
        .catch(e => logCrash('idea-supply-alerts', e))
        .then(() => runAutoGrow(send))
        .catch(e => logCrash('idea-grow-subjects', e))
      setTimeout(check, 5 * 60_000).unref?.()
      setInterval(check, 60 * 60_000).unref?.()
    } catch (e) {
      logCrash('idea-supply-alerts', e)
    }

    // 1.4.287 — automatic backup: daily, and when the backup drive comes back, only while idle.
    try {
      const { startAutoBackupScheduler } = await import('./server/services/backup-runner.js')
      startAutoBackupScheduler(e => logCrash('auto-backup', e))
    } catch (e) {
      logCrash('auto-backup', e)
    }

    // 1.4.321 — automatic retention (owner, 2026-10-18): Story's Trash hands items to the
    // Mac's Trash after `trash_handoff_days`, and the verified all-channel cleanup runs
    // itself. Both daily, on this app's existing boot-timer pattern; both settings live on
    // Story → Trash. Skipped with a clear status where the Mac's Trash is unreachable.
    try {
      const { startRetentionScheduler } = await import('./server/services/retention.js')
      startRetentionScheduler(e => logCrash('retention', e))
    } catch (e) {
      logCrash('retention', e)
    }

    // 1.4.322 — the TTS and chat catalogues are kept warm off the job path, so a paid job never
    // waits on a catalogue refresh. On the overloaded production mini those refreshes timed out at
    // the old 8-second ceiling and the stale-catalogue guard then refused work.
    try {
      const { startGenStudioCatalogRefreshScheduler } = await import('./server/services/genstudio-catalog-refresh.js')
      startGenStudioCatalogRefreshScheduler(e => logCrash('catalogue-refresh', e))
    } catch (e) {
      logCrash('catalogue-refresh', e)
    }

    // Remote updates from the Gateway (services/app-update.ts). Packaged builds only: a dev run
    // has no bundle to replace. Not awaited: settling a previous install waits for /api/health.
    if (electronApp.isPackaged && process.platform === 'darwin') {
      const { startStoryUpdater } = await import('./server/routes/app-update.js')
      void startStoryUpdater({
        currentVersion: electronApp.getVersion(),
        executable: process.execPath,
        port,
        quit: () => electronApp.quit(),
      }).catch(e => logCrash('app-updater', e))
    }
  } catch (e) {
    // Quitting cancels an in-flight window load; a modal here would block that quit.
    if (isShuttingDown) return
    logCrash('startup', e)
    dialog.showErrorBox(
      'Story Studio failed to start',
      redactSecrets(String((e as Error)?.message || e)),
    )
    electronApp.quit()
  }
})

electronApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    electronApp.quit()
  }
})

electronApp.on('activate', () => {
  if (!mainWindow) {
    const port = server ? (server.address() as any)?.port || DEV_BACKEND_PORT : DEV_BACKEND_PORT
    void createWindow(port).catch(e => logCrash('activate-window', e))
  }
})

// ── Clean shutdown ────────────────────────────────────────────────────────
// SIGTERM every tracked child (FFmpeg assemblies, audio merges, etc.) so
// they don't get reparented to launchd and keep writing to project files
// after we go away. Brief drain so they release file handles cleanly,
// then close the HTTP server. SIGKILL fallback inside killAllTrackedChildren
// reaps anything that ignored SIGTERM.
//
// Returns synchronously the second time through — Electron re-fires
// before-quit during the delayed quit() call below, and we don't want to
// double-run the cleanup or block forever.
let isShuttingDown = false
const SHUTDOWN_DRAIN_MS = 800
electronApp.on('before-quit', (event) => {
  if (isShuttingDown) return
  // Stage markers for the smoke's SIGTERM-timeout report; no behavior change.
  console.log('[shutdown] before-quit event')
  // Say what happens to running jobs before they stop. Headless server mode has no window to ask in.
  // An update quit never asks: a drain that hit its 30-minute ceiling would stall at the dialog.
  const warning = isQuittingForUpdate() ? null : formatQuitWarning(getQueueStats().running)
  if (warning && mainWindow && !mainWindow.isDestroyed()) {
    console.log('[shutdown] quit-warning dialog opening')
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 0, cancelId: 1,
      message: warning.title, detail: warning.body,
    })
    if (choice === 1) {
      event.preventDefault()
      return
    }
  }
  isShuttingDown = true
  event.preventDefault()
  console.log('[shutdown] server close requested')
  try { if (server) server.close() } catch (e) { logCrash('shutdown-server-close', e) }
  try {
    const pids = killAllTrackedChildren()
    if (pids.length > 0) {
      console.log(`[shutdown] SIGTERM sent to ${pids.length} tracked child(ren): ${pids.join(', ')}`)
    }
  } catch (e) {
    logCrash('shutdown-killchildren', e)
  }
  void drainJobPersistenceForShutdown(SHUTDOWN_DRAIN_MS).then(drained => {
    console.log(`[shutdown] job persistence drained: ${drained}`)
    if (drained) clearRunningFlag()
    else console.error('[shutdown] Job persistence did not drain before the shutdown deadline; preserving the running flag for recovery.')
    console.log('[shutdown] final quit requested')
    electronApp.quit()
  }).catch(e => {
    logCrash('shutdown-job-persistence', e)
    console.log('[shutdown] final quit requested')
    electronApp.quit()
  })
})

electronApp.on('will-quit', () => {
  console.log('[shutdown] will-quit event')
})
