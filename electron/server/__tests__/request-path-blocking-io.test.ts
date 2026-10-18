/**
 * Nothing on the request path may block the event loop on the disk.
 *
 * ── The defect ──
 *
 * The app appeared to freeze while it was rendering video. It was not a
 * deadlock and it was not the renderer competing for CPU: the request path
 * itself performed synchronous disk I/O, and a synchronous disk call on a
 * saturated disk stops the ENTIRE process — every other request, every timer,
 * every callback — for as long as the disk takes to answer.
 *
 * There were four of them, all on the path of an ordinary request:
 *
 *   1. `logLine` ran `fs.mkdirSync` + `fs.appendFileSync` on EVERY request. The
 *      request logger was blocking the server it was logging.
 *   2. `logLine` also triggered an hourly `pruneOldLogs` — a readdir plus a stat
 *      and an unlink per file, synchronously — on whichever unlucky request
 *      happened to cross the hour boundary.
 *   3. `listProjects` had two untimed `existsSync` calls per channel sitting
 *      OUTSIDE the 30-second race that was written to stop exactly this. Two of
 *      its three disk touches per channel were unguarded, and the first one ran
 *      before the race even began.
 *   4. `projectsRoot()` read and parsed app-settings.json synchronously on every
 *      call, by design, to guarantee freshness — and `listProjects` calls into
 *      it once per candidate folder.
 *
 * ── What is pinned here ──
 *
 * Behaviour where behaviour can be measured: a slow log sink must not delay the
 * caller, and `listProjects` must survive a folder whose disk never answers.
 * Where the property is a structural absence — "no synchronous fs call remains
 * on this path" — the source is asserted, because an absence has no runtime
 * signal to observe.
 *
 * Zero paid calls, no network, no real provider.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fs from 'fs/promises'
import { readFileSync } from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function source(relative: string): string {
  return readFileSync(path.join(SERVER_ROOT, relative), 'utf8')
}

/**
 * Strip comments before asserting that something is ABSENT.
 *
 * Every fix in this file is documented by a comment that names the call it
 * removed — that is deliberate, and it is how the next reader learns why the
 * code looks the way it does. It also means a naive `doesNotMatch` against the
 * raw source is defeated by the very prose explaining the fix. An absence
 * assertion has to look at code.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The text BETWEEN two markers, so an assertion about a function's body is
 *  never satisfied or defeated by prose somewhere else in the file. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  assert.ok(start >= 0, `marker not found: ${from}`)
  const end = text.indexOf(to, start + from.length)
  assert.ok(end > start, `marker not found after ${from}: ${to}`)
  return text.slice(start, end)
}

/** `logLine` itself — the code that runs on every single request. */
function logLineBody(): string {
  return between(source('services/logger.ts'), 'export function logLine', '\n/**')
}

/** The body of `listProjects`' per-candidate mapper. */
function listProjectsBody(): string {
  return between(
    source('services/project-manager.ts'),
    'const READ_TIMEOUT_MS = 30_000',
    'return summaries.filter',
  )
}

let tempDir: string
let cleanup: () => Promise<void>

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'logs'), { recursive: true })
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
})

after(async () => {
  const logger = await import('../services/logger.js')
  logger.stopLogPruning()
  logger.closeLogStream()
  await cleanup()
})

