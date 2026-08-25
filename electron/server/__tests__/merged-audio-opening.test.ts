/**
 * "Does the merged audio already include my intro?" — answered from the file
 * and its record, never from the current settings.
 *
 * The trap these tests exist to hold shut: 393 merged files on the owner's
 * disk carry a `schema_version: 1` completion record with no intro
 * information at all. The cheap fix is to read the live Audio Assembly config
 * and describe the file with it. The config describes NOW; the file was merged
 * earlier and the setting may have changed since. So the old-schema path here
 * is only ever allowed to report what the bytes prove.
 *
 * The second thing under test is that the measurement is the SAME one the
 * subtitle stitcher uses (`introLeadInFrom`) rather than a second derivation
 * of the same fact — the drift v1.3.1 was spent removing on the video side.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import {
  buildMergedAudioOpeningRecord,
  describeMergedAudioOpening,
} from '../services/merged-audio-opening.js'
import { introLeadInFrom, computeIntroLeadInSec } from '../lib/intro-lead-in.js'

let root: string

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-merged-opening-'))
})
after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * The real EP0047 numbers off the owner's disk: ten chapters, a 1s gap, a
 * merged file of 1127.05542s. `mergedDuration − narrationExtent` = 16.066s,
 * which is the figure the burned captions are already shifted by.
 */
const EP0047_SECTIONS = [
  { slug: 'Chapter_01', duration_s: 101.722875 },
  { slug: 'Chapter_02', duration_s: 86.335792 },
  { slug: 'Chapter_03', duration_s: 83.853167 },
  { slug: 'Chapter_04', duration_s: 96.964542 },
  { slug: 'Chapter_05', duration_s: 90.481958 },
  { slug: 'Chapter_06', duration_s: 97.856417 },
  { slug: 'Chapter_07', duration_s: 115.808292 },
  { slug: 'Chapter_08', duration_s: 98.334833 },
  { slug: 'Chapter_09', duration_s: 193.353125 },
  { slug: 'Chapter_10', duration_s: 137.27825 },
]
const EP0047_MERGED_SEC = 1127.05542

let episodeSeq = 0
async function makeEpisode(opts: {
  completion?: unknown
  sidecar?: unknown
  code?: string
  filename?: string
}) {
  const code = opts.code || 'EP0047'
  const filename = opts.filename || `${code}_merged_audio.mp3`
  const episodeDir = path.join(root, `ep-${episodeSeq++}`)
  const mergedDir = path.join(episodeDir, 'merged')
  await fs.mkdir(mergedDir, { recursive: true })
  if (opts.completion !== undefined) {
    await fs.writeFile(
      path.join(mergedDir, `${code}_merged_audio.completion.json`),
      JSON.stringify(opts.completion, null, 2),
    )
  }
  if (opts.sidecar !== undefined) {
    await fs.writeFile(
      path.join(episodeDir, 'audio_chapters.json'),
      JSON.stringify(opts.sidecar, null, 2),
    )
  }
  return { episodeDir, mergedDir, code, filename }
}

