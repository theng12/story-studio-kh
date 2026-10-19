/**
 * Automatic retention (owner, 2026-10-18; the size half 2026-10-19): generated
 * files age out by themselves. Facts pinned here:
 *
 *   1. Story's Trash hands ONLY items that have waited the full number of days
 *      to the Mac's Trash (an injected clock decides the age; injected
 *      `trashItem` records the move), including unrecorded legacy items whose
 *      on-disk mtime is the only evidence.
 *   2. Once the WHOLE Trash passes `trash_handoff_gb`, its oldest movable items
 *      go too, oldest-first, until it is back under the cap — and an item is
 *      never handed over twice for matching both rules.
 *   3. The automatic cleanup reuses the button's own path — `cleanup_all`
 *      through `startLibraryMediaCleanupPreview` and then its reviewed
 *      `preview_id` through `startLibraryMediaCleanupRun` — and starts nothing
 *      while a cleanup is already running.
 *   4. Expired logs move into Story's Trash (`_trash/_logs`) instead of being
 *      unlinked, and the folder is bounded by size as well as by age.
 *   5. The settings round-trip, with 7 days and 20 GB as the defaults.
 *
 * Everything runs inside `useTempDataDir()`, so no real Library, `_trash`, or
 * macOS Trash is touched.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { pruneOldLogs } from '../services/logger.js'
import {
  _forTesting, _setAutoCleanupDepsForTests, getRetentionSettings, runAutomaticCleanup, setRetentionSettings,
} from '../services/retention.js'
import { handoffOldTrash } from '../services/trash.js'
import { useTempDataDir } from './_helpers.js'

const DAY_MS = 24 * 60 * 60 * 1000
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  _forTesting.reset()
  await cleanup?.()
  cleanup = undefined
})

async function tempDir(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return temp.dir
}

function indexLine(from: string, to: string, at: string): string {
  return `${JSON.stringify({ id: `${path.basename(from)}-${at}`, from, to, kind: 'final_video', at })}\n`
}

describe('Story Trash age handoff', () => {
  test('moves only items that waited the full number of days, by injected clock', async () => {
    const dir = await tempDir()
    const trash = path.join(dir, 'projects', '_trash')
    const channel = path.join(trash, 'channel')
    await fs.mkdir(path.join(channel, 'legacy'), { recursive: true })
    const now = Date.UTC(2026, 9, 18, 12)
    const oldAt = new Date(now - 10 * DAY_MS).toISOString()
    const newAt = new Date(now - 2 * DAY_MS).toISOString()
    const oldFile = path.join(channel, 'old.mp4')
    const newFile = path.join(channel, 'new.mp4')
    const unrecorded = path.join(channel, 'legacy', 'ancient.bin')
    await fs.writeFile(oldFile, 'old')
    await fs.writeFile(newFile, 'new')
    await fs.writeFile(unrecorded, 'ancient')
    const ancient = new Date(now - 30 * DAY_MS)
    await fs.utimes(unrecorded, ancient, ancient)
    await fs.writeFile(
      path.join(trash, '.trash-index.jsonl'),
      indexLine('/library/channel/old.mp4', oldFile, oldAt) + indexLine('/library/channel/new.mp4', newFile, newAt),
    )

    const handedOver: string[] = []
    const macTrash = path.join(dir, 'mac-trash')
    const result = await handoffOldTrash({ olderThanDays: 7, now }, async (p) => {
      handedOver.push(path.basename(p))
      await fs.mkdir(macTrash, { recursive: true })
      await fs.rename(p, path.join(macTrash, path.basename(p)))
    })

    assert.deepEqual(handedOver.sort(), ['ancient.bin', 'old.mp4'])
    assert.equal(result.eligible, 2)
    assert.equal(result.moved, 2)
    assert.equal(result.bytes, 3 + 7)
    // The two-day-old item stays exactly where it is.
    assert.equal(await fs.readFile(newFile, 'utf8'), 'new')
    await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' })
    // Each hand-over is recorded as removed, so Restore is no longer offered.
    const index = await fs.readFile(path.join(trash, '.trash-index.jsonl'), 'utf8')
    assert.match(index, /"removed":"macos-trash"/)
  })

  test('a failed Mac Trash move leaves the item in Story Trash and reports it', async () => {
    const dir = await tempDir()
    const trash = path.join(dir, 'projects', '_trash')
    const channel = path.join(trash, 'channel')
    await fs.mkdir(channel, { recursive: true })
    const now = Date.UTC(2026, 9, 18, 12)
    const file = path.join(channel, 'old.mp4')
    await fs.writeFile(file, 'old')
    await fs.writeFile(path.join(trash, '.trash-index.jsonl'), indexLine('/library/channel/old.mp4', file, new Date(now - 10 * DAY_MS).toISOString()))

    const result = await handoffOldTrash({ olderThanDays: 7, now }, async () => { throw new Error('Finder did not answer') })

    assert.equal(result.moved, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(await fs.readFile(file, 'utf8'), 'old')
  })
})

describe('automatic cleanup', () => {
  function completedPreview(id: string, files: number) {
    return {
      id, project_slug: '*', kind: 'preview', status: 'completed', stage: 'checking', done: 0, total: 0,
      bytes_done: 0, bytes_total: 0, current: '', detail: '', created_at: '', updated_at: '',
      library: true, library_action: 'cleanup_all',
      library_preview: {
        preview_id: `preview-${id}`, action: 'cleanup_all', created_at: '', expires_at: '',
        channels: [], files: Array.from({ length: files }, () => ({})), total_bytes: 0, blocked_reasons: [], trash_roots: [],
        estimate: { compress_files: 0, compress_bytes_before: 0, compress_bytes_after: 0, already_jpeg_files: 0, trash_files: 0, trash_bytes: 0 },
        leftovers: { count: 0, total_bytes: 0, items: [] },
      },
    }
  }
  function completedRun(id: string) {
    return {
      id, project_slug: '*', kind: 'run', status: 'completed', stage: 'removing', done: 1, total: 1,
      bytes_done: 10, bytes_total: 10, current: '', detail: '', created_at: '', updated_at: '',
      library: true, library_action: 'cleanup_all',
      result: { mode: 'remove', items: [], archived_count: 0, removed_count: 1, compressed_count: 0, skipped_count: 0, failed_count: 0, pending_count: 0, bytes_reclaimed: 10, bytes_moved: 10, bytes_trashed: 10, bytes_after: 0, leftovers_moved: 1, leftovers_bytes_moved: 5, leftovers_left: 0 },
    }
  }

  test('runs cleanup_all through the button\'s own preview and run functions', async () => {
    await tempDir()
    const calls: string[] = []
    const restore = _setAutoCleanupDepsForTests({
      active: () => null,
      wait: async () => {},
      startPreview: async (action) => { calls.push(`preview:${action}`); return { operation_id: 'p1' } },
      getOperation: id => (id === 'p1' ? completedPreview('p1', 2) : completedRun(id)) as any,
      startRun: async ({ preview_id }) => { calls.push(`run:${preview_id}`); return { operation_id: 'r1' } },
    })
    try {
      const run = await runAutomaticCleanup(Date.UTC(2026, 9, 18))
      assert.deepEqual(calls, ['preview:cleanup_all', 'run:preview-p1'])
      assert.equal(run.status, 'completed')
      assert.equal(run.moved, 2)
      assert.equal(run.bytes, 15)
    } finally { restore() }
  })

  test('starts nothing while a cleanup is already running', async () => {
    await tempDir()
    let started = 0
    const restore = _setAutoCleanupDepsForTests({
      active: () => ({ id: 'busy', kind: 'run', status: 'running' }),
      wait: async () => {},
      startPreview: async () => { started += 1; return { operation_id: 'never' } },
    })
    try {
      const run = await runAutomaticCleanup(Date.UTC(2026, 9, 18))
      assert.equal(started, 0)
      assert.equal(run.status, 'skipped')
      assert.match(run.detail, /already running/)
    } finally { restore() }
  })
})

describe('Story Trash size cap', () => {
  /** A `<Library>/_trash/channel` holding the named files, each with an index line dating it. */
  async function seededTrash(dir: string, files: Array<{ name: string; bytes: number; at: number }>): Promise<string> {
    const trash = path.join(dir, 'projects', '_trash')
    const channel = path.join(trash, 'channel')
    await fs.mkdir(channel, { recursive: true })
    let index = ''
    for (const file of files) {
      const full = path.join(channel, file.name)
      await fs.writeFile(full, '')
      await fs.truncate(full, file.bytes)
      index += indexLine(`/library/channel/${file.name}`, full, new Date(file.at).toISOString())
    }
    await fs.writeFile(path.join(trash, '.trash-index.jsonl'), index)
    return channel
  }
  function recorder(dir: string, handedOver: string[]) {
    const macTrash = path.join(dir, 'mac-trash')
    return async (p: string) => {
      handedOver.push(path.basename(p))
      await fs.mkdir(macTrash, { recursive: true })
      await fs.rename(p, path.join(macTrash, path.basename(p)))
    }
  }

  test('over the cap, the OLDEST movable items go first until it is back under — none of them old enough by age', async () => {
    const dir = await tempDir()
    const now = Date.UTC(2026, 9, 19, 12)
    // Three 60-byte items, all younger than the 7-day rule: only the size cap can move them.
    const channel = await seededTrash(dir, [
      { name: 'a.mp4', bytes: 60, at: now - 3 * 60 * 60 * 1000 },
      { name: 'b.mp4', bytes: 60, at: now - 2 * 60 * 60 * 1000 },
      { name: 'c.mp4', bytes: 60, at: now - 1 * 60 * 60 * 1000 },
    ])
    const handedOver: string[] = []
    const result = await handoffOldTrash({ olderThanDays: 7, maxBytes: 100, now }, recorder(dir, handedOver))

    // 180 bytes over a 100-byte cap: the two oldest go, the newest stays.
    assert.deepEqual(handedOver, ['a.mp4', 'b.mp4'], 'oldest first, and only until the cap is met')
    assert.equal(result.for_size, 2, 'both were picked for size, not for age')
    assert.equal(result.moved, 2)
    assert.equal(result.bytes, 120)
    assert.equal(await fs.readFile(path.join(channel, 'c.mp4')).then(s => s.length), 60, 'the newest item stays in Story Trash')
  })

  test('no cap given, nothing over-age moves — the size rule is the only thing that would', async () => {
    const dir = await tempDir()
    const now = Date.UTC(2026, 9, 19, 12)
    await seededTrash(dir, [
      { name: 'a.mp4', bytes: 60, at: now - 3 * 60 * 60 * 1000 },
      { name: 'b.mp4', bytes: 60, at: now - 2 * 60 * 60 * 1000 },
      { name: 'c.mp4', bytes: 60, at: now - 1 * 60 * 60 * 1000 },
    ])
    const handedOver: string[] = []
    const result = await handoffOldTrash({ olderThanDays: 7, now }, recorder(dir, handedOver))
    assert.deepEqual(handedOver, [], 'nothing has waited 7 days')
    assert.equal(result.moved, 0)
    assert.equal(result.for_size, 0)
  })

  test('an item both old enough AND over the cap is handed over exactly once', async () => {
    const dir = await tempDir()
    const now = Date.UTC(2026, 9, 19, 12)
    const day = 24 * 60 * 60 * 1000
    const channel = await seededTrash(dir, [
      { name: 'aged.mp4', bytes: 60, at: now - 10 * day },
      { name: 'a.mp4', bytes: 60, at: now - 3 * 60 * 60 * 1000 },
      { name: 'b.mp4', bytes: 60, at: now - 2 * 60 * 60 * 1000 },
      { name: 'c.mp4', bytes: 60, at: now - 1 * 60 * 60 * 1000 },
    ])
    const handedOver: string[] = []
    // 240 bytes over a 100-byte cap: `aged` by age, then the two oldest for size.
    const result = await handoffOldTrash({ olderThanDays: 7, maxBytes: 100, now }, recorder(dir, handedOver))

    assert.deepEqual(handedOver, ['aged.mp4', 'a.mp4', 'b.mp4'], 'no item is handed over twice')
    assert.equal(result.moved, 3)
    assert.equal(result.for_size, 2, 'only the two the cap needed are counted as size-driven')
    assert.equal((await fs.stat(path.join(channel, 'c.mp4'))).size, 60, 'c.mp4 is the newest and stays')
  })

  test('an un-dateable item is never guessed into the oldest', async () => {
    const dir = await tempDir()
    const now = Date.UTC(2026, 9, 19, 12)
    const channel = path.join(dir, 'projects', '_trash', 'channel')
    const legacy = path.join(channel, 'legacy')
    await fs.mkdir(legacy, { recursive: true })
    // Unrecorded, so the on-disk mtime is its only evidence — and that is recent.
    const undated = path.join(legacy, 'undated.mp4')
    await fs.writeFile(undated, 'x'.repeat(60))
    const recent = new Date(now - 60_000)
    await fs.utimes(undated, recent, recent)
    await fs.writeFile(path.join(channel, 'dated.mp4'), '')
    await fs.truncate(path.join(channel, 'dated.mp4'), 60)
    const trash = path.join(dir, 'projects', '_trash')
    await fs.writeFile(path.join(trash, '.trash-index.jsonl'), indexLine('/library/channel/dated.mp4', path.join(channel, 'dated.mp4'), new Date(now - 5 * 60 * 60 * 1000).toISOString()))

    const handedOver: string[] = []
    const result = await handoffOldTrash({ olderThanDays: 7, maxBytes: 60, now }, recorder(dir, handedOver))
    assert.deepEqual(handedOver, ['dated.mp4'], 'the dated item goes; the undated one is not assumed old')
    assert.equal(result.for_size, 1)
  })
})

