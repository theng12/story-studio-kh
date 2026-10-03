/**
 * One file per chapter: split narration parts are joined with text-led pauses,
 * level-matched, click-free, kept in `.parts`, migrated idempotently, finished
 * after a stop, and cleared to `_trash` after the final render.
 * Fixtures are synthetic tones made with FFmpeg (no real narration needed).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
const {
  planSeams, stitchParts, consolidateChapterParts, readPartsManifest, trashEpisodeParts, SEAM_PAUSE_S,
} = await import('../services/chapter-parts.js')
const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
const { readAudioQualityProvenance, writeAudioQualityProvenance } = await import('../services/audio-quality-store.js')

/** A tone of `seconds` at `gainDb`, with leading/trailing digital silence. */
async function tone(file: string, opts: { seconds: number; gainDb: number; lead: number; trail: number; freq?: number; noise?: boolean }): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Pink noise stands in for speech where loudness is measured: LAME re-encoding
  // a pure tone loses ~0.5 LU per generation, which speech does not.
  await runFfmpeg(['-y', '-hide_banner', '-f', 'lavfi', '-i', opts.noise
    ? `anoisesrc=color=pink:amplitude=0.1:sample_rate=24000:duration=${opts.seconds}:seed=${opts.freq ?? 1}`
    : `sine=frequency=${opts.freq ?? 220}:sample_rate=24000:duration=${opts.seconds}`,
    '-af', `volume=${opts.gainDb}dB,adelay=${Math.round(opts.lead * 1000)},apad=pad_dur=${opts.trail}`,
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', file])
}

async function silences(file: string): Promise<Array<[number, number]>> {
  const log = await runFfmpeg(['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=n=-50dB:d=0.1', '-f', 'null', '-'])
  const s = [...log.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]))
  const e = [...log.matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]))
  return s.map((start, i) => [start, e[i] ?? Infinity])
}

async function lufs(file: string, start: number, end: number): Promise<number> {
  const log = await runFfmpeg(['-hide_banner', '-nostats', '-i', file, '-af', `atrim=start=${start}:end=${end},ebur128=framelog=quiet`, '-f', 'null', '-'])
  return Number([...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)![1])
}

async function samples(file: string): Promise<Int16Array> {
  const raw = path.join(path.dirname(file), `${path.basename(file)}.raw`)
  await runFfmpeg(['-y', '-hide_banner', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '24000', raw])
  const bytes = await fs.readFile(raw)
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
}

void test('seams follow the text: 0.6 s at a paragraph break, 0.3 s after a sentence, 0.18 s mid-sentence', () => {
  const text = 'One sentence ends here. Another follows.\n\nA new paragraph starts, and it runs on and'
    + ' then the part ends mid-sentence and continues "quoted."\nNext line.'
  const parts = ['One sentence ends here.', 'Another follows.', 'A new paragraph starts, and it runs on and',
    'then the part ends mid-sentence and continues "quoted."', 'Next line.']
  const { pauses, ranges } = planSeams(text, parts)
  assert.deepEqual(pauses, [SEAM_PAUSE_S.sentence, SEAM_PAUSE_S.paragraph, SEAM_PAUSE_S.soft, SEAM_PAUSE_S.sentence])
  assert.equal(text.slice(ranges[2]!.start, ranges[2]!.end), parts[2])
})

