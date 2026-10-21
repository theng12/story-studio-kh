/**
 * 1.4.289 — one Story-wide Trash (owner 2026-10-11): every removal goes through
 * lib/trash-move.ts into `<Library>/_trash/<slug>/…`, old per-channel trashes are
 * moved there once (idempotently), the Trash page restores, and only the owner
 * can empty it (automation keys get 403).
 */
import assert from 'node:assert/strict'
import nodeFs, { existsSync, readFileSync, readdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let trash: typeof import('../services/trash.js')
let move: typeof import('../lib/trash-move.js')

before(async () => {
  tmp = await useTempDataDir()
  pm = await import('../services/project-manager.js')
  trash = await import('../services/trash.js')
  move = await import('../lib/trash-move.js')
})
after(async () => { await tmp.cleanup() })

async function write(file: string, text = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const libraryTrash = () => path.join(pm.projectsRoot(), '_trash')

describe('one helper for every removal', () => {
  test('a channel file lands in <Library>/_trash/<slug>/… and the move is recorded for Restore', async () => {
    const { slug } = await pm.createProject({ name: 'Helper Channel' })
    const projectDir = pm.getProjectDir(slug)!
    const file = path.join(projectDir, 'episodes', 'EP1', 'a.png')
    await write(file, 'picture')
    const root = move.trashRootFor(projectDir, projectDir, slug)
    assert.equal(root, path.join(libraryTrash(), slug))
    const landed = move.moveToTrashSync(file, path.join(root, 'EP1', 'a.png'), 'images')
    assert.equal(readFileSync(landed, 'utf8'), 'picture')
    const lines = readFileSync(path.join(libraryTrash(), move.TRASH_INDEX), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual({ from: lines.at(-1).from, to: lines.at(-1).to, kind: lines.at(-1).kind }, { from: file, to: landed, kind: 'images' })
  })

  test('no service builds its own _trash path any more: they all route through lib/trash-move.ts', () => {
    const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    // Places that READ old locations (migration, sizes) or are the app's own fallback.
    const allowed = new Map<string, RegExp>([
      ['services/storage-audit.ts', /path\.join\(projectDir, '_trash'\)/],
      ['services/app-update.ts', /export function trashDir\(\)/],
      ['services/channel-self-contained.ts', /e(ntry)?\.name !== '_trash'/],
    ])
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full); continue }
        if (!entry.name.endsWith('.ts')) continue
        const rel = path.relative(server, full)
        if (rel === 'lib/trash-move.ts') continue
        readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
          if (!line.includes("'_trash'") || line.trim().startsWith('*') || line.trim().startsWith('//')) return
          if (allowed.get(rel)?.test(line)) return
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`)
        })
      }
    }
    walk(server)
    assert.deepEqual(offenders, [], 'build trash paths with trashRootFor / moveToTrashSync')
  })
})

describe('durable Trash index EOF replay', () => {
  test('repairs an exact EOF entry before an ordinary append so both Restore entries stay readable', async t => {
    const { slug } = await pm.createProject({ name: 'Durable EOF Restore' })
    const projectDir = pm.getProjectDir(slug)!
    const root = move.trashRootFor(projectDir, projectDir, slug)
    const index = path.join(libraryTrash(), move.TRASH_INDEX)
    const saved = `${index}.retained-before-${randomUUID()}`
    const hadIndex = existsSync(index)
    if (hadIndex) await fs.rename(index, saved)
    t.after(async () => {
      if (existsSync(index)) await fs.rename(index, `${index}.retained-after-${randomUUID()}`)
      if (hadIndex) await fs.rename(saved, index)
    })
    const first = path.join(projectDir, 'first.txt')
    const second = path.join(projectDir, 'second.txt')
    await write(first, 'first retained bytes')
    const landed = move.moveToTrashSync(first, path.join(root, 'first.txt'), 'other')
    const complete = await fs.readFile(index)
    assert.equal(complete.at(-1), 10)
    // Retain the complete predecessor; only its final LF is absent in the crash fixture.
    await fs.rename(index, `${index}.retained-complete-${randomUUID()}`)
    await fs.writeFile(index, complete.subarray(0, complete.length - 1), { flag: 'wx' })
    move.ensureTrashMoveIndexedSync(first, landed, 'other')
    const repaired = await fs.readFile(index)
    move.ensureTrashMoveIndexedSync(first, landed, 'other')
    const replayed = await fs.readFile(index)
    await write(second, 'second retained bytes')
    const secondLanded = move.moveToTrashSync(second, path.join(root, 'second.txt'), 'other')
    const listing = await trash.listTrash()
    const entries = listing.items.filter(item => item.from === first || item.from === second)
    assert.equal(entries.length, 2, 'the real Restore reader must retain both separate index entries')
    assert.ok(entries.every(item => item.restorable && item.kind === 'other'))
    assert.deepEqual(entries.map(item => item.path).sort(), [landed, secondLanded].sort())
    assert.deepEqual(repaired, complete, 'exact EOF replay adds only the lost LF, preserving the original id/time')
    assert.deepEqual(replayed, complete, 'repeated durable replay adds no duplicate record or newline')
    const lines = (await fs.readFile(index, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(await fs.readFile(landed, 'utf8'), 'first retained bytes')
    assert.equal(await fs.readFile(secondLanded, 'utf8'), 'second retained bytes')
  })
})

// Observe the real regular index FD only during the synchronous durable helper call.
function observeDurableIndex(t: import('node:test').TestContext, index: string, action: () => void) {
  const descriptors = new Set<number>()
  const reads: number[] = []
  const allocations: number[] = []
  let wholeReads = 0
  let appends = 0
  let synced = 0
  const originals = {
    open: nodeFs.openSync, close: nodeFs.closeSync, read: nodeFs.readSync,
    readFile: nodeFs.readFileSync, append: nodeFs.appendFileSync, sync: nodeFs.fsyncSync,
    alloc: Buffer.alloc, allocUnsafe: Buffer.allocUnsafe,
  }
  const target = (value: unknown) => typeof value === 'number' ? descriptors.has(value)
    : typeof value === 'string' && path.resolve(value) === index
  const mocks = [
    t.mock.method(nodeFs, 'openSync', (...args: any[]) => {
      const fd = Reflect.apply(originals.open, nodeFs, args)
      if (target(args[0]) && nodeFs.fstatSync(fd).isFile()) descriptors.add(fd)
      return fd
    }),
    t.mock.method(nodeFs, 'closeSync', (fd: number) => {
      originals.close(fd)
      descriptors.delete(fd)
    }),
    t.mock.method(nodeFs, 'readSync', (...args: any[]) => {
      if (descriptors.has(args[0])) reads.push(args[3])
      return Reflect.apply(originals.read, nodeFs, args)
    }),
    t.mock.method(nodeFs, 'readFileSync', (...args: any[]) => {
      if (target(args[0])) wholeReads++
      return Reflect.apply(originals.readFile, nodeFs, args)
    }),
    t.mock.method(nodeFs, 'appendFileSync', (...args: any[]) => {
      if (target(args[0])) appends++
      return Reflect.apply(originals.append, nodeFs, args)
    }),
    t.mock.method(nodeFs, 'fsyncSync', (fd: number) => {
      originals.sync(fd)
      if (descriptors.has(fd)) synced++
    }),
    t.mock.method(Buffer, 'alloc', (...args: any[]) => {
      allocations.push(args[0])
      return Reflect.apply(originals.alloc, Buffer, args)
    }),
    t.mock.method(Buffer, 'allocUnsafe', (...args: any[]) => {
      allocations.push(args[0])
      return Reflect.apply(originals.allocUnsafe, Buffer, args)
    }),
  ]
  syncBuiltinESMExports()
  let error: unknown
  try { action() } catch (caught) { error = caught }
  finally {
    for (const mocked of mocks) mocked.mock.restore()
    syncBuiltinESMExports()
  }
  return { reads, allocations, wholeReads, appends, synced, error, openDescriptors: descriptors.size }
}

describe('durable Trash index bounded scan', () => {
  test('scans real history across many buffers without whole-index reads or allocations', async t => {
    const root = path.join(tmp.dir, `index-history-${randomUUID()}`, '_trash')
    const index = path.join(root, move.TRASH_INDEX)
    const from = path.join(tmp.dir, 'bounded-original-é.txt')
    const to = path.join(root, 'kept-é.txt')
    await write(to, 'retained recovery bytes')
    const exact = { id: randomUUID(), from, to, kind: 'other', at: new Date().toISOString() }
    const history = Array.from({ length: 4096 }, (_, n) => JSON.stringify({
      ...exact, id: randomUUID(), from: `${from}.${n}`, to: `${to}.${n}`, kind: 'x'.repeat(220),
    }) + '\n').join('')
    const bytes = Buffer.from(history + JSON.stringify(exact) + '\n')
    assert.ok(bytes.length > 1024 * 1024, 'the actual index spans more than sixteen 64KiB reads')
    await fs.writeFile(index, bytes, { flag: 'wx' })
    const observed = observeDurableIndex(t, index, () => move.ensureTrashMoveIndexedSync(from, to, 'other'))
    assert.equal(observed.error, undefined)
    assert.equal(observed.wholeReads, 0, 'durable replay must not call readFileSync on the real index')
    assert.ok(observed.reads.length > 16, 'the real regular index FD is read in bounded pieces')
    assert.ok(observed.reads.every(size => Number.isInteger(size) && size > 0 && size <= 64 * 1024))
    assert.ok(observed.allocations.every(size => size <= 64 * 1024), 'index buffer allocations stay at most 64KiB')
    assert.equal(observed.appends, 0, 'an exact terminated entry is reused')
    assert.ok(observed.synced > 0, 'the actual index descriptor is fsynced')
    assert.equal(observed.openDescriptors, 0)
    assert.deepEqual(await fs.readFile(index), bytes, 'all existing history bytes remain unchanged')
    assert.equal(await fs.readFile(to, 'utf8'), 'retained recovery bytes')
  })

  test('an oversized actual record fails before append and retains renamed recovery bytes', async t => {
    const root = path.join(tmp.dir, `index-oversize-${randomUUID()}`, '_trash')
    const index = path.join(root, move.TRASH_INDEX)
    const from = path.join(tmp.dir, `prior-${randomUUID()}.txt`)
    const to = path.join(root, 'prior.txt')
    await write(from, 'prior bytes retained after rename')
    // Valid JSON, finite fixture: one historical record exceeds the proposed 64KiB ceiling.
    const bytes = Buffer.from(JSON.stringify({ note: 'x'.repeat(64 * 1024) }))
    await write(index, bytes.toString('utf8'))
    const observed = observeDurableIndex(t, index, () => move.moveToTrashSync(from, to, 'other', true))
    assert.ok(observed.error instanceof Error, 'durable indexing must reject an oversized historical record')
    assert.equal(observed.appends, 0, 'scan failure appends neither separator nor new record')
    assert.equal(observed.wholeReads, 0)
    assert.ok(observed.reads.every(size => size <= 64 * 1024))
    assert.ok(observed.allocations.every(size => size <= 64 * 1024))
    assert.equal(observed.openDescriptors, 0)
    assert.deepEqual(await fs.readFile(index), bytes, 'oversized history is preserved, never rewritten')
    assert.equal(existsSync(from), false)
    assert.equal(await fs.readFile(to, 'utf8'), 'prior bytes retained after rename')
  })
})

describe('moving the old per-channel trashes', () => {
  test('moves each old _trash under <channel>/legacy (and the app one under _story-studio/legacy); a second run changes nothing', async () => {
    const { slug } = await pm.createProject({ name: 'Old Trash Channel' })
    const projectDir = pm.getProjectDir(slug)!
    await write(path.join(projectDir, '_trash', 'EP0001', 'final_video', 'EP0001_final_video.mp4'), 'old final')
    await write(path.join(tmp.dir, '_trash', 'launch-agent', 'agent.plist'), 'plist')

    const first = await trash.migrateLegacyTrash()
    assert.ok(first.moved.some(m => m.from === path.join(projectDir, '_trash')))
    assert.equal(readFileSync(path.join(libraryTrash(), slug, 'legacy', 'EP0001', 'final_video', 'EP0001_final_video.mp4'), 'utf8'), 'old final')
    assert.equal(readFileSync(path.join(libraryTrash(), '_story-studio', 'legacy', 'launch-agent', 'agent.plist'), 'utf8'), 'plist')
    assert.equal(existsSync(path.join(projectDir, '_trash')), false, 'the emptied old folder is removed (it was empty)')
    assert.match(readFileSync(path.join(libraryTrash(), trash.MIGRATION_LOG), 'utf8'), /moved .*_trash -> /)

    const snapshot = JSON.stringify(await trash.listTrash())
    const second = await trash.migrateLegacyTrash()
    assert.deepEqual(second, { moved: [], left: [] })
    assert.equal(JSON.stringify(await trash.listTrash()), snapshot, 'idempotent: nothing moved twice')

    // Something an older build put back into the channel folder joins the legacy folder, never replacing it.
    await write(path.join(projectDir, '_trash', 'EP0001', 'final_video', 'EP0001_final_video.mp4'), 'newer')
    const third = await trash.migrateLegacyTrash()
    assert.equal(third.moved.length, 1)
    assert.equal(readFileSync(path.join(libraryTrash(), slug, 'legacy', 'EP0001', 'final_video', 'EP0001_final_video.mp4'), 'utf8'), 'old final')
    assert.ok(readdirSync(path.join(libraryTrash(), slug, 'legacy')).some(name => name.startsWith('EP0001.')), 'kept beside it with a suffix')
  })

  test('the Trash lists channels, kinds and items; Restore puts an item back and refuses when its place is taken', async () => {
    const { slug } = await pm.createProject({ name: 'Restore Channel' })
    const projectDir = pm.getProjectDir(slug)!
    const file = path.join(projectDir, 'music', 'song.mp3')
    await write(file, 'song')
    move.moveToTrashSync(file, path.join(move.trashRootFor(projectDir, projectDir, slug), 'music', 'song.mp3'), 'music')

    const listing = await trash.listTrash()
    const item = listing.items.find(i => i.from === file)!
    assert.equal(item.slug, slug)
    assert.equal(item.kind, 'music')
    assert.equal(item.restorable, true)
    assert.ok(listing.channels.some(c => c.slug === slug && c.bytes >= 4))
    assert.ok(listing.kinds.some(k => k.kind === 'music'))

    await write(file, 'a new song')
    await assert.rejects(trash.restoreTrashItem(item.id), /Something is already at/)
    await fs.rm(file)
    assert.deepEqual(await trash.restoreTrashItem(item.id), { restored_to: file })
    assert.equal(readFileSync(file, 'utf8'), 'song')
  })
})

describe('Empty Trash is retired (owner decision 2026-10-16)', () => {
  test('POST /trash/empty answers 410 pointing to Delete all permanently and deletes nothing, whatever the body', async () => {
    const { router } = await import('../routes/trash.js')
    const app = express()
    app.use(express.json())
    app.use('/api', router)
    const { slug } = await pm.createProject({ name: 'Empty Channel' })
    const projectDir = pm.getProjectDir(slug)!
    const file = path.join(projectDir, 'x.txt')
    await write(file, 'bytes')
    const landed = move.moveToTrashSync(file, path.join(move.trashRootFor(projectDir, projectDir, slug), 'x.txt'), 'other')
    const unindexed = path.join(libraryTrash(), slug, 'legacy', 'old.txt')
    await write(unindexed, 'old')

    for (const body of [{ confirm: 'EMPTY TRASH' }, {}, { confirm: true }]) {
      const gone = await request(app).post('/api/trash/empty').send(body)
      assert.equal(gone.status, 410)
      assert.match(gone.body.detail, /Delete all permanently/)
    }
    assert.equal(existsSync(landed), true, 'still in the Trash')
    assert.equal(existsSync(unindexed), true, 'unindexed items too')
    assert.equal('emptyTrash' in trash, false, 'the delete-every-root service is gone')
  })
})

describe('Clear Uploaded Videos runs in the background with progress', () => {
  test('progress fields while it runs (what is being read, how far), one at a time on this Mac, its result after', async () => {
    const cleanup = await import('../services/episode-media-cleanup.js')
    const { slug } = await pm.createProject({ name: 'Tracked Channel' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const MB = 1024 ** 2
    const { operation_id } = await cleanup.startTrackedCleanup(slug, 'verifying', async (operation) => {
      operation.total = 2; operation.bytes_total = 10 * MB
      cleanup.readingProgress(operation, { path: '/x/EP0001_final_video.mp4', bytes: 10 * MB }, 'Matching')(4 * MB)
      operation.bytes_done = 4 * MB
      await gate
      return { items: [], item_count: 0, bytes_freed: 0, deleted_count: 0, skipped_count: 0, failed_count: 0 }
    })
    const read = () => cleanup.getMediaCleanupOperation(slug, operation_id)!
    await waitFor(() => read().bytes_done > 0)
    const running = read()
    assert.equal(running.status, 'running')
    assert.equal(running.stage, 'verifying')
    assert.equal(running.detail, 'Matching EP0001_final_video.mp4 — 4 MB of 10 MB read')
    assert.deepEqual([running.bytes_done, running.bytes_total], [4 * MB, 10 * MB])
    await assert.rejects(cleanup.startTrackedCleanup(slug, 'verifying', async () => ({ items: [], item_count: 0, bytes_freed: 0, deleted_count: 0, skipped_count: 0, failed_count: 0 })), /already running on this Mac/)
    release()
    await waitFor(() => read().status !== 'running')
    assert.equal(read().status, 'completed')
    assert.deepEqual(read().final_cleanup?.deleted_count, 0)
  })

  test('a timed-out wait is a clear error, not a hang', async () => {
    const { withTimeout } = await import('../lib/with-timeout.js')
    await assert.rejects(withTimeout(new Promise(() => {}), 20, 'YouTube did not answer within 0 seconds'), (error: any) => error.code === 'ETIMEDOUT' && /did not answer/.test(error.message))
    assert.equal(await withTimeout(Promise.resolve(7), 20, 'unused'), 7)
  })
})

describe('an outline uploaded again under the same name', () => {
  test('the earlier outline goes to Story\'s Trash instead of being written over', async () => {
    const sharp = (await import('sharp')).default
    const { saveOutlineMask, outlineMaskPath } = await import('../services/outline-masks.js')
    const { slug } = await pm.createProject({ name: 'Outline Channel' })
    const projectDir = pm.getProjectDir(slug)!
    const episodeDir = path.join(projectDir, 'episodes', 'EP0001 - Outline')
    const mask = (x: number) => {
      const raw = Buffer.alloc(256 * 256, 0)
      for (let y = 64; y < 192; y++) raw.fill(255, y * 256 + x, y * 256 + x + 96)
      return sharp(raw, { raw: { width: 256, height: 256, channels: 1 } }).png().toBuffer()
    }
    const first = await saveOutlineMask({ episodeDir, sceneId: 's001', label: 'candle', data: await mask(32), channel: { slug, projectDir } })
    const target = outlineMaskPath(episodeDir, first.name)
    const before = readFileSync(target)
    await saveOutlineMask({ episodeDir, sceneId: 's001', label: 'candle', data: await mask(128), channel: { slug, projectDir } })
    const kept = path.join(libraryTrash(), slug, path.relative(projectDir, target))
    assert.deepEqual(readFileSync(kept), before, 'the replaced outline waits in the Trash')
    assert.notDeepEqual(readFileSync(target), before)
  })
})
