/**
 * File-based server logger.
 * Writes to {userData}/logs/server-YYYY-MM-DD.log, keeps last 7 days.
 */

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { redactSecrets, redactSensitiveValue } from '../lib/redact-secrets.js'

const require = createRequire(import.meta.url)

let cachedLogDir: string | null = null

function resolveLogDir(): string {
  if (cachedLogDir) return cachedLogDir

  // Test override
  if (process.env.STORY_STUDIO_DATA_DIR) {
    cachedLogDir = path.join(process.env.STORY_STUDIO_DATA_DIR, 'logs')
  } else {
    try {
      const { app } = require('electron')
      if (app && typeof app.getPath === 'function') {
        cachedLogDir = path.join(app.getPath('userData'), 'logs')
      }
    } catch {
      // Not in Electron — fall through
    }
    if (!cachedLogDir) {
      cachedLogDir = path.join(process.cwd(), 'logs')
    }
  }

  try {
    fs.mkdirSync(cachedLogDir, { recursive: true })
  } catch {}
  return cachedLogDir
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
  try {
    const dir = resolveLogDir()
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
  try {
    fs.appendFileSync(currentLogFile(), line)
  } catch {}
  if (level === 'error') console.error(line.trim())
}

export function getLogDir(): string {
  return resolveLogDir()
}