void test('a join trims each part\'s own silence, inserts the exact pause and never clicks', async () => {
  const dir = path.join(temp.dir, 'stitch')
  const files = [path.join(dir, 'a.mp3'), path.join(dir, 'b.mp3'), path.join(dir, 'c.mp3')]
  // Different edge silences and levels; part b ends mid-waveform (no tail silence).
  await tone(files[0]!, { seconds: 2, gainDb: 8, lead: 0.25, trail: 0.4 })
  await tone(files[1]!, { seconds: 2.013, gainDb: -2, lead: 0, trail: 0, freq: 330 })
  await tone(files[2]!, { seconds: 2, gainDb: 3, lead: 0.5, trail: 0.2 })
  const out = path.join(dir, 'joined.mp3')
  const result = await stitchParts(files, [0.6, 0.3], out)

  // Exact pauses: the only silences >= 100 ms are the two seams, each within 20 ms.
  const gaps = (await silences(out)).filter(([s, e]) => e !== Infinity && s > 0.05)
  assert.equal(gaps.length, 2, JSON.stringify(gaps))
  assert.ok(Math.abs((gaps[0]![1] - gaps[0]![0]) - 0.6) <= 0.02, `paragraph seam ${gaps[0]![1] - gaps[0]![0]}`)
  assert.ok(Math.abs((gaps[1]![1] - gaps[1]![0]) - 0.3) <= 0.02, `sentence seam ${gaps[1]![1] - gaps[1]![0]}`)
  // Leading silence of part a was trimmed too: the file starts with sound.
  assert.ok((await silences(out)).every(([s]) => s > 0.05))

  assert.equal(result.parts.length, 3)
  assert.ok(result.parts.some(part => part.gain_db > 3) && result.parts.some(part => part.gain_db < -3), 'quiet part raised, loud part lowered')

  // No click: the largest sample step across each seam is no bigger than the
  // tone's own largest step (a hard cut of part b's 330 Hz wave would be ~3x that).
  const pcm = await samples(out)
  const step = (from: number, to: number) => {
    let max = 0
    for (let i = Math.max(1, Math.floor(from * 24000)); i < Math.min(pcm.length, Math.floor(to * 24000)); i++) max = Math.max(max, Math.abs(pcm[i]! - pcm[i - 1]!))
    return max
  }
  const inTone = step(gaps[0]![1] + 0.2, gaps[0]![1] + 1.2)
  assert.ok(step(gaps[1]![0] - 0.004, gaps[1]![0] + 0.05) <= inTone * 1.05, 'seam after the abrupt part does not click')
})

void test('parts recorded up to 10 LU apart are joined within 0.5 LU of each other, without passing -1 dBTP', async () => {
  const dir = path.join(temp.dir, 'level')
  const files = [path.join(dir, 'a.mp3'), path.join(dir, 'b.mp3'), path.join(dir, 'c.mp3')]
  await tone(files[0]!, { seconds: 3, gainDb: 6, lead: 0.1, trail: 0.1, noise: true, freq: 1 })
  await tone(files[1]!, { seconds: 3, gainDb: -4, lead: 0.1, trail: 0.1, noise: true, freq: 2 })
  await tone(files[2]!, { seconds: 3, gainDb: 1, lead: 0.1, trail: 0.1, noise: true, freq: 3 })
  const out = path.join(dir, 'joined.mp3')
  const result = await stitchParts(files, [0.6, 0.6], out)
  const raw = result.parts.map(part => part.lufs!)
  assert.ok(Math.max(...raw) - Math.min(...raw) > 9, `raw ${raw}`)
  const gaps = (await silences(out)).filter(([s, e]) => e !== Infinity && s > 0.05)
  assert.equal(gaps.length, 2)
  const levels = [
    await lufs(out, 0.05, gaps[0]![0] - 0.05),
    await lufs(out, gaps[0]![1] + 0.05, gaps[1]![0] - 0.05),
    await lufs(out, gaps[1]![1] + 0.05, gaps[1]![1] + 2.8),
  ]
  assert.ok(Math.max(...levels) - Math.min(...levels) < 0.5, `levels ${levels}`)
  const log = await runFfmpeg(['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'])
  assert.ok(Number(log.match(/Peak:\s+(-?[\d.]+) dBFS/)![1]) <= -0.8, 'no part was pushed past the true-peak ceiling')
})

