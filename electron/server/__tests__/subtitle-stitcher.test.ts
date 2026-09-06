/**
 * Subtitle stitcher (v1.0.218+) — matching robustness + loud-empty failure.
 *
 * Guards the "blank stitched SRT" bug: a slug/filename mismatch between
 * audio_chapters.json sections and the per-chapter SRT files used to write
 * an empty file, which the Scene Plan LLM step then choked on. Now the
 * matcher tolerates format drift, and a genuinely-empty stitch THROWS.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseSrt } from '../lib/subtitle-builder.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'
import { allowedSubtitleCueGapSec } from '../services/scene-plan-pacing.js'

let stitch: typeof import('../services/subtitle-stitcher.js')
let subtitles: typeof import('../generators/subtitles.js')
let autostitch: typeof import('../lib/subtitle-autostitch.js')
let timelineIntegrity: typeof import('../services/scene-timeline-integrity.js')
let tmp: string

before(async () => {
  stitch = await import('../services/subtitle-stitcher.js')
  subtitles = await import('../generators/subtitles.js')
  autostitch = await import('../lib/subtitle-autostitch.js')
  timelineIntegrity = await import('../services/scene-timeline-integrity.js')
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-stitch-'))
})
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

async function makeCase(name: string, chapters: any, files: Record<string, string>) {
  const dir = path.join(tmp, name)
  const subs = path.join(dir, 'subs')
  await fs.mkdir(subs, { recursive: true })
  await fs.writeFile(path.join(dir, 'audio_chapters.json'), JSON.stringify(chapters), 'utf-8')
  for (const [fn, body] of Object.entries(files)) await fs.writeFile(path.join(subs, fn), body, 'utf-8')
  return { episode_dir: dir, subtitles_dir: subs, episode_code: 'EP0001' }
}

const SRT = '1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond line\n'

describe('subtitle stitcher', () => {
  test('rejects skipped, stale, and malformed stitch states', () => {
    for (const status of ['not-applicable', 'kept', 'stale', 'malformed']) {
      assert.throws(
        () => subtitles.requireWrittenSubtitleStitch({ status, reason: 'timeline is not verified' }),
        /subtitle stitch did not complete.*timeline is not verified/i,
      )
    }
  })

  test('accepts an unchanged complete stitch only after its recorded inputs and timeline remain valid', async () => {
    const inputs = await makeCase('fresh-complete', {
      gap_duration_s: 1,
      sections: [{ slug: 'Chapter_01', duration_s: 60 }],
    }, { 'EP0001_Chapter_01.srt': SRT })
    const mergedAudioDir = path.join(inputs.episode_dir, 'merged')
    await fs.mkdir(mergedAudioDir)
    await fs.writeFile(path.join(mergedAudioDir, 'EP0001_merged_audio.mp3'), 'audio')
    await fs.writeFile(path.join(mergedAudioDir, 'EP0001_merged_audio.completion.json'), JSON.stringify({
      output_filename: 'EP0001_merged_audio.mp3',
      opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
    }))

    const options = {
      episodeDir: inputs.episode_dir,
      subtitlesDir: inputs.subtitles_dir,
      mergedAudioDir,
      episodeCode: inputs.episode_code,
    }
    assert.equal((await autostitch.ensureStitchedSubtitle(options)).status, 'stitched')
    const fresh = await autostitch.ensureStitchedSubtitle(options)
    assert.equal(fresh.status, 'fresh')
    assert.ok(await autostitch.readRecordedSignature(fresh.path), 'a fresh stitch must carry its input fingerprint')
    assert.equal((await timelineIntegrity.readSubtitleTimelineIntegrity(inputs.subtitles_dir, inputs.episode_code)).complete, true)
    assert.doesNotThrow(() => subtitles.requireWrittenSubtitleStitch(fresh))
  })

  test('matches per-chapter SRT despite slug-format drift (chapter_1 ↔ EP0001_Chapter1.srt)', async () => {
    const inputs = await makeCase('drift', {
      gap_duration_s: 1.5,
      sections: [{ slug: 'chapter_1', duration_s: 120 }],
    }, { 'EP0001_Chapter1.srt': SRT })
    const r = await stitch.stitchSubtitles(inputs)
    assert.equal(r.total_cues, 2)
    assert.equal(r.sections[0].source_srt, 'EP0001_Chapter1.srt')
    // The stitched file must be non-empty on disk.
    const out = await fs.readFile(r.output_path, 'utf-8')
    assert.ok(out.includes('Hello world'))
  })

  test('matches exact "{code}_{slug}.srt" convention', async () => {
    const inputs = await makeCase('exact', {
      gap_duration_s: 1, sections: [{ slug: 'introduction', duration_s: 60 }],
    }, { 'EP0001_introduction.srt': SRT })
    const r = await stitch.stitchSubtitles(inputs)
    assert.equal(r.total_cues, 2)
  })

  test('throws a diagnostic error (not a blank file) when nothing matches', async () => {
    const inputs = await makeCase('empty', {
      gap_duration_s: 1, sections: [{ slug: 'chapter_1', duration_s: 60 }],
    }, { 'EP0001_whisper.srt': SRT })  // merged-mode file, no per-chapter SRT
    await assert.rejects(
      () => stitch.stitchSubtitles(inputs),
      /incomplete|produced 0 cues|no per-chapter subtitle file matched/i,
    )
    // And it must NOT have written a stitched file.
    const exists = await fs.access(path.join(inputs.subtitles_dir, 'EP0001_stitched.srt')).then(() => true).catch(() => false)
    assert.equal(exists, false)
  })

  test('rejects a partial stitch and identifies every missing audio section', async () => {
    const inputs = await makeCase('partial', {
      gap_duration_s: 1,
      sections: [
        { slug: 'Chapter_01', duration_s: 60 },
        { slug: 'Chapter_02', duration_s: 70 },
        { slug: 'Chapter_03', duration_s: 80 },
      ],
    }, { 'EP0001_Chapter_01.srt': SRT })
    await assert.rejects(
      () => stitch.stitchSubtitles(inputs),
      error => {
        assert.match(String(error), /subtitle timeline is incomplete/i)
        assert.match(String(error), /Chapter_02/)
        assert.match(String(error), /Chapter_03/)
        return true
      },
    )
    const exists = await fs.access(path.join(inputs.subtitles_dir, 'EP0001_stitched.srt')).then(() => true).catch(() => false)
    assert.equal(exists, false)
  })

  test('marks a fully stitched timeline complete in its metadata', async () => {
    const inputs = await makeCase('complete-meta', {
      gap_duration_s: 1,
      sections: [
        { slug: 'Chapter_01', duration_s: 60 },
        { slug: 'Chapter_02', duration_s: 70 },
      ],
    }, {
      'EP0001_Chapter_01.srt': SRT,
      'EP0001_Chapter_02.srt': SRT,
    })
    const result = await stitch.stitchSubtitles(inputs)
    const meta = JSON.parse(await fs.readFile(`${result.output_path}.json`, 'utf-8'))
    assert.equal(result.complete, true)
    assert.deepEqual(result.missing_sections, [])
    assert.equal(meta.complete, true)
    assert.deepEqual(meta.missing_sections, [])
  })

  test('attributes a pacing-blocking stitched cue gap to its exact chapter without changing raw integrity', async () => {
    const inputs = await makeCase('cue-gap', {
      gap_duration_s: 1,
      sections: [{ slug: 'Chapter_15', duration_s: 90 }],
    }, { 'EP0001_Chapter_15.srt': SRT })
    const result = await stitch.stitchSubtitles(inputs)
    const gapSrt = [
      '1', '00:00:17,880 --> 00:00:17,880', 'before', '',
      '2', '00:00:55,460 --> 00:00:56,000', 'after', '',
    ].join('\n')
    await fs.writeFile(result.output_path, gapSrt)
    const metaPath = `${result.output_path}.json`
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const cues = parseSrt(gapSrt)
    await fs.writeFile(metaPath, JSON.stringify({ ...meta, total_cues: cues.length, timeline: stampFromCues(cues) }))
    const raw = await timelineIntegrity.readSubtitleTimelineIntegrity(inputs.subtitles_dir, inputs.episode_code)
    assert.equal(raw.complete, true, 'callers that do not choose a pacing threshold keep section-only semantics')
    assert.equal(allowedSubtitleCueGapSec(), 30, 'subtitle admission is independent of visual hold duration')
    const paced = await timelineIntegrity.readSubtitleTimelineIntegrity(inputs.subtitles_dir, inputs.episode_code, {
      max_cue_gap_sec: allowedSubtitleCueGapSec(),
    })
    assert.equal(paced.complete, false)
    assert.deepEqual(paced.blocking_cue_gaps, [{
      previous_end_sec: 17.88,
      next_start_sec: 55.46,
      gap_sec: 37.58,
      section_slugs: ['Chapter_15'],
      section_local_start_sec: 17.88,
      section_local_end_sec: 55.46,
    }])
    assert.equal(paced.max_cue_gap_sec, 30)
  })

  test('pacing readiness refuses a stitched file whose bytes no longer match its proof', async () => {
    const inputs = await makeCase('cue-proof', {
      gap_duration_s: 1,
      sections: [{ slug: 'Chapter_01', duration_s: 60 }],
    }, { 'EP0001_Chapter_01.srt': SRT })
    const result = await stitch.stitchSubtitles(inputs)
    await fs.writeFile(result.output_path, '')
    const paced = await timelineIntegrity.readSubtitleTimelineIntegrity(inputs.subtitles_dir, inputs.episode_code, {
      max_cue_gap_sec: 36,
    })
    assert.equal(paced.complete, false)
    assert.ok(paced.missing_sections.includes('subtitle timeline verification'))
    assert.ok(paced.missing_sections.includes('planning transcript cues'))
  })
})
