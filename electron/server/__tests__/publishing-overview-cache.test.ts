/**
 * The Publishing Overview's result cache.
 *
 * ── Why it exists ──
 *
 * One read of this page resolves EVERY accepted episode of EVERY channel:
 * sidecar resolution plus a rendered-video probe apiece, tens of thousands of
 * async fs calls on a 19-channel / 854-episode Library. Those calls share the
 * process's libuv threadpool with whatever the app is already doing, and on the
 * production Mac mini (2026-10-18) a running upload reading gigabytes through
 * the same pool turned the sweep into a stall for every other request.
 *
 * Repeating that sweep for a second look at the same page bought nothing. So a
 * built overview is reused for `PUBLISHING_OVERVIEW_TTL_MS`, and concurrent
 * callers SHARE one computation rather than each starting their own.
 *
 * ── What is pinned ──
 *
 * The single-flight property is pinned by object IDENTITY, not by a timestamp:
 * two callers that shared a computation receive the very same response object.
 * A timestamp assertion would pass by luck whenever two independent sweeps
 * happened to start in the same millisecond.
 *
 * The freshness half is pinned the same way round: a store change made after the
 * first read is deliberately NOT visible inside the TTL (that is the cache doing
 * its job), and IS visible the moment the deliberate refresh invalidates it.
 *
 * Real temp filesystem, real readers — no mocked stores.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let svc: typeof import('../services/publishing-overview.js')

let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  svc = await import('../services/publishing-overview.js')
})

beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
  // A fresh data dir per test is also a fresh cache key (the cache is keyed on
  // the resolved Library root), so no test can inherit the previous one's sweep.
  svc.invalidatePublishingOverviewCache()
})

after(async () => { await tmp?.cleanup() })

test('the reuse window is a short, positive bound — not "forever"', () => {
  assert.ok(svc.PUBLISHING_OVERVIEW_TTL_MS > 0)
  assert.ok(
    svc.PUBLISHING_OVERVIEW_TTL_MS <= 60_000,
    'a page whose job is to say what is scheduled must not hold an answer for longer than a minute',
  )
})

test('concurrent callers share ONE sweep, and a repeat inside the window reuses it', async () => {
  await pm.createProject({ name: 'Cache Channel', episode_prefix: 'CC' })

  // Same object, not merely equal values: that is what proves one computation
  // was shared rather than two that happened to agree.
  const [first, second] = await Promise.all([
    svc.readPublishingOverview(),
    svc.readPublishingOverview(),
  ])
  assert.equal(first, second, 'two concurrent readers must await the same sweep')
  assert.equal(first.channels.length, 1)

  const third = await svc.readPublishingOverview()
  assert.equal(third, first, 'a later reader inside the window is served the cached sweep')
})

test('an invalidation makes the next read recompute, and the change is then visible', async () => {
  await pm.createProject({ name: 'First Channel', episode_prefix: 'FC' })
  const before = await svc.readPublishingOverview()
  assert.equal(before.channels.length, 1)

  await pm.createProject({ name: 'Second Channel', episode_prefix: 'SC' })

  // Inside the window the cached sweep stands — the cache is doing its job.
  const stillCached = await svc.readPublishingOverview()
  assert.equal(stillCached, before)
  assert.equal(stillCached.channels.length, 1)

  // The deliberate refresh path (POST /youtube/sync) invalidates; the very next
  // read must show what is actually there now.
  svc.invalidatePublishingOverviewCache()
  const after = await svc.readPublishingOverview()
  assert.notEqual(after, before, 'an invalidated read must recompute, not replay')
  assert.equal(after.channels.length, 2)
  assert.deepEqual(after.channels.map(c => c.slug).sort(), ['first-channel', 'second-channel'])
})

test('a caller pinning the clock always recomputes', async () => {
  await pm.createProject({ name: 'Pinned Channel', episode_prefix: 'PC' })
  const now = Date.now()

  const cached = await svc.readPublishingOverview()
  const pinned = await svc.readPublishingOverview({ now })

  assert.notEqual(pinned, cached, 'a pinned clock asks a different question, so it cannot reuse an answer')
  assert.equal(pinned.generated_at, new Date(now).toISOString())
  // And it did not replace the cache: an unpinned read still reuses the sweep
  // the page already paid for.
  assert.equal(await svc.readPublishingOverview(), cached)
})

test('a project write the overview displays is visible on the very next read — no TTL wait, no manual invalidation', async () => {
  const created = await pm.createProject({ name: 'Labelled Channel', episode_prefix: 'LC' })
  const warmed = await svc.readPublishingOverview()
  assert.equal(warmed.channels[0]!.channel_status, null, 'starts unlabelled')

  // PUT /projects/:slug { channel_status } — the write path behind the status
  // chips, shared with every other updateProject caller.
  await pm.updateProject(created.slug, { channel_status: 'live' })

  const fresh = await svc.readPublishingOverview()
  assert.notEqual(fresh, warmed, 'a project.json write must drop the cached sweep, not serve it until the TTL')
  assert.equal(fresh.channels[0]!.channel_status, 'live')

  await pm.updateProject(created.slug, { channel_status: 'live' })
  assert.equal(await svc.readPublishingOverview(), fresh, 'a no-op save still reuses the cached sweep')

  await pm.updateProject(created.slug, { name: 'Renamed Channel' })
  const renamed = await svc.readPublishingOverview()
  assert.notEqual(renamed, fresh)
  assert.equal(renamed.channels[0]!.name, 'Renamed Channel')
  assert.equal(renamed.channels[0]!.channel_status, 'live')
})

test('the unknown-store semantics survive the cache unchanged', async () => {
  // A cache must not flatten a null into a zero or vice versa: the same response
  // is handed to every reader, so the honesty rules are exactly as they were.
  const created = await pm.createProject({ name: 'Honest Channel', episode_prefix: 'HC' })
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const first = await svc.readPublishingOverview()
  assert.equal(first.channels[0]!.readiness.episodes, 0)
  assert.equal(first.channels[0]!.readiness.error, undefined)

  await fs.writeFile(path.join(pm.projectsRoot(), created.slug, 'ideas.json'), '{ not json')
  svc.invalidatePublishingOverviewCache()

  const second = await svc.readPublishingOverview()
  assert.equal(second.channels[0]!.readiness.episodes, null, 'an unreadable store is unknown, not a confident 0')
  assert.equal(typeof second.channels[0]!.readiness.error, 'string')
})
