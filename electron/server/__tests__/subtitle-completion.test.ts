import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { inspectPipelineSubtitleRepairReadiness, inspectSubtitleCompletion } from '../services/subtitle-completion.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'
import { parseSrt } from '../lib/subtitle-builder.js'

const CODE = 'EP0033'
const SRT = '1\n00:00:00,000 --> 00:00:02,000\nhello\n'
const roots: string[] = []

async function fixture(sections = ['Introduction', 'Chapter_01', 'Chapter_02']) {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-completion-'))
  roots.push(episodeDir)
  const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
  await fs.mkdir(subtitlesDir)
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    sections: sections.map(slug => ({ slug })),
  }))
  return { episodeDir, subtitlesDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('subtitle completion', () => {
  test('reports the exact missing audio sections', async () => {
    const dirs = await fixture()
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Introduction.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_02.srt`), SRT)
    const result = await inspectSubtitleCompletion(dirs.episodeDir, dirs.subtitlesDir, CODE)
    assert.equal(result.complete, false)
    assert.deepEqual(result.completed_sections, ['Introduction', 'Chapter_02'])
    assert.deepEqual(result.missing_sections, ['Chapter_01'])
  })

  test('requires every section and tolerates filename punctuation drift', async () => {
    const dirs = await fixture()
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Introduction.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter1.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter-02_whisper.srt`), SRT)
    const result = await inspectSubtitleCompletion(dirs.episodeDir, dirs.subtitlesDir, CODE)
    assert.equal(result.complete, true)
    assert.equal(result.mode, 'per-section')
  })

  test('does not let a partial stitched track hide missing chapters', async () => {
    const dirs = await fixture()
    const stitched = `${CODE}_stitched.srt`
    await fs.writeFile(path.join(dirs.subtitlesDir, stitched), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${stitched}.json`), JSON.stringify({
      sections: [
        { slug: 'Introduction', source_srt: `${CODE}_Introduction.srt`, cues_added: 1 },
        { slug: 'Chapter_01', source_srt: `${CODE}_Chapter_01.srt`, cues_added: 1 },
        { slug: 'Chapter_02', cues_added: 0 },
      ],
    }))
    const result = await inspectSubtitleCompletion(dirs.episodeDir, dirs.subtitlesDir, CODE)
    assert.equal(result.complete, false)
    assert.deepEqual(result.completed_sections, ['Introduction', 'Chapter_01'])
    assert.deepEqual(result.missing_sections, ['Chapter_02'])
  })

  test('accepts a verified complete stitched track', async () => {
    const dirs = await fixture()
    const stitched = `${CODE}_stitched.srt`
    await fs.writeFile(path.join(dirs.subtitlesDir, stitched), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${stitched}.json`), JSON.stringify({
      sections: ['Introduction', 'Chapter_01', 'Chapter_02'].map(slug => ({
        slug, source_srt: `${CODE}_${slug}.srt`, cues_added: 1,
      })),
    }))
    const result = await inspectSubtitleCompletion(dirs.episodeDir, dirs.subtitlesDir, CODE)
    assert.equal(result.complete, true)
    assert.equal(result.full_track_filename, stitched)
  })

  test('accepts intentional whole-episode imported and Whisper tracks', async () => {
    for (const filename of [`${CODE}_imported.srt`, `${CODE}_whisper.vtt`]) {
      const dirs = await fixture()
      await fs.writeFile(path.join(dirs.subtitlesDir, filename), SRT)
      const result = await inspectSubtitleCompletion(dirs.episodeDir, dirs.subtitlesDir, CODE)
      assert.equal(result.complete, true, filename)
      assert.equal(result.mode, 'full-track')
    }
  })

  test('strict transcription audit does not let a whole-track file hide a missing chapter', async () => {
    const dirs = await fixture()
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_whisper.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Introduction.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_01.srt`), SRT)
    const result = await inspectSubtitleCompletion(
      dirs.episodeDir,
      dirs.subtitlesDir,
      CODE,
      { require_per_section: true },
    )
    assert.equal(result.complete, false)
    assert.deepEqual(result.missing_sections, ['Chapter_02'])
  })

  test('strict transcription audit treats a nonempty malformed chapter source as missing', async () => {
    const dirs = await fixture()
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Introduction.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_01.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_02.srt`), 'not an SRT')
    const result = await inspectSubtitleCompletion(
      dirs.episodeDir,
      dirs.subtitlesDir,
      CODE,
      { require_per_section: true },
    )
    assert.equal(result.complete, false)
    assert.deepEqual(result.missing_sections, ['Chapter_02'])
  })

  test('pipeline repair maps a blocking internal cue gap to only its chapter', async () => {
    const dirs = await fixture(['Chapter_01', 'Chapter_02'])
    const source = [
      '1', '00:00:00,000 --> 00:00:01,000', 'before', '',
      '2', '00:00:38,580 --> 00:00:39,000', 'after', '',
    ].join('\n')
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_01.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_02.srt`), source)
    const stitched = `${CODE}_stitched.srt`
    const stitchedText = [
      '1', '00:00:00,000 --> 00:00:01,000', 'first chapter', '',
      '2', '00:00:03,000 --> 00:00:04,000', 'before', '',
      '3', '00:00:41,580 --> 00:00:42,000', 'after', '',
    ].join('\n')
    const cues = parseSrt(stitchedText)
    await fs.writeFile(path.join(dirs.subtitlesDir, stitched), stitchedText)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${stitched}.json`), JSON.stringify({
      complete: true,
      total_cues: cues.length,
      timeline: stampFromCues(cues),
      sections: [
        { slug: 'Chapter_01', source_srt: `${CODE}_Chapter_01.srt`, offset_sec: 0, duration_sec: 2, cues_added: 1 },
        { slug: 'Chapter_02', source_srt: `${CODE}_Chapter_02.srt`, offset_sec: 3, duration_sec: 90, cues_added: 2 },
      ],
    }))

    const readiness = await inspectPipelineSubtitleRepairReadiness(dirs.episodeDir, dirs.subtitlesDir, CODE)
    assert.deepEqual(readiness.affected_sections, ['Chapter_02'])
    assert.deepEqual(readiness.completed_sections, ['Chapter_01'])
  })
})
