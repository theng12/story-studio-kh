import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  hashSubtitleAudioSources,
  inspectPipelineSubtitleRepairReadiness,
  inspectSubtitleCompletion,
  inspectSubtitleSourceFreshness,
} from '../services/subtitle-completion.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'
import { parseSrt } from '../lib/subtitle-builder.js'

const CODE = 'EP0033'
const SRT = '1\n00:00:00,000 --> 00:00:02,000\nhello\n'
const roots: string[] = []

async function fixture(sections = ['Introduction', 'Chapter_01', 'Chapter_02']) {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-completion-'))
  roots.push(episodeDir)
  const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
  const audioDir = path.join(episodeDir, `${CODE} - 07 Audio Assets`)
  await fs.mkdir(subtitlesDir)
  await fs.mkdir(audioDir)
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    sections: sections.map(slug => ({ slug })),
  }))
  return { episodeDir, subtitlesDir, audioDir }
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
    // A `_stitched` file is DERIVED from the per-section transcripts, so it is
    // never reported as a standalone whole-episode track: it can only ever be as
    // fresh as the sections it was cut from. `pipelineSubtitleRepairComplete`
    // (routes/pipeline.ts) refuses one as a full-track for the same reason.
    assert.equal(result.mode, 'per-section')
    assert.equal(result.full_track_filename, undefined)
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

  test('marks only a transcript whose active audio bytes changed as stale', async () => {
    const dirs = await fixture(['Chapter_01', 'Chapter_02'])
    const first = path.join(dirs.audioDir, `${CODE}_Chapter_01.mp3`)
    const second = path.join(dirs.audioDir, `${CODE}_Chapter_02.mp3`)
    await fs.writeFile(first, 'audio-a')
    await fs.writeFile(second, 'audio-b')
    await fs.writeFile(path.join(dirs.episodeDir, 'audio_chapters.json'), JSON.stringify({
      sections: [
        { slug: 'Chapter_01', source_file: `${CODE}_Chapter_01.mp3` },
        { slug: 'Chapter_02', source_file: `${CODE}_Chapter_02.mp3` },
      ],
    }))
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_01.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_02.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, '.subtitle-recovery.json'), JSON.stringify({
      version: 1,
      sections: {
        [`${CODE}_Chapter_01.srt`]: { sourceAudioHash: await hashSubtitleAudioSources([first]) },
        [`${CODE}_Chapter_02.srt`]: { sourceAudioHash: await hashSubtitleAudioSources([second]) },
      },
      plans: {},
    }))

    assert.deepEqual(
      (await inspectSubtitleSourceFreshness(dirs.episodeDir, dirs.audioDir, dirs.subtitlesDir, CODE)).stale_sections,
      [],
    )

    // Identical duration cannot establish freshness. The new bytes must.
    await fs.writeFile(second, 'audio-c')
    assert.deepEqual(
      (await inspectSubtitleSourceFreshness(dirs.episodeDir, dirs.audioDir, dirs.subtitlesDir, CODE)).stale_sections,
      ['Chapter_02'],
    )

    // Successful re-transcription records the new active bytes and clears only
    // that chapter's stale status; the untouched Chapter_01 remains current.
    await fs.writeFile(path.join(dirs.subtitlesDir, '.subtitle-recovery.json'), JSON.stringify({
      version: 1,
      sections: {
        [`${CODE}_Chapter_01.srt`]: { sourceAudioHash: await hashSubtitleAudioSources([first]) },
        [`${CODE}_Chapter_02.srt`]: { sourceAudioHash: await hashSubtitleAudioSources([second]) },
      },
      plans: {},
    }))
    assert.deepEqual(
      (await inspectSubtitleSourceFreshness(dirs.episodeDir, dirs.audioDir, dirs.subtitlesDir, CODE)).stale_sections,
      [],
    )
  })

  test('keeps the active transcript fresh when an unselected audio version is saved', async () => {
    const dirs = await fixture(['Chapter_01'])
    const active = path.join(dirs.audioDir, `${CODE}_Chapter_01.mp3`)
    await fs.writeFile(active, 'active-audio')
    await fs.writeFile(path.join(dirs.episodeDir, 'audio_chapters.json'), JSON.stringify({
      sections: [{ slug: 'Chapter_01', source_file: `${CODE}_Chapter_01.mp3` }],
    }))
    await fs.writeFile(path.join(dirs.subtitlesDir, `${CODE}_Chapter_01.srt`), SRT)
    await fs.writeFile(path.join(dirs.subtitlesDir, '.subtitle-recovery.json'), JSON.stringify({
      version: 1,
      sections: {
        [`${CODE}_Chapter_01.srt`]: { sourceAudioHash: await hashSubtitleAudioSources([active]) },
      },
      plans: {},
    }))
    await fs.writeFile(path.join(dirs.audioDir, `${CODE}_Chapter_01_v2.mp3`), 'alternate-audio')

    assert.deepEqual(
      (await inspectSubtitleSourceFreshness(dirs.episodeDir, dirs.audioDir, dirs.subtitlesDir, CODE)).stale_sections,
      [],
    )
  })
})
