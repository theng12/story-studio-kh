/**
 * v1.4.0 — the stitched transcript keeps itself current, or the render stops.
 *
 * *"i need you to make sure that the subtitle is automatically stitched/re-stitched."*
 *
 * Until now stitching was something a person remembered to do. Forgetting it
 * left `{CODE}_stitched.srt` describing an older version of the episode and the
 * renderer burned it faithfully.
 *
 * Two properties are asserted here, and they pull in opposite directions on
 * purpose:
 *
 *   - A stitch that is still correct must NOT be rebuilt. Re-stitching on every
 *     render would make "re-stitched" meaningless in the log, which is how a
 *     genuine rebuild becomes invisible.
 *   - A stitch that is stale MUST be rebuilt, and by content rather than by
 *     timestamp. mtime is rewritten by copying, restoring or syncing a project
 *     folder without a word changing — and can make a stale stitch look newer
 *     than the chapters it came from.
 *
 * And one refusal: an intro lead-in that cannot be measured stops the render
 * instead of becoming a zero. AGENTS.md ("A Zero That Means Two Things Is A
 * Defect") records what that zero cost — roughly 284 episodes stitched sixteen
 * seconds early, with nothing in any log to see, because "no intro" and "I could
 * not measure the intro" were spelled the same way.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import {
  decideRestitch,
  ensureStitchedSubtitle,
  readRecordedSignature,
  sha256File,
  SubtitleStitchBlocked,
  type StitchInputSignature,
} from '../lib/subtitle-autostitch.js'

const CODE = 'EP0047'

function sig(over: Partial<StitchInputSignature> = {}): StitchInputSignature {
  return {
    schema: 1,
    gap_sec: 1.5,
    lead_in_sec: 16.07,
    sections: [
      { slug: 'chapter_1', duration_sec: 300, source_srt: 'EP0047_chapter_1.srt', sha256: 'aaa' },
      { slug: 'chapter_2', duration_sec: 280, source_srt: 'EP0047_chapter_2.srt', sha256: 'bbb' },
    ],
    ...over,
  }
}

describe('deciding whether a stitch is still current', () => {
  test('identical inputs are left alone, and say why', () => {
    const d = decideRestitch(sig(), sig(), true)
    assert.equal(d.restitch, false)
    assert.deepEqual(d.changed, [])
    assert.match(d.reason, /still matches/)
  })

  test('a missing stitched file is rebuilt whatever the record says', () => {
    const d = decideRestitch(sig(), sig(), false)
    assert.equal(d.restitch, true)
    assert.match(d.reason, /no stitched transcript yet/)
  })

  test('an edited chapter transcript is caught by content, and named', () => {
    const now = sig()
    now.sections[1]!.sha256 = 'ccc'
    const d = decideRestitch(sig(), now, true)
    assert.equal(d.restitch, true)
    assert.deepEqual(d.changed, ["chapter_2's transcript was edited"])
  })

  test('a re-merge that only changes a chapter\'s LENGTH is caught', () => {
    // The SRTs are byte-identical; only the audio moved. The stitched timeline
    // is still wrong, because every later chapter is now offset differently.
    const now = sig()
    now.sections[0]!.duration_sec = 305
    const d = decideRestitch(sig(), now, true)
    assert.equal(d.restitch, true)
    assert.match(d.reason, /chapter_1's audio length changed \(300s → 305s\)/)
  })

  test('a changed gap or intro lead-in is caught', () => {
    assert.equal(decideRestitch(sig(), sig({ gap_sec: 2 }), true).restitch, true)
    const lead = decideRestitch(sig(), sig({ lead_in_sec: 0 }), true)
    assert.equal(lead.restitch, true)
    assert.match(lead.reason, /intro lead-in changed \(16\.07s → 0s\)/)
  })

  test('added and removed chapters are both caught', () => {
    const added = sig()
    added.sections.push({ slug: 'chapter_3', duration_sec: 100, source_srt: 'EP0047_chapter_3.srt', sha256: 'ddd' })
    assert.match(decideRestitch(sig(), added, true).reason, /chapter_3 is a new chapter/)
    assert.match(decideRestitch(added, sig(), true).reason, /chapter_3 is no longer part/)
  })

  test('a chapter that swapped which file feeds it is caught even at the same hash', () => {
    const now = sig()
    now.sections[0]!.source_srt = 'EP0047_chapter_1_whisper.srt'
    const d = decideRestitch(sig(), now, true)
    assert.equal(d.restitch, true)
    assert.match(d.reason, /now reads EP0047_chapter_1_whisper\.srt instead of EP0047_chapter_1\.srt/)
  })

  test('a stitch with no recorded fingerprint is rebuilt once, not trusted', () => {
    // Every stitch written before v1.4.0 is in this state. Assuming it is
    // current because it exists is exactly the assumption this release removes.
    for (const recorded of [null, undefined, { schema: 2 } as never, { schema: 1 } as never]) {
      const d = decideRestitch(recorded, sig(), true)
      assert.equal(d.restitch, true, `a ${JSON.stringify(recorded)} record must not count as current`)
    }
    assert.match(decideRestitch(null, sig(), true).reason, /no record of what it was built from/)
  })

  test('float noise in a duration is not a change', () => {
    // Durations are re-derived from the audio and wobble in the last decimals.
    // Treating that as an edit would re-stitch on every single render.
    const now = sig()
    now.sections[0]!.duration_sec = 300.0000001
    assert.equal(decideRestitch(sig(), now, true).restitch, false)
  })
})

describe('bringing an episode\'s stitch up to date', () => {
  async function makeEpisode(opts: {
    chapters?: Array<{ slug: string; duration_s: number; srt?: string }>
    gap?: number
  } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-autostitch-'))
    const episodeDir = path.join(root, 'EP0047 - Rome')
    const subtitlesDir = path.join(episodeDir, 'EP0047 - 09 Subtitles Output')
    const mergedDir = path.join(episodeDir, 'EP0047 - 08 Audio Merge Output')
    await fs.mkdir(subtitlesDir, { recursive: true })
    await fs.mkdir(mergedDir, { recursive: true })

    const chapters = opts.chapters ?? [
      { slug: 'chapter_1', duration_s: 60, srt: '1\n00:00:00,000 --> 00:00:04,000\nThe grain dole ran dry.\n' },
      { slug: 'chapter_2', duration_s: 60, srt: '1\n00:00:01,000 --> 00:00:05,000\nRome went hungry.\n' },
    ]
    await fs.writeFile(
      path.join(episodeDir, 'audio_chapters.json'),
      JSON.stringify({ gap_duration_s: opts.gap ?? 1, sections: chapters.map(c => ({ slug: c.slug, duration_s: c.duration_s })) }),
    )
    for (const c of chapters) {
      if (c.srt) await fs.writeFile(path.join(subtitlesDir, `${CODE}_${c.slug}.srt`), c.srt)
    }
    return { root, episodeDir, subtitlesDir, mergedDir }
  }

  /**
   * A merged-audio record the lead-in resolver can read, so these tests exercise
   * the real measurement path rather than a stub of it.
   */
  async function writeMergedRecord(mergedDir: string, leadInSec: number | null) {
    await fs.writeFile(path.join(mergedDir, `${CODE}_merged_audio.mp3`), 'not really audio')
    await fs.writeFile(
      path.join(mergedDir, `${CODE}_merged_audio.completion.json`),
      JSON.stringify({
        output_filename: `${CODE}_merged_audio.mp3`,
        opening: leadInSec === null ? {} : { lead_in_sec: leadInSec, music_lead_in_sec: 0 },
      }),
    )
  }

  test('an episode with no per-chapter transcripts is not stitched and not blocked', async () => {
    // A hand-imported transcript is a legitimate way to caption an episode.
    // Blocking it because there is nothing to stitch would be a regression
    // dressed up as strictness.
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode({
      chapters: [{ slug: 'chapter_1', duration_s: 60 }],
    })
    try {
      const outcome = await ensureStitchedSubtitle({ episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE })
      assert.equal(outcome.status, 'not-applicable')
      assert.match(outcome.reason, /nothing to stitch/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('an unmeasurable intro BLOCKS the render, and never becomes zero', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      // A merge record with no `lead_in_sec`, and no probeable audio behind it.
      await writeMergedRecord(mergedDir, null)
      await assert.rejects(
        () => ensureStitchedSubtitle({ episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }),
        (e: Error) => {
          assert.ok(e instanceof SubtitleStitchBlocked, 'must be the blocking error type')
          assert.match(e.message, /blocked/i)
          // It has to distinguish the two zeros in words, or the next reader
          // learns nothing the old silent zero did not already tell them.
          assert.match(e.message, /no intro.*could not measure|could not measure.*no intro/is)
          // And say what to do about it.
          assert.match(e.message, /Audio Assembly/)
          return true
        },
      )
      // Nothing was written. A partial or zero-offset stitch left behind would
      // be worse than none: the next render would find it and call it current.
      const files = await fs.readdir(subtitlesDir)
      assert.ok(!files.includes(`${CODE}_stitched.srt`), 'a blocked stitch must leave no file')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('stitches, records the fingerprint, and then leaves it alone', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      await writeMergedRecord(mergedDir, 16.07)
      const args = { episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }

      const first = await ensureStitchedSubtitle(args)
      assert.equal(first.status, 'stitched')
      assert.equal(first.status === 'stitched' && first.created, true)

      const stitchedPath = path.join(subtitlesDir, `${CODE}_stitched.srt`)
      const recorded = await readRecordedSignature(stitchedPath)
      assert.ok(recorded, 'the stitch must record what it was built from')
      assert.equal(recorded!.lead_in_sec, 16.07)
      assert.equal(recorded!.sections.length, 2)
      // Recorded by CONTENT, so a copy or restore cannot make it look current.
      assert.equal(
        recorded!.sections[0]!.sha256,
        await sha256File(path.join(subtitlesDir, `${CODE}_chapter_1.srt`)),
      )

      // Second pass: nothing moved, so nothing is rebuilt.
      const second = await ensureStitchedSubtitle(args)
      assert.equal(second.status, 'fresh')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds truncated, malformed, and hash-mismatched stitched output despite unchanged sources and metadata', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      await writeMergedRecord(mergedDir, 16.07)
      const args = { episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }
      await ensureStitchedSubtitle(args)
      const stitchedPath = path.join(subtitlesDir, `${CODE}_stitched.srt`)
      const valid = await fs.readFile(stitchedPath, 'utf-8')
      assert.ok(JSON.parse(await fs.readFile(`${stitchedPath}.json`, 'utf-8')).inputs, 'the retained sidecar must keep a source fingerprint')
      assert.ok(valid.includes('00:00:16,070'), 'fixture must provide a cue boundary to alter')

      for (const [label, corrupt] of [
        ['truncated', valid.split(/\n\n+/)[0]!],
        ['malformed', 'this is not an SRT file'],
        ['hash-mismatched', valid.replace('00:00:16,070', '00:00:16,071')],
      ]) {
        const metadata = await fs.readFile(`${stitchedPath}.json`, 'utf-8')
        await fs.writeFile(stitchedPath, corrupt, 'utf-8')
        assert.equal(await fs.readFile(`${stitchedPath}.json`, 'utf-8'), metadata, `${label} output must retain valid metadata`)
        const outcome = await ensureStitchedSubtitle(args)
        assert.equal(outcome.status, 'stitched', `${label} output must be rebuilt, never reported fresh`)
        assert.equal(await fs.readFile(stitchedPath, 'utf-8'), valid, `${label} output must be restored from unchanged source artifacts`)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('an edited chapter is re-stitched even when its timestamp says otherwise', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      await writeMergedRecord(mergedDir, 16.07)
      const args = { episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }
      await ensureStitchedSubtitle(args)

      const chapter = path.join(subtitlesDir, `${CODE}_chapter_2.srt`)
      await fs.writeFile(chapter, '1\n00:00:01,000 --> 00:00:05,000\nRome starved.\n')
      // Backdate the edited chapter to BEFORE the stitch. An mtime comparison
      // would now conclude the stitch is newer and therefore current — which is
      // precisely the wrong answer, and precisely why the check hashes content.
      const old = new Date(Date.now() - 86_400_000)
      await fs.utimes(chapter, old, old)

      const again = await ensureStitchedSubtitle(args)
      assert.equal(again.status, 'stitched')
      assert.match(again.reason, /chapter_2's transcript was edited/)
      assert.ok(
        (await fs.readFile(path.join(subtitlesDir, `${CODE}_stitched.srt`), 'utf-8')).includes('Rome starved.'),
        'the rebuilt stitch must contain the edit',
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('`force` re-stitches a file that was already current', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      await writeMergedRecord(mergedDir, 16.07)
      const args = { episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }
      await ensureStitchedSubtitle(args)
      assert.equal((await ensureStitchedSubtitle(args)).status, 'fresh')
      // The manual Re-stitch button. Pressing it and being told "nothing to do"
      // reads as a broken button.
      const forced = await ensureStitchedSubtitle({ ...args, force: true })
      assert.equal(forced.status, 'stitched')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  /**
   * The branch that does the most work in practice.
   *
   * Every stitched file already on this Mac predates the fingerprint, so none of
   * them carry one. If "no record" meant "leave it alone", the ~284 episodes
   * stitched sixteen seconds early since 2026-07-14 would stay broken until each
   * was re-stitched by hand. Treating absence as "cannot be shown current" makes
   * the backlog repair itself the next time each episode is rendered — repair on
   * touch, not a bulk sweep.
   */
  test('a stitch with no sidecar at all is rebuilt, repairing the backlog on touch', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      await writeMergedRecord(mergedDir, 16.07)
      const args = { episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }
      await ensureStitchedSubtitle(args)
      const stitchedPath = path.join(subtitlesDir, `${CODE}_stitched.srt`)

      // Exactly the shape of a pre-v1.4.0 episode: a stitched file, no sidecar.
      await fs.rm(`${stitchedPath}.json`)
      assert.equal(await readRecordedSignature(stitchedPath), null)

      const outcome = await ensureStitchedSubtitle(args)
      assert.equal(outcome.status, 'stitched')
      assert.match(outcome.reason, /no record of what it was built from/)
      // And it now carries one, so the NEXT render leaves it alone.
      assert.ok(await readRecordedSignature(stitchedPath), 'the rebuild must record a fingerprint')
      assert.equal((await ensureStitchedSubtitle(args)).status, 'fresh')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('an unparseable sidecar is rebuilt, never trusted', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      await writeMergedRecord(mergedDir, 16.07)
      const args = { episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }
      await ensureStitchedSubtitle(args)
      const stitchedPath = path.join(subtitlesDir, `${CODE}_stitched.srt`)

      // Truncated by an interrupted write, or corrupted by a sync conflict.
      for (const junk of ['{ not json', '', 'null', '{"inputs": "nonsense"}']) {
        await fs.writeFile(`${stitchedPath}.json`, junk, 'utf-8')
        const outcome = await ensureStitchedSubtitle(args)
        assert.equal(outcome.status, 'stitched', `a ${JSON.stringify(junk)} sidecar must force a rebuild`)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('a good stitch survives its inputs being tidied away', async () => {
    const { root, episodeDir, subtitlesDir, mergedDir } = await makeEpisode()
    try {
      await writeMergedRecord(mergedDir, 16.07)
      const args = { episodeDir, subtitlesDir, mergedAudioDir: mergedDir, episodeCode: CODE }
      await ensureStitchedSubtitle(args)
      const before = await fs.readFile(path.join(subtitlesDir, `${CODE}_stitched.srt`), 'utf-8')

      // Someone deleted the per-chapter partials to save space. The full
      // transcript is still correct; rebuilding or discarding it here would
      // destroy a good timeline because its sources are gone.
      await fs.rm(path.join(subtitlesDir, `${CODE}_chapter_1.srt`))
      await fs.rm(path.join(subtitlesDir, `${CODE}_chapter_2.srt`))

      const outcome = await ensureStitchedSubtitle(args)
      assert.equal(outcome.status, 'kept')
      assert.equal(await fs.readFile(path.join(subtitlesDir, `${CODE}_stitched.srt`), 'utf-8'), before)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