describe('what precedes the narration in a merged audio file', () => {
  test('a v2 record is quoted, naming the intro file it actually prepended', async () => {
    const ep = await makeEpisode({
      completion: {
        schema_version: 2,
        output_filename: 'EP0047_merged_audio.mp3',
        bytes: 27051198,
        duration_sec: EP0047_MERGED_SEC,
        generated_at: '2026-08-18T00:00:00.000Z',
        opening: {
          lead_in_sec: 16.066,
          intro: { filename: 'Channel_Intro.mp3', duration_sec: 14.066, gap_after_sec: 2 },
          music_lead_in_sec: 0,
        },
      },
      sidecar: { sections: EP0047_SECTIONS, gap_duration_s: 1 },
    })

    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir,
      code: ep.code,
      filename: ep.filename,
      mergedDurationSec: EP0047_MERGED_SEC,
      episodeDir: ep.episodeDir,
    })

    assert.equal(opening.source, 'recorded')
    assert.equal(opening.lead_in_sec, 16.066)
    assert.equal(opening.intro?.filename, 'Channel_Intro.mp3')
    assert.equal(opening.intro?.gap_after_sec, 2)
    assert.equal(opening.music_lead_in_sec, 0)
    assert.equal(opening.reason, null)
  })

  test('a v2 record with no intro states the absence rather than falling back to measuring', async () => {
    const ep = await makeEpisode({
      completion: {
        schema_version: 2,
        output_filename: 'EP0047_merged_audio.mp3',
        bytes: 1,
        duration_sec: 100,
        opening: { lead_in_sec: 0, intro: null, music_lead_in_sec: 0 },
      },
      sidecar: { sections: EP0047_SECTIONS, gap_duration_s: 1 },
    })
    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: ep.filename,
      mergedDurationSec: EP0047_MERGED_SEC, episodeDir: ep.episodeDir,
    })
    assert.equal(opening.source, 'recorded')
    assert.equal(opening.intro, null)
    assert.equal(opening.lead_in_sec, 0)
  })

  test('an old v1 record falls back to measuring the file, and matches the stitcher', async () => {
    const ep = await makeEpisode({
      // Byte-for-byte the shape of the owner's real EP0047 record.
      completion: {
        schema_version: 1,
        output_filename: 'EP0047_merged_audio.mp3',
        bytes: 27051198,
        duration_sec: EP0047_MERGED_SEC,
        generated_at: '2026-07-16T18:20:22.130Z',
      },
      sidecar: { sections: EP0047_SECTIONS, gap_duration_s: 1 },
    })

    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: ep.filename,
      mergedDurationSec: EP0047_MERGED_SEC, episodeDir: ep.episodeDir,
    })

    assert.equal(opening.source, 'measured')
    assert.equal(opening.lead_in_sec, 16.066)
    // Nothing is invented about WHAT produced those seconds.
    assert.equal(opening.intro, null)
    assert.equal(opening.music_lead_in_sec, null)
    // And it is the same number the subtitle timeline is shifted by — one
    // measurement, not two.
    assert.equal(
      opening.lead_in_sec,
      introLeadInFrom(EP0047_MERGED_SEC, EP0047_SECTIONS, 1).seconds,
    )
  })

  test('an old record on a file with no lead-in reports a real zero, not an unknown', async () => {
    const sections = [{ slug: 'Chapter_01', duration_s: 100 }, { slug: 'Chapter_02', duration_s: 50 }]
    const ep = await makeEpisode({
      completion: { schema_version: 1, output_filename: 'EP0047_merged_audio.mp3', bytes: 9, duration_sec: 151 },
      sidecar: { sections, gap_duration_s: 1 },
    })
    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: ep.filename,
      mergedDurationSec: 151, episodeDir: ep.episodeDir,
    })
    assert.equal(opening.source, 'measured')
    assert.equal(opening.lead_in_sec, 0)
  })

  test('a completion record naming a DIFFERENT file is not used to describe this one', async () => {
    // `write_mode: 'new'` leaves _v2 beside the original while the completion
    // record — written once per episode code — describes only the newest. The
    // record's intro must not be attributed to the other file.
    const ep = await makeEpisode({
      completion: {
        schema_version: 2,
        output_filename: 'EP0047_merged_audio_v2.mp3',
        bytes: 1,
        duration_sec: 10,
        opening: {
          lead_in_sec: 30,
          intro: { filename: 'SomeOtherIntro.mp3', duration_sec: 28, gap_after_sec: 2 },
          music_lead_in_sec: 0,
        },
      },
      sidecar: { sections: EP0047_SECTIONS, gap_duration_s: 1 },
      filename: 'EP0047_merged_audio.mp3',
    })
    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: 'EP0047_merged_audio.mp3',
      mergedDurationSec: EP0047_MERGED_SEC, episodeDir: ep.episodeDir,
    })
    assert.equal(opening.source, 'measured')
    assert.equal(opening.intro, null)
    assert.equal(opening.lead_in_sec, 16.066)
  })

  test('no sidecar means unmeasurable — never a confident "no intro"', async () => {
    const ep = await makeEpisode({
      completion: { schema_version: 1, output_filename: 'EP0047_merged_audio.mp3', bytes: 1, duration_sec: 900 },
    })
    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: ep.filename,
      mergedDurationSec: 900, episodeDir: ep.episodeDir,
    })
    assert.equal(opening.source, 'unmeasurable')
    assert.equal(opening.lead_in_sec, null)
    assert.match(String(opening.reason), /audio_chapters\.json/)
  })

  test('a sidecar longer than the file is unmeasurable, not a negative lead-in', async () => {
    const ep = await makeEpisode({
      completion: { schema_version: 1, output_filename: 'EP0047_merged_audio.mp3', bytes: 1, duration_sec: 100 },
      sidecar: { sections: EP0047_SECTIONS, gap_duration_s: 1 },
    })
    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: ep.filename,
      mergedDurationSec: 100, episodeDir: ep.episodeDir,
    })
    assert.equal(opening.source, 'unmeasurable')
    assert.match(String(opening.reason), /add up to more than this file/)
  })

  test('no completion record at all still measures from the file', async () => {
    const ep = await makeEpisode({ sidecar: { sections: EP0047_SECTIONS, gap_duration_s: 1 } })
    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: ep.filename,
      mergedDurationSec: EP0047_MERGED_SEC, episodeDir: ep.episodeDir,
    })
    assert.equal(opening.source, 'measured')
    assert.equal(opening.lead_in_sec, 16.066)
  })

  test('an unreadable duration is unmeasurable', async () => {
    const ep = await makeEpisode({ sidecar: { sections: EP0047_SECTIONS, gap_duration_s: 1 } })
    const opening = await describeMergedAudioOpening({
      mergedDir: ep.mergedDir, code: ep.code, filename: ep.filename,
      mergedDurationSec: undefined, episodeDir: ep.episodeDir,
    })
    assert.equal(opening.source, 'unmeasurable')
    assert.equal(opening.lead_in_sec, null)
  })
})

