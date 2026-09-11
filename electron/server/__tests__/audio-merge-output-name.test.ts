import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { useTempDataDir } from './_helpers.js'

let resolveMergedOutputName: typeof import('../generators/audio-merge.js').resolveMergedOutputName
let root: string

before(async () => {
  await useTempDataDir()
  ;({ resolveMergedOutputName } = await import('../generators/audio-merge.js'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-audio-merge-output-'))
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('overwrite replaces the active highest merge while new creates the next version', async () => {
  await Promise.all([
    fs.writeFile(path.join(root, 'EP0047_merged_audio.mp3'), 'v1'),
    fs.writeFile(path.join(root, 'EP0047_merged_audio_v2.mp3'), 'v2'),
    fs.writeFile(path.join(root, 'unrelated.mp3'), 'ignore'),
  ])

  assert.equal(await resolveMergedOutputName(root, 'EP0047', 'overwrite'), 'EP0047_merged_audio_v2.mp3')
  assert.equal(await resolveMergedOutputName(root, 'EP0047', 'new'), 'EP0047_merged_audio_v3.mp3')
})

test('overwrite keeps the canonical filename when no merge exists yet', async () => {
  const empty = await fs.mkdtemp(path.join(root, 'empty-'))
  assert.equal(await resolveMergedOutputName(empty, 'EP0048', 'overwrite'), 'EP0048_merged_audio.mp3')
})
