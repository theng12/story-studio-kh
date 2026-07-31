/**
 * Test-isolation guard for the last-session store.
 *
 * Same bug as `app-settings-isolation.test.ts` documents, in a third module:
 * `services/last-session.ts` used to resolve its data dir ONCE, into
 * module-scope `const DATA_DIR / LAST_SESSION_PATH / RUNNING_FLAG_PATH`.
 * Because `STORY_STUDIO_DATA_DIR` is only set inside `before()` /
 * `useTempDataDir()` — after every static import has been evaluated — any test
 * file whose static import chain reached this module froze the paths to the
 * developer's REAL repo-root `last-session.json` and `running.flag`.
 *
 * Instrumenting a full backend run showed this store getting off lightly: all
 * 11 binding test processes happened to claim their temp dir before the import,
 * and nothing wrote it. That is luck, not a property — it flips the moment a
 * test file adds a static import that reaches this module. The structural fix
 * plus this guard makes it a property.
 *
 * What this file pins:
 *   1. Both paths are resolved lazily, per access — NOT captured at module load.
 *   2. Under the node test runner, writing outside a claimed data dir is a hard
 *      error rather than a silent write to the developer's real file.
 *   3. Neither of the above disturbs the real store.
 *
 * Cheap, offline, zero-spend.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const originalDataDir = process.env.STORY_STUDIO_DATA_DIR

/**
 * The path the store resolves to with no data dir claimed — i.e. the
 * developer's real file. Asked of the module itself rather than
 * re-implementing the platform branching here, so the two can't drift.
 */
async function realStorePath(): Promise<string> {
  delete process.env.STORY_STUDIO_DATA_DIR
  const mod = await import('../services/last-session.js')
  return mod.getLastSessionPath()
}

const REAL_STORE = await realStorePath()

async function realStoreSnapshot(): Promise<string | null> {
  if (!existsSync(REAL_STORE)) return null
  return fs.readFile(REAL_STORE, 'utf-8')
}

const REAL_STORE_AT_START = await realStoreSnapshot()

after(() => {
  if (originalDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = originalDataDir
})

describe('last-session path resolution', () => {
  test('resolves the store path per access, not once at module load', async () => {
    // Import FIRST, with no data dir claimed — exactly the ordering that used
    // to freeze the path to the real file.
    delete process.env.STORY_STUDIO_DATA_DIR
    const store = await import('../services/last-session.js')

    const a = await useTempDataDir()
    await store.patchLastSession({ projectSlug: 'probe-a', route: '/projects/probe-a' })
    const b = await useTempDataDir()
    await store.patchLastSession({ projectSlug: 'probe-b', route: '/projects/probe-b' })

    const fileA = JSON.parse(await fs.readFile(path.join(a.dir, 'last-session.json'), 'utf-8'))
    const fileB = JSON.parse(await fs.readFile(path.join(b.dir, 'last-session.json'), 'utf-8'))

    assert.equal(fileA.projectSlug, 'probe-a', 'first write must land in the first temp dir')
    assert.equal(
      fileB.projectSlug, 'probe-b',
      'second write must follow STORY_STUDIO_DATA_DIR to the NEW temp dir — a module-load-time '
      + 'path capture would have kept writing to the first one',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('reads and the running-flag path follow the currently-claimed data dir', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    const store = await import('../services/last-session.js')

    const a = await useTempDataDir()
    await store.patchLastSession({ projectSlug: 'probe-read' })
    assert.equal((await store.readLastSession()).projectSlug, 'probe-read')
    assert.equal(store.getRunningFlagPath(), path.join(a.dir, 'running.flag'))

    const b = await useTempDataDir()
    assert.equal(
      (await store.readLastSession()).projectSlug, undefined,
      'a fresh data dir must read empty — a frozen path would still see the previous dir',
    )
    assert.equal(
      store.getRunningFlagPath(), path.join(b.dir, 'running.flag'),
      'the running-flag path must track the data dir too — main.ts writes it at boot',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('does not capture the store paths in module-scope constants', async () => {
    const source = await fs.readFile(path.join(SERVER_ROOT, 'services', 'last-session.ts'), 'utf-8')
    // Module-scope `const DATA_DIR = resolveDataDir()` (and the two paths
    // derived from it) is the exact shape of the bug. Calls INSIDE a function
    // body are indented, so anchor to column 0.
    assert.ok(
      !/^const\s+\w+\s*=\s*resolveDataDir\(\)/m.test(source),
      'last-session.ts must not resolve its data dir into a module-scope const — '
      + 'that freezes it before tests can claim STORY_STUDIO_DATA_DIR',
    )
    assert.ok(
      !/^const\s+\w+\s*=\s*path\.join\(\s*DATA_DIR/m.test(source),
      'last-session.ts must not derive module-scope path constants from a captured data dir',
    )
  })
})

describe('last-session write guard', () => {
  test('refuses to write the real store from a test process', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    const store = await import('../services/last-session.js')

    await assert.rejects(
      () => store.patchLastSession({ projectSlug: 'should-never-be-written' }),
      /isolation violation/i,
      'writing last-session without a claimed data dir must throw, not silently overwrite the '
      + 'developer\'s real last-session.json',
    )
    await assert.rejects(
      () => store.clearRouteState(),
      /isolation violation/i,
      'clearRouteState writes too — it must be guarded the same way',
    )
  })

  test('the real store file was never touched by this suite', async () => {
    assert.equal(
      await realStoreSnapshot(), REAL_STORE_AT_START,
      `the real last-session store (${REAL_STORE}) changed while this test file ran`,
    )
  })
})
