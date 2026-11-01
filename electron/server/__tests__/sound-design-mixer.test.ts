import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { ffmpegExitErrorLine } from '../lib/ffmpeg-utils.js'
import { buildSoundDesignMixArgs, buildSpotGroupArgs, mixSoundDesignIntoAudio, SPOT_MIX_GROUP_SIZE, type SoundDesignMixCue } from '../lib/sound-design-mixer.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-mix-test-'))
const file = (name: string) => path.join(dir, name)
const ffmpeg = await getFFmpegPath()
function run(args: string[]): Buffer {
  return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 })
}
function tone(name: string, frequency: number, duration: number, rate: number, channels: number): string {
  const target = file(name)
  run(['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=${duration}`, '-t', String(duration), '-ac', String(channels), '-c:a', 'pcm_f32le', target])
  return target
}
function pcm(target: string, duration: number): Buffer {
  return run(['-i', target, '-t', String(duration), '-ar', '44100', '-ac', '2', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1'])
}
function lossless(args: string[]): string[] {
  const result = [...args]
  const codec = result.indexOf('-c:a')
  result.splice(codec, 4, '-c:a', 'pcm_f32le')
  return result
}

test('FFmpeg failure details keep the reason and omit the banner', () => {
  const result = ffmpegExitErrorLine('ffmpeg version 7\n  built with Apple clang\n  configuration: --foo\n  libavutil  59. 1\n[aist#0] Invalid data found when processing input\nError opening input file x.\nError opening input files: Invalid data found\n')
  assert.match(result, /Invalid data found when processing input/)
  assert.doesNotMatch(result, /ffmpeg version|built with|configuration:|libavutil/)
  assert.equal(ffmpegExitErrorLine('  \n'), '(no stderr captured)')
})

test('337 cues all reach the real mix without exceeding 25 inputs per process', async () => {
  const base = tone('many-base.wav', 100, 15, 44100, 1)
  const spot = tone('many-spot.wav', 1200, 0.018, 44100, 1)
  const cues: SoundDesignMixCue[] = Array.from({ length: 337 }, (_, i) => ({ kind: 'spot', path: spot, gain_db: 0, start_sec: 0.1 + i * 0.04 }))
  const resources = file('resources')
  fs.mkdirSync(path.join(resources, 'ffmpeg'), { recursive: true })
  const log = file('inputs.log')
  const wrapper = path.join(resources, 'ffmpeg', 'ffmpeg')
  fs.writeFileSync(wrapper, '#!/bin/sh\nn=0\nfor arg in "$@"; do [ "$arg" = "-i" ] && n=$((n+1)); done\nprintf "%s\\n" "$n" >> "$SOUND_MIX_INPUT_LOG"\nexec "$SOUND_MIX_REAL_FFMPEG" "$@"\n', { mode: 0o755 })
  const oldResources = process.env.STORY_STUDIO_RESOURCES_DIR
  process.env.STORY_STUDIO_RESOURCES_DIR = resources
  process.env.SOUND_MIX_REAL_FFMPEG = ffmpeg
  process.env.SOUND_MIX_INPUT_LOG = log
  try {
    await mixSoundDesignIntoAudio({ basePath: base, cues: [...cues].reverse(), outPath: file('many.mp3'), ducking_profile: 'standard' })
  } finally {
    if (oldResources === undefined) delete process.env.STORY_STUDIO_RESOURCES_DIR
    else process.env.STORY_STUDIO_RESOURCES_DIR = oldResources
    delete process.env.SOUND_MIX_REAL_FFMPEG
    delete process.env.SOUND_MIX_INPUT_LOG
  }
  const counts = fs.readFileSync(log, 'utf8').trim().split('\n').map(Number)
  assert.equal(counts.length, Math.ceil(cues.length / SPOT_MIX_GROUP_SIZE) + 1)
  assert.ok(counts.every(n => n <= SPOT_MIX_GROUP_SIZE + 1), `input counts: ${counts}`)
  const audio = pcm(file('many.mp3'), 15)
  for (const [i, cue] of cues.entries()) {
    const first = Math.round((cue.start_sec + 0.004) * 44100)
    const last = Math.round((cue.start_sec + 0.014) * 44100)
    let energy = 0
    for (let frame = first; frame < last; frame++) energy += Math.abs(audio.readFloatLE(frame * 8))
    assert.ok(energy / (last - first) > 0.025, `cue ${i} missing at ${cue.start_sec}s`)
  }
})

test('grouped PCM matches direct mix with a ducked bed and mixed formats', () => {
  const base = tone('base.wav', 210, 4, 44100, 2)
  const bedPath = tone('bed.wav', 310, 0.5, 48000, 1)
  const a = tone('a.wav', 730, 0.06, 44100, 1)
  const b = tone('b.wav', 990, 0.06, 48000, 2)
  const beds: SoundDesignMixCue[] = [{ kind: 'bed', path: bedPath, gain_db: -15, start_sec: 0, end_sec: 3.9 }]
  const spots: SoundDesignMixCue[] = Array.from({ length: 26 }, (_, i) => ({ kind: 'spot', path: i % 2 ? b : a, gain_db: -9, start_sec: 0.1006 + i * 0.1 }))
  const stems = []
  for (let i = 0; i < spots.length; i += SPOT_MIX_GROUP_SIZE) {
    const group = spots.slice(i, i + SPOT_MIX_GROUP_SIZE)
    const start_sec = group[0]!.start_sec
    const stem = file(`stem-${i}.wav`)
    run(buildSpotGroupArgs({ cues: group, startSec: start_sec, outPath: stem, sampleRate: 44100, channelLayout: 'stereo' }))
    const stemPcm = pcm(stem, 0.03)
    let stemEnergy = 0
    for (let frame = 100; frame < 800; frame++) stemEnergy += Math.abs(stemPcm.readFloatLE(frame * 8))
    assert.ok(stemEnergy / 700 > 0.01, 'stem begins with its first cue')
    stems.push({ path: stem, start_sec })
  }
  const grouped = file('grouped.wav')
  run(lossless(buildSoundDesignMixArgs({ basePath: base, beds, stems, outPath: grouped, ducking_profile: 'standard' })))
  const direct = file('direct.wav')
  const args = ['-i', base, '-i', bedPath, ...spots.flatMap(c => ['-i', c.path])]
  const graph = ['[0:a]asplit=2[base][voice0]', '[1:a]aloop=loop=-1:size=2147483647,atrim=duration=3.900,volume=-15dB,adelay=0:all=1[raw0]', '[raw0][voice0]sidechaincompress=threshold=0.045:ratio=5:attack=30:release=450[bed0]']
  spots.forEach((c, i) => graph.push(`[${i + 2}:a]volume=${c.gain_db}dB,adelay=${Math.round(c.start_sec * 1000)}:all=1[c${i}]`))
  graph.push(`[base][bed0]${spots.map((_, i) => `[c${i}]`).join('')}amix=inputs=28:duration=first:normalize=0[mix]`)
  run([...args, '-filter_complex', graph.join(';'), '-map', '[mix]', '-t', '4', '-c:a', 'pcm_f32le', direct])
  const x = pcm(direct, 4), y = pcm(grouped, 4)
  assert.equal(x.length, y.length)
  let max = 0, sum = 0, maxAt = 0
  for (let i = 0; i < x.length; i += 4) { const d = Math.abs(x.readFloatLE(i) - y.readFloatLE(i)); if (d > max) { max = d; maxAt = i / 8 / 44100 }; sum += d * d }
  const rms = Math.sqrt(sum / (x.length / 4))
  console.log(`PCM difference: max=${max} at ${maxAt}s, rms=${rms}, samples=${x.length / 4}; tolerance max=0.001`)
  assert.ok(max < 0.001, `PCM max difference ${max}`)
})