async function episodeFixture(name: string, opts: { selector?: boolean; oldTake?: boolean } = {}) {
  const projectDir = path.join(temp.dir, name)
  const episodeDir = path.join(projectDir, 'episodes', 'EP001 - Test')
  const audioDir = path.join(episodeDir, 'EP001 - 07 Audio Assets')
  const parts = [1, 2, 3].map(n => `EP001_Chapter_02_part${n}.mp3`)
  for (const [i, file] of parts.entries()) await tone(path.join(audioDir, file), { seconds: 1, gainDb: -16 - i * 3, lead: 0.1, trail: 0.15 })
  await tone(path.join(audioDir, 'EP001_Chapter_01.mp3'), { seconds: 1, gainDb: -16, lead: 0, trail: 0 })
  if (opts.oldTake) await tone(path.join(audioDir, 'EP001_Chapter_02.mp3'), { seconds: 3, gainDb: -16, lead: 0, trail: 0, freq: 440 })
  await writeAudioQualityProvenance(episodeDir, {
    version: 1,
    chapters: {
      Chapter_01: { normalized_script_hash: 'sha256:a', normalization: 'tts-v1', source_files: ['EP001_Chapter_01.mp3'], recorded_at: 'now',
        source_audio_hash: (await hashSubtitleAudioSources([path.join(audioDir, 'EP001_Chapter_01.mp3')]))! },
      Chapter_02: { normalized_script_hash: 'sha256:b', normalization: 'tts-v1', source_files: parts, recorded_at: 'now',
        source_audio_hash: (await hashSubtitleAudioSources(parts.map(file => path.join(audioDir, file))))!,
        tts: { model_id: 'mock-model', voice_id: 'mock-voice', task_ids: { [parts[0]!]: 'task-1' }, idempotency_keys: { [parts[0]!]: 'key-1' } } },
    },
  })
  if (opts.selector) {
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({ sections: [
      { slug: 'Chapter_01', duration_s: 1, source_file: 'EP001_Chapter_01.mp3', source_files: ['EP001_Chapter_01.mp3'] },
      { slug: 'Chapter_02', duration_s: 3, source_file: parts[0], source_files: parts },
    ] }))
  }
  const texts = new Map([['Chapter_02', { sectionText: 'First part.\n\nSecond part. Third part.', parts: ['First part.', 'Second part.', 'Third part.'] }]])
  return { projectDir, episodeDir, audioDir, parts, texts, code: 'EP001' }
}

async function looseAudio(audioDir: string): Promise<string[]> {
  return (await fs.readdir(audioDir)).filter(name => name.endsWith('.mp3')).sort()
}

void test('migration: complete parts become one chapter file, parts hidden with a manifest, older take to _trash, idempotent', async () => {
  const fx = await episodeFixture('migrate', { selector: true, oldTake: true })
  const log: string[] = []
  assert.deepEqual(await consolidateChapterParts({ ...fx, log: line => log.push(line) }), ['Chapter_02'])

  assert.deepEqual(await looseAudio(fx.audioDir), ['EP001_Chapter_01.mp3', 'EP001_Chapter_02.mp3'])
  const manifest = (await readPartsManifest(fx.audioDir, 'EP001_Chapter_02'))!
  assert.deepEqual(manifest.parts.map(part => [part.file, part.source_name, part.pause_after_s]), [
    ['part1.mp3', fx.parts[0], 0.6], ['part2.mp3', fx.parts[1], 0.3], ['part3.mp3', fx.parts[2], undefined],
  ])
  assert.equal(manifest.parts[0]!.request_key, 'key-1')
  assert.equal(manifest.parts[0]!.task_id, 'task-1')
  assert.equal(manifest.model_id, 'mock-model')
  assert.equal(manifest.voice_id, 'mock-voice')
  for (const n of [1, 2, 3]) assert.ok(existsSync(path.join(fx.audioDir, '.parts', 'EP001_Chapter_02', `part${n}.mp3`)))

  const provenance = await readAudioQualityProvenance(fx.episodeDir)
  assert.deepEqual(provenance.chapters.Chapter_02!.source_files, ['EP001_Chapter_02.mp3'])
  assert.equal(provenance.chapters.Chapter_02!.source_audio_hash, await hashSubtitleAudioSources([path.join(fx.audioDir, 'EP001_Chapter_02.mp3')]))
  const selector = JSON.parse(await fs.readFile(path.join(fx.episodeDir, 'audio_chapters.json'), 'utf8'))
  assert.deepEqual(selector.sections[1].source_files, ['EP001_Chapter_02.mp3'])
  assert.equal(selector.sections[1].source_file, 'EP001_Chapter_02.mp3')

  // Never deleted: the older single take is in the project's _trash, same relative path.
  assert.ok(existsSync(path.join(fx.projectDir, '_trash', 'episodes', 'EP001 - Test', 'EP001 - 07 Audio Assets', 'EP001_Chapter_02.mp3')))
  assert.ok(log.some(line => /older single-file take/.test(line)))

  // Second run: nothing to do, nothing moves.
  const before = await fs.readFile(path.join(fx.audioDir, 'EP001_Chapter_02.mp3'))
  assert.deepEqual(await consolidateChapterParts(fx), [])
  assert.deepEqual(await fs.readFile(path.join(fx.audioDir, 'EP001_Chapter_02.mp3')), before)
})

