/**
 * Test-isolation guard for the app-level settings store.
 *
 * Background — the bug this locks out:
 *   `services/app-settings.ts` used to resolve its settings-file path ONCE, in
 *   a module-scope `const`, at module-load time. `STORY_STUDIO_DATA_DIR` is
 *   what redirects the store into an isolated directory, and a test only sets
 *   it inside `before()` / at the top of a test — which runs AFTER every static
 *   import in the file has already been evaluated. So any test file whose
 *   static import chain reached this module (e.g. `job-notifier.test.ts` →
 *   `services/job-notifier.js` → `services/app-settings.js`) froze the path to
 *   the developer's REAL app-settings.json and then read and wrote it for the
 *   rest of the process.
 *
 *   The damage was not local. Writing the real file corrupted live config
 *   (the GenStudio base URL got rewritten to a mock server's ephemeral port)
 *   and let real on-disk state — including the `server_mode` block that arms
 *   session auth — reach test processes that never asked for it. The symptom
 *   surfaced as unrelated route tests intermittently returning 401/403 instead
 *   of their expected status, with the cause several files away.
 *
 * What this file pins:
 *   1. The path is resolved lazily, per access — NOT captured at module load.
 *   2. Under the node test runner, writing settings outside a claimed data dir
 *      is a hard error rather than a silent write to the developer's real file.
 *   3. Neither of the above disturbs the real settings file.
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
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..')
const REAL_SETTINGS = path.join(REPO_ROOT, 'app-settings.json')

/**
 * Snapshot the real settings file so every assertion below can prove it was
 * never touched. `null` when the developer has no settings file at all.
 */
async function realSettingsSnapshot(): Promise<string | null> {
  if (!existsSync(REAL_SETTINGS)) return null
  return fs.readFile(REAL_SETTINGS, 'utf-8')
}

const REAL_SETTINGS_AT_START = await realSettingsSnapshot()

const originalDataDir = process.env.STORY_STUDIO_DATA_DIR

after(() => {
  if (originalDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = originalDataDir
})

describe('app-settings path resolution', () => {
  test('resolves the settings path per access, not once at module load', async () => {
    // Import FIRST, with no data dir claimed — this is exactly the ordering
    // that used to freeze the path to the real file. If the module captures
    // its path at load time, both writes below land in the same place and the
    // second assertion fails.
    delete process.env.STORY_STUDIO_DATA_DIR
    const settings = await import('../services/app-settings.js')

    const a = await useTempDataDir()
    await settings.setAppSetting('__isolation_probe__', 'dir-a')
    const b = await useTempDataDir()
    await settings.setAppSetting('__isolation_probe__', 'dir-b')

    const fileA = JSON.parse(await fs.readFile(path.join(a.dir, 'app-settings.json'), 'utf-8'))
    const fileB = JSON.parse(await fs.readFile(path.join(b.dir, 'app-settings.json'), 'utf-8'))

    assert.equal(fileA.__isolation_probe__, 'dir-a', 'first write must land in the first temp dir')
    assert.equal(
      fileB.__isolation_probe__, 'dir-b',
      'second write must follow STORY_STUDIO_DATA_DIR to the NEW temp dir — a module-load-time '
      + 'path capture would have kept writing to the first one',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('does not capture the settings path in a module-scope constant', async () => {
    const source = await fs.readFile(path.join(SERVER_ROOT, 'services', 'app-settings.ts'), 'utf-8')
    // A module-scope `const X = resolveAppSettingsPath()` is the exact shape of
    // the bug. Calls INSIDE a function body are indented, so anchor to column 0.
    assert.ok(
      !/^const\s+\w+\s*=\s*resolveAppSettingsPath\(\)/m.test(source),
      'app-settings.ts must not resolve its path into a module-scope const — '
      + 'that freezes it before tests can claim STORY_STUDIO_DATA_DIR',
    )
  })
})

describe('app-settings write guard', () => {
  test('refuses to write the real settings file from a test process', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    const settings = await import('../services/app-settings.js')

    await assert.rejects(
      () => settings.setAppSetting('__isolation_probe__', 'should-never-be-written'),
      /isolation violation/i,
      'writing app settings without a claimed data dir must throw, not silently '
      + 'corrupt the developer\'s real app-settings.json',
    )
  })

  test('the real settings file was never touched by this suite', async () => {
    assert.equal(
      await realSettingsSnapshot(), REAL_SETTINGS_AT_START,
      'the real app-settings.json changed while this test file ran',
    )
  })
})
