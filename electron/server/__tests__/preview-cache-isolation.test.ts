/**
 * Test-isolation guard for the preview-render cache.
 *
 * Background — the bug this locks out:
 *   `services/preview-cache.ts` used to resolve its cache-root directory once,
 *   into a module-scope `let cachedRoot`, on the FIRST call rather than at
 *   module load — a softer variant of the same class of bug fixed in
 *   `services/app-settings.ts` (and `named-roots.ts`, `last-session.ts`).
 *   `STORY_STUDIO_DATA_DIR` is what redirects the cache into an isolated
 *   directory, and a test only sets it inside `before()` / `useTempDataDir()`.
 *   Whichever test happened to resolve the root first — in any file sharing
 *   the same test worker process — froze the directory (and, since
 *   `resolveCacheRoot` also `mkdirSync`'d it, created it on disk) for every
 *   later test, including ones that had already claimed their own temp dir.
 *
 * What this file pins:
 *   1. The cache root is resolved lazily, per access — NOT captured on first
 *      call.
 *   2. Under the node test runner, rendering into the cache outside a claimed
 *      data dir is a hard error rather than a silent write to the developer's
 *      real `.preview-cache` directory.
 *   3. Neither of the above disturbs the real cache directory.
 *
 * These are cheap, offline, and zero-spend — `render` below never shells out
 * to ffmpeg, it just writes a marker file.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REAL_CACHE_DIR = path.join(SERVER_ROOT, '..', '.preview-cache')

/** Snapshot the real cache dir's file list so every assertion can prove it
 *  was never written to by this suite (existing dev-machine files are fine —
 *  only a NEW entry from this run would indicate a leak). */
async function realCacheFiles(): Promise<string[]> {
  if (!existsSync(REAL_CACHE_DIR)) return []
  return (await fs.readdir(REAL_CACHE_DIR)).sort()
}

const REAL_CACHE_FILES_AT_START = await realCacheFiles()

const originalDataDir = process.env.STORY_STUDIO_DATA_DIR

after(() => {
  if (originalDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = originalDataDir
})

describe('preview-cache path resolution', () => {
  test('resolves the cache root per access, not once on first call', async () => {
    // Import FIRST, with no data dir claimed — the ordering that used to
    // freeze the root to the real (or cwd-fallback) directory forever.
    delete process.env.STORY_STUDIO_DATA_DIR
    const cache = await import('../services/preview-cache.js')

    const a = await useTempDataDir()
    const pathA = cache.cachePath('probe-key', 'webm')
    const b = await useTempDataDir()
    const pathB = cache.cachePath('probe-key', 'webm')

    assert.equal(path.dirname(pathA), path.join(a.dir, 'preview-cache'))
    assert.equal(
      path.dirname(pathB), path.join(b.dir, 'preview-cache'),
      'a second claimed temp dir must move the cache root — a first-call capture would have kept it in dir A',
    )

    await a.cleanup()
    await b.cleanup()
  })

  test('does not memoise the cache root in a module-scope variable', async () => {
    const source = await fs.readFile(path.join(SERVER_ROOT, 'services', 'preview-cache.ts'), 'utf-8')
    assert.ok(
      !/^let\s+cachedRoot/m.test(source),
      'preview-cache.ts must not cache its resolved root in a module-scope variable — '
      + 'that freezes it before a later test can claim its own STORY_STUDIO_DATA_DIR',
    )
  })
})

describe('preview-cache write guard', () => {
  test('refuses to render into the cache from a test process with no claimed data dir', async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    const cache = await import('../services/preview-cache.js')

    await assert.rejects(
      () => cache.getOrRender('isolation-probe', 'webm', async (targetPath) => {
        await fs.writeFile(targetPath, 'should never be written')
      }),
      /isolation violation/i,
      'rendering into the preview cache without a claimed data dir must throw, not silently '
      + 'write into the developer\'s real .preview-cache directory',
    )
  })

  test('the real cache directory gained no new files from this suite', async () => {
    assert.deepEqual(
      await realCacheFiles(), REAL_CACHE_FILES_AT_START,
      'the real .preview-cache directory changed while this test file ran',
    )
  })
})
