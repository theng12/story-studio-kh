/**
 * Express app assembly.
 *
 * This module's only job is to wire middleware, routes, boot tasks, and the
 * error handler onto a single `app` instance — and optionally start listening
 * when we're running standalone via tsx (not inside packaged Electron).
 *
 * Anything bigger than one or two lines lives in a dedicated module:
 *   - `boot/providers.ts`   — registers every provider with the registry
 *   - `boot/executors.ts`   — binds each JobType to its generator
 *   - `boot/migrations.ts`  — runs idempotent startup migrations
 *   - `routes/index.ts`     — mounts every router under /api
 */

import express from 'express'
import cors from 'cors'
import './boot/providers.js'              // side-effect: self-register providers
import { mountRoutes } from './routes/index.js'
import { registerAllExecutors } from './boot/executors.js'
import { runBootMigrations, isBootComplete } from './boot/migrations.js'
import { signalBootFirstPaint } from './boot/deferred-boot.js'
import { logLine, startLogPruning } from './services/logger.js'
import { isQueuePaused, getQueuePauseOwner, updateHoldState } from './services/job-queue.js'
import { startEventLoopMonitor, readEventLoopLag } from './lib/event-loop-lag.js'
import { applyServerTimeouts, requestDeadline } from './lib/server-timeouts.js'
import { setStallReporter } from './lib/stall-watch.js'
import { migrateLegacyProjects } from './services/project-manager.js'
import { applySecurityHeaders, requireAllowedHost } from './lib/security.js'
import { setCrossProcessLockHoldReporter } from './lib/atomic-store.js'
import { installOutboundConnectionCap, OUTBOUND_CONNECTIONS_PER_ORIGIN } from './lib/outbound-connections.js'
import { isServerMode, getServerModeConfig } from './lib/server-mode.js'
import { DEV_BACKEND_PORT } from './lib/dev-backend.js'
import { buildRequireSession, automationKeyHint } from './lib/auth-session.js'
import { recordAutomationKeyUse } from './services/app-settings.js'
import { router as authRouter } from './routes/auth.js'
import { errorBoundary } from './lib/error-boundary.js'
import { resolveStoryStudioVersion } from './lib/app-version.js'
import { currentWaits } from './lib/stall-watch.js'
import { getApiKey } from './services/app-secrets-store.js'
import { migrateLegacyKeychain } from './services/legacy-keychain-migration.js'
import {
  refreshGenStudioAdmission,
  describeGenStudioChatTransport,
  genStudioChatTransportLogLine,
} from './lib/genstudio-client.js'

const app = express()
void migrateLegacyKeychain().catch(() => undefined)
const SERVER_MODE = isServerMode()

// ── Middleware ─────────────────────────────────────────────────────────────
// Host-header check runs first: a DNS-rebound request from attacker.com still
// arrives with `Host: attacker.com`, so rejecting here shuts that class of
// attack before CORS has a chance to echo a permissive Access-Control header.
//
// In server mode, the host check is bypassed — the server is intentionally
// reachable from non-local hosts (the user's iMac browser via Tailscale), and
// session-cookie auth carries the security weight instead. See lib/server-mode.ts.
app.use(requireAllowedHost(SERVER_MODE))
app.use(applySecurityHeaders)

// v1.0.472 — Chrome Private Network Access (PNA) preflight support (server mode).
// When a browser/extension on ANOTHER machine (e.g. the iMac reaching this Mac
// mini over Tailscale) fetches this server-mode API, Chrome sends a CORS
// preflight carrying `Access-Control-Request-Private-Network: true` and then
// SILENTLY blocks the fetch unless the response echoes
// `Access-Control-Allow-Private-Network: true`. The `cors` package doesn't set
// this header, so we add it ourselves — BEFORE cors() runs, so it's present on
// the 204 that cors() ends the OPTIONS preflight with. localhost / 127.0.0.1 are
// exempt from PNA (that's why desktop-loopback mode already works), so this is
// scoped to server mode only. Only requests that actually ask for private-network
// access get the header.
if (SERVER_MODE) {
  app.use((req, res, next) => {
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    next()
  })
}

// In production (packaged Electron), frontend is served from the same Express
// server so CORS isn't needed. In dev, allow the Nuxt dev server origin.
const isDev = !process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_ENV === 'development'
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '3000')
app.use(cors({
  origin: isDev
    ? [`http://localhost:${FRONTEND_PORT}`, `http://127.0.0.1:${FRONTEND_PORT}`]
    : true,
  credentials: true,
}))
// Body limit set to 10mb so base64 reference-image uploads (Phase 5) fit
// alongside the existing routes that POST script + image-prompt JSON. The
// reference-image route caps the decoded buffer at 5mb to enforce the
// portrait-not-full-art convention; this 10mb covers the base64 overhead.
app.use(express.json({ limit: '10mb' }))
app.use(express.text({ type: 'text/plain', limit: '2mb' }))

