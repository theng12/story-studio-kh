/**
 * Regression for a surviving completion-review finding — 2026-10-19.
 *
 * FINDING: asset-status reports the subtitle step COMPLETE for a stitched SRT
 * that is stale against the current narration, because its audio-freshness
 * check runs only in `per-section` mode — and `inspectSubtitleCompletion`
 * promotes a complete `_stitched.srt` to `full-track`.
 *
 * `inspectSubtitleCompletion` (services/subtitle-completion.ts:366-438) returns
 * `mode: 'full-track'` when a complete `_stitched.(srt|ass|vtt)` exists (the
 * loop at lines 402-423 sets `fullTrack` to the stitched file, then lines
 * 414-423 return it). `computeEpisodeStatus` (services/asset-status.ts:1290-1301)
 * then does:
 *     status.subtitles = completion.complete
 *     if (status.subtitles && completion.mode === 'per-section') { ...freshness... }
 * so for `full-track` the `inspectSubtitleSourceFreshness` call — the only check
 * that notices "the audio was regenerated after this transcript" — is SKIPPED.
 *
 * CONTRAST (the repo's own rule): the Pipeline repair path already refuses a
 * stitched file as a standalone full-track — `pipelineSubtitleRepairComplete`
 * (routes/pipeline.ts:2276-2292) requires
 * `!/_stitched\.(?:srt|ass|vtt)$/i.test(completion.full_track_filename)`.
 * So Pipeline's subtitle step and the Production Board disagree about the same
 * episode: §8 requires them to share one rule.
 *
 * TRIGGER: an episode whose per-chapter audio was regenerated after the stitch
 * (so the per-section SRTs are stale) but which still carries a complete
 * `_stitched.srt`. asset-status shows subtitles done; the generator would block
 * with `SubtitleStitchBlocked` (lib/subtitle-autostitch.ts:206-214).
 *
 * This test asserts ONLY the observable status, never the intermediate
 * `inspectSubtitleCompletion` shape: pinning `mode: 'full-track'` would make the
 * test fail the moment the fix stops promoting stitched files, which is the
 * whole point of the fix. The stale fixture keeps the chapter AUDIO present (the
 * "regenerated after the stitch" state) with its mtime newer than the SRTs —
 * `utimes`, no sleeps — so the freshness check is what decides the result, not a
 * missing file.
 *
 * PLACEMENT: uses the application's own relative imports, so copy to
 * electron/server/__tests__/ before running against a release worktree.
 *
 * EXPECTED RED on the current source: the RED case's `subtitles` is true.
 * GREEN once the stitched file is not treated as a standalone full-track (so
 * the freshness check runs and reports the stale sections). The CONTROL proves
 * the fixture is really read (it is not an empty status) — it must stay green
 * on both the red and the green source.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const { computeEpisodeStatus } = await import('../services/asset-status.js')
const { resolveEpisodePaths } = await import('../services/utils.js')
after(async () => { await temp.cleanup() })

const CODE = 'EP0001'
const SRT_MTIME = new Date('2020-06-01T00:00:00Z')

function srt(startSec: number, endSec: number, text: string): string {
  const ts = (s: number) => {
    const ms = Math.round(s * 1000)
    const hh = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
    const mm = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')
    const ss = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')
    const mmm = String(ms % 1000).padStart(3, '0')
    return `${hh}:${mm}:${ss},${mmm}`
  }
  return `1\n${ts(startSec)} --> ${ts(endSec)}\n${text}\n`
}

/**
 * A two-chapter episode with per-section SRTs and a complete `_stitched.srt`.
 * The chapter AUDIO is always present; `audioNewerThanSrt` decides whether its
 * mtime is after the SRTs (the narration was regenerated after the stitch —
 * stale) or before them (the transcript still matches the narration).
 */
async function buildEpisode(name: string, audioNewerThanSrt: boolean) {
  const project = await pm.createProject({ name })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Story', logline: '', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm',
  }], 'test')
  await im.acceptIdea(project.slug, idea!.id, false, { override_code: CODE })

  const paths = await resolveEpisodePaths(project.slug, CODE, 'Story')
  await fs.mkdir(paths.episode_dir, { recursive: true })
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.mkdir(paths.audio_dir, { recursive: true })

  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: 'Chapter_01' }, { slug: 'Chapter_02' }],
    gap_duration_s: 1,
  }))

  const audioMtime = audioNewerThanSrt
    ? new Date('2020-12-01T00:00:00Z')
    : new Date('2020-01-01T00:00:00Z')
  for (const slug of ['Chapter_01', 'Chapter_02']) {
    const audio = path.join(paths.audio_dir, `${CODE}_${slug}.mp3`)
    await fs.writeFile(audio, 'audio bytes')
    await fs.utimes(audio, audioMtime, audioMtime)
  }
  for (const slug of ['Chapter_01', 'Chapter_02']) {
    const file = path.join(paths.subtitles_dir, `${CODE}_${slug}.srt`)
    await fs.writeFile(file, srt(0, 5, slug))
    await fs.utimes(file, SRT_MTIME, SRT_MTIME)
  }
  await fs.writeFile(path.join(paths.subtitles_dir, `${CODE}_stitched.srt`),
    srt(0, 5, 'One') + '\n' + srt(6, 11, 'Two'))
  await fs.writeFile(path.join(paths.subtitles_dir, `${CODE}_stitched.srt.json`), JSON.stringify({
    complete: true,
    sections: [
      { slug: 'Chapter_01', source_srt: `${CODE}_Chapter_01.srt`, cues_added: 1 },
      { slug: 'Chapter_02', source_srt: `${CODE}_Chapter_02.srt`, cues_added: 1 },
    ],
  }))

  return { slug: project.slug, paths }
}

test('CONTROL: a stitched episode whose narration still matches reads subtitle-complete', async () => {
  const { slug } = await buildEpisode('Fresh Stitched Subtitle', false)
  const status = await computeEpisodeStatus(slug, CODE)
  // Guards against a false green: an empty status (project not read) would also
  // be false, so this must be TRUE for the fixture to be considered read.
  assert.equal(status.subtitles, true, 'a fresh, complete stitched episode must read subtitle-complete')
})

test('RED: a complete but stale _stitched.srt must not read as subtitle-complete', async () => {
  const { slug } = await buildEpisode('Stale Stitched Subtitle', true)
  const status = await computeEpisodeStatus(slug, CODE)
  assert.equal(status.subtitles, false,
    'a stitched SRT that no longer matches the narration must not be reported as subtitle-complete')
})
