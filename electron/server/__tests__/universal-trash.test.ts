/**
 * 1.4.289 — one Story-wide Trash (owner 2026-10-11): every removal goes through
 * lib/trash-move.ts into `<Library>/_trash/<slug>/…`, old per-channel trashes are
 * moved there once (idempotently), the Trash page restores, and only the owner
 * can empty it (automation keys get 403).
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
