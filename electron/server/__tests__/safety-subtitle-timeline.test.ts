/**
 * 1.4.300 — "Joined subtitle file checks out" and "Subtitles match today's audio": Off / Warn carry on
 * (re-stitch by itself; keep the older captions and re-transcribe when free), Block keeps the old stop.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

const CODE = 'EP0047'
let temp: { dir: string; cleanup: () => Promise<void> }
let slug = ''

before(async () => {
  temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  slug = (await pm.createProject({ name: 'Safety Subtitles', episode_prefix: 'EP', episode_digits: 4 })).slug
})
after(async () => { await temp.cleanup() })

const job = () => ({ project_slug: slug, job_id: 'safety-subtitles', output_lines: [] as string[], result: undefined as any }) as any
const setMode = async (id: string, mode: string) => {
  const pm = await import('../services/project-manager.js')
  await pm.updateConfig(slug, { safety_checks: { [id]: mode } } as any)
}

/** Two chapters, their SRTs, active audio and a merge record: enough for a real stitch. */
async function episode(name: string) {
  const episodeDir = path.join(temp.dir, name)
  const subtitlesDir = path.join(episodeDir, 'subtitles')
  const mergedAudioDir = path.join(episodeDir, 'merged')
  const audioDir = path.join(episodeDir, 'audio')
  for (const dir of [subtitlesDir, mergedAudioDir, audioDir]) await fs.mkdir(dir, { recursive: true })
  const chapters = ['chapter_1', 'chapter_2']
  for (const [i, slug] of chapters.entries()) {
    await fs.writeFile(path.join(audioDir, `${CODE}_${slug}.mp3`), `audio-${slug}`)
    await fs.writeFile(path.join(subtitlesDir, `${CODE}_${slug}.srt`), `1\n00:00:00,000 --> 00:00:04,000\nLine ${i + 1}.\n`)
  }
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1, sections: chapters.map(slug => ({ slug, duration_s: 60, source_file: `${CODE}_${slug}.mp3` })),
  }))
  await fs.writeFile(path.join(mergedAudioDir, `${CODE}_merged_audio.mp3`), 'not really audio')
  await fs.writeFile(path.join(mergedAudioDir, `${CODE}_merged_audio.completion.json`), JSON.stringify({
    output_filename: `${CODE}_merged_audio.mp3`, opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
  }))
  const { ensureStitchedSubtitle } = await import('../lib/subtitle-autostitch.js')
  const dirs = { episodeDir, subtitlesDir, mergedAudioDir, audioDir }
  await ensureStitchedSubtitle({ ...dirs, episodeCode: CODE })
  return dirs
}

test('stitched_subtitles Warn (default) re-stitches a cut-short joined file; Block leaves it for the old stop', async () => {
  const { restitchIfBroken, verifyWrittenSubtitleTimeline } = await import('../services/scene-timeline-integrity.js')
  const dirs = await episode('stitch')
  const stitched = path.join(dirs.subtitlesDir, `${CODE}_stitched.srt`)
  const valid = await fs.readFile(stitched, 'utf8')
  await fs.writeFile(stitched, valid.split(/\n\n+/)[0]!)

  await setMode('stitched_subtitles', 'block')
  await restitchIfBroken(job(), dirs, CODE)
  assert.equal(await verifyWrittenSubtitleTimeline(dirs.subtitlesDir, CODE), false)

  await setMode('stitched_subtitles', 'warn')
  const warned = job()
  await restitchIfBroken(warned, dirs, CODE)
  assert.equal(await verifyWrittenSubtitleTimeline(dirs.subtitlesDir, CODE), true)
  assert.equal(await fs.readFile(stitched, 'utf8'), valid)
  assert.deepEqual(warned.result?.safety_warnings?.map((w: any) => w.check), ['stitched_subtitles'])
})

test('subtitles_match_audio Warn (default) carries on with the older captions; Block stops', async () => {
  const { assertSubtitleTimelineComplete } = await import('../services/scene-timeline-integrity.js')
  const dirs = await episode('stale')
  // The chapter was re-narrated after its subtitles were made.
  const later = new Date(Date.now() + 60_000)
  await fs.utimes(path.join(dirs.audioDir, `${CODE}_chapter_2.mp3`), later, later)
  const source = { episodeDir: dirs.episodeDir, audioDir: dirs.audioDir }

  await setMode('subtitles_match_audio', 'block')
  await assert.rejects(assertSubtitleTimelineComplete(dirs.subtitlesDir, CODE, source, job()), /needs updating for chapter_2/)

  await setMode('subtitles_match_audio', 'warn')
  const warned = job()
  await assertSubtitleTimelineComplete(dirs.subtitlesDir, CODE, source, warned)
  assert.deepEqual(warned.result?.safety_warnings?.map((w: any) => w.check), ['subtitles_match_audio'])
  // No free transcription on record, so nothing is queued and the log says so.
  assert.ok(warned.output_lines.some((line: string) => /not re-transcribed automatically/.test(line)), warned.output_lines.join('\n'))
  // Without the job (callers not wired yet) it stops as before.
  await assert.rejects(assertSubtitleTimelineComplete(dirs.subtitlesDir, CODE, source), /needs updating for chapter_2/)
})
