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
import { logLine } from './services/logger.js'
import { migrateLegacyProjects } from './services/project-manager.js'
import { applySecurityHeaders, requireAllowedHost } from './lib/security.js'
import { isServerMode, getServerModeConfig } from './lib/server-mode.js'
import { buildRequireSession } from './lib/auth-session.js'
import { router as authRouter } from './routes/auth.js'
import { errorBoundary } from './lib/error-boundary.js'
import { getApiKey } from './services/app-secrets-store.js'
import {
  refreshGenStudioAdmission,
  describeGenStudioChatTransport,
  genStudioChatTransportLogLine,
} from './lib/genstudio-client.js'

const app = express()
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

// Request logging — method/path/status/duration to the daily log file.
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
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    boot_complete: isBootComplete(),
  })
})

// v1.0.99+ — process start timestamp so /api/server-info can report uptime
// for the diagnostic card on the Settings page.
const PROCESS_START_MS = Date.now()

app.get('/api/server-info', (_req, res) => {
  const cfg = getServerModeConfig()
  // Read it fresh — credentials could have been rotated since boot.
  const hasCredentials = !!cfg?.auth?.password_hash && !!cfg?.auth?.session_secret
  res.json({
    server_mode: SERVER_MODE,
    app_name: 'Story Studio KH',
    version: '0.1.0',
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
  const requireSession = buildRequireSession(() => getServerModeConfig()?.auth)
  app.use('/api', requireSession)
}

// ── Gated routes ────────────────────────────────────────────────────────────
mountRoutes(app)

runBootMigrations()
registerAllExecutors()

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
const PORT = parseInt(process.env.PORT || '8000')
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
  app.listen(PORT, () => {
    console.log(`Story Studio API running on http://localhost:${PORT}`)
    console.log(`API docs: http://localhost:${PORT}/api/health`)
  })
}

export { app, PORT }
