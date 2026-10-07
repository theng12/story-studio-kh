import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { _clearAudioDurationCache, getAudioDuration } from '../lib/ffmpeg-utils.js'
import { useTempDataDir } from './_helpers.js'

/** A silent 16-bit mono PCM WAV with exactly `dataBytes` of samples. */
function wav(sampleRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}

// S7: one ffprobe per (path, size, mtime), not one per scan.
test('getAudioDuration remembers a probe until the file changes; an unprobeable file is not remembered', async () => {
  const temp = await useTempDataDir()
  try {
    _clearAudioDurationCache()
    const file = path.join(temp.dir, 'narration.wav')
    const stamp = new Date('2026-10-01T00:00:00Z')
    await fs.writeFile(file, wav(8000, 16000)) // 1 s
    await fs.utimes(file, stamp, stamp)
    assert.equal(Math.round(await getAudioDuration(file) ?? -1), 1)

    // Same size and mtime, different audio: the memo answers (proves no second probe).
    await fs.writeFile(file, wav(4000, 16000)) // 2 s, identical byte count
    await fs.utimes(file, stamp, stamp)
    assert.equal(Math.round(await getAudioDuration(file) ?? -1), 1)

    // Any touch is a miss.
    const later = new Date('2026-10-02T00:00:00Z')
    await fs.utimes(file, later, later)
    assert.equal(Math.round(await getAudioDuration(file) ?? -1), 2)

    const broken = path.join(temp.dir, 'broken.wav')
    await fs.writeFile(broken, 'not audio')
    assert.equal(await getAudioDuration(broken), undefined)
    await fs.writeFile(broken, wav(8000, 16000))
    await fs.utimes(broken, later, later)
    assert.equal(Math.round(await getAudioDuration(broken) ?? -1), 1, 'a failed probe was not cached')
    assert.equal(await getAudioDuration(path.join(temp.dir, 'missing.wav')), undefined)
  } finally {
    await temp.cleanup()
  }
})
