/**
 * File-based server logger.
 * Writes to {userData}/logs/server-YYYY-MM-DD.log, keeps last 7 days.
 */

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { redactSecrets, redactSensitiveValue } from '../lib/redact-secrets.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'

const require = createRequire(import.meta.url)

/**
 * The log directory, resolved on EVERY access.
 *
 * Deliberately not captured in a module-scope variable, even a lazily-set
 * one. `STORY_STUDIO_DATA_DIR` is what redirects logs into an isolated
 * directory, and it is set by the caller — the Electron main process at boot,
 * `useTempDataDir()` in tests. Memoising on first CALL still froze the path:
 * whichever test happened to log first — in any file sharing this test worker
 * process — bound the directory for every later test, including ones that had
 * already claimed their own temp dir. Same shape as `services/app-settings.ts`.
 * Directory creation is deferred to the actual write sites below (`logLine`,
 * `pruneOldLogs`), not done here, so a plain read (`getLogDir`, used only to
 * report the path) never side-effects the filesystem.
 */
function resolveLogDir(): string {
  // Test override
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'logs')
  }
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'logs')
    }
  } catch {
    // Not in Electron — fall through
  }
  return path.join(process.cwd(), 'logs')
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function currentLogFile(): string {
  return path.join(resolveLogDir(), `server-${todayStamp()}.log`)
}

/** Delete log files older than 7 days. Covers both request logs
 *  (`server-YYYY-MM-DD.log`) and main-process crash logs
 *  (`main-YYYY-MM-DD.log`, introduced alongside the uncaughtException
 *  handler in `main.ts`). Any other `.log` file in this dir is left alone. */
function pruneOldLogs() {
  const dir = resolveLogDir()
  // Outside the try/catch below on purpose: under the node test runner, a
  // prune whose directory falls outside the claimed temp data dir must fail
  // loudly, not be swallowed as just another benign fs error (e.g. ENOENT for
  // a directory that hasn't been written to yet). See lib/test-isolation.ts.
  assertWriteIsolatedInTests(dir, 'logger')
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.log')) continue
      if (!name.startsWith('server-') && !name.startsWith('main-')) continue
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full)
    }
  } catch {}
}

let prunedAt = 0
function maybePrune() {
  const now = Date.now()
  if (now - prunedAt > 60 * 60 * 1000) {
    prunedAt = now
    pruneOldLogs()
  }
}

export function logLine(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, any>) {
  maybePrune()
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: redactSecrets(message),
    ...(redactSensitiveValue(meta || {})),
  }
  const line = JSON.stringify(entry) + '\n'
  const target = currentLogFile()
  // Outside the try/catch below on purpose — see pruneOldLogs above.
  assertWriteIsolatedInTests(target, 'logger')
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(target, line)
  } catch {}
  if (level === 'error') console.error(line.trim())
}

export function getLogDir(): string {
  return resolveLogDir()
}
