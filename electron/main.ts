/**
 * Electron main process.
 * Starts the Express backend server and opens the frontend in a BrowserWindow.
 */

import { app as electronApp, BrowserWindow, Menu, Notification, dialog, shell } from 'electron'
import { app as expressApp } from './server/app.js'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { killAllTrackedChildren, jobEvents, getJobs } from './server/services/job-queue.js'
import { reapFfmpegOrphans } from './server/services/orphan-reaper.js'
import { PROJECTS_ROOT } from './server/services/project-manager.js'
import { getRunningFlagPath, patchLastSession } from './server/services/last-session.js'
import { isServerMode, getServerModeConfig } from './server/lib/server-mode.js'
import { bootstrapServerModeFromEnv } from './server/services/app-settings.js'
import {
  aggregateBatch, isBatchComplete, shouldNotifyForSingleJob,
  formatBatchMessage, formatSingleJobMessage, getBatchId,
  getNotifierSettings,
} from './server/services/job-notifier.js'
import type { Job } from './server/models/types.js'

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
      port = isDev ? 8000 : 0
      bind = '127.0.0.1'
    }
    server = http.createServer(expressApp)
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
      // Marker preload — sets `window.electron` so the renderer can refuse to
      // run when a user accidentally opens http://localhost:3001/ in Chrome.
      // See electron/preload.cjs and frontend/app.vue for the other half.
      preload: path.join(__dirname, '..', 'preload.cjs'),
    },
  })

  if (isDev) {
    // In dev, load Nuxt dev server
    mainWindow.loadURL('http://localhost:3000')
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

    // ── Content Security Policy ───────────────────────────────────────────
    // Defense against XSS-via-AI-output: even if an injected script lands in
    // the renderer (e.g. via v-html of poisoned provider content), CSP stops
    // it from exfiltrating to attacker-controlled hosts. Key restriction is
    // `connect-src` — fetch/XHR can only talk to loopback. Blocks off-box
    // POSTs that would otherwise drain provider keys out of /api/settings/*.
    //
    // `'unsafe-inline'` on script-src is a concession to Nuxt 3's built-in
    // inline hydration shim (`window.__NUXT__={...}`). Removing it requires a
    // per-request nonce rewrite of index.html, which isn't worth the
    // complexity for a self-use app. Omitting `'unsafe-eval'` still blocks
    // the dangerous eval/new-Function escalation path.
    const CSP = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
      "media-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
      "connect-src 'self' http://127.0.0.1:* http://localhost:*",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
    expressApp.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', CSP)
      // Frame-ancestors can't be set via <meta>; but it's also not reachable
      // from an Electron BrowserWindow. X-Frame-Options is the legacy mirror
      // that covers older embed contexts.
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'no-referrer')
      next()
    })

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

    expressApp.use(express.default.static(frontendPath, { dotfiles: 'allow' }))

    // SPA fallback — Express 5 / path-to-regexp v8 removed bare '*' wildcards
    expressApp.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      if (req.path.startsWith('/api/')) return next()
      sendIndex(req, res, next)
    })

    // Global error handler
    expressApp.use((err: any, _req: any, res: any, _next: any) => {
      console.error('[express-error]', err.stack || err)
      res.status(500).send('Internal server error')
    })

    mainWindow.loadURL(`http://127.0.0.1:${port}`)
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
  function isOwnOrigin(urlStr: string): boolean {
    try {
      const u = new URL(urlStr)
      return allowedOrigins.has(`${u.protocol}//${u.host}`)
    } catch { return false }
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isOwnOrigin(targetUrl)) return
    event.preventDefault()
    if (/^https?:\/\//.test(targetUrl)) shell.openExternal(targetUrl)
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
        {
          label: 'Show Logs',
          click: () => {
            try { fs.mkdirSync(logsDir, { recursive: true }) } catch {}
            shell.openPath(logsDir)
          },
        },
        {
          label: 'Show User Data',
          click: () => shell.openPath(electronApp.getPath('userData')),
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

      // Resolve a friendly project label so notifications carry "—
      // TerraNash Sleep Stories" instead of just "Pipeline finished".
      // Falls back to slug when the project meta lookup fails (e.g.
      // project deleted between job submission and completion ping).
      let projectLabel: string | undefined
      try {
        const { getProject } = await import('./server/services/project-manager.js')
        const meta = await getProject(job.project_slug)
        projectLabel = meta?.name || job.project_slug
      } catch { projectLabel = job.project_slug }

      const batchId = getBatchId(job)
      if (batchId) {
        if (notifiedBatches.has(batchId)) return
        const allJobs = await getJobs(job.project_slug).catch(() => [] as Job[])
        const stats = aggregateBatch(allJobs, batchId)
        if (!isBatchComplete(stats)) return
        notifiedBatches.add(batchId)
        await dispatchNotification(formatBatchMessage(stats, projectLabel), job.project_slug, settings)
        return
      }

      if (notifiedJobs.has(job.job_id)) return
      // shouldNotifyForSingleJob still gates on `settings.enabled` for
      // the desktop side, so we re-check at dispatch level: if EITHER
      // desktop or telegram is on for long-job pings, dispatch.
      const wantsLongJobPing = (settings.enabled
        || !!(settings.telegram?.enabled && settings.telegram.bot_token && settings.telegram.chat_id))
        && !getBatchId(job)
        && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')
        && !!(job.started_at && job.finished_at)
        && (Date.parse(job.finished_at) - Date.parse(job.started_at)) >= settings.min_duration_ms
      if (wantsLongJobPing) {
        notifiedJobs.add(job.job_id)
        await dispatchNotification(formatSingleJobMessage(job, projectLabel), job.project_slug, settings)
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
    message = err instanceof Error ? (err.stack || err.message) : String(err)
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

electronApp.whenReady().then(async () => {
  try {
    buildMenu()
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
      const result = await reapFfmpegOrphans(PROJECTS_ROOT)
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
    // ── Notifications ─────────────────────────────────────────────────────
    // Subscribe to the queue's event bus so long-running single jobs and
    // completed batches pop an OS notification. Runs after createWindow so
    // the click handler has a window to focus. See job-notifier.ts.
    installJobNotifier()

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
  } catch (e) {
    logCrash('startup', e)
    dialog.showErrorBox(
      'Story Studio failed to start',
      String((e as Error)?.message || e),
    )
    electronApp.quit()
  }
})

electronApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    electronApp.quit()
  }
})

electronApp.on('activate', async () => {
  if (!mainWindow) {
    const port = server ? (server.address() as any)?.port || 8000 : 8000
    await createWindow(port)
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
  isShuttingDown = true
  // Clear FIRST so a SIGKILL inside the 800ms drain still counts as unclean.
  // (If we cleared after, a force-quit during drain would look clean next
  // launch and the operator wouldn't know jobs were left half-finished.)
  clearRunningFlag()
  event.preventDefault()
  try {
    const pids = killAllTrackedChildren()
    if (pids.length > 0) {
      console.log(`[shutdown] SIGTERM sent to ${pids.length} tracked child(ren): ${pids.join(', ')}`)
    }
  } catch (e) {
    logCrash('shutdown-killchildren', e)
  }
  setTimeout(() => {
    try { if (server) server.close() } catch (e) { logCrash('shutdown-server-close', e) }
    electronApp.quit()
  }, SHUTDOWN_DRAIN_MS)
})
