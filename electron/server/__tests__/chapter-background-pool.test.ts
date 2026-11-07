/**
 * Chapter Background Pools — reusable backgrounds with serial rotation per channel
 * (release 1.4.386, item 14).
 *
 * Pinned here:
 *   - no pool = today's behaviour (decide returns null, nothing is invented);
 *   - one background = every episode gets it;
 *   - serial is the default and rotates in pool order, wrapping, skipping disabled items;
 *   - a pool edit mid-run never repeats and never skips (the cursor carries id AND index);
 *   - percentages the UI prints are the shared function's own answer, adding to 100;
 *   - peek does not advance the cursor; an actual record does, and re-recording the same
 *     episode keeps its own background without moving the rotation (same contract as
 *     the music pool's re-merge test);
 *   - portable references resolve: catalog ids, ${CHANNEL}/…, plain filenames, absolutes.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import * as pool from '../contracts/chapter-background-pool.js'

/** A serial pool from plain ids, as the editor would send it. */
function poolOf(ids: string[], overrides: Record<string, unknown> = {}): pool.ChapterBackgroundPool {
  return {
    usage_mode: 'serial',
    allow_repeat: false,
    items: ids.map(id => ({ id, name: id, reference: `${id}.jpg`, enabled: true, weight: 100 })),
    ...overrides,
  } as pool.ChapterBackgroundPool
}

/** Run `count` serial decisions through the pool, carrying the cursor forward like the writer does. */
function rotate(poolValue: pool.ChapterBackgroundPool, count: number, rng: () => number = () => 0): string[] {
  const picked: string[] = []
  let cursor: pool.ChapterBackgroundCursor | null = null
  for (let index = 0; index < count; index++) {
    const decision = pool.decideChapterBackground(poolValue, cursor, rng)
    if (!decision) break
    picked.push(decision.item.id)
    cursor = decision.cursor
  }
  return picked
}

describe('chapter background pools — the rotation contract', () => {
  test('no pool leaves today\'s behaviour: decide is null, nothing invented', () => {
    assert.equal(pool.decideChapterBackground(undefined, null), null)
    assert.equal(pool.decideChapterBackground(null, null), null)
    assert.equal(pool.decideChapterBackground(poolOf([]), null), null)
    assert.equal(pool.decideChapterBackground(poolOf(['a', 'b'], { usage_mode: 'manual' }), null), null)
    // Every item disabled is also "no answer", never a pick of an off item.
    assert.equal(pool.decideChapterBackground(poolOf(['a', 'b'], {
      items: [{ id: 'a', name: 'a', reference: 'a.jpg', enabled: false, weight: 100 }],
    }), null), null)
    assert.deepEqual(pool.normaliseChapterBackgroundPool(null), pool.emptyChapterBackgroundPool())
  })

  test('one background means every episode uses it', () => {
    assert.deepEqual(rotate(poolOf(['deep-space']), 3), ['deep-space', 'deep-space', 'deep-space'])
    assert.deepEqual(rotate(poolOf(['only'], { usage_mode: 'weighted' }), 3, () => 0), ['only', 'only', 'only'])
  })

  test('serial walks the pool in order and wraps, with no configuration', () => {
    assert.equal(pool.normaliseUsageMode('shuffle'), 'serial')
    assert.equal(pool.normaliseUsageMode(undefined), 'serial')
    assert.deepEqual(rotate(poolOf(['a', 'b', 'c']), 7), ['a', 'b', 'c', 'a', 'b', 'c', 'a'])
    // Disabled items are skipped without rewriting the stored order.
    const withOff = poolOf(['a', 'b', 'c'])
    withOff.items[1]!.enabled = false
    assert.deepEqual(rotate(withOff, 5), ['a', 'c', 'a', 'c', 'a'])
  })

  test('a pool edit mid-run never repeats and never skips', () => {
    // Serial took 'b' at index 1 of [a, b, c]; 'b' is then removed.
    // The entry that slid into its place (index 1 = 'c') is next — nothing skipped.
    const removed = poolOf(['a', 'b', 'c'])
    const afterB = pool.decideChapterBackground(removed, { last_background_id: 'b', last_index: 1 })
    assert.equal(afterB!.item.id, 'c')
    removed.items = removed.items.filter(it => it.id !== 'b')
    assert.equal(pool.decideChapterBackground(removed, afterB!.cursor)!.item.id, 'a')
    // 'b' was removed before its turn: the entry at the stored index is used, wrapping.
    assert.equal(pool.nextSerialIndex(
      poolOf(['a', 'c']).items,
      { last_background_id: 'gone', last_index: 2 },
    ), 0)
    // A cursor stored as a bare index (early shape) still answers.
    assert.equal(pool.normaliseCursor(3).last_index, 3)
    assert.deepEqual(pool.normaliseCursor(0), { last_background_id: null, last_index: 0 })
  })

  test('weighted percentages are shown truthfully and add to 100', () => {
    const weighted = poolOf(['a', 'b', 'c'], { usage_mode: 'weighted', items: [
      { id: 'a', name: 'a', reference: 'a', enabled: true, weight: 60 },
      { id: 'b', name: 'b', reference: 'b', enabled: true, weight: 25 },
      { id: 'c', name: 'c', reference: 'c', enabled: true, weight: 15 },
    ] })
    assert.deepEqual(pool.percentagesFor(weighted), [60, 25, 15])
    assert.deepEqual(pool.percentagesFor(poolOf(['a', 'b', 'c'], { usage_mode: 'weighted' })), [34, 33, 33])
    assert.equal(pool.percentagesFor(poolOf(['a', 'b'], { usage_mode: 'weighted' }))
      .reduce((sum, value) => sum + value, 0), 100)
    assert.deepEqual(pool.percentagesFor(poolOf([])), [])
    // Weighted avoids the previous pick unless the customer opts into repeats.
    const first = pool.decideChapterBackground(weighted, null, () => 0)
    const second = pool.decideChapterBackground(weighted, first!.cursor, () => 0)
    assert.notEqual(second!.item.id, first!.item.id)
    const repeat = pool.decideChapterBackground(
      { ...weighted, allow_repeat: true }, first!.cursor, () => 0,
    )
    assert.equal(repeat!.item.id, first!.item.id)
  })
})