void test('incomplete, unconfirmed or held parts are never joined', async () => {
  // A part whose bytes no longer match the committed take (still being remade).
  const changed = await episodeFixture('changed')
  await tone(path.join(changed.audioDir, changed.parts[1]!), { seconds: 2, gainDb: -16, lead: 0, trail: 0 })
  assert.deepEqual(await consolidateChapterParts(changed), [])
  assert.equal((await looseAudio(changed.audioDir)).length, 4)

  // A missing part.
  const missing = await episodeFixture('missing')
  await fs.rename(path.join(missing.audioDir, missing.parts[2]!), path.join(missing.projectDir, 'elsewhere.mp3'))
  assert.deepEqual(await consolidateChapterParts(missing), [])

  // Audio Assembly selected other files than the committed take.
  const disagree = await episodeFixture('disagree', { selector: true })
  const selectorPath = path.join(disagree.episodeDir, 'audio_chapters.json')
  const sidecar = JSON.parse(await fs.readFile(selectorPath, 'utf8'))
  sidecar.sections[1].source_files = ['EP001_Chapter_02_part1_v2.mp3']
  await fs.writeFile(selectorPath, JSON.stringify(sidecar))
  assert.deepEqual(await consolidateChapterParts(disagree), [])

  // A pending audio-quality action owns the chapter's source map.
  const held = await episodeFixture('held')
  const provenance = await readAudioQualityProvenance(held.episodeDir)
  provenance.actions = { a1: { action_id: 'a1', scope_fingerprint: 's', source_fingerprint: 'f', sections: ['Chapter_02'],
    source_files: { Chapter_02: held.parts }, mode: 'check_and_repair', state: 'confirmed', created_at: 'now', verification_credit_ceiling: 1 } }
  await writeAudioQualityProvenance(held.episodeDir, provenance)
  assert.deepEqual(await consolidateChapterParts(held), [])
})

void test('restart safety: a join stopped before its parts moved is finished, a stale temp file never becomes the chapter', async () => {
  const fx = await episodeFixture('restart', { selector: true })
  // A stop mid-FFmpeg leaves only the hidden temp file; the chapter is untouched.
  await fs.writeFile(path.join(fx.audioDir, '.EP001_Chapter_02.joined.mp3'), 'half a file')
  assert.deepEqual(await consolidateChapterParts({ ...fx, texts: fx.texts }), ['Chapter_02'])
  const joined = await fs.readFile(path.join(fx.audioDir, 'EP001_Chapter_02.mp3'))
  assert.ok(joined.length > 1000)
  assert.ok(!existsSync(path.join(fx.audioDir, '.EP001_Chapter_02.joined.mp3')))

  // Simulate a stop after the records moved to the joined file but before the
  // parts moved: the parts are back loose in the folder.
  for (const n of [1, 2, 3]) {
    await fs.rename(path.join(fx.audioDir, '.parts', 'EP001_Chapter_02', `part${n}.mp3`), path.join(fx.audioDir, fx.parts[n - 1]!))
  }
  assert.deepEqual(await consolidateChapterParts(fx), [], 'finishing a join is not a new join')
  assert.deepEqual(await looseAudio(fx.audioDir), ['EP001_Chapter_01.mp3', 'EP001_Chapter_02.mp3'])
  assert.deepEqual(await fs.readFile(path.join(fx.audioDir, 'EP001_Chapter_02.mp3')), joined)
  assert.ok(!existsSync(path.join(fx.projectDir, '_trash')), 'the joined file was not treated as an older take')

  // Simulate a stop after the joined file and manifest were written but before
  // the records changed: provenance still names the parts.
  const provenance = await readAudioQualityProvenance(fx.episodeDir)
  provenance.chapters.Chapter_02!.source_files = fx.parts
  await writeAudioQualityProvenance(fx.episodeDir, provenance)
  for (const n of [1, 2, 3]) {
    await fs.rename(path.join(fx.audioDir, '.parts', 'EP001_Chapter_02', `part${n}.mp3`), path.join(fx.audioDir, fx.parts[n - 1]!))
  }
  await consolidateChapterParts(fx)
  assert.deepEqual((await readAudioQualityProvenance(fx.episodeDir)).chapters.Chapter_02!.source_files, ['EP001_Chapter_02.mp3'])
  assert.deepEqual(await looseAudio(fx.audioDir), ['EP001_Chapter_01.mp3', 'EP001_Chapter_02.mp3'])
  assert.deepEqual(await fs.readFile(path.join(fx.audioDir, 'EP001_Chapter_02.mp3')), joined)
})

