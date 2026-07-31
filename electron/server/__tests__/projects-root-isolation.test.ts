/**
 * Test-isolation guard for the projects root.
 *
 * The same module-load path-capture bug already fixed in `app-settings.ts`,
 * `named-roots.ts`, `last-session.ts`, `preview-cache.ts` and `logger.ts`, in
 * the module with by far the largest blast radius:
 * `services/project-manager.ts` used to export
 *
 *     export const PROJECTS_ROOT = resolveProjectsRoot()
 *
 * and then, still at module scope, `mkdirSync(PROJECTS_ROOT)` and
 * `migrateLegacyProjects()`. `STORY_STUDIO_DATA_DIR` is what redirects project
 * storage into an isolated directory and it is only set inside `before()` /
 * `useTempDataDir()` — after every static import has been evaluated — so any
 * test file whose import chain reached this module froze the path to the
 * developer's REAL projects directory, and merely importing it created
 * directories and ran a copying migration there.
 *
 * Measured on the full backend suite before the fix: 147 test processes loaded
 * this module and 73 of them bound the real projects directory. On this
 * machine that is not a throwaway userData path — `projects_root_override`
 * points it at the owner's actual working folder.
 *
 * What this file pins:
 *   1. `STORY_STUDIO_DATA_DIR` set AFTER the module is imported is still
 *      honoured, and keeps being honoured when it changes again.
 *   2. Resolving the path is side-effect free — no directory is created.
 *   3. Importing the module neither creates directories nor runs the legacy
 *      migration; the migration is exported for an explicit boot call site.
 *   4. Under the node test runner, anything that would write the real projects
 *      directory is a hard error rather than a silent success.
 *   5. None of the above disturbs the real projects directory.
 *
 * Cheap, offline, zero-spend.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PM_SOURCE = path.join(SERVER_ROOT, 'services', 'project-manager.ts')

const originalDataDir = process.env.STORY_STUDIO_DATA_DIR

/**
 * Import with NO data dir claimed — exactly the ordering that used to freeze
 * the path to the developer's real projects directory. Everything below runs
 * against this one already-evaluated module instance, so if any import-time
 * capture survived, these tests would see it.
 */
delete process.env.STORY_STUDIO_DATA_DIR
const pm = await import('../services/project-manager.js')

/** The real projects directory, asked of the module rather than re-derived. */
const REAL_ROOT = pm.projectsRoot()

function realRootSnapshot(): string | null {
  if (!existsSync(REAL_ROOT)) return null
  return readdirSync(REAL_ROOT).sort().join('\n')
}

const REAL_ROOT_AT_START = realRootSnapshot()

