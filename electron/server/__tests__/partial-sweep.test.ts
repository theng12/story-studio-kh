import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sweepDeadPartials } from '../lib/partial-sweep.js'

test('a dead pid\'s unfinished image is cleared and a live one is left alone', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'partial-sweep-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const dead = ['ep-scene-0063.png.partial-24399-1795087344411', 'ep-scene-0065.png.partial-24399-1795087351289']
  const live = [`ep-scene-0066.png.partial-${process.pid}-1795087351289`]
  for (const name of [...dead, ...live, 'ep-scene-0067.png', 'partial-notes.txt']) {
    await fs.writeFile(path.join(dir, name), 'bytes')
  }
  const result = await sweepDeadPartials(dir, pid => pid === process.pid)
  assert.deepEqual(result, { removed: 2, kept: 1 })
  assert.deepEqual((await fs.readdir(dir)).sort(), [live[0]!, 'ep-scene-0067.png', 'partial-notes.txt'].sort())
})
