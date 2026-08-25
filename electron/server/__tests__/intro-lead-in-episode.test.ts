/**
 * Episode-level intro lead-in resolution.
 *
 * REWRITTEN in v1.3.4, and the reason matters more than the tests.
 *
 * The previous version of this file had two tests and both asserted ZERO — one
 * for an empty merge folder, one for a merge folder holding another episode's
 * file. Nothing here ever asserted a non-zero result. So when the resolver
 * began returning zero *unconditionally* — it started matching the
 * `{CODE}_merged_audio.completion.json` record the merge writes beside the
 * track, ffprobed a JSON file, and silently fell back to 0 — this suite stayed
 * green while every episode merged after 2026-07-14 got a stitched timeline
 * that ran ahead of the video by the length of its intro.
 *
 * A test that only proves a function returns 0 cannot fail when the function
 * breaks by always returning 0. Every case below therefore pins down WHICH of
 * the two zeroes it is — `measured` or `unmeasurable` — and several pin a real
 * non-zero offset.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { resolveEpisodeIntroLeadIn } from '../lib/intro-lead-in.js'

let root: string

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-intro-lead-in-'))
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** EP0047's real numbers: 10 chapters + 9×1s gaps = 973.754283s of narration. */
const REAL_SECTIONS = [
  96.470204, 81.423673, 81.71102, 92.813061, 86.83102,
  90.958367, 108.59102, 90.357551, 105.142857, 130.45551,
].map((duration_s, i) => ({ slug: `Chapter_${String(i + 1).padStart(2, '0')}`, duration_s }))

async function makeEpisode(name: string, opts: {
  merged?: string[]
  /** Which file the merge's completion record claims to describe. */
  completionFor?: string
  leadInSec?: number
  sidecar?: boolean
} = {}): Promise<{ episodeDir: string; mergedDir: string }> {
  const episodeDir = path.join(root, name)
  const mergedDir = path.join(episodeDir, 'merged')
  await fs.mkdir(mergedDir, { recursive: true })
  if (opts.sidecar !== false) {
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
      sections: REAL_SECTIONS,
      gap_duration_s: 1,
    }))
  }
  for (const file of opts.merged || []) {
    await fs.writeFile(path.join(mergedDir, file), 'not really audio')
  }
  if (opts.completionFor) {
    await fs.writeFile(path.join(mergedDir, 'EP0047_merged_audio.completion.json'), JSON.stringify({
      schema_version: 2,
      output_filename: opts.completionFor,
      duration_sec: 989.820522,
      opening: {
        lead_in_sec: opts.leadInSec ?? 16.066,
        intro: { filename: 'Channel - Intro Audio 15s.MP3', duration_sec: 15.073, gap_after_sec: 1 },
        music_lead_in_sec: 0,
      },
    }))
  }
  return { episodeDir, mergedDir }
}

describe('episode intro lead-in resolution', () => {
  test('the merge completion record no longer wins the filename match', async () => {
    // THE REGRESSION. `EP0047_merged_audio.completion.json` sorts before
    // `EP0047_merged_audio.mp3` (`c` < `m`) and the old prefix test matched
    // both, so the JSON was selected and the answer was a silent zero.
    const { episodeDir, mergedDir } = await makeEpisode('collision', {
      merged: ['EP0047_merged_audio.mp3'],
      completionFor: 'EP0047_merged_audio.mp3',
    })
    const lead = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, 'EP0047')
    assert.equal(lead.status, 'measured')
    assert.equal(lead.seconds, 16.066)
    assert.equal(lead.merged_filename, 'EP0047_merged_audio.mp3')
    assert.equal(lead.source, 'recorded')
  })

  test('a re-merged _v2 track is found, not skipped', async () => {
    // Audio Assembly's `write_mode: 'new'` names the output `_v2`, `_v3` …
    // The old prefix test required a `.` straight after `_merged_audio`, so
    // those episodes silently resolved to zero as well.
    const { episodeDir, mergedDir } = await makeEpisode('revision', {
      merged: ['EP0047_merged_audio_v2.mp3'],
      completionFor: 'EP0047_merged_audio_v2.mp3',
      leadInSec: 9.5,
    })
    const lead = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, 'EP0047')
    assert.equal(lead.status, 'measured')
    assert.equal(lead.seconds, 9.5)
    assert.equal(lead.merged_filename, 'EP0047_merged_audio_v2.mp3')
  })

  test('picks the same track the renderer will use when both exist', async () => {
    // `scanEpisodeAssets` hands the renderer `merged_audio[0]`, and `.` sorts
    // before `_`, so the base track wins there. Captions must be timed against
    // the file that actually plays under the pictures.
    const { episodeDir, mergedDir } = await makeEpisode('both', {
      merged: ['EP0047_merged_audio.mp3', 'EP0047_merged_audio_v2.mp3'],
      completionFor: 'EP0047_merged_audio.mp3',
    })
    const lead = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, 'EP0047')
    assert.equal(lead.merged_filename, 'EP0047_merged_audio.mp3')
    assert.equal(lead.seconds, 16.066)
  })

  test('a record describing a DIFFERENT file is refused rather than borrowed', async () => {
    // The completion record is written once per episode code and overwritten,
    // so it can outlive the file it describes. Applying its number to another
    // track would be a confident wrong answer.
    const { episodeDir, mergedDir } = await makeEpisode('stale-record', {
      merged: ['EP0047_merged_audio_v2.mp3'],
      completionFor: 'EP0047_merged_audio.mp3',
    })
    const lead = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, 'EP0047')
    // Falls through to measuring, which cannot probe a text file — so it must
    // say it does not know, never "no intro".
    assert.equal(lead.status, 'unmeasurable')
    assert.equal(lead.seconds, 0)
    assert.ok(lead.reason)
  })

  test('no merged audio reports unmeasurable, not "no intro"', async () => {
    const { episodeDir, mergedDir } = await makeEpisode('empty')
    const lead = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, 'EP0047')
    assert.equal(lead.status, 'unmeasurable')
    assert.equal(lead.seconds, 0)
    assert.match(lead.reason || '', /no merged audio file/i)
  })

  test('another episode\'s merged file in the same folder is ignored', async () => {
    const { episodeDir, mergedDir } = await makeEpisode('wrong-code', {
      merged: ['EP9999_merged_audio.mp3'],
    })
    const lead = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, 'EP0047')
    assert.equal(lead.status, 'unmeasurable')
    assert.equal(lead.seconds, 0)
  })

  test('never throws, so it can never block a stitch', async () => {
    // The callers' old `.catch(() => 0)` wrappers are gone. The reason they
    // existed — a stitch must not fail because the intro is unknown — is
    // handled inside now, where it can be reported instead of silenced.
    const lead = await resolveEpisodeIntroLeadIn(
      undefined as unknown as string,
      undefined as unknown as string,
      'EP0047',
    )
    assert.equal(lead.status, 'unmeasurable')
    assert.equal(lead.seconds, 0)
    assert.ok(lead.reason)
  })

  test('a missing chapter sidecar reports unmeasurable rather than throwing', async () => {
    // This used to be a bare `JSON.parse(await readFile(...))` that threw
    // straight out of the function and into a caller's empty catch block.
    const { episodeDir, mergedDir } = await makeEpisode('no-sidecar', {
      merged: ['EP0047_merged_audio.mp3'],
      sidecar: false,
    })
    const lead = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, 'EP0047')
    assert.equal(lead.status, 'unmeasurable')
    assert.equal(lead.seconds, 0)
    assert.ok(lead.reason)
  })
})