// A request that never answers gets a 503 with a sentence in it instead of an
// endless spinner. Mounted before the routes and after the body parsers so it
// covers every handler; streams and in-flight responses are exempt by
// construction (see lib/server-timeouts.ts).
app.use(requestDeadline())

// Request logging — method/path/status/duration to the daily log file.
//
// The write is buffered and lands off the event loop. It used to be an
// `fs.mkdirSync` plus an `fs.appendFileSync` HERE, on every request — two
// synchronous disk calls on the hot path of a server whose own disk is
// routinely saturated by video rendering. See services/logger.ts.
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    logLine(
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      'request',
      { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start },
    )
  })
  next()
})

// ── Public routes (mounted BEFORE the auth gate) ───────────────────────────
//
// Liveness + server-info + login/logout/me must be reachable without a
// session cookie. The SPA's boot-ready gate hits /api/health, the login
// page hits /api/server-info + /api/auth/login, and /api/auth/me is the
// "am I logged in?" probe used by the frontend on every page mount.
//
// `boot_complete` flips true once every async boot migration has settled
// (or after the 20 s safety-net timeout).
//
// The version is resolved ONCE here, after the app is constructed, and health
// answers from that variable — the route never touches the filesystem. A boot
// that cannot read package.json logs once and reports `unknown`; while the
// read is still in flight it also reports `unknown` rather than waiting.
// Production saw health hang alongside other disk-touching routes while an
// in-memory route kept answering (what held the disk is a hypothesis, not a
// finding); this route no longer depends on it either way.
let healthVersion = 'unknown'
export const healthVersionReady: Promise<string> = resolveStoryStudioVersion()
  .then(version => {
    healthVersion = version
    return version
  })
  .catch(error => {
    logLine('error', 'story version could not be read at boot; /api/health reports unknown', { error: String(error) })
    return 'unknown'
  })

startEventLoopMonitor()
// A persistence lock held too long is the difference between a slow commit and a failed one; surface the
// number instead of waiting for the timeout to name it (angkor 2026-11-19).
setCrossProcessLockHoldReporter(({ key, heldMs }) => {
  logLine('warn', 'persistence lock held', { file: key.split('/').pop(), held_ms: heldMs })
})

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: healthVersion,
    boot_complete: isBootComplete(),
    waiting: currentWaits(),
    // A paused queue takes no work: say so here, not only in a settings file nobody reads.
    queue: isQueuePaused()
      ? { paused: true, owner: getQueuePauseOwner(), holds_dispatch: true }
      : { paused: false },
    // An update hold closes dispatch in memory only: it is never a durable pause, and it expires by
    // itself. Naming it here is the only way to see one that is in force.
    hold: updateHoldState(),
    // How often the main thread itself stalls, in milliseconds. 200-300 ms is a functional defect
    // even when nothing crashes (angkor 2026-11-19).
    loop_lag: readEventLoopLag(),
  })
})

// v1.0.99+ — process start timestamp so /api/server-info can report uptime
// for the diagnostic card on the Settings page.
const PROCESS_START_MS = Date.now()

app.get('/api/server-info', async (_req, res) => {
  const cfg = getServerModeConfig()
  // Read it fresh — credentials could have been rotated since boot.
  const hasCredentials = !!cfg?.auth?.password_hash && !!cfg?.auth?.session_secret
  res.json({
    server_mode: SERVER_MODE,
    app_name: 'Story Studio KH',
    version: await resolveStoryStudioVersion(),
    // v1.0.99+ — diagnostic surface for the Settings → Server Mode card.
    // All fields are safe to expose unauthenticated: they reveal whether
    // server mode is on + which bind/port is in use (the user already knows
    // — they typed the URL to get here), credentials are reported as a
    // boolean only (no hash material), and uptime is operational data.
    diagnostic: SERVER_MODE && cfg ? {
      bind: cfg.bind,
      port: cfg.port,
      has_credentials: hasCredentials,
      session_ttl_hours: cfg.auth?.session_ttl_hours || null,
      uptime_seconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
      node_version: process.versions.node,
      platform: process.platform,
    } : null,
  })
})

app.use('/api', authRouter)

// ── Auth gate (server mode only) ───────────────────────────────────────────
//
// Gates every /api/* route registered below this line. Has a loopback
// bypass so the local Electron window on the Mac mini still works without
// a login dialog. In default (Electron desktop) mode this middleware is
// not mounted at all — the host-header guard above already restricts
// access to localhost.
if (SERVER_MODE) {
  // Re-read the config on each request so credential changes (set/rotate
  // via the Settings UI) take effect immediately without an app restart.
  // Cheap — sync read of a small JSON file from OS page cache.
  const requireSession = buildRequireSession(() => getServerModeConfig()?.auth, {
    getKeys: () => getServerModeConfig()?.automation_keys || [],
    onKeyUsed: recordAutomationKeyUse,
    // Never the key itself: its last four characters identify it in the log.
    onKeyRejected: (presented, peer, status) => logLine('warn', 'automation key rejected', {
      key_hint: automationKeyHint(presented), peer, status,
    }),
  })
  app.use('/api', requireSession)
}

