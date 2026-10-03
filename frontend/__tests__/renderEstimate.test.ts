import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateRender, formatEstimateTime } from '../utils/render-estimate.js'

// The measured render (Dreamlands EP0002, 2026-10-03): 2:10:25 of 1080p30 H.264 on the
// Media Engine ("YouTube — Fast"), pan + crossfades + subtitles → 5.91 GB in 30 min.
// The page used to say ~3.3 GB and ~5 min.
const youtubeFast = { resolution: '1080p', fps: 30, quality: 'medium', encoding_effort: 'hardware', codec: 'h264', format: 'mp4' }

test('the estimate for the measured render lands within 15 % of what it really took', () => {
  const { sizeGb, seconds } = estimateRender(youtubeFast, 7825)
  assert.ok(Math.abs(sizeGb - 5.91) / 5.91 < 0.15, `size ${sizeGb.toFixed(2)} GB`)
  assert.ok(Math.abs(seconds - 1800) / 1800 < 0.15, `time ${formatEstimateTime(seconds)}`)
})

test('a hardware bitrate target decides the size; a software cap only lowers it', () => {
  assert.ok(Math.abs(estimateRender({ ...youtubeFast, video_bitrate_kbps: 5000 }, 3600).sizeGb - 5 * 3600 / 8 / 1024) < 0.01)
  const software = { ...youtubeFast, encoding_effort: 'medium' }
  assert.ok(estimateRender({ ...software, video_bitrate_kbps: 1000 }, 3600).sizeGb < estimateRender(software, 3600).sizeGb)
  assert.equal(estimateRender({ ...software, video_bitrate_kbps: 50_000 }, 3600).sizeGb, estimateRender(software, 3600).sizeGb)
})
