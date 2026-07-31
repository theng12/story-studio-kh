/**
 * Test-isolation guard for the named-roots store.
 *
 * Same bug as `app-settings-isolation.test.ts` documents, in a second module:
 * `services/named-roots.ts` used to resolve its store path ONCE, into a
 * module-scope `const STORE_PATH = resolveNamedRootsPath()`. Because
 * `STORY_STUDIO_DATA_DIR` is only set inside `before()` / `useTempDataDir()` —
 * after every static import has been evaluated — any test file whose static
 * import chain reached this module froze the path to the developer's REAL
 * `<userData>/named-roots.json`.
 *
 * That was not hypothetical: instrumenting a full backend run showed 18 test
 * files binding the real file, and one of them (`media-root.test.ts`) reading
 * it. No test wrote it — the store is only written by the Settings UI — so the
 * damage was a latent read leak one `setNamedRoot()` away from corrupting the
 * developer's real per-machine root map.
 *
 * What this file pins:
 *   1. The path is resolved lazily, per access — NOT captured at module load.
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
  const mod = await import('../services/named-roots.js')
  return mod.namedRootsPath()
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

describe('named-roots path resolution', () => {
  test('resolves the store path per access, not once at module load', async () => {
    // Import FIRST, with no data dir claimed — exactly the ordering that used
    // to freeze the path to the real file.
    delete process.env.STORY_STUDIO_DATA_DIR
    const roots = await import('../services/named-roots.js')

    const a = await useTempDataDir()
    await roots.setNamedRoot('PROBE_A', path.join(a.dir, 'assets'))
    const b = await useTempDataDir()
    await roots.setNamedRoot('PROBE_B', path.join(b.dir, 'assets'))

    const fileA = JSON.parse(await fs.readFile(path.join(a.dir, 'named-roots.json'), 'utf-8'))
    const fileB = JSON.parse(await fs.readFile(path.join(b.dir, 'named-roots.json'), 'utf-8'))

    assert.equal(fileA.PROBE_A, path.join(a.dir, 'assets'), 'first write must land in the first temp dir')
    assert.ok(!('PROBE_B' in fileA), 'the second write must not land back in the first temp dir')
    assert.ok(
      'PROBE_B' in fileB && !('PROBE_A' in fileB),
      'the second write must follow STORY_STUDIO_DATA_DIR to the NEW temp dir, and must have read '
      + 'that dir (not the first one) before merging — a module-load-time path capture would have '
      + 'kept using the first',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('reads follow the currently-claimed data dir too', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    const roots = await import('../services/named-roots.js')

    const a = await useTempDataDir()
    await roots.setNamedRoot('PROBE_READ', path.join(a.dir, 'assets'))
    assert.equal(roots.getNamedRoot('PROBE_READ'), path.join(a.dir, 'assets'))

    const b = await useTempDataDir()
    assert.equal(
      roots.getNamedRoot('PROBE_READ'), undefined,
      'a fresh data dir must read empty — a frozen path would still see the previous dir',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('does not capture the store path in a module-scope constant', async () => {
    const source = await fs.readFile(path.join(SERVER_ROOT, 'services', 'named-roots.ts'), 'utf-8')
    // A module-scope `const X = resolveNamedRootsPath()` is the exact shape of
    // the bug. Calls INSIDE a function body are indented, so anchor to column 0.
    assert.ok(
      !/^const\s+\w+\s*=\s*resolveNamedRootsPath\(\)/m.test(source),
      'named-roots.ts must not resolve its path into a module-scope const — '
      + 'that freezes it before tests can claim STORY_STUDIO_DATA_DIR',
    )
  })
})

describe('named-roots write guard', () => {
  test('refuses to write the real store from a test process', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    const roots = await import('../services/named-roots.js')

    await assert.rejects(
      () => roots.setNamedRoot('PROBE_NEVER', '/tmp/should-never-be-written'),
      /isolation violation/i,
      'writing named roots without a claimed data dir must throw, not silently write the '
      + 'developer\'s real named-roots.json',
    )
  })

  test('the real store file was never touched by this suite', async () => {
    assert.equal(
      await realStoreSnapshot(), REAL_STORE_AT_START,
      `the real named-roots store (${REAL_STORE}) changed while this test file ran`,
    )
  })
})
