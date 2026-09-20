/**
 * The merged-transcript skip must not bless a stale transcript.
 *
 * THE DEFECT. `generateSubtitlesTranscribe` kept an existing `${code}_whisper.srt`
 * when `existing.cues > 0` and nothing else. The per-chapter path in the same
 * file consults `staleSections`; this path did not. So re-running Audio and then
 * Retry left the OLD transcript in place and reported the job complete — the
 * whole point of the run was to pick up audio that had changed.
 *
 * `cues > 0` is also not coverage (one cue over a 40-minute episode passed), but
 * the staleness check is the part that is wrong in a way a user would notice.
 *
 * These tests exercise the extracted predicate rather than the generator, which
 * would call a provider. The staleness authority is
 * `inspectSubtitleSourceFreshness`, the same one the per-chapter path uses; the
 * legacy (no recorded byte hash) branch of that authority compares mtimes, which
 * is what these fixtures drive.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let subtitles: typeof import('../generators/subtitles.js')
let pm: typeof import('../services/project-manager.js')

const SLUG = 'subtitle-skip-project'
const EPISODE = 'EP0001'
const TITLE = 'A Real Episode'
const SECTION = 'chapter-01'

let episodeDir = ''
let audioDir = ''
let outDir = ''

async function writeFixture(): Promise<void> {
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${EPISODE} - ${TITLE}`)
  audioDir = path.join(episodeDir, `${EPISODE} - 07 Audio Assets`)
  outDir = path.join(episodeDir, `${EPISODE} - 09 Subtitles Output`)
  await fs.mkdir(audioDir, { recursive: true })
  await fs.mkdir(outDir, { recursive: true })

  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: SECTION, source_file: `${EPISODE}_${SECTION}.mp3` }],
  }))
  await fs.writeFile(path.join(audioDir, `${EPISODE}_${SECTION}.mp3`), 'audio bytes')
  // The per-section SRT is what maps this chapter to a source transcript, so
  // the freshness authority has something to compare against.
  await fs.writeFile(path.join(outDir, `${EPISODE}_${SECTION}.srt`), '1\n00:00:00,000 --> 00:00:02,000\nhello\n')
  // The whole-track transcript the skip path guards.
  await fs.writeFile(path.join(outDir, `${EPISODE}_whisper.srt`), '1\n00:00:00,000 --> 00:00:02,000\nhello\n')
}

/** Force a definite ordering: `older` strictly before `newer`. */
async function setMtimes(older: string[], newer: string[]): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  const present = new Date()
  for (const f of older) await fs.utimes(f, past, past)
  for (const f of newer) await fs.utimes(f, present, present)
}

const run = () => subtitles.existingTranscriptIsCurrent({
  projectSlug: SLUG, episodeId: EPISODE, code: EPISODE, outDir,
})

before(async () => {
  tmp = await useTempDataDir()
  subtitles = await import('../generators/subtitles.js')
  pm = await import('../services/project-manager.js')
  await pm.createProject({ name: 'Subtitle Skip Project' })
  await writeFixture()
})

after(async () => { await tmp?.cleanup() })

describe('an existing whole-track transcript is kept only while it is current', () => {
  test('audio older than the transcript → SKIP (the transcript is newer)', async () => {
    await setMtimes(
      [path.join(audioDir, `${EPISODE}_${SECTION}.mp3`), path.join(outDir, `${EPISODE}_${SECTION}.srt`)],
      [path.join(outDir, `${EPISODE}_whisper.srt`)],
    )
    const verdict = await run()
    assert.equal(verdict.skip, true, verdict.reason)
    assert.equal(verdict.cues, 1)
  })

  test('audio NEWER than the transcript → do NOT skip, and say why', async () => {
    // THE FIX. Before this change the predicate was `cues > 0`, so this case
    // returned skip:true and the stale transcript was blessed as current.
    await setMtimes(
      [path.join(outDir, `${EPISODE}_${SECTION}.srt`), path.join(outDir, `${EPISODE}_whisper.srt`)],
      [path.join(audioDir, `${EPISODE}_${SECTION}.mp3`)],
    )
    const verdict = await run()
    assert.equal(verdict.skip, false, 'a transcript whose audio changed must be regenerated')
    assert.match(verdict.reason, /audio changed/i)
    assert.match(verdict.reason, new RegExp(SECTION))
  })

  test('a transcript with no valid cues is not skipped (the old floor, kept)', async () => {
    await fs.writeFile(path.join(outDir, `${EPISODE}_whisper.srt`), 'not a subtitle file at all')
    const verdict = await run()
    assert.equal(verdict.skip, false)
    assert.match(verdict.reason, /no valid cues/i)
  })

  test('a missing transcript is not skipped', async () => {
    await fs.rm(path.join(outDir, `${EPISODE}_whisper.srt`), { force: true })
    const verdict = await run()
    assert.equal(verdict.skip, false)
    assert.match(verdict.reason, /could not be read/i)
  })

  /**
   * v1.4.193 — "I could not measure the audio" was reported as "the audio is
   * unchanged", by two different routes. Both made a deleted narration file
   * read as a current transcript, so the skip kept captions for audio that no
   * longer exists. AGENTS.md §6: a zero that means two things is a defect.
   */
  test('narration that cannot be stat-ed does not read as unchanged (mtime branch)', async () => {
    await writeFixture()
    // Transcript strictly newest, so ONLY the unmeasurable audio can decide.
    await setMtimes(
      [path.join(audioDir, `${EPISODE}_${SECTION}.mp3`), path.join(outDir, `${EPISODE}_${SECTION}.srt`)],
      [path.join(outDir, `${EPISODE}_whisper.srt`)],
    )
    await fs.rm(path.join(audioDir, `${EPISODE}_${SECTION}.mp3`), { force: true })

    const verdict = await run()
    assert.equal(verdict.skip, false, 'a missing narration file must not read as "unchanged"')
    assert.match(verdict.reason, /audio changed/i)
  })

  test('narration that cannot be re-hashed does not read as a match', async () => {
    await writeFixture()
    const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
    const hash = await hashSubtitleAudioSources([path.join(audioDir, `${EPISODE}_${SECTION}.mp3`)])
    assert.ok(hash, 'the fixture must be able to hash its narration')
    await fs.writeFile(path.join(outDir, '.subtitle-recovery.json'), JSON.stringify({
      sections: { [`${EPISODE}_${SECTION}.srt`]: { sourceAudioHash: hash } },
    }))
    await fs.rm(path.join(audioDir, `${EPISODE}_${SECTION}.mp3`), { force: true })

    const verdict = await run()
    assert.equal(verdict.skip, false, 'an unreadable source is not evidence that it matches')
    assert.match(verdict.reason, /audio changed/i)
  })
})