void test('a new take of the parts (Regenerate) is joined again; the previous join and parts go to _trash', async () => {
  const fx = await episodeFixture('retake', { selector: true })
  await consolidateChapterParts(fx)
  const firstJoin = await fs.readFile(path.join(fx.audioDir, 'EP001_Chapter_02.mp3'))
  // Regenerate wrote all three parts again, with different sound, and committed them.
  for (const [i, file] of fx.parts.entries()) await tone(path.join(fx.audioDir, file), { seconds: 1.5, gainDb: -16, lead: 0, trail: 0, freq: 500 + i * 50 })
  const provenance = await readAudioQualityProvenance(fx.episodeDir)
  provenance.chapters.Chapter_02!.source_files = fx.parts
  provenance.chapters.Chapter_02!.source_audio_hash = (await hashSubtitleAudioSources(fx.parts.map(file => path.join(fx.audioDir, file))))!
  await writeAudioQualityProvenance(fx.episodeDir, provenance)
  const selectorPath = path.join(fx.episodeDir, 'audio_chapters.json')
  const sidecar = JSON.parse(await fs.readFile(selectorPath, 'utf8'))
  sidecar.sections[1].source_files = fx.parts
  await fs.writeFile(selectorPath, JSON.stringify(sidecar))

  assert.deepEqual(await consolidateChapterParts(fx), ['Chapter_02'])
  assert.notDeepEqual(await fs.readFile(path.join(fx.audioDir, 'EP001_Chapter_02.mp3')), firstJoin)
  assert.deepEqual(await looseAudio(fx.audioDir), ['EP001_Chapter_01.mp3', 'EP001_Chapter_02.mp3'])
  const trashed = path.join(fx.projectDir, '_trash', 'episodes', 'EP001 - Test', 'EP001 - 07 Audio Assets')
  assert.deepEqual(await fs.readFile(path.join(trashed, 'EP001_Chapter_02.mp3')), firstJoin)
  assert.ok(existsSync(path.join(trashed, '.parts', 'EP001_Chapter_02', 'part1.mp3')))
})

void test('after the final render the kept parts move to the project _trash', async () => {
  const fx = await episodeFixture('render')
  await consolidateChapterParts(fx)
  assert.equal(trashEpisodeParts(fx.projectDir, fx.audioDir), true)
  assert.ok(!existsSync(path.join(fx.audioDir, '.parts')))
  assert.ok(existsSync(path.join(fx.projectDir, '_trash', 'episodes', 'EP001 - Test', 'EP001 - 07 Audio Assets', '.parts', 'EP001_Chapter_02', 'part1.mp3')))
  assert.equal(trashEpisodeParts(fx.projectDir, fx.audioDir), false, 'nothing left to move')
  assert.ok(existsSync(path.join(fx.audioDir, 'EP001_Chapter_02.mp3')))
})