describe('retention settings', () => {
  test('defaults to 7 days and 20 GB, round-trips, and refuses an out-of-range size', async () => {
    await tempDir()
    const defaults = await getRetentionSettings()
    assert.equal(defaults.trash_handoff_days, 7)
    assert.equal(defaults.trash_handoff_gb, 20, 'the owner\'s 20 GB default')
    assert.equal(defaults.auto_cleanup_enabled, true)

    const saved = await setRetentionSettings({ trash_handoff_days: 3, trash_handoff_gb: 5 })
    assert.equal(saved.trash_handoff_days, 3)
    assert.equal(saved.trash_handoff_gb, 5)
    const reread = await getRetentionSettings()
    assert.equal(reread.trash_handoff_days, 3, 'the size write did not lose the days')
    assert.equal(reread.trash_handoff_gb, 5, 'and the days write did not lose the size')

    await assert.rejects(setRetentionSettings({ trash_handoff_gb: 0 }), /between 1 and 10000/)
    await assert.rejects(setRetentionSettings({ trash_handoff_gb: 10_001 }), /between 1 and 10000/)
    assert.equal((await getRetentionSettings()).trash_handoff_gb, 5, 'a refused write changes nothing')
  })
})

describe('log retention', () => {
  test('moves expired server and main logs into _trash/_logs instead of unlinking', async () => {
    const dir = await tempDir()
    const logs = path.join(dir, 'logs')
    await fs.mkdir(logs, { recursive: true })
    const expired = ['server-2020-01-01.log', 'main-2020-01-01.log']
    for (const name of expired) await fs.writeFile(path.join(logs, name), 'old log')
    const recent = `server-${new Date().toISOString().slice(0, 10)}.log`
    await fs.writeFile(path.join(logs, recent), 'recent log')
    await fs.writeFile(path.join(logs, 'notes.txt'), 'not a log')
    const old = new Date(Date.now() - 30 * DAY_MS)
    for (const name of expired) await fs.utimes(path.join(logs, name), old, old)

    await pruneOldLogs()

    for (const name of expired) {
      await assert.rejects(fs.stat(path.join(logs, name)), { code: 'ENOENT' })
      assert.equal(await fs.readFile(path.join(dir, 'projects', '_trash', '_logs', name), 'utf8'), 'old log')
    }
    assert.equal(await fs.readFile(path.join(logs, recent), 'utf8'), 'recent log')
    assert.equal(await fs.readFile(path.join(logs, 'notes.txt'), 'utf8'), 'not a log')
  })

  test('a log folder over the cap sheds its OLDEST logs even though none of them has aged out', async () => {
    const dir = await tempDir()
    await setRetentionSettings({ trash_handoff_gb: 1 })
    const logs = path.join(dir, 'logs')
    await fs.mkdir(logs, { recursive: true })
    const names = ['server-2026-10-16.log', 'server-2026-10-17.log', 'server-2026-10-18.log']
    for (const name of names) {
      const full = path.join(logs, name)
      await fs.writeFile(full, '')
      await fs.truncate(full, 400 * 1024 ** 2) // sparse: 1.2 GB of logical size, no disk
    }
    const now = Date.now()
    for (const [i, name] of names.entries()) {
      const at = new Date(now - (3 - i) * 60 * 60 * 1000)
      await fs.utimes(path.join(logs, name), at, at)
    }

    await pruneOldLogs()

    // 1.2 GB over a 1 GB cap: only the oldest 400 MB log goes.
    await assert.rejects(fs.stat(path.join(logs, names[0]!)), { code: 'ENOENT' })
    assert.equal((await fs.stat(path.join(dir, 'projects', '_trash', '_logs', names[0]!))).size, 400 * 1024 ** 2)
    for (const name of names.slice(1)) {
      assert.equal((await fs.stat(path.join(logs, name))).size, 400 * 1024 ** 2, `${name} is under the cap and stays`)
    }
  })
})
