/**
 * Chapter Background Pools — serial rotation with stable (episode, chapter)
 * identity (release 1.4.386, item 14; HANDOFF "four-background serial chapter
 * rotation").
 *
 * Pinned here:
 *   - no pool = today's behaviour (decide returns null, nothing invented);
 *   - serial walks the enabled list in order, wrapping, skipping disabled items;
 *   - a pool edit mid-run never repeats and never skips (cursor carries id AND index);
 *   - TWO CHAPTERS IN ONE EPISODE take two successive backgrounds — identity is
 *     (episode, chapter), never the episode alone;
 *   - TWO RETRIES of the same chapters keep their backgrounds and do NOT move
 *     the rotation, and a concurrent burst of records loses nothing (the whole
 *     read-modify-write runs inside the project's config lock);
 *   - resolution is restricted to approved catalog backgrounds or THIS
 *     channel's own inventory with realpath containment: traversal, foreign
 *     paths and symlink escapes are refused by name; valid local references
 *     keep working;
 *   - a failed catalog reads as a NAMED unavailable state, never an empty success.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import * as pool from '../contracts/chapter-background-pool.js'

/** A pool from plain ids, as the editor would send it. */
function poolOf(ids: string[]): pool.ChapterBackgroundPool {
  return pool.normaliseChapterBackgroundPool({
    items: ids.map(id => ({ id, name: id, reference: `${id}.jpg`, enabled: true })),
  })
}

/** Run `count` serial decisions, carrying the cursor forward like the writer does. */
function rotate(poolValue: pool.ChapterBackgroundPool, count: number): string[] {
  const picked: string[] = []
  let cursor: pool.ChapterBackgroundCursor | null = null
  for (let index = 0; index < count; index++) {
    const decision = pool.decideChapterBackground(poolValue, cursor)
    if (!decision) break
    picked.push(decision.item.id)
    cursor = decision.cursor
  }
  return picked
}

