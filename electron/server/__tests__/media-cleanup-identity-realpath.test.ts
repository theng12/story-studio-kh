/**
 * The final identity check before a cleanup moves a file must resolve paths the
 * same way the preview did. The preview records `fs.realpath` (native, on-disk
 * case); the check used the JS `realpathSync`, which keeps the caller's case, so
 * on a case-insensitive disk every file whose path was spelled in another case
 * failed "The reviewed file changed immediately before removal." (1.4.329: 488/488).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { _assertReviewedIdentityForTests } from '../services/episode-media-cleanup.js'

test('a file reviewed under another letter case still passes the final identity check', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'CleanupCase-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'Story Studio Projects', 'Boundful', 'EP0001')
  await fs.mkdir(dir, { recursive: true })
  const onDisk = path.join(dir, 'Scene_001.png')
  await fs.writeFile(onDisk, Buffer.alloc(64, 1))
  const spelled = path.join(root, 'story studio projects', 'boundful', 'EP0001', 'scene_001.png')
  try { await fs.stat(spelled) } catch { t.skip('this disk is case-sensitive'); return }
  const stat = await fs.lstat(onDisk)
  const file = { path: spelled, real_path: await fs.realpath(spelled), bytes: stat.size, mtime_ms: stat.mtimeMs } as any
  assert.doesNotThrow(() => _assertReviewedIdentityForTests(file))
  await fs.appendFile(onDisk, 'changed')
  assert.throws(() => _assertReviewedIdentityForTests(file), /changed immediately before removal/)
})