describe('chapter background pools — the channel service', () => {
  let cleanup: () => Promise<void>
  let pm: typeof import('../services/project-manager.js')
  let svc: typeof import('../services/chapter-background-pool.js')

  before(async () => {
    cleanup = (await useTempDataDir()).cleanup
    pm = await import('../services/project-manager.js')
    svc = await import('../services/chapter-background-pool.js')
  })
  after(async () => { await cleanup() })

  test('peek reads the next pick without moving the cursor; record advances it once', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgPool' })
    const bgDir = path.join(pm.getProjectDir(proj.slug)!, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    for (const name of ['one.jpg', 'two.jpg', 'three.jpg']) {
      await fs.writeFile(path.join(bgDir, name), 'x')
    }
    await svc.updateChapterBackgroundPool(proj.slug, poolOf(['one.jpg', 'two.jpg', 'three.jpg']))
    assert.equal((await svc.getChapterBackgroundPool(proj.slug)).items.length, 3)
    // A fresh channel has no cursor — the honest "not started", not a zero pick.
    assert.deepEqual(await svc.getChapterBackgroundCursor(proj.slug), { last_background_id: null, last_index: null })

    // Peek is read-only.
    assert.equal((await svc.peekNextChapterBackground(proj.slug, 'EP0001'))?.item.id, 'one.jpg')
    assert.equal((await svc.peekNextChapterBackground(proj.slug, 'EP0001'))?.item.id, 'one.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, null)

    // Record advances; a second record of the SAME episode keeps its pick and does not move on.
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001'))?.item.id, 'one.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 0)
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001'))?.item.id, 'one.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 0)
    // Peek for a recorded episode returns ITS background, not the rotation's next.
    assert.equal((await svc.peekNextChapterBackground(proj.slug, 'EP0001'))?.item.id, 'one.jpg')

    // Next new episode takes the next background in order.
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0002'))?.item.id, 'two.jpg')
    assert.equal((await svc.peekNextChapterBackground(proj.slug, 'EP0003'))?.item.id, 'three.jpg')
    // And the log is capped, newest first.
    const log = await svc.getChapterBackgroundUsageLog(proj.slug)
    assert.equal(log[0]?.episode_code, 'EP0002')

    // Reset rotation starts over for a fresh run.
    await svc.resetChapterBackgroundCursor(proj.slug)
    assert.equal((await svc.peekNextChapterBackground(proj.slug, 'EP0005'))?.item.id, 'one.jpg')
  })

  test('an explicit pick is recorded and survives later rotation', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgPick' })
    await svc.updateChapterBackgroundPool(proj.slug, poolOf(['a.jpg', 'b.jpg']))
    const decision = await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'b.jpg')
    assert.equal(decision?.item.id, 'b.jpg')
    assert.equal((await svc.peekNextChapterBackground(proj.slug, 'EP0001'))?.item.id, 'b.jpg')
    // Rotation still moves on from the explicit pick's index.
    assert.equal((await svc.peekNextChapterBackground(proj.slug, 'EP0002'))?.item.id, 'a.jpg')
  })

  test('references resolve: channel files, ${CHANNEL} form, and catalog ids', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgResolve' })
    const bgDir = path.join(pm.getProjectDir(proj.slug)!, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    await fs.writeFile(path.join(bgDir, 'plate.jpg'), 'x')

    const byName = await svc.resolveChapterBackground(proj.slug, 'plate.jpg')
    assert.equal(byName, path.join(bgDir, 'plate.jpg'))
    const byChannelRef = await svc.resolveChapterBackground(proj.slug, '${CHANNEL}/backgrounds/plate.jpg')
    assert.equal(byChannelRef, path.join(bgDir, 'plate.jpg'))

    // Catalog references resolve through the shipped catalog — only when this build ships one.
    const catalog = await import('../services/background-catalog.js')
    const entries = catalog.listBackgrounds()
    if (entries.length) {
      const resolved = await svc.resolveChapterBackground(proj.slug, entries[0]!.id)
      assert.equal(resolved, catalog.resolveBackground(entries[0]!.id))
      const resolvedRef = await svc.resolveChapterBackground(proj.slug, entries[0]!.reference)
      assert.equal(resolvedRef, catalog.resolveBackground(entries[0]!.id))
    }

    // An unresolvable reference fails loudly, naming the background (AGENTS §8).
    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, 'does-not-exist.jpg'),
      /does-not-exist/,
    )
  })

  test('pool state reports catalog, channel files and folder for the editor', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgState' })
    const bgDir = path.join(pm.getProjectDir(proj.slug)!, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    await fs.writeFile(path.join(bgDir, 'x.mp4'), 'x')
    await svc.updateChapterBackgroundPool(proj.slug, poolOf(['x.mp4']))

    const state = await svc.getChapterBackgroundPoolState(proj.slug)
    assert.equal(state.pool.items.length, 1)
    assert.deepEqual(state.channel_files, ['x.mp4'])
    assert.equal(state.folder, bgDir)
    assert.ok(Array.isArray(state.available_catalog))
    assert.deepEqual(state.cursor, { last_background_id: null, last_index: null })
  })
})
