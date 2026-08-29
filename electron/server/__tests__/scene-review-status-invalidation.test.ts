import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * v1.4.82 — the server half of the "Pending only / Steps 10 of 12" vs
 * "Greenlit 100%" split-brain.
 *
 * Only `approve` dropped the episode's cached status. Queueing scene images,
 * queueing the missing ones, starting a continuity render and uploading an
 * image all left the cache holding the PRE-change answer, so the episode's own
 * page recomputed from disk while the selector, the pending filter and the
 * Production Board went on reporting what was true a minute ago.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = path.resolve(HERE, '../routes/scene-review.ts')

/** Every write route that can change what the episode's status says. */
const WRITE_ROUTES = [
  'generate-image',
  'generate-missing',
  'continuity-render',
  'upload-image/:sceneId',
  'approve',
]

describe('scene-review write routes invalidate the episode status cache', () => {
  test('the helper exists and drops exactly this episode, not the whole project', async () => {
    const source = await readFile(ROUTE, 'utf-8')
    assert.match(source, /async function invalidateEpisodeStatus\(slug: string, episodeId: string\)/)
    assert.match(source, /episodeStatusCache\.invalidate\(slug, episodeId\)/)
    assert.doesNotMatch(source, /episodeStatusCache\.invalidateProject/,
      'a single scene change must not pay to recompute every episode in the project')
  })

  test('every write route calls it before answering', async () => {
    const source = await readFile(ROUTE, 'utf-8')
    // Slice the file at each route declaration so a call in a NEIGHBOURING
    // handler cannot satisfy the assertion for this one.
    const starts = [...source.matchAll(/router\.(?:post|put)\('\/projects\/:slug\/scene-review\/:episodeId\/([^']+)'/g)]
    assert.ok(starts.length >= WRITE_ROUTES.length, `expected at least ${WRITE_ROUTES.length} routes, found ${starts.length}`)

    const missing: string[] = []
    for (const route of WRITE_ROUTES) {
      const index = starts.findIndex(m => m[1] === route)
      assert.ok(index >= 0, `route ${route} not found — did it get renamed?`)
      const from = starts[index]!.index!
      const to = starts[index + 1]?.index ?? source.length
      if (!/await invalidateEpisodeStatus\(slug, episodeId\)/.test(source.slice(from, to))) missing.push(route)
    }
    assert.deepEqual(missing, [], `these routes change episode status without dropping its cache: ${missing.join(', ')}`)
  })

  test('the guard would notice a route that stopped invalidating', async () => {
    // Calibration: prove the slice-per-route matcher can actually fail. The
    // clip routes are deliberately NOT in WRITE_ROUTES (a clip does not move
    // any status field the episode list reads), so they must come back absent.
    const source = await readFile(ROUTE, 'utf-8')
    const starts = [...source.matchAll(/router\.(?:post|put)\('\/projects\/:slug\/scene-review\/:episodeId\/([^']+)'/g)]
    const index = starts.findIndex(m => m[1] === 'generate-clip')
    assert.ok(index >= 0, 'generate-clip should still exist as a route')
    const slice = source.slice(starts[index]!.index!, starts[index + 1]?.index ?? source.length)
    assert.doesNotMatch(slice, /await invalidateEpisodeStatus/,
      'the matcher must be able to report a route as NOT invalidating')
  })
})