describe('chapter background pools — the serial rotation contract', () => {
  test('no pool leaves today\'s behaviour: decide is null, nothing invented', () => {
    assert.equal(pool.decideChapterBackground(undefined, null), null)
    assert.equal(pool.decideChapterBackground(null, null), null)
    assert.equal(pool.decideChapterBackground(poolOf([]), null), null)
    assert.equal(pool.decideChapterBackground(
      pool.normaliseChapterBackgroundPool({ items: [{ id: 'a', name: 'a', reference: 'a', enabled: false }] }),
      null,
    ), null)
    assert.deepEqual(pool.emptyChapterBackgroundPool(), { items: [] })
    assert.deepEqual(pool.normaliseChapterBackgroundPool(null), { items: [] })
  })

  test('one background means every chapter uses it; serial wraps in pool order', () => {
    assert.deepEqual(rotate(poolOf(['only']), 3), ['only', 'only', 'only'])
    assert.deepEqual(rotate(poolOf(['a', 'b', 'c']), 7), ['a', 'b', 'c', 'a', 'b', 'c', 'a'])
    const withOff = pool.normaliseChapterBackgroundPool({
      items: [
        { id: 'a', name: 'a', reference: 'a', enabled: true },
        { id: 'b', name: 'b', reference: 'b', enabled: false },
        { id: 'c', name: 'c', reference: 'c', enabled: true },
      ],
    })
    assert.deepEqual(rotate(withOff, 5), ['a', 'c', 'a', 'c', 'a'])
    assert.deepEqual(pool.poolBackgroundIds(withOff), ['a', 'c'])
  })

  test('a pool edit mid-run never repeats and never skips', () => {
    const decision = pool.decideChapterBackground(poolOf(['a', 'b', 'c']), { last_background_id: 'b', last_index: 1 })
    assert.equal(decision!.item.id, 'c')
    const removed = poolOf(['a', 'b', 'c'])
    removed.items = removed.items.filter(item => item.id !== 'b')
    assert.equal(pool.decideChapterBackground(removed, decision!.cursor)!.item.id, 'a')
    assert.equal(pool.nextSerialIndex(poolOf(['a', 'c']).items, { last_background_id: 'gone', last_index: 2 }), 0)
    const deduped = pool.normaliseChapterBackgroundPool({
      items: [
        { id: 'x', name: 'first', reference: 'x', enabled: true },
        { id: 'x', name: 'second', reference: 'x', enabled: true },
        { id: '   ' },
        null,
      ],
    })
    assert.equal(deduped.items.length, 1)
    assert.equal(deduped.items[0]!.name, 'first')
  })

  test('rotation identity is the (episode, chapter) pair', () => {
    assert.equal(pool.chapterRotationKey('EP0001', 'setup'), 'EP0001\u0000setup')
    assert.equal(pool.chapterRotationKey('EP0001', undefined), pool.chapterRotationKey('EP0001', ''))
    assert.notEqual(pool.chapterRotationKey('EP0001', 'setup'), pool.chapterRotationKey('EP0001', 'reveal'))
    assert.deepEqual(pool.normaliseCursor(2), { last_background_id: null, last_index: 2 })
    assert.deepEqual(pool.normaliseCursor(0), { last_background_id: null, last_index: 0 })
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

  test('two chapters in one episode advance; two retries of each do not move', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgTwoChapters' })
    const bgDir = path.join(pm.getProjectDir(proj.slug)!, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    for (const name of ['one.jpg', 'two.jpg', 'three.jpg']) await fs.writeFile(path.join(bgDir, name), 'x')
    await svc.updateChapterBackgroundPool(proj.slug, poolOf(['one.jpg', 'two.jpg', 'three.jpg']).items)

    // Peek is read-only: repeated peeks never advance.
    assert.equal((await svc.peekChapterBackground(proj.slug, 'EP0001', 'ch-a'))?.item.id, 'one.jpg')
    assert.equal((await svc.peekChapterBackground(proj.slug, 'EP0001', 'ch-a'))?.item.id, 'one.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, null)

    // Chapter A then chapter B of the SAME episode → two successive backgrounds.
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-a'))?.item.id, 'one.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 0)
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-b'))?.item.id, 'two.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 1)

    // Two retries of the same two chapters: same picks, cursor untouched.
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-a'))?.item.id, 'one.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 1)
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-b'))?.item.id, 'two.jpg')
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 1)
    assert.equal((await svc.peekChapterBackground(proj.slug, 'EP0001', 'ch-a'))?.item.id, 'one.jpg')

    // A third chapter continues the run; the next episode's first chapter too.
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-c'))?.item.id, 'three.jpg')
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0002', 'ch-a'))?.item.id, 'one.jpg')

    const log = await svc.getChapterBackgroundUsageLog(proj.slug)
    const keys = new Set(log.map(entry => `${entry.episode_code} ${entry.chapter_slug}`))
    assert.equal(keys.size, 4, 'one keyed entry per (episode, chapter) boundary')
    assert.equal(log.length, 4)

    await svc.resetChapterBackgroundCursor(proj.slug)
    assert.equal((await svc.peekChapterBackground(proj.slug, 'EP0009', 'ch-a'))?.item.id, 'one.jpg')
  })

  test('concurrent chapter records lose neither history nor cursor', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgConcurrent' })
    await svc.updateChapterBackgroundPool(proj.slug, poolOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).items)

    const chapters = Array.from({ length: 8 }, (_, index) => `ch-${index}`)
    await Promise.all(chapters.map(chapter => svc.recordChapterBackgroundPick(proj.slug, 'EP0001', chapter)))

    const log = await svc.getChapterBackgroundUsageLog(proj.slug)
    assert.equal(log.length, 8, 'every concurrent record landed — none clobbered another')
    for (const chapter of chapters) {
      assert.ok(log.some(entry => entry.chapter_slug === chapter), `missing record for ${chapter}`)
    }
    // 8 serial picks over an 8-item pool end at index 7.
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 7)
    // A retry keeps its OWN recorded pick, not the rotation's next.
    const ch0 = log.find(entry => entry.chapter_slug === 'ch-0')
    assert.ok(ch0)
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-0'))?.item.id, ch0.background_id)
    assert.equal((await svc.getChapterBackgroundCursor(proj.slug)).last_index, 7)
  })

  test('an explicit valid pick is recorded and rotation continues past it', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgPick' })
    await svc.updateChapterBackgroundPool(proj.slug, poolOf(['a.jpg', 'b.jpg']).items)
    const decision = await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-a', 'b.jpg')
    assert.equal(decision?.item.id, 'b.jpg')
    assert.equal((await svc.peekChapterBackground(proj.slug, 'EP0001', 'ch-a'))?.item.id, 'b.jpg')
    assert.equal((await svc.recordChapterBackgroundPick(proj.slug, 'EP0001', 'ch-b'))?.item.id, 'a.jpg')
    // An id the pool does not hold is not invented: serial decides from the
    // standing cursor (ch-b left it at a.jpg, so the serial next is b.jpg).
    const fallback = await svc.recordChapterBackgroundPick(proj.slug, 'EP0002', 'ch-a', 'not-in-pool')
    assert.equal(fallback?.item.id, 'b.jpg')
  })

  test('resolution is restricted to the catalog or this channel\'s own inventory', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgResolve' })
    const other = await pm.createProject({ name: 'ChapterBgOther' })
    const bgDir = path.join(pm.getProjectDir(proj.slug)!, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    await fs.writeFile(path.join(bgDir, 'plate.jpg'), 'x')
    const otherBg = path.join(pm.getProjectDir(other.slug)!, 'backgrounds')
    await fs.mkdir(otherBg, { recursive: true })
    await fs.writeFile(path.join(otherBg, 'foreign.jpg'), 'x')

    assert.equal(await svc.resolveChapterBackground(proj.slug, 'plate.jpg'), path.join(bgDir, 'plate.jpg'))
    assert.equal(
      await svc.resolveChapterBackground(proj.slug, '${CHANNEL}/backgrounds/plate.jpg'),
      path.join(bgDir, 'plate.jpg'),
    )
    assert.equal(
      await svc.resolveChapterBackground(proj.slug, path.join(bgDir, 'plate.jpg')),
      path.join(bgDir, 'plate.jpg'),
    )

    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, '${CHANNEL}/../' + other.slug + '/backgrounds/foreign.jpg'),
      /outside|refused/,
    )
    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, '${CHANNEL}/backgrounds/../secret.jpg'),
      /outside|refused/,
    )
    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, path.join(otherBg, 'foreign.jpg')),
      /outside|refused/,
    )
    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, '/etc/hosts'),
      /outside|refused|not one of/,
    )
    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, 'not-listed.jpg'),
      /not one of/,
    )
    // A symlink planted in the folder cannot reach outside: realpath containment.
    const outsideDir = path.join(pm.getProjectDir(proj.slug)!, 'secrets')
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(path.join(outsideDir, 'outside.jpg'), 'x')
    await fs.symlink(path.join(outsideDir, 'outside.jpg'), path.join(bgDir, 'evil.jpg'))
    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, path.join(bgDir, 'evil.jpg')),
      /outside|refused/,
    )
    await assert.rejects(
      () => svc.resolveChapterBackground(proj.slug, '${BACKGROUND}/no-such-background'),
      /no-such-background/,
    )
  })

  test('pool state reports the inventory, cursor, and an honest catalog answer', async () => {
    const proj = await pm.createProject({ name: 'ChapterBgState' })
    const bgDir = path.join(pm.getProjectDir(proj.slug)!, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    await fs.writeFile(path.join(bgDir, 'x.mp4'), 'x')
    await svc.updateChapterBackgroundPool(proj.slug, poolOf(['x.mp4']).items)

    const state = await svc.getChapterBackgroundPoolState(proj.slug)
    assert.equal(state.pool.items.length, 1)
    assert.deepEqual(state.channel_files, ['x.mp4'])
    assert.equal(state.folder, bgDir)
    assert.deepEqual(state.cursor, { last_background_id: null, last_index: null })
    assert.ok(Array.isArray(state.recent_usage))

    // A broken catalog is a NAMED failure with its reason — never an empty success.
    const catalog = await import('../services/background-catalog.js')
    try {
      catalog._clearBackgroundCatalogCache()
      catalog._setBackgroundsDirForTesting(path.join(bgDir, 'no-such-catalog-dir'))
      const failed = await svc.getChapterBackgroundPoolState(proj.slug)
      assert.equal(failed.catalog.available, false)
      assert.equal(failed.catalog.entries.length, 0)
      assert.match(failed.catalog.reason ?? '', /catalog unavailable/i)
      assert.equal(failed.channel_files.length, 1)
    } finally {
      catalog._setBackgroundsDirForTesting(null)
      catalog._clearBackgroundCatalogCache()
    }
    const healthy = await svc.getChapterBackgroundPoolState(proj.slug)
    assert.equal(healthy.catalog.available, true)
    assert.ok(Array.isArray(healthy.catalog.entries))
  })
})
