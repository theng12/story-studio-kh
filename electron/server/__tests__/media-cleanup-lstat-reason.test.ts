/**
 * The pre-removal check swallowed the lstat error code, so a permission or disk
 * error read "The reviewed file is missing." Only ENOENT means missing (AGENTS.md section 6).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { _exactFileStillReviewedForTests } from '../services/episode-media-cleanup.js'

test('an absent reviewed file is missing; an unreadable one says what happened', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'CleanupLstat-'))
  const dir = path.join(root, 'locked')
  t.after(async () => { await fs.chmod(dir, 0o755).catch(() => {}); await fs.rm(root, { recursive: true, force: true }) })
  await fs.mkdir(dir)
  const file = { path: path.join(dir, 'Scene_001.png'), real_path: path.join(dir, 'Scene_001.png'), bytes: 1, mtime_ms: 0 } as any
  assert.equal(await _exactFileStillReviewedForTests(file), 'The reviewed file is missing.')
  await fs.chmod(dir, 0o000)
  const reason = await _exactFileStillReviewedForTests(file)
  assert.match(reason || '', /EACCES/)
  assert.doesNotMatch(reason || '', /is missing/)
})
