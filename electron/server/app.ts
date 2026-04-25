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
import { runBootMigrations } from './boot/migrations.js'
import { logLine } from './services/logger.js'
import { requireLocalHost, csrfTokenHandler } from './lib/security.js'

const app = express()

// ── Middleware ─────────────────────────────────────────────────────────────
// Host-header check runs first: a DNS-rebound request from attacker.com still
// arrives with `Host: attacker.com`, so rejecting here shuts that class of
// attack before CORS has a chance to echo a permissive Access-Control header.
app.use(requireLocalHost)

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

// ── Routes + boot tasks ────────────────────────────────────────────────────
mountRoutes(app)

// Global health (duplicated inside healthRouter for completeness — leave it
// here so a broken health router never masks the liveness probe).
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' })
})

// CSRF token distribution — Origin-gated inside the handler so only the
// bundled renderer can read the value. Writes to sensitive endpoints echo
// it back in X-Story-Studio-Token.
app.get('/api/csrf-token', csrfTokenHandler)

runBootMigrations()
registerAllExecutors()

// Phase 5 of the perf overhaul: portable-flag reconciliation used to run
// per-project on every listProjects() call, serializing a write-back to
// disk on the home-page hot path. Moved to a fire-and-forget startup task
// — idempotent, safe to run alongside everything else.
import('./services/project-manager.js').then(m => m.reconcilePortableFlagsAtStartup())
  .catch(() => { /* boot best-effort */ })

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
