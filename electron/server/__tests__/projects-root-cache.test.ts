/**
 * The cached Library path — and which app-settings writes are allowed to drop it.
 *
 * ── The defect this pins ──
 *
 * `projectsRoot()` sits on the per-request path (`getProjectDir` →
 * `routes/middleware.ts` `requireProject`, and once per channel in
 * `listProjects`). It used to read and parse app-settings.json synchronously on
 * every call; v1.4.320 replaced that with a cache dropped by
 * `onAppSettingWritten`. But it dropped on ANY write — and app-settings.json is
 * written constantly by things with nothing to do with the Library: the hourly
 * retention status, the queue pause flag and its owner token, the last-seen
 * version. Each of those put an `existsSync` + `readFileSync` + `JSON.parse`
 * back onto the request path, on the event loop, while ten jobs saturated the
 * same disk.
 *
 * ── What is pinned ──
 *
 * The rule itself — `appSettingMovesProjectsRoot` — is the whole fix, so it is
 * tested directly. Two keys can move the Library (`library_root`, and the
 * pre-1.4.3 `projects_root_override` that is still read); nothing else can.
 *
 * The cache itself is not reachable at runtime from here: `resolveProjectsRoot`
 * deliberately answers from `STORY_STUDIO_DATA_DIR` BEFORE it consults the
 * cache, which is what keeps every test process isolated and costs no file read
 * at all. So the wiring is asserted against the source, exactly as
 * `request-path-blocking-io.test.ts` does for this same path, and the
 * user-visible half — a resolved root that does not move under unrelated writes
 * — is asserted at runtime.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function source(relative: string): string {
  return readFileSync(path.join(SERVER_ROOT, relative), 'utf8')
}

let pm: typeof import('../services/project-manager.js')
let settings: typeof import('../services/app-settings.js')

let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  settings = await import('../services/app-settings.js')
})

beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
  await fs.mkdir(path.join(tmp.dir, 'projects'), { recursive: true })
})

after(async () => { await tmp?.cleanup() })

test('only the keys that can move the Library drop the cached path', () => {
  // The two the reader honours, and nothing else.
  assert.equal(pm.appSettingMovesProjectsRoot('library_root'), true)
  assert.equal(pm.appSettingMovesProjectsRoot('projects_root_override'), true)

  // Every key that is written on a schedule, or on an ordinary user action, and
  // that therefore must NOT put a synchronous file read back on the request
  // path. `retention_status` is the hourly one the owner's new automatic
  // retention writes.
  for (const key of [
    'retention_status',
    'job_queue_paused',
    'job_queue_pause_token',
    'last_seen_version',
    'ffmpeg_path',
    'ffprobe_path',
    'exports_root',
    'exports_root_previous',
    'llm_concurrency',
    'genstudio_url',
  ]) {
    assert.equal(pm.appSettingMovesProjectsRoot(key), false, `${key} cannot move the Library`)
  }
})

test('the cache is dropped by the write announcement, but only for those keys', () => {
  const pmSource = source('services/project-manager.ts')

  // Still wired to the announcement rather than to a timer — and still called
  // with the key, so the listener can tell the two cases apart.
  assert.match(pmSource, /onAppSettingWritten\(invalidateProjectsRootCache\)/)
  assert.match(source('services/app-settings.ts'), /announceWrite\(key\)/)

  // The early return is the fix: a key that cannot move the Library must leave
  // `cachedLibraryRoot` alone rather than clearing it.
  assert.match(
    pmSource,
    /function invalidateProjectsRootCache\(key: string\): void \{[\s\S]{0,400}if \(!appSettingMovesProjectsRoot\(key\)\) return[\s\S]{0,120}cachedLibraryRoot = null/,
  )
})

test('an unrelated app-settings write leaves the resolved root exactly where it was', async () => {
  await pm.createProject({ name: 'Root Channel', episode_prefix: 'RC' })
  const before = pm.projectsRoot()

  // The real writer, on the real announcement path: the hourly retention status
  // is what used to drop the cache and force a re-read on the next request.
  await settings.setAppSetting('retention_status', {
    handoff: { status: 'ok', at: new Date().toISOString() },
  })

  assert.equal(pm.projectsRoot(), before, 'an unrelated setting cannot move where the Library is')

  // And the settings write really landed — the assertion above is not passing
  // because nothing happened.
  assert.deepEqual((await settings.getAppSetting('retention_status'))?.handoff?.status, 'ok')
})

test('the Library setting itself is still live, and still moves the root', async () => {
  // The freshness contract this cache must never break: a Library that IS moved
  // has to be picked up, and the async reader is the proof that the setting
  // round-trips through the store the sync reader shares.
  const library = path.join(tmp.dir, 'a-moved-library')
  await fs.mkdir(library, { recursive: true })
  await settings.setAppSetting('library_root', library)

  const { getLibraryRoot } = await import('../services/library.js')
  assert.equal(await getLibraryRoot(), library)
})

test('a claimed data dir still moves the root immediately, cache or no cache', async () => {
  const other = await useTempDataDir()
  try {
    assert.equal(
      pm.projectsRoot(),
      path.join(other.dir, 'projects'),
      'the test override is checked before the cache, so isolation cannot be cached away',
    )
  } finally {
    await other.cleanup()
    process.env.STORY_STUDIO_DATA_DIR = tmp.dir
  }
})
