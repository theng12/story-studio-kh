/**
 * Dreamlands EP0001 Ch03 312-347 s: 4 s of silence, then 28 s of slow DC drift
 * where a sentence should be. The Subtitles page now says "the narration is
 * silent here" for that, and "there is sound here" when something is audible.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { annotateGapAudio, classifyGapAudio, inspectGapAudio, voicedShare } from '../services/gap-audio-check.js'

const run = promisify(execFile)
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gap-audio-'))
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function render(name: string, expr: string, seconds: number): Promise<string> {
  const out = path.join(dir, name)
  await run(await getFFmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=24000:d=${seconds}`, '-c:a', 'libmp3lame', '-y', out])
  return out
}

test('slow DC drift counts as silence; a voice-level tone counts as sound', () => {
  const drift = Int16Array.from({ length: 16000 * 3 }, (_, i) => Math.round(18000 + 6000 * Math.sin(2 * Math.PI * 0.3 * i / 16000)))
  const tone = Int16Array.from({ length: 16000 * 3 }, (_, i) => Math.round(6000 * Math.sin(2 * Math.PI * 220 * i / 16000)))
  assert.equal(classifyGapAudio(voicedShare(drift)), 'silent')
  assert.equal(classifyGapAudio(voicedShare(new Int16Array(16000))), 'silent')
  assert.equal(classifyGapAudio(voicedShare(tone)), 'sound')
})

test('a gap is measured in the chapter audio, across its parts', async () => {
  const part1 = await render('EP0001_Chapter_03_part1.mp3', '0.3*sin(2*PI*220*t)', 4)
  const part2 = await render('EP0001_Chapter_03_part2.mp3', '0.5+0.2*sin(2*PI*0.3*t)', 6)
  assert.equal(await inspectGapAudio([part1, part2], 0.5, 3.5), 'sound')
  assert.equal(await inspectGapAudio([part1, part2], 4.5, 9.5), 'silent', 'the drift in part 2 is found at chapter time 4.5-9.5 s')
  assert.equal(await inspectGapAudio([path.join(dir, 'missing.mp3')], 0, 5), null, 'unreadable audio is not a verdict')

  await fs.writeFile(path.join(dir, 'audio_chapters.json'), JSON.stringify({ sections: [
    { slug: 'Chapter_03', source_files: [path.basename(part1), path.basename(part2)] },
  ] }))
  const gaps = [
    { previous_end_sec: 100, next_start_sec: 105, gap_sec: 5, section_slugs: ['Chapter_03'], section_local_start_sec: 4.5, section_local_end_sec: 9.5 },
    { previous_end_sec: 200, next_start_sec: 203, gap_sec: 3, section_slugs: ['Chapter_03', 'Chapter_04'] },
  ] as any[]
  await annotateGapAudio(gaps, dir, dir, 'EP0001')
  assert.equal(gaps[0].audio, 'silent')
  assert.equal(gaps[1].audio, undefined, 'a gap across two chapters has no single chapter audio to measure')
})
