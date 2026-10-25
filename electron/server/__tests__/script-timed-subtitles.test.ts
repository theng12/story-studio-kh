/**
 * Script-timed subtitles (2026-10-05): the script's own words on the narration's
 * known timeline. Fixtures have known section times, so every boundary is exact,
 * no cue crosses a join pause, time inside a section follows spoken length,
 * Khmer sentence ends split cues, and a file with no section timeline for its
 * bytes falls back to its whole speech and says so. Output is ordinary SRT.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const { cuesForSpans, cuesToSrt, spokenWeight, splitLongCue, scriptWordsFor } = await import('../lib/script-timed-cues.js')
const { parseSrt, normalizeSrtOrVtt } = await import('../lib/subtitle-builder.js')
const { scriptTimedChapter, recordSectionTimeline, sectionTimelineRows, SECTION_TIMELINES } = await import('../services/script-subtitles.js')
const { sha256File, textSha, EDGE_FADE_S } = await import('../services/chapter-parts.js')
const { resolveSubtitleMethod } = await import('../generators/subtitles.js')
const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)

test('Khmer: one cue per ។ sentence, section boundaries exact, no cue across the join pause', () => {
  const s1 = 'ព្រះអាទិត្យរះ។ផ្កាយលិច។'
  const s2 = 'ទឹកហូរ។'
  const cues = cuesForSpans([
    { start_s: 0.2, end_s: 4.2, text: s1 },
    // 1.0 s sentence pause, then the next section
    { start_s: 5.2, end_s: 7.0, text: s2 },
  ])
  assert.deepEqual(cues.map(c => c.text), ['ព្រះអាទិត្យរះ។', 'ផ្កាយលិច។', 'ទឹកហូរ។'])
  near(cues[0]!.start_sec, 0.2)
  near(cues[1]!.end_sec, 4.2)
  near(cues[2]!.start_sec, 5.2)
  near(cues[2]!.end_sec, 7.0)
  for (const cue of cues) assert.ok(!(cue.start_sec < 5.2 && cue.end_sec > 4.2), 'a cue spans the join pause')
  // proportional to spoken length (grapheme clusters, not code units)
  const w0 = spokenWeight('ព្រះអាទិត្យរះ។'), w1 = spokenWeight('ផ្កាយលិច។')
  near(cues[0]!.end_sec, 0.2 + 4 * w0 / (w0 + w1))
  assert.ok(w0 < 'ព្រះអាទិត្យរះ។'.length, 'Khmer vowel signs and subscripts do not count as extra length')
})

test('English: time inside a section follows spoken length; a long sentence splits at a clause', () => {
  const short = 'The tide came in.'
  const long = 'She walked along the shore for a long while, listening to the gulls and the soft hush of the waves, until the light was gone.'
  const cues = cuesForSpans([{ start_s: 10, end_s: 20, text: `${short} ${long}` }])
  assert.equal(cues[0]!.text, short)
  assert.ok(cues.length >= 3, 'the long sentence became several cues')
  assert.ok(cues.every(c => c.text.length <= 84))
  assert.equal(cues.slice(1).map(c => c.text).join(' '), long, 'every word kept, in order')
  near(cues[0]!.start_sec, 10)
  near(cues.at(-1)!.end_sec, 20)
  const total = spokenWeight(short) + cues.slice(1).reduce((sum, c) => sum + spokenWeight(c.text), 0)
  near(cues[0]!.end_sec, 10 + 10 * spokenWeight(short) / total)
  for (let i = 1; i < cues.length; i++) near(cues[i]!.start_sec, cues[i - 1]!.end_sec)
  assert.deepEqual(splitLongCue('short'), ['short'])
})

test('SRT output is the shape every consumer already parses', () => {
  const cues = cuesForSpans([{ start_s: 0, end_s: 3.5, text: 'One. Two.' }, { start_s: 4.5, end_s: 6, text: 'Three.' }])
  const srt = cuesToSrt(cues)
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,750\nOne\.\n\n2\n/)
  const parsed = parseSrt(srt)
  assert.deepEqual(parsed.map(c => [c.start_sec, c.end_sec, c.text]), [[0, 1.75, 'One.'], [1.75, 3.5, 'Two.'], [4.5, 6, 'Three.']])
  const normalized = normalizeSrtOrVtt(srt)
  assert.equal(normalized.cues, 3)
  assert.deepEqual(normalized.warnings, [])
})

test('the script\'s own words are shown where the voice was given normalised text', () => {
  const cues = cuesForSpans([{ start_s: 0, end_s: 4, text: 'It was nineteen ninety. The sea, calm.' }])
  assert.deepEqual(scriptWordsFor(cues, 'It was 1990. The sea — calm.').map(c => c.text), ['It was 1990.', 'The sea — calm.'])
  // different sentence counts: keep the spoken words rather than guess
  assert.deepEqual(scriptWordsFor(cues, 'It was 1990 and the sea was calm.').map(c => c.text), ['It was nineteen ninety.', 'The sea, calm.'])
})

test('Khmer picks script-timed automatically; English keeps transcription unless asked', () => {
  assert.equal(resolveSubtitleMethod({}, 'ព្រះអាទិត្យរះ។'), 'script')
  assert.equal(resolveSubtitleMethod({ language: 'km' }, ''), 'script')
  assert.equal(resolveSubtitleMethod({}, 'The tide came in.'), 'transcribe')
  assert.equal(resolveSubtitleMethod({ method: 'script' }, 'The tide came in.'), 'script')
  assert.equal(resolveSubtitleMethod({ method: 'transcribe' }, 'ព្រះអាទិត្យរះ។'), 'transcribe')
})

test('2026-10-25 scope: explicit method always wins; default unchanged for km and en', () => {
  // Explicit method wins both ways, regardless of language or script
  assert.equal(resolveSubtitleMethod({ method: 'script' }, 'The tide came in.'), 'script')
  assert.equal(resolveSubtitleMethod({ method: 'transcribe' }, 'ព្រះអាទិត្យរះ។'), 'transcribe')
  assert.equal(resolveSubtitleMethod({ method: 'transcribe', language: 'km' }, ''), 'transcribe')
  assert.equal(resolveSubtitleMethod({ method: 'script', language: 'en' }, 'Hello'), 'script')

  // Default unchanged: Khmer (by language or script) stays script-timed
  assert.equal(resolveSubtitleMethod({ language: 'km' }, ''), 'script')
  assert.equal(resolveSubtitleMethod({}, 'ព្រះអាទិត្យរះ។'), 'script')
  assert.equal(resolveSubtitleMethod({ language: 'km-KH' }, 'Some text'), 'script')

  // Default unchanged: English and other languages stay transcribed
  assert.equal(resolveSubtitleMethod({ language: 'en' }, 'Hello'), 'transcribe')
  assert.equal(resolveSubtitleMethod({}, 'The tide came in.'), 'transcribe')
  assert.equal(resolveSubtitleMethod({ language: 'th' }, 'สวัสดี'), 'transcribe')
})

test('a Hub timeline is kept only when every row is usable', () => {
  const row = { section: 1, start_s: 0, end_s: 1, text_start: 0, text_end: 4 }
  assert.deepEqual(sectionTimelineRows({ timeline: [row] }), [{ start_s: 0, end_s: 1, text_start: 0, text_end: 4 }])
  assert.equal(sectionTimelineRows({ sections: [] }), null)
  assert.equal(sectionTimelineRows({ timeline: [row, { ...row, start_s: 0.5 }] }), null, 'overlapping sections')
  assert.equal(sectionTimelineRows({ timeline: [{ ...row, end_s: Number.NaN }] }), null)
})

test('a joined chapter: Hub sections inside each part, Story\'s seams between parts, fallback for a part without timing', async () => {
  const audioDir = path.join(temp.dir, 'joined', 'audio')
  const code = 'KM0001', slug = 'Chapter_01', stem = `${code}_${slug}`
  await fs.mkdir(path.join(audioDir, '.parts', stem), { recursive: true })
  const part1 = 'ព្រះអាទិត្យរះ។ ផ្កាយលិច។'
  const part2 = 'ទឹកហូរ។ ខ្យល់បក់។'
  const spokenText = `${part1}\n\n${part2}`
  await fs.writeFile(path.join(audioDir, `${stem}.mp3`), 'joined bytes')
  await fs.writeFile(path.join(audioDir, `${stem}_part1.mp3`), 'part one bytes')
  // part 1 has the Hub's timeline: two sections, 1.0 s join between them, inside a file with 0.4 s lead silence.
  await recordSectionTimeline(audioDir, `${stem}_part1.mp3`, part1, {
    sections: [], timeline: [
      { section: 1, start_s: 0.4, end_s: 3.4, text_start: 0, text_end: part1.indexOf(' ') },
      { section: 2, start_s: 4.4, end_s: 6.4, text_start: part1.indexOf(' ') + 1, text_end: part1.length },
    ],
  })
  const partSha = await sha256File(path.join(audioDir, `${stem}_part1.mp3`))
  await fs.writeFile(path.join(audioDir, '.parts', stem, 'manifest.json'), JSON.stringify({
    schema_version: 1, chapter: slug, stitched_file: `${stem}.mp3`,
    stitched_sha256: await sha256File(path.join(audioDir, `${stem}.mp3`)), stitched_at: '', target_lufs: null,
    pause_rule: { sentence: 1, paragraph: 1.5, soft: 0.15 },
    parts: [
      { file: 'part1.mp3', source_name: `${stem}_part1.mp3`, sha256: partSha, text_start: 0, text_end: part1.length,
        text_sha256: textSha(part1), pause_after_s: 1.5, duration_s: 7.0, lead_silence_s: 0.4, trail_silence_s: 0.5, lufs: -20, gain_db: 0 },
      // part 2 was re-made on an older Hub: no timeline for its bytes
      { file: 'part2.mp3', source_name: `${stem}_part2.mp3`, sha256: 'other', text_start: part1.length + 2, text_end: spokenText.length,
        text_sha256: textSha(part2), duration_s: 5.0, lead_silence_s: 0.2, trail_silence_s: 0.3, lufs: -20, gain_db: 0 },
    ],
  }))

  const chapter = await scriptTimedChapter({ audioDir, code, slug, files: [`${stem}.mp3`], spokenText, scriptText: spokenText })
  assert.equal(chapter.timing, 'proportional', 'part 2 had no section timing, and the chapter says so')
  const cues = chapter.cues
  assert.deepEqual(cues.map(c => c.text), ['ព្រះអាទិត្យរះ។', 'ផ្កាយលិច។', 'ទឹកហូរ។', 'ខ្យល់បក់។'])
  // part 1 starts at 0 in the chapter (its 0.4 s lead was trimmed by the join)
  near(cues[0]!.start_sec, 0); near(cues[0]!.end_sec, 3.0)
  near(cues[1]!.start_sec, 4.0); near(cues[1]!.end_sec, 6.0)
  // part 1 is 7.0 - 0.4 - 0.5 = 6.1 s, then the 1.5 s paragraph seam (less the two edge fades)
  const part2Start = 6.1 + 1.5 - 2 * EDGE_FADE_S
  near(cues[2]!.start_sec, part2Start)
  near(cues[3]!.end_sec, part2Start + (5.0 - 0.2 - 0.3))
  for (const cue of cues) assert.ok(!(cue.start_sec < part2Start - 1e-6 && cue.end_sec > 6.1 + 1e-6), 'a cue spans the seam pause')
})

test('a single chapter file: exact with its timeline; whole-speech fallback without one', async () => {
  const audioDir = path.join(temp.dir, 'single', 'audio')
  await fs.mkdir(audioDir, { recursive: true })
  const code = 'EN0001'
  const text = 'The tide came in. The gulls were quiet.\n\nNight fell.'
  const file = path.join(audioDir, `${code}_Chapter_01.mp3`)
  // 0.5 s silence, 3 s tone, 0.7 s silence
  await runFfmpeg(['-y', '-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=3',
    '-af', 'adelay=500,apad=pad_dur=0.7', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', file])

  const fallback = await scriptTimedChapter({ audioDir, code, slug: 'Chapter_01', files: [path.basename(file)], spokenText: text, scriptText: text })
  assert.equal(fallback.timing, 'proportional')
  near(fallback.cues[0]!.start_sec, 0.5, 0.08)
  near(fallback.cues.at(-1)!.end_sec, 3.5, 0.08)

  await recordSectionTimeline(audioDir, path.basename(file), ` ${text}`, { timeline: [
    { section: 1, start_s: 0.5, end_s: 2.2, text_start: 0, text_end: 39 },
    { section: 2, start_s: 3.0, end_s: 3.5, text_start: 41, text_end: text.length },
  ] })
  const exact = await scriptTimedChapter({ audioDir, code, slug: 'Chapter_01', files: [path.basename(file)], spokenText: text, scriptText: text })
  assert.equal(exact.timing, 'sections')
  assert.deepEqual(exact.cues.map(c => c.text), ['The tide came in.', 'The gulls were quiet.', 'Night fell.'])
  near(exact.cues[0]!.start_sec, 0.5); near(exact.cues[1]!.end_sec, 2.2)
  near(exact.cues[2]!.start_sec, 3.0); near(exact.cues[2]!.end_sec, 3.5)

  // new bytes (a re-made chapter) → its old timeline no longer applies
  await runFfmpeg(['-y', '-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000:duration=2',
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', file])
  const remade = await scriptTimedChapter({ audioDir, code, slug: 'Chapter_01', files: [path.basename(file)], spokenText: text, scriptText: text })
  assert.equal(remade.timing, 'proportional')
  const record = JSON.parse(await fs.readFile(path.join(audioDir, SECTION_TIMELINES), 'utf8'))
  assert.ok(record.files[path.basename(file)].sha256, 'the timeline is bound to the bytes it describes')
})

test('a Khmer episode is script-timed end to end: no model, per-chapter SRTs, method recorded, timeline stitched', async t => {
  const isolated = await useTempDataDir()
  t.after(() => isolated.cleanup())
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')
  const { readSubtitleSourceModels } = await import('../services/subtitle-recovery.js')
  const project = await pm.createProject({ name: 'Khmer script-timed', episode_prefix: 'KM', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Two chapters', logline: 'A fixture.', themes: [], suggested_chapters: 2,
    suggested_length: '2 minutes', mood: 'measured',
  }], 'mock-chat-v1')
  const code = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  const texts: Record<string, string> = { Chapter_01: 'ព្រះអាទិត្យរះ។ ផ្កាយលិច។', Chapter_02: 'ទឹកហូរ។' }
  await fs.writeFile(paths.narration_docx, Object.values(texts).map((text, i) => `## Chapter 0${i + 1}: Fixture\n\n${text}`).join('\n\n'))
  for (const [slug, text] of Object.entries(texts)) {
    const name = `${code}_${slug}.mp3`
    await fs.writeFile(path.join(paths.audio_dir, name), `audio-${slug}`)
    await recordSectionTimeline(paths.audio_dir, name, text, { timeline: [{ section: 1, start_s: 0.1, end_s: 1.9, text_start: 0, text_end: text.length }] })
  }
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1,
    sections: Object.keys(texts).map(slug => ({ slug, duration_s: 2, source_file: `${code}_${slug}.mp3` })),
  }))
  const merged = path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`)
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=5', '-codec:a', 'libmp3lame', '-q:a', '9', merged])
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: path.basename(merged), bytes: (await fs.stat(merged)).size, duration_sec: 5, opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
  }))

  const job = {
    job_id: 'khmer-script-timed', project_slug: project.slug, episode_id: code, type: 'subtitles_transcribe',
    status: 'running', progress: 0, output_lines: [], params: { per_chapter: true, engine: 'genstudio' },
  } as any
  await generateSubtitlesTranscribe(job)

  assert.equal(job.result?.subtitle_method, 'script')
  assert.equal(job.result?.complete, true, job.output_lines.join('\n'))
  const first = parseSrt(await fs.readFile(path.join(paths.subtitles_dir, `${code}_Chapter_01.srt`), 'utf8'))
  assert.deepEqual(first.map(c => c.text), ['ព្រះអាទិត្យរះ។', 'ផ្កាយលិច។'])
  near(first[0]!.start_sec, 0.1, 0.001); near(first[1]!.end_sec, 1.9, 0.001)
  const models = await readSubtitleSourceModels(paths.subtitles_dir)
  assert.equal(models[`${code}_Chapter_01.srt`], 'script-timed')
  const stitched = parseSrt(await fs.readFile(path.join(paths.subtitles_dir, `${code}_stitched.srt`), 'utf8'))
  assert.deepEqual(stitched.map(c => c.text), ['ព្រះអាទិត្យរះ។', 'ផ្កាយលិច។', 'ទឹកហូរ។'])
  near(stitched[2]!.start_sec, 2 + 1 + 0.1, 0.001)
})
