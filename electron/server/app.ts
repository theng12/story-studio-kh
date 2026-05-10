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
import { requireAllowedHost } from './lib/security.js'
import { isServerMode, getServerModeConfig } from './lib/server-mode.js'
import { buildRequireSession } from './lib/auth-session.js'
import { router as authRouter } from './routes/auth.js'

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

app.get('/api/server-info', (_req, res) => {
  res.json({
    server_mode: SERVER_MODE,
    app_name: 'Story Studio KH',
    version: '0.1.0',
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

// (Removed: reconcilePortableFlagsAtStartup boot task. The `portable`
// flag was the multi-machine-vs-local distinction for the legacy
// manifest-sync feature; all projects are equivalent now. Existing
// project.json files in the wild may still carry the field — ignored.)

// ── Error boundary (must be last) ──────────────────────────────────────────
app.use((err: any, req: any, res: any, _next: any) => {
  logLine('error', 'unhandled-error', {
    method: req.method, path: req.path,
    error: String(err?.message || err), stack: err?.stack,
  })
  if (res.headersSent) return
  res.status(err?.status || 500).json({
    detail: err?.expose ? String(err.message) : 'Internal server error',
  })
})

// ── Standalone listen (dev via tsx) ────────────────────────────────────────
// Packaged Electron (main.ts) owns the port and calls `app.listen` itself.
// STORY_STUDIO_DISABLE_LISTEN=1 is set by supertest so tests mount `app` without binding.
const PORT = parseInt(process.env.PORT || '8000')
const isElectron = !!(process.versions as any).electron
const shouldListen = !isElectron && !process.env.STORY_STUDIO_DISABLE_LISTEN

if (shouldListen) {
  app.listen(PORT, () => {
    console.log(`Story Studio API running on http://localhost:${PORT}`)
    console.log(`API docs: http://localhost:${PORT}/api/health`)
  })
}

export { app, PORT }
