/** FFmpeg runs at nice 10 and libx264 leaves two cores free, so encodes cannot starve the main thread. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import test from 'node:test'
import { lowerFfmpegPriority, withX264ThreadCap } from '../lib/ffmpeg-utils.js'

test('a spawned encoder is lowered to nice 10; a vanished pid is ignored', async () => {
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
  try {
    lowerFfmpegPriority(proc)
    assert.equal(os.getPriority(proc.pid!), 10)
  } finally {
    proc.kill('SIGKILL')
  }
  await new Promise(resolve => proc.once('close', resolve))
  assert.doesNotThrow(() => lowerFfmpegPriority(proc))
})

test('libx264 encodes get -threads cores-2 (at least 1); other encoders and explicit caps are untouched', () => {
  assert.deepEqual(withX264ThreadCap(['-i', 'a.png', '-c:v', 'libx264', '-crf', '20', 'out.mp4'], 10),
    ['-i', 'a.png', '-c:v', 'libx264', '-threads', '8', '-crf', '20', 'out.mp4'])
  assert.deepEqual(withX264ThreadCap(['-c:v', 'libx264', 'o.mp4'], 2), ['-c:v', 'libx264', '-threads', '1', 'o.mp4'])
  const vt = ['-c:v', 'h264_videotoolbox', 'o.mp4']
  assert.deepEqual(withX264ThreadCap(vt, 10), vt)
  const pinned = ['-c:v', 'libx264', '-threads', '2', 'o.mp4']
  assert.equal(withX264ThreadCap(pinned, 10), pinned)
  assert.deepEqual(withX264ThreadCap(['-i', 'in.wav', 'out.mp3'], 10), ['-i', 'in.wav', 'out.mp3'])
})
