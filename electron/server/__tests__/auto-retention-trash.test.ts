/**
 * Automatic retention (owner, 2026-10-18): generated files age out by
 * themselves. Three facts pinned here:
 *
 *   1. Story's Trash hands ONLY items that have waited the full number of days
 *      to the Mac's Trash (an injected clock decides the age; injected
 *      `trashItem` records the move), including unrecorded legacy items whose
 *      on-disk mtime is the only evidence.
 *   2. The automatic cleanup reuses the button's own path — `cleanup_all`
 *      through `startLibraryMediaCleanupPreview` and then its reviewed
 *      `preview_id` through `startLibraryMediaCleanupRun` — and starts nothing
 *      while a cleanup is already running.
 *   3. Expired logs move into Story's Trash (`_trash/_logs`) instead of being
 *      unlinked.
 *
 * Everything runs inside `useTempDataDir()`, so no real Library, `_trash`, or
 * macOS Trash is touched.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { pruneOldLogs } from '../services/logger.js'
import { _forTesting, _setAutoCleanupDepsForTests, runAutomaticCleanup } from '../services/retention.js'
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
})