after(() => {
  if (originalDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = originalDataDir
})

describe('projects root resolution', () => {
  test('honours STORY_STUDIO_DATA_DIR set AFTER the module was imported', async () => {
    // The module above was imported with no data dir. A module-load capture
    // would have frozen REAL_ROOT and would keep returning it here.
    const a = await useTempDataDir()
    assert.equal(
      pm.projectsRoot(), path.join(a.dir, 'projects'),
      'projectsRoot() must follow a STORY_STUDIO_DATA_DIR claimed after import — '
      + 'a module-load-time capture would still return the real projects directory',
    )
    assert.notEqual(pm.projectsRoot(), REAL_ROOT)

    // ...and keep following it when it changes again, which a resolve-once-on-
    // first-call memo would fail.
    const b = await useTempDataDir()
    assert.equal(
      pm.projectsRoot(), path.join(b.dir, 'projects'),
      'projectsRoot() must re-resolve on every access, not memoise on first call',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('resolving the path creates nothing on disk', async () => {
    const tmp = await useTempDataDir()
    const root = pm.projectsRoot()
    // Resolve a few more times for good measure — a read must never
    // side-effect the filesystem.
    pm.projectsRoot()
    pm.projectsRoot()
    assert.equal(
      existsSync(root), false,
      'merely resolving the projects root must not create it — the old module-scope '
      + 'mkdirSync is what let a stray import materialise folders in real storage',
    )
    await tmp.cleanup()
  })

  test('ensureProjectsRoot() creates the directory only when asked', async () => {
    const tmp = await useTempDataDir()
    const root = pm.ensureProjectsRoot()
    assert.equal(root, path.join(tmp.dir, 'projects'))
    assert.equal(existsSync(root), true, 'ensureProjectsRoot() must create the directory')
    await tmp.cleanup()
  })
})

describe('projects root import side effects', () => {
  test('the module does not capture the root in a module-scope const', async () => {
    const source = await fs.readFile(PM_SOURCE, 'utf-8')
    // A module-scope `const X = resolveProjectsRoot()` is the exact shape of
    // the bug. Calls INSIDE a function body are indented, so anchor to column 0.
    assert.ok(
      !/^(export\s+)?const\s+\w+\s*=\s*resolveProjectsRoot\(\)/m.test(source),
      'project-manager.ts must not resolve the projects root into a module-scope const — '
      + 'that freezes it before tests (or the Electron boot) can set STORY_STUDIO_DATA_DIR',
    )
  })

  test('the module does not create directories or migrate at import time', async () => {
    const source = await fs.readFile(PM_SOURCE, 'utf-8')
    // Top-level statements sit at column 0; anything inside a function is
    // indented. Both of these used to run on import.
    assert.ok(
      !/^if\s*\(!existsSync\(.*\)\)\s*mkdirSync/m.test(source) && !/^mkdirSync\(/m.test(source),
      'project-manager.ts must not mkdir the projects root at module scope',
    )
    assert.ok(
      !/^migrateLegacyProjects\(\)/m.test(source),
      'migrateLegacyProjects() must not run at import time — it copies directories and writes '
      + 'a marker file, and importing this module happens in 147 test processes',
    )
  })

  test('migrateLegacyProjects is exported so a real boot can call it explicitly', () => {
    assert.equal(
      typeof pm.migrateLegacyProjects, 'function',
      'the migration must be callable from the real startup path (electron/main.ts and the '
      + 'standalone-listen branch of server/app.ts) now that it no longer runs on import',
    )
  })

  test('the exported PROJECTS_ROOT const is gone', () => {
    // Deleted rather than deprecated: ESM named exports cannot be backed by a
    // lazy getter, so leaving the name in place could only ever hand back a
    // stale path. Removing it makes any missed consumer a compile error.
    assert.equal(
      (pm as Record<string, unknown>).PROJECTS_ROOT, undefined,
      'PROJECTS_ROOT must not be re-introduced as a value export — use projectsRoot()',
    )
  })
})

describe('projects root write guard', () => {
  test('refuses to create the real projects root from a test process', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    assert.throws(
      () => pm.ensureProjectsRoot(),
      /isolation violation/i,
      'a write path reaching the real projects directory without a claimed data dir must throw, '
      + 'not silently operate on the developer\'s real work',
    )
  })

  test('refuses to run the legacy migration against the real projects root', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    assert.throws(
      () => pm.migrateLegacyProjects(),
      /isolation violation/i,
      'the migration copies directories and writes a marker file — from a test process that '
      + 'must be a hard error',
    )
  })

  test('a stale path is caught even while another data dir is claimed', async () => {
    const tmp = await useTempDataDir()
    // Simulates exactly what a frozen path did: a claimed temp data dir, but a
    // write aimed at the real projects directory anyway. The guard compares
    // the resolved target, so this is caught rather than waved through.
    const { assertWriteIsolatedInTests } = await import('../lib/test-isolation.js')
    assert.throws(
      () => assertWriteIsolatedInTests(REAL_ROOT, 'projects-root'),
      /isolation violation/i,
      'the guard must compare the resolved target against the claimed data dir, not merely '
      + 'check that STORY_STUDIO_DATA_DIR is set',
    )
    await tmp.cleanup()
  })

  test('the real projects directory was never touched by this suite', () => {
    assert.equal(
      realRootSnapshot(), REAL_ROOT_AT_START,
      `the real projects directory (${REAL_ROOT}) changed while this test file ran`,
    )
  })
})