describe('the record the merge writes', () => {
  const sections = EP0047_SECTIONS
  const intro = { filename: 'Channel_Intro.mp3', duration_sec: 14.066, gap_after_sec: 2 }

  test('prefers the measured file over the arithmetic of its own parts', () => {
    const record = buildMergedAudioOpeningRecord({
      finalDurationSec: EP0047_MERGED_SEC,
      sections,
      gapSec: 1,
      intro,
      musicLeadInSec: 0,
    })
    // 14.066 + 2 = 16.066 either way here, but the value must come from the
    // same measurement the stitcher uses so encoder padding lands in both.
    assert.equal(record.lead_in_sec, introLeadInFrom(EP0047_MERGED_SEC, sections, 1).seconds)
    assert.deepEqual(record.intro, intro)
    assert.equal(record.music_lead_in_sec, 0)
  })

  test('falls back to the arithmetic only when the sidecar is missing', () => {
    const record = buildMergedAudioOpeningRecord({
      finalDurationSec: EP0047_MERGED_SEC,
      sections: [],
      gapSec: 1,
      intro,
      musicLeadInSec: 6,
    })
    assert.equal(record.lead_in_sec, 22.066)
  })

  test('an unknown intro length does not become a zero-length intro', () => {
    const record = buildMergedAudioOpeningRecord({
      finalDurationSec: 0,
      sections: [],
      gapSec: 1,
      intro: { filename: 'intro.mp3', duration_sec: null, gap_after_sec: 2 },
      musicLeadInSec: 0,
    })
    assert.equal(record.intro?.duration_sec, null)
    assert.equal(record.lead_in_sec, 2)
  })

  test('no intro and no music records a real zero, which is a complete answer', () => {
    const record = buildMergedAudioOpeningRecord({
      finalDurationSec: 1101.989251 + 9,
      sections,
      gapSec: 1,
      intro: null,
      musicLeadInSec: 0,
    })
    assert.equal(record.lead_in_sec, 0)
    assert.equal(record.intro, null)
    assert.equal(record.music_lead_in_sec, 0)
  })
})

describe('the timing callers keep the exact behaviour they had', () => {
  /**
   * `computeIntroLeadInSec` now delegates to the measurement, and subtitle
   * timing depends on it. Every case that used to return 0 must still return
   * 0 — an "unmeasurable" must not become a shift.
   */
  test('unmeasurable still flattens to zero for subtitle timing', async () => {
    assert.equal(await computeIntroLeadInSec(null, EP0047_SECTIONS, 1), 0)
    assert.equal(await computeIntroLeadInSec(undefined, EP0047_SECTIONS, 1), 0)
    assert.equal(await computeIntroLeadInSec('/nonexistent/file.mp3', EP0047_SECTIONS, 1), 0)
  })

  test('sub-0.3s noise is not a lead-in, at or below the threshold', () => {
    assert.equal(introLeadInFrom(100.2, [{ duration_s: 100 }], 0).seconds, 0)
    assert.equal(introLeadInFrom(100.3, [{ duration_s: 100 }], 0).seconds, 0)
    assert.equal(introLeadInFrom(100.4, [{ duration_s: 100 }], 0).seconds, 0.4)
    // Slightly short is rounding, not a broken sidecar.
    assert.equal(introLeadInFrom(99.8, [{ duration_s: 100 }], 0).status, 'measured')
    assert.equal(introLeadInFrom(99.8, [{ duration_s: 100 }], 0).seconds, 0)
  })

  test('inter-section gaps count toward the narration extent', () => {
    // 3 sections of 10s + 2 gaps of 1s = 32s; a 40s file has an 8s lead-in.
    const sections = [{ duration_s: 10 }, { duration_s: 10 }, { duration_s: 10 }]
    assert.equal(introLeadInFrom(40, sections, 1).seconds, 8)
  })
})