// ── Gated routes ────────────────────────────────────────────────────────────
mountRoutes(app)

runBootMigrations()
registerAllExecutors()

// Bundled fonts must be visible to the system before anyone asks for a picture: on macOS,
// pangocairo draws through CoreText, which only knows fonts installed for the Mac (see
// lib/thumbnail-fonts.ts). Idempotent, and it never overwrites a family the Mac already has.
void import('./lib/thumbnail-fonts.js')
  .then(module => module.ensureBundledFontsInstalled())
  .then(result => {
    if (result.installed.length) {
      logLine('info', 'fonts.installed', { installed: result.installed })
    }
    if (result.failed.length) {
      logLine('warn', 'fonts.install_failed', { failed: result.failed })
    }
  })
  .catch(error => logLine('warn', 'fonts.install_error', { error: String(error) }))

// Cap outbound sockets before anything can fetch. See lib/outbound-connections.ts.
installOutboundConnectionCap()

// ── Runtime configuration, stated out loud at boot ─────────────────────────
//
// GenStudio once diagnosed a chapter-generation failure as Story Studio
// overriding its transport to the synchronous route. There was no override —
// the running build predated the durable-route code — but nobody could tell
// which route was live without reading source. This line makes that a support
// question anyone can answer from the log. It carries the route, the variable
// that controls it, and whether that variable was set; it never carries the
// API key or anything derived from it.
{
  const transport = describeGenStudioChatTransport()
  console.log(genStudioChatTransportLogLine())
  logLine('info', 'genstudio.transport', {
    transport: transport.transport,
    source: transport.source,
    env_var: 'STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT',
    env_value: transport.envValue,
    env_recognised: transport.envRecognised,
  })
  // How many sockets this process may hold open to any one origin. The number
  // that matters when a Gateway is being buried in connections.
  logLine('info', 'outbound.connections', { per_origin: OUTBOUND_CONNECTIONS_PER_ORIGIN })
}

// Warm the account-wide GenStudio admission snapshot at startup. This is
// advisory only: every actual dispatch refreshes capacity again, and a
// missing usage:read grant falls back to the scheduler's safe single-submit
// profile without blocking application startup.
void getApiKey('genstudio')
  .then(apiKey => apiKey?.trim() ? refreshGenStudioAdmission(apiKey) : undefined)
  .catch(() => undefined)

// (Removed: reconcilePortableFlagsAtStartup boot task. The `portable`
// flag was the multi-machine-vs-local distinction for the legacy
// manifest-sync feature; all projects are equivalent now. Existing
// project.json files in the wild may still carry the field — ignored.)

// ── Error boundary (must be last) ──────────────────────────────────────────
// Extracted to lib/error-boundary.ts so it's unit-tested against a real
// throwing route (error-boundary.test.ts).
app.use(errorBoundary)

// ── Standalone listen (dev via tsx) ────────────────────────────────────────
// Packaged Electron (main.ts) owns the port and calls `app.listen` itself.
// STORY_STUDIO_DISABLE_LISTEN=1 is set by supertest so tests mount `app` without binding.
// Same default as Electron's dev branch (main.ts) and the Nuxt devProxy —
// all three read DEV_BACKEND_PORT so they cannot drift apart. `PORT` still
// overrides for anyone running two backends side by side.
const PORT = parseInt(process.env.PORT || String(DEV_BACKEND_PORT))
const isElectron = !!(process.versions as any).electron
const shouldListen = !isElectron && !process.env.STORY_STUDIO_DISABLE_LISTEN

if (shouldListen) {
  // Real standalone boot (dev via tsx). Deliberately inside this branch and
  // NOT at module scope: `shouldListen` is false for tests (they set
  // STORY_STUDIO_DISABLE_LISTEN) and for Electron (main.ts calls it itself),
  // so merely importing app.ts never runs a filesystem migration. See
  // migrateLegacyProjects() in services/project-manager.ts.
  try {
    migrateLegacyProjects()
  } catch (e) {
    console.warn('[projects] legacy migration failed:', e)
  }
  // The old sweep of expired log files ran inside the request logger, on
  // whichever request happened to cross the hour boundary. Housekeeping belongs
  // on a timer, not on the path a person is waiting on.
  startLogPruning()
  // Stall lines go to the app's own log; the watcher stays free of services/ so a
  // lock primitive never drags the job queue into the frontend's type program.
  setStallReporter((level, message, meta) => logLine(level, message, meta))
  // Loopback only: this backend has no login, and Node's default bind is every
  // interface (LAN + Tailscale). `HOST=0.0.0.0` opts back in deliberately.
  const server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`Story Studio API running on http://localhost:${PORT}`)
    console.log(`API docs: http://localhost:${PORT}/api/health`)
    // 1.4.402 — standalone server mode has no window: the boot work deferred to
    // first paint starts one macrotask after the listen callback returns.
    setTimeout(() => signalBootFirstPaint('standalone server listening (no window)'), 0)
  })
  void applyServerTimeouts(server)
}

export { app, PORT }
