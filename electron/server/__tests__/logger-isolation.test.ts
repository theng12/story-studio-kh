/**
 * Test-isolation guard for the file-based server logger.
 *
 * Background — the bug this locks out:
 *   `services/logger.ts` used to resolve its log directory once, into a
 *   module-scope `let cachedLogDir`, on the FIRST call rather than at module
 *   load — a softer variant of the same class of bug fixed in
 *   `services/app-settings.ts` (and `named-roots.ts`, `last-session.ts`).
 *   `STORY_STUDIO_DATA_DIR` is what redirects logs into an isolated
 *   directory, and a test only sets it inside `before()` / `useTempDataDir()`.
 *   Whichever test happened to log first — in any file sharing the same test
 *   worker process — froze the directory for every later test, including
 *   ones that had already claimed their own temp dir. Measured on a full
 *   backend suite run: two test files that never claim a temp dir at all
 *   (`error-boundary.test.ts`, `humanize-error-code.test.ts` — logging is
 *   incidental there, fired by `errorBoundary`/`humanizeBackendError`, not
 *   the thing under test) wrote real request/error log lines straight into
 *   the developer's `electron/logs/server-*.log` before this fix.
 *
 * What this file pins:
 *   1. The log directory is resolved lazily, per access — NOT captured on
 *      first call.
 *   2. Under the node test runner, logging outside a claimed data dir is a
 *      hard error rather than a silent write to the developer's real log
 *      file.
 *   3. Neither of the above disturbs the real log directory.
 *
 * These are cheap, offline, and zero-spend.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REAL_LOG_DIR = path.join(SERVER_ROOT, '..', 'logs')

/** Snapshot the real log dir's file list so every assertion can prove it was
 *  never written to by this suite (existing dev-machine logs are fine — only
 *  a NEW entry from this run would indicate a leak). */
async function realLogFiles(): Promise<string[]> {
  if (!existsSync(REAL_LOG_DIR)) return []
  return (await fs.readdir(REAL_LOG_DIR)).sort()
}

const REAL_LOG_FILES_AT_START = await realLogFiles()

const originalDataDir = process.env.STORY_STUDIO_DATA_DIR

after(() => {
  if (originalDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = originalDataDir
})

describe('logger path resolution', () => {
  test('resolves the log dir per access, not once on first call', async () => {
    // Import FIRST, with no data dir claimed — the ordering that used to
    // freeze the directory to the real (or cwd-fallback) location forever.
    delete process.env.STORY_STUDIO_DATA_DIR
    const logger = await import('../services/logger.js')

    const a = await useTempDataDir()
    const dirA = logger.getLogDir()
    const b = await useTempDataDir()
    const dirB = logger.getLogDir()

    assert.equal(dirA, path.join(a.dir, 'logs'))
    assert.equal(
      dirB, path.join(b.dir, 'logs'),
      'a second claimed temp dir must move the log directory — a first-call capture would have kept it at dir A',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('does not memoise the log dir in a module-scope variable', async () => {
    const source = await fs.readFile(path.join(SERVER_ROOT, 'services', 'logger.ts'), 'utf-8')
    assert.ok(
      !/^let\s+cachedLogDir/m.test(source),
      'logger.ts must not cache its resolved log dir in a module-scope variable — '
      + 'that freezes it before a later test can claim its own STORY_STUDIO_DATA_DIR',
    )
  })
})

describe('logger write guard', () => {
  test('refuses to log from a test process with no claimed data dir', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    const logger = await import('../services/logger.js')

    assert.throws(
      () => logger.logLine('info', 'isolation probe — should never reach a real log file'),
      /isolation violation/i,
      'logging without a claimed data dir must throw, not silently write into the developer\'s real log file',
    )
  })

  test('the real log directory gained no new files from this suite', async () => {
    assert.deepEqual(
      await realLogFiles(), REAL_LOG_FILES_AT_START,
      'the real logs directory changed while this test file ran',
    )
  })
})