describe('the request logger does not block the caller', () => {
  test('logging returns without waiting for the disk', async () => {
    const logger = await import('../services/logger.js')

    // A synchronous append of this many lines was the shape of the old code.
    // What matters is that the CALL returns promptly — the bytes land later.
    const started = process.hrtime.bigint()
    for (let i = 0; i < 500; i++) {
      logger.logLine('info', 'request', { method: 'GET', path: `/api/projects/${i}`, status: 200, durationMs: 3 })
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    assert.ok(elapsedMs < 250, `500 log lines took ${elapsedMs.toFixed(1)}ms of caller time — this path must not wait on the disk`)

    // The lines are real: they arrive once the buffer drains.
    await logger.flushLogLines()
    const file = path.join(tempDir, 'logs', `server-${new Date().toISOString().slice(0, 10)}.log`)
    const written = await fs.readFile(file, 'utf-8')
    assert.ok(written.split('\n').filter(Boolean).length >= 500, 'every line reached the file')
    assert.match(written, /"path":"\/api\/projects\/499"/)
  })

  test('an unwritable log target degrades to a dropped line, never to a throw', async () => {
    const logger = await import('../services/logger.js')
    // Remove the directory out from under the open stream. A logger that threw
    // here would take down whatever request it was logging.
    await fs.rm(path.join(tempDir, 'logs'), { recursive: true, force: true })
    logger.closeLogStream()
    assert.doesNotThrow(() => logger.logLine('info', 'request after the log dir vanished'))
    await fs.mkdir(path.join(tempDir, 'logs'), { recursive: true })
  })

  test('no synchronous fs call remains on the logging path', () => {
    const logger = source('services/logger.ts')
    // The call that was there, by name. (Comments stripped: the comment that
    // explains this fix names the very call it removed.)
    assert.doesNotMatch(code(logger), /appendFileSync/, 'the per-request synchronous append must not come back')
    assert.doesNotMatch(code(logLineBody()), /Sync\(/, 'logLine must do no synchronous fs work')
    // The mkdir survives, but once per log file rather than once per request.
    assert.match(logger, /function streamFor\(target: string\)[\s\S]{0,400}mkdirSync/)
  })

  test('the prune runs on a timer, never inside a request', () => {
    const logger = source('services/logger.ts')
    assert.doesNotMatch(logger, /maybePrune/, 'the request-triggered prune must be gone entirely')
    assert.doesNotMatch(
      code(logLineBody()), /pruneOldLogs\(/,
      'logLine must not reach the prune by any route',
    )
    // Same shape as the live-output flush timer in job-queue.ts: unref'd, so it
    // never holds the process open at shutdown.
    assert.match(logger, /export function startLogPruning\(\)[\s\S]{0,400}setInterval\([\s\S]{0,120}PRUNE_INTERVAL_MS\)/)
    assert.match(logger, /pruneTimer\.unref\(\)/)
    // And it is async now — a sweep on a busy disk must not stop the process.
    assert.match(logger, /export async function pruneOldLogs\(\): Promise<void>/)
    assert.match(logger, /await fs\.promises\.readdir\(dir\)/)

    // Started from real boots only. Importing this module — which every route
    // test does — must not start a timer or touch the filesystem.
    assert.match(source('app.ts'), /startLogPruning\(\)/)
    assert.doesNotMatch(logger, /^startLogPruning\(\)/m)
  })
})

describe('listProjects survives a folder whose disk never answers', () => {
  test('both membership checks sit inside the race that was written to guard them', () => {
    const listProjects = listProjectsBody()

    // The check for project.json — the FIRST disk touch per channel, and the one
    // that used to run before the race began.
    assert.match(listProjects, /const readAll = \(async \(\) => \{/)
    assert.match(listProjects, /await fs\.access\(metaPath\)\.then\(\(\) => true, \(\) => false\)/)
    // The episodes-folder check, previously a bare synchronous call after the race.
    assert.match(listProjects, /await resolveOutputRootAsync\(cand\.dir\)/)
    // Everything raced together against the one timeout.
    assert.match(listProjects, /await Promise\.race\(\[readAll, timeoutPromise\]\)/)
    assert.doesNotMatch(code(listProjects), /existsSync/, 'no synchronous existence check may remain inside listProjects')
  })

  test('a timeout is reported as an unknown channel, not dropped', () => {
    const pm = source('services/project-manager.ts')
    // Unchanged behaviour, restated because the checks that now share this
    // branch did not previously have one: a channel that is there but
    // unreadable stays visible as a problem instead of silently vanishing.
    assert.match(pm, /if \(e\?\.message === 'READ_TIMEOUT'\)[\s\S]{0,600}status: 'downloading'/)
  })

  test('the async twin of resolveOutputRoot gives the same answer', async () => {
    const pm = await import('../services/project-manager.js')
    const present = path.join(tempDir, 'projects')
    await fs.mkdir(path.join(present, 'episodes'), { recursive: true })
    const absent = path.join(tempDir, 'not-a-project')

    assert.deepEqual(await pm.resolveOutputRootAsync(present), pm.resolveOutputRoot(present))
    assert.deepEqual(await pm.resolveOutputRootAsync(absent), pm.resolveOutputRoot(absent))
    assert.equal((await pm.resolveOutputRootAsync(present)).exists, true)
    assert.equal((await pm.resolveOutputRootAsync(absent)).exists, false)
  })
})

describe('projectsRoot keeps its freshness contract without the per-call read', () => {
  test('a Library change is picked up on the very next call', async () => {
    const pm = await import('../services/project-manager.js')
    const settings = await import('../services/app-settings.js')

    // The test override wins outright and is checked before the cache, so this
    // suite's own isolation is unaffected either way. The invalidation rule
    // itself — which writes may drop the cache — is pinned in
    // projects-root-cache.test.ts, because the cache is unreachable at runtime
    // from under the override. What is asserted here is the user-visible half: a
    // write to a setting that cannot move the Library leaves the root alone.
    const first = pm.projectsRoot()
    await settings.setAppSetting('a_setting_that_is_not_the_library', 'x')
    const second = pm.projectsRoot()
    assert.equal(second, first, 'an unrelated setting cannot move where the Library is')

    // The stale-path bug class the comment on projectsRoot() describes must stay
    // fixed: a claimed data dir has to move the root, cache or no cache.
    const other = await useTempDataDir()
    try {
      assert.equal(pm.projectsRoot(), path.join(other.dir, 'projects'),
        'a newly claimed data dir must move the projects root immediately')
    } finally {
      await other.cleanup()
      process.env.STORY_STUDIO_DATA_DIR = tempDir
    }
  })

  test('the cache is wired to the settings-write announcement, not to a timer', () => {
    const pm = source('services/project-manager.ts')
    assert.match(pm, /onAppSettingWritten\(invalidateProjectsRootCache\)/)
    // The environment override is checked BEFORE the cache — that is what keeps
    // per-test isolation working and costs no file read at all.
    assert.match(
      pm,
      /function resolveProjectsRoot\(\): string \{[\s\S]{0,600}STORY_STUDIO_DATA_DIR[\s\S]{0,400}if \(cachedLibraryRoot !== null\) return cachedLibraryRoot/,
    )
    assert.match(source('services/app-settings.ts'), /export function onAppSettingWritten/)
    assert.match(source('services/app-settings.ts'), /announceWrite\(key\)/)
  })
})

describe('a request that never answers gets an answer anyway', () => {
  test('the deadline guard is mounted, and exempts anything already responding', () => {
    const app = source('app.ts')
    assert.match(app, /app\.use\(requestDeadline\(\)\)/)

    const timeouts = source('lib/server-timeouts.ts')
    // Streams and in-flight responses are exempt by construction rather than by
    // a list of paths that would drift out of step with the router. The job
    // event streams and the media routes send headers immediately.
    assert.match(timeouts, /if \(res\.headersSent \|\| res\.writableEnded\) return/)
    assert.match(timeouts, /res\.status\(503\)/)
    assert.match(timeouts, /timer\.unref\(\)/)
    assert.match(timeouts, /res\.on\('finish', clear\)/)
  })

  test('the defaults clear this app’s real long-running requests', async () => {
    const timeouts = await import('../lib/server-timeouts.js')
    // Five minutes is the documented per-attempt ceiling for a GenStudio image
    // preview, which is awaited inside its request. A deadline under that would
    // 503 work that was proceeding perfectly well — which is a worse bug than
    // the one this guard exists to fix.
    assert.ok(timeouts.REQUEST_DEADLINE_SECONDS_DEFAULT >= 300 + 60)
    // Local ffmpeg previews are deliberately allowed 90s before they count as
    // wedged; a kit install chains four 60s downloads.
    assert.ok(timeouts.REQUEST_DEADLINE_SECONDS_DEFAULT >= 240)
    assert.ok(timeouts.SOCKET_TIMEOUT_SECONDS_DEFAULT > timeouts.REQUEST_DEADLINE_SECONDS_DEFAULT)
    // headersTimeout must exceed keepAliveTimeout or Node races itself.
    assert.match(source('lib/server-timeouts.ts'), /server\.headersTimeout = \(keepAliveSeconds \+ 5\) \* 1_000/)
  })

  test('every ceiling is a setting the owner can change', async () => {
    const timeouts = await import('../lib/server-timeouts.js')
    for (const key of [
      timeouts.REQUEST_DEADLINE_SECONDS_KEY,
      timeouts.SOCKET_TIMEOUT_SECONDS_KEY,
      timeouts.KEEP_ALIVE_SECONDS_KEY,
    ]) {
      assert.equal(typeof key, 'string')
      assert.ok(key.length > 0)
    }
    // Read from settings, not frozen into the code.
    assert.match(source('lib/server-timeouts.ts'), /await getAppSetting\(REQUEST_DEADLINE_SECONDS_KEY\)/)
    assert.match(source('lib/server-timeouts.ts'), /await getAppSetting\(SOCKET_TIMEOUT_SECONDS_KEY\)/)
    assert.match(source('lib/server-timeouts.ts'), /await getAppSetting\(KEEP_ALIVE_SECONDS_KEY\)/)
  })

  test('the packaged app applies them too, not only the dev entry point', () => {
    const main = readFileSync(path.join(SERVER_ROOT, '..', 'main.ts'), 'utf8')
    assert.match(main, /applyServerTimeouts\(server\)/)
    assert.match(main, /startLogPruning\(\)/)
  })
})

describe('the scene decoder check no longer stops the process', () => {
  test('stillDecoderArgs asks the disk asynchronously', () => {
    const utils = source('lib/ffmpeg-utils.ts')
    assert.match(utils, /await fsAccess\(filePath\)\.then\(\(\) => true, \(\) => false\)/)
    assert.doesNotMatch(
      utils,
      /export async function stillDecoderArgs[\s\S]{0,600}existsSync/,
      'this runs once per scene while an assembly job is saturating the same disk',
    )
  })
})
