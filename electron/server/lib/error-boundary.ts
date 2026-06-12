/**
 * error-boundary.ts — the terminal Express error handler.
 *
 * Extracted from app.ts so it can be unit-tested against a real throwing
 * route (and reused). Express 5 auto-forwards rejected promises from async
 * route handlers to the error middleware, so an unhandled throw anywhere
 * downstream lands here instead of hanging the request or leaking a
 * stack-trace HTML page to the client.
 *
 * Contract:
 *   - Already responded (headersSent) → do nothing (can't change a sent response).
 *   - `err.status` (or `.statusCode`) sets the HTTP status; default 500.
 *   - `err.expose === true` → the real message is returned in `detail`
 *     (used for deliberate, client-safe errors). Otherwise `detail` is the
 *     generic 'Internal server error' so internals/stack frames never leak.
 *   - Always logs the full error + stack server-side for debugging.
 */

import type { Request, Response, NextFunction } from 'express'
import { logLine } from '../services/logger.js'

export function errorBoundary(err: any, req: Request, res: Response, _next: NextFunction): void {
  logLine('error', 'unhandled-error', {
    method: req.method,
    path: req.path,
    error: String(err?.message || err),
    stack: err?.stack,
  })
  if (res.headersSent) return
  const status = Number(err?.status || err?.statusCode) || 500
  res.status(status).json({
    detail: err?.expose ? String(err.message) : 'Internal server error',
  })
}
