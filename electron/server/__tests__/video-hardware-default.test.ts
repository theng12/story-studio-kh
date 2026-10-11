/**
 * Owner, 2026-10-09: "set up the hardware encoder for video assembly." The final
 * encode ran libx264 ultrafast at about 0.9× realtime on the mini (a TerraNash
 * episode took ~1 h 56 min). With no saved encoding effort it now uses the Media
 * Engine; a saved effort is the owner's and wins; libx264 takes over by itself if
 * VideoToolbox cannot start; the length check still runs on the result.
 */
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let video: typeof import('../generators/video.js')
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'video.ts')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  video = await import('../generators/video.js')
})
after(async () => { await cleanup() })

test('hardware is the default only when no effort was saved and VideoToolbox exists', () => {
  const hw = { h264: true }
  assert.equal(video.defaultEncodingEffort({}, hw), 'hardware')
  assert.equal(video.defaultEncodingEffort({ codec: 'h264', format: 'mp4' }, hw), 'hardware')
  assert.equal(video.defaultEncodingEffort({ encoding_effort: 'ultrafast' }, hw), undefined, 'a saved CPU preset is honoured')
  assert.equal(video.defaultEncodingEffort({ encoding_effort: 'slow' }, hw), undefined)
  assert.equal(video.defaultEncodingEffort({ codec: 'h265' }, hw), undefined, 'HEVC keeps libx265')
  assert.equal(video.defaultEncodingEffort({ format: 'webm' }, hw), undefined, 'WebM keeps VP9')
  assert.equal(video.defaultEncodingEffort({}, { h264: false }), undefined, 'no VideoToolbox in this FFmpeg: CPU as before')
  assert.equal(video.defaultEncodingEffort({}, undefined), undefined)
})

test('the hardware argv: videotoolbox at the quality tier\'s q:v, no silent Apple software encoder, same audio/container', () => {
  const args = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'hardware' })
  assert.deepEqual(args, [
    '-c:v', 'h264_videotoolbox', '-q:v', String(video.crfToVideotoolboxQ(28)),
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  assert.equal(video.crfToVideotoolboxQ(28), 50)
})

test('a failed VideoToolbox encode falls back to libx264 with the full graph, then the result is checked', async () => {
  const hardware = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'hardware' })
  const software = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'ultrafast' })
  const ran: string[][] = []
  const log: string[] = []
  const result = await video.runEncodeTierChain([
    { label: 'H.264 · hardware', build: () => ['FULL', ...hardware] },
    { label: 'H.264 · libx264 ultrafast (hardware fallback, full effects)', degraded: 'hardware encoder unavailable', shouldRun: () => true, build: () => ['FULL', ...software] },
    { label: 'H.264 · no effects (recovery)', build: () => ['MINIMAL'], dropsBurnedInFeatures: true },
  ], {
    run: async args => {
      ran.push(args)
      if (args.includes('h264_videotoolbox')) throw Object.assign(new Error('FFmpeg exited with code 1'), { stderr: 'Error while opening encoder: VTCompressionSessionCreate failed' })
    },
    validate: async () => {},
    log: line => log.push(line),
    logCmd: () => {},
    isCancelled: () => false,
  })
  assert.equal(result.succeededTier?.label, 'H.264 · libx264 ultrafast (hardware fallback, full effects)')
  assert.deepEqual(ran.map(args => args[0]), ['FULL', 'FULL'], 'effects kept: the minimal recovery never ran')
  assert.ok(ran[1]!.includes('libx264'))

  // The production chain has exactly this tier, keyed on the hardware effort, and both
  // final paths still run the length check after encoding.
  const source = await readFile(SOURCE, 'utf8')
  assert.match(source, /label: `H\.264 · libx264 \$\{quality\.preset\} \(hardware fallback, full effects\)`[\s\S]{0,300}shouldRun: \(\) => effort === 'hardware',\s*build: \(\) => buildFullArgs\('h264', quality\.preset\)/)
  assert.equal(source.match(/await verifyFinalVideo\(job, /g)?.length, 2)
  assert.match(source, /if \(defaultEncodingEffort\(req, ffmpegCheck\.hw_encoders\)\) \{\s*req\.encoding_effort = 'hardware'/)
})

test('the job says which encoder made the video, and why software when hardware was wanted', () => {
  const hardware = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'hardware' })
  const software = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'ultrafast' })
  assert.equal(video.describeEncoder(hardware, true), 'Encoder: hardware (VideoToolbox h264)')
  assert.equal(video.describeEncoder(software, false), 'Encoder: software (libx264)', 'a saved CPU preset needs no excuse')
  assert.equal(
    video.describeEncoder(software, true, { message: 'FFmpeg exited with code 1', stderr: 'Error while opening encoder\nVTCompressionSessionCreate failed (-12902)\n' }),
    'Encoder: software (libx264) — hardware unavailable: VTCompressionSessionCreate failed (-12902)',
  )
  assert.equal(video.encoderKind(hardware), 'hardware (VideoToolbox h264)')
})
