/**
 * Night Atlas History EP0012–14 (2026-10-20): the merged audio was mixed BEFORE 1.4.327, so it
 * carries no closing tail (`closing_tail_sec` 0), while the channel's Video Assembly preset asks
 * for a 25 s closing WITH music. The renderer padded the tail with silence, and the final check
 * failed it after a multi-hour render.
 *
 * The supported recovery is to re-mix the episode's audio with the closing tail (the 1.4.327
 * Audio Assembly path) BEFORE rendering — narration, lead-in and the Scene Plan's clock untouched,
 * the tail added after the speech. Where that is not safely possible the render is refused with a
 * plain reason rather than drawing a silent tail.
 *
 * REAL merges with local FFmpeg; ZERO paid calls.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import test, { after, describe } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudioMerge } = await import('../generators/audio-merge.js')
const { guardClosingTail, prepareUnifiedVideoAssemblyInputs, scanEpisodeAssets } = await import('../generators/video.js')
const { planClosingTailRemix, beginClosingTailRemix } = await import('../services/closing-tail-remix.js')
const { claimClosingTailRemix } = await import('../services/closing-tail-remix-admission.js')
const jq = await import('../services/job-queue.js')
const { readSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { measureLoudness } = await import('../generators/music-episode-build.js')

const service = await startMockGenStudioService()
await setGenStudioUrl(service.baseUrl)
await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
service.ttsModels = [{
  id: 'roomy-model', display_name: 'roomy-model', provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 4_000,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
}] as any
clearGenStudioCatalogCache()

after(async () => {
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

const NARRATION_SEC = 3
const LEAD_IN_SEC = 8
const TAIL_SEC = 25
const POST_AUDIO = { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: TAIL_SEC, closing_music: { volume: 100 } } as const
const near = (actual: number | null | undefined, expected: number, tolerance = 0.6) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `expected ${actual} ≈ ${expected} (±${tolerance})`)
const sha = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex')

async function sliceLufs(file: string, startSec: number, durSec: number): Promise<number | null> {
  const out = path.join(temp.dir, `slice-${Math.random().toString(36).slice(2, 8)}.wav`)
  await runFfmpeg(['-y', '-ss', String(startSec), '-t', String(durSec), '-i', file, '-vn', '-c:a', 'pcm_s16le', out])
  const measured = await measureLoudness(out, { truePeak: false })
  await fs.rm(out, { force: true })
  return measured.lufs
}

/**
 * An episode whose audio was merged under an OLD preset (no closing tail), then a channel whose
 * Video Assembly preset now asks for a 25 s closing with music. `musicOn: false` is a channel that
 * never used background music.
 */
async function oldMergeEpisode(opts: { musicOn?: boolean; savedTail?: number; leadInSec?: number } = {}) {
  const musicOn = opts.musicOn !== false
  const leadInSec = opts.leadInSec ?? LEAD_IN_SEC
  const project = await pm.createProject({
    name: `Remix ${Math.random().toString(36).slice(2, 7)}`, episode_prefix: 'EP', episode_digits: 3,
  })
  const slug = project.slug
  const videoPreset = (postAudio: Record<string, unknown>) => ({
    video_bundle_presets: [{ id: 'bundle-1', name: 'Closing', data: { fallback: { timeline: { post_audio: postAudio } } } }],
    video_bundle_last_preset: 'bundle-1',
  })
  // The merge happens while the preset still asks for no tail — the pre-1.4.327 world.
  await pm.updateConfig(slug, {
    safety_checks: { chapter_audio_present: 'off' },
    ...videoPreset({ behavior: 'hard-cut', fade_duration: 5 }),
  } as any)

  const outputRoot = (await pm.getProjectOutputRoot(slug))!
  // The accepted idea names the episode's folder, as it does in a real channel.
  await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'i-1', title: 'Test', logline: 'l', themes: [], suggested_chapters: 1, suggested_length: '1 min', mood: 'm',
      status: 'accepted', episode_code: 'EP001', generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'imported', model_used: 'imported',
    }],
    next_episode_number: 2, recycled_numbers: [],
  }))
  const narrationDir = path.join(outputRoot, 'Season 001', 'EP001 - Test')
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One', 'The first chapter is short.',
  ].join('\n\n'))
  const { resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
  const audioDir = await resolveAudioDir(slug, await findNarrationFile(slug, 'EP001'), 'EP001')
  await fs.mkdir(audioDir, { recursive: true })
  const chapter = path.join(audioDir, 'EP001_Chapter_01.mp3')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${NARRATION_SEC}`,
    '-c:a', 'libmp3lame', chapter])
  const musicPath = path.join(temp.dir, `closing-music-${slug}.mp3`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-c:a', 'libmp3lame', musicPath])

  const music = {
    enabled: musicOn, source: 'manual', files: [musicPath], volume: 0.5, post_narration_volume: 0.6, fade_in: 0, fade_out: 0,
    lead_in_enabled: leadInSec > 0, lead_in_seconds: leadInSec,
  }
  const merge = async () => {
    const job: any = {
      job_id: `merge-${Math.random().toString(36).slice(2)}`, project_slug: slug, type: 'audio_merge',
      episode_id: 'EP001', title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(),
      started_at: null, finished_at: null, error: null, output_lines: [],
      params: { episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false, music },
    }
    await generateAudioMerge(job)
    return job.output_dir as string
  }
  const mergedDir = await merge()

  // Now the channel asks for the closing, and its saved Audio Assembly preset is what a re-mix uses.
  await pm.updateConfig(slug, {
    ...videoPreset(opts.savedTail === undefined ? { ...POST_AUDIO } : { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: opts.savedTail, closing_music: { volume: 100 } }),
    audio_merge_presets: [{
      id: 'merge-1', name: 'Mix',
      data: {
        music: { enabled: musicOn, source: 'manual', files: [musicPath], volume: 50, post_narration_volume: 60, fade_in: 0, fade_out: 0, lead_in_enabled: leadInSec > 0, lead_in_seconds: leadInSec },
        gap_duration: 0, normalize_volume: false,
      },
    }],
    audio_merge_last_preset: 'merge-1',
  } as any)

  const job: any = {
    job_id: 'va-1', project_slug: slug, type: 'video_assembly', episode_id: 'EP001', title: 'Video Assembly',
    status: 'running', created_at: new Date().toISOString(), started_at: null, finished_at: null, error: null,
    output_lines: [], params: {},
  }
  return { slug, mergedDir, chapter, job, merge, musicPath, original: path.join(mergedDir, 'EP001_merged_audio.mp3') }
}

describe('an old merge (no closing tail) asked for a 25 s closing with music', () => {
  test('is re-mixed before rendering: music in the tail, narration and lead-in unchanged, new track selected', async () => {
    const ep = await oldMergeEpisode()
    const before = await scanEpisodeAssets(ep.slug, 'EP001')
    const old = before.merged_audio[0]!
    assert.equal(old.closing_tail_sec, 0, 'the fixture really is an old merge')
    const oldBytes = await sha(ep.original)
    const oldSidecar = await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8')

    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'remix')

    const req: any = { merged_audio_path: old.path, post_audio: { ...POST_AUDIO } }
    const after = await guardClosingTail(ep.slug, 'EP001', req, before, ep.job)
    const fresh = after.merged_audio[0]!

    assert.equal(fresh.filename, 'EP001_merged_audio_v2.mp3', 'the re-mix is a new track beside the original')
    assert.equal(fresh.closing_tail_sec, TAIL_SEC)
    assert.equal(req.merged_audio_path, fresh.path, 'the render now lays the re-mixed track under the pictures')
    // The tail is added AFTER the speech: the narration the Scene Plan was timed on does not move.
    near((fresh.duration ?? 0) - (fresh.closing_tail_sec ?? 0), old.duration ?? 0, 0.5)
    near(fresh.opening?.lead_in_sec, old.opening?.lead_in_sec ?? 0, 0.1)
    near(fresh.opening?.lead_in_sec, LEAD_IN_SEC, 0.4)
    // The new track is THE selected one (the owner's pin file), so every reader agrees.
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), 'EP001_merged_audio_v2.mp3')
    // The original stays exactly as it was, and so does the record that described it.
    assert.equal(await sha(ep.original), oldBytes)
    // Music — not silence — across the tail, long after the 2 s bed would have run out.
    const midTail = await sliceLufs(fresh.path, (fresh.duration ?? 0) - TAIL_SEC + 8, 3)
    assert.ok(midTail !== null && midTail > -70, `the tail must carry music (got ${midTail})`)
    assert.match(ep.job.output_lines.join('\n'), /closing/i)
    // The first track's own record is not needed for it to keep reading as a no-tail merge.
    const reread = await scanEpisodeAssets(ep.slug, 'EP001')
    assert.equal(reread.merged_audio[0]!.filename, 'EP001_merged_audio_v2.mp3')
    assert.equal(reread.merged_audio[0]!.closing_tail_sec, TAIL_SEC)
    assert.ok(oldSidecar.includes('"closing_tail_sec": 0'))
  })

  test('legacy audio without recorded opening reuses measured timing instead of the current preset lead-in', async () => {
    for (const leadInSec of [0, LEAD_IN_SEC]) {
      const ep = await oldMergeEpisode({ leadInSec })
      const recordPath = path.join(ep.mergedDir, 'EP001_merged_audio.completion.json')
      const record = JSON.parse(await fs.readFile(recordPath, 'utf-8'))
      delete record.opening
      await fs.writeFile(recordPath, JSON.stringify(record, null, 2))
      await pm.updateConfig(ep.slug, {
        audio_merge_presets: [{
          id: 'merge-1', name: 'Mix',
          data: { music: { enabled: true, source: 'manual', files: [ep.musicPath], volume: 50, post_narration_volume: 60, fade_in: 0, fade_out: 0, lead_in_enabled: true, lead_in_seconds: 6 }, gap_duration: 0, normalize_volume: false },
        }],
      } as any)
      const oldBytes = await sha(ep.original)

      const verdict: any = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
      assert.equal(verdict.action, 'remix')
      assert.equal(verdict.params.music.lead_in_seconds, leadInSec, 'the existing opening is measured from the merged audio')
      assert.equal(verdict.track.leadInSec, leadInSec, 'the strict lead-in guard uses the measured baseline')
      assert.equal(verdict.params.intro.enabled, false, 'the current preset cannot add an unrecorded intro')

      const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: path.basename(ep.original) })
      const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, ep.job)
      near((after.merged_audio[0]!.duration ?? 0) - TAIL_SEC, Number(record.duration_sec), 0.5)
      assert.equal(await sha(ep.original), oldBytes, 'the source audio remains byte-for-byte unchanged')
    }
  })

  test('a merge that already carries the tail is left alone', async () => {
    const ep = await oldMergeEpisode()
    // Re-merge under the closing preset (already 25 s by now): the tail is baked.
    const baked = await ep.merge()
    const assets = await scanEpisodeAssets(ep.slug, 'EP001')
    assert.equal(assets.merged_audio[0]!.closing_tail_sec, TAIL_SEC)
    const listing = (await fs.readdir(baked)).sort()

    assert.deepEqual(await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO }), { action: 'none' })
    const req: any = { merged_audio_path: assets.merged_audio[0]!.path, post_audio: { ...POST_AUDIO } }
    const after = await guardClosingTail(ep.slug, 'EP001', req, assets, ep.job)
    assert.equal(after, assets, 'nothing re-scanned, nothing re-made')
    assert.deepEqual((await fs.readdir(baked)).sort(), listing, 'no new file, no pin')
  })

  test('a request with no closing music, no tail, or a channel without background music changes nothing', async () => {
    const ep = await oldMergeEpisode()
    for (const postAudio of [
      { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: TAIL_SEC }, // no closing_music block
      { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: TAIL_SEC, closing_music: { volume: 0 } },
      { behavior: 'hard-cut', fade_duration: 5, closing_music: { volume: 100 } },
      undefined,
    ]) {
      assert.deepEqual(await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: postAudio as any }), { action: 'none' })
    }
    const noMusic = await oldMergeEpisode({ musicOn: false })
    assert.deepEqual(
      await planClosingTailRemix({ slug: noMusic.slug, code: 'EP001', postAudio: POST_AUDIO }),
      { action: 'none' },
      'a channel that never mixes background music keeps the silent tail it was designed with (1.4.327)',
    )
  })
})

describe('with no active Audio Assembly preset (Wonder in Ink WI0001, 2026-10-23)', () => {
  const clearAudioPreset = (slug: string) => pm.updateConfig(slug, { audio_merge_presets: [], audio_merge_last_preset: '' } as any)
  const recordPath = (ep: { mergedDir: string }) => path.join(ep.mergedDir, 'EP001_merged_audio.completion.json')
  const rewriteRecord = async (ep: { mergedDir: string }, mutate: (record: any) => void) => {
    const record = JSON.parse(await fs.readFile(recordPath(ep), 'utf-8'))
    mutate(record)
    await fs.writeFile(recordPath(ep), JSON.stringify(record, null, 2))
  }

  test('a mix KNOWN to have a bed is refused, naming the episode and the way out', async () => {
    const ep = await oldMergeEpisode()
    await clearAudioPreset(ep.slug)
    assert.equal(JSON.parse(await fs.readFile(recordPath(ep), 'utf-8')).background_music, true, 'the merge records its bed')
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'refuse')
    const reason = (verdict as any).reason as string
    assert.match(reason, /^EP001:/)
    assert.match(reason, /no active Audio Assembly preset/)
    assert.match(reason, /Save an Audio Assembly preset with the music/)
    assert.match(reason, /re-run Audio Assembly/)
    assert.match(reason, /music turned off/, 'and the way to keep the ending silent on purpose')
    const assets = await scanEpisodeAssets(ep.slug, 'EP001')
    await assert.rejects(
      guardClosingTail(ep.slug, 'EP001', postAudioReq(assets.merged_audio[0]!.path), assets, ep.job),
      /no active Audio Assembly preset/,
      'the render refuses before it draws a padded silent tail',
    )
  })

  test('a record that does not say whether it has a bed (older merge) keeps the old behaviour: no refusal', async () => {
    const ep = await oldMergeEpisode()
    await clearAudioPreset(ep.slug)
    await rewriteRecord(ep, record => { delete record.background_music })
    assert.deepEqual(await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO }), { action: 'none' })
    const assets = await scanEpisodeAssets(ep.slug, 'EP001')
    assert.equal(await guardClosingTail(ep.slug, 'EP001', postAudioReq(assets.merged_audio[0]!.path), assets, ep.job), assets)
  })

  test('a mix KNOWN to have no bed is not refused; neither is a saved preset with music off', async () => {
    const noBed = await oldMergeEpisode({ musicOn: false })
    await clearAudioPreset(noBed.slug)
    assert.equal(JSON.parse(await fs.readFile(recordPath(noBed), 'utf-8')).background_music, false)
    assert.deepEqual(await planClosingTailRemix({ slug: noBed.slug, code: 'EP001', postAudio: POST_AUDIO }), { action: 'none' })
    const musicOffPreset = await oldMergeEpisode({ musicOn: false })
    assert.deepEqual(await planClosingTailRemix({ slug: musicOffPreset.slug, code: 'EP001', postAudio: POST_AUDIO }), { action: 'none' })
  })

  test("a closing saved only as the episode's last render is the one a manual Audio Assembly bakes", async () => {
    const ep = await oldMergeEpisode()
    // No Video Assembly preset at all: the 25 s closing exists only as EP001's last render.
    await pm.updateConfig(ep.slug, {
      video_bundle_presets: [], video_bundle_last_preset: '',
      video_assembly_last_used: { episodes: { EP001: { episode_id: 'EP001', saved_at: '2026-10-23T00:00:00.000Z', settings: { timeline: { post_audio: { ...POST_AUDIO } } } } } },
    } as any)
    await ep.merge()
    assert.equal((await scanEpisodeAssets(ep.slug, 'EP001')).merged_audio[0]!.closing_tail_sec, TAIL_SEC)
  })
})

describe("the render's own closing outranks whatever is saved", () => {
  const lastRenderOnly = (slug: string, postAudio: Record<string, unknown>) => pm.updateConfig(slug, {
    video_bundle_presets: [], video_bundle_last_preset: '',
    video_assembly_last_used: { episodes: { EP001: { episode_id: 'EP001', saved_at: '2026-10-23T00:00:00.000Z', settings: { timeline: { post_audio: postAudio } } } } },
  } as any)

  test('a manual last render with no tail and a Pipeline preset of 25 s: re-mixed to 25 s, not refused', async () => {
    const ep = await oldMergeEpisode()
    await lastRenderOnly(ep.slug, { behavior: 'hard-cut', fade_duration: 5 })
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'remix', JSON.stringify(verdict))
    assert.deepEqual((verdict as any).params.closing_post_audio, POST_AUDIO)
    const before = await scanEpisodeAssets(ep.slug, 'EP001')
    const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(before.merged_audio[0]!.path), before, ep.job)
    assert.equal(after.merged_audio[0]!.closing_tail_sec, TAIL_SEC)
  })

  test('a saved closing shorter than the render asks for no longer blocks it', async () => {
    const ep = await oldMergeEpisode({ savedTail: 5 })
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'remix', JSON.stringify(verdict))
  })

  test('a merge that carries closing_post_audio bakes that block, not the episode\'s last render', async () => {
    const ep = await oldMergeEpisode()
    // The episode last rendered with a 25 s closing; the Pipeline preset this run renders from says 10 s.
    await lastRenderOnly(ep.slug, { ...POST_AUDIO })
    const record = JSON.parse(await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8'))
    assert.equal(record.closing_tail_sec, 0, 'the fixture merge is the old one')
    const job = mergeJob(ep.slug, {
      episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false, write_mode: 'new',
      music: { enabled: true, source: 'manual', files: [ep.musicPath], volume: 0.5, post_narration_volume: 0.6, fade_in: 0, fade_out: 0, lead_in_enabled: true, lead_in_seconds: LEAD_IN_SEC },
      closing_post_audio: { ...POST_AUDIO, tail_seconds: 10 },
    })
    await generateAudioMerge(job)
    const written = JSON.parse(await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8'))
    assert.equal(written.closing_tail_sec, 10, 'the render\'s 10 s, not the last render\'s 25 s')
  })

  test('the re-mixed track records its bed, so the next render knows it', async () => {
    const ep = await oldMergeEpisode()
    const before = await scanEpisodeAssets(ep.slug, 'EP001')
    await guardClosingTail(ep.slug, 'EP001', postAudioReq(before.merged_audio[0]!.path), before, ep.job)
    const record = JSON.parse(await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8'))
    assert.equal(record.background_music, true)
    assert.equal(record.closing_tail_remix_of, 'EP001_merged_audio.mp3')
  })
})

describe('where a re-mix is not safely possible, the render is refused with a plain reason', () => {
  const WORDING = /this episode's audio was mixed before closing music existed; re-mix the audio to add the 25 s closing/

  test('audio that Audio Assembly did not record cannot be re-made from the chapters', async () => {
    const ep = await oldMergeEpisode()
    await fs.rm(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), { force: true })
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'refuse')
    assert.match((verdict as any).reason, WORDING)
    const assets = await scanEpisodeAssets(ep.slug, 'EP001')
    await assert.rejects(
      guardClosingTail(ep.slug, 'EP001', { merged_audio_path: assets.merged_audio[0]!.path, post_audio: { ...POST_AUDIO } } as any, assets, undefined),
      WORDING,
      'the admission route (no job) refuses too',
    )
  })

  test('a re-mix that moves the narration is undone and refused: original kept, nothing selected', async () => {
    const ep = await oldMergeEpisode()
    const before = await scanEpisodeAssets(ep.slug, 'EP001')
    // The chapters changed since the old merge: a re-mix would no longer be the same narration.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
      '-c:a', 'libmp3lame', ep.chapter])
    const oldBytes = await sha(ep.original)
    const oldSidecar = await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8')
    const listing = (await fs.readdir(ep.mergedDir)).sort()

    await assert.rejects(
      guardClosingTail(ep.slug, 'EP001', { merged_audio_path: before.merged_audio[0]!.path, post_audio: { ...POST_AUDIO } } as any, before, ep.job),
      /narration/,
    )
    assert.equal(await sha(ep.original), oldBytes)
    assert.equal(await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8'), oldSidecar)
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), null)
    assert.deepEqual((await fs.readdir(ep.mergedDir)).sort(), listing, 'the re-mix files were removed again')
  })
})

describe('Pipeline preflight says the same thing before anything is queued', () => {
  const preflight = async (slug: string) => {
    const { router } = await import('../routes/pipeline.js')
    const app = express()
    app.use(express.json())
    app.use('/api', router)
    return request(app).post(`/api/projects/${slug}/pipeline/preflight`).send({ episode_ids: ['EP001'], steps: ['video_assembly'] })
  }

  test('an old merge that can be re-mixed is announced, not blocked', async () => {
    const ep = await oldMergeEpisode()
    const response = await preflight(ep.slug)
    assert.ok(!response.body.issues.some((issue: any) => issue.code === 'closing_tail_unsafe'), JSON.stringify(response.body.issues))
    assert.match(response.body.warnings.join('\n'), /EP001: its audio was mixed without the 25 s closing music.*re-mixes the audio/)
  })

  test('one that cannot be re-mixed is refused with the reason', async () => {
    const ep = await oldMergeEpisode()
    await fs.rm(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), { force: true })
    const response = await preflight(ep.slug)
    const issue = response.body.issues.find((row: any) => row.code === 'closing_tail_unsafe')
    assert.ok(issue, JSON.stringify(response.body.issues))
    assert.equal(issue.episode_id, 'EP001')
    assert.match(issue.message, /this episode's audio was mixed before closing music existed; re-mix the audio to add the 25 s closing/)
  })

  test('no active Audio Assembly preset: refused for a recorded bed, left alone for an older record', async () => {
    const known = await oldMergeEpisode()
    await pm.updateConfig(known.slug, { audio_merge_presets: [], audio_merge_last_preset: '' } as any)
    const refused = (await preflight(known.slug)).body.issues.find((row: any) => row.code === 'closing_tail_unsafe')
    assert.ok(refused, 'a recorded bed with nothing to re-mix it from is announced before anything is queued')
    assert.match(refused.message, /no active Audio Assembly preset/)

    const legacy = await oldMergeEpisode()
    await pm.updateConfig(legacy.slug, { audio_merge_presets: [], audio_merge_last_preset: '' } as any)
    const file = path.join(legacy.mergedDir, 'EP001_merged_audio.completion.json')
    const record = JSON.parse(await fs.readFile(file, 'utf-8'))
    delete record.background_music
    await fs.writeFile(file, JSON.stringify(record, null, 2))
    const response = await preflight(legacy.slug)
    assert.ok(!response.body.issues.some((row: any) => row.code === 'closing_tail_unsafe'), JSON.stringify(response.body.issues))
  })

  test('a merge that carries the tail raises nothing', async () => {
    const ep = await oldMergeEpisode()
    await ep.merge()
    const response = await preflight(ep.slug)
    assert.ok(!response.body.issues.some((issue: any) => issue.code === 'closing_tail_unsafe'))
    assert.doesNotMatch(response.body.warnings.join('\n'), /closing music this run asks for/)
  })
})

describe('the render and its admission both run the guard', () => {
  // Neither episode has a Scene Plan, so preparation stops there — AFTER the closing-tail decision.
  test('the render re-mixes before it goes on to the Scene Plan; admission only refuses', async () => {
    const ep = await oldMergeEpisode()
    await assert.rejects(
      prepareUnifiedVideoAssemblyInputs(ep.slug, 'EP001', { post_audio: { ...POST_AUDIO } } as any, ep.job),
      /No Scene Plan timeline was found/,
    )
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), 'EP001_merged_audio_v2.mp3', 'the render re-mixed the audio first')

    const admitted = await oldMergeEpisode()
    await assert.rejects(
      prepareUnifiedVideoAssemblyInputs(admitted.slug, 'EP001', { post_audio: { ...POST_AUDIO } } as any),
      /No Scene Plan timeline was found/,
    )
    assert.equal(await readSelectedMergedAudio(admitted.mergedDir), null, 'admission re-mixes nothing: the render does')

    await fs.rm(path.join(admitted.mergedDir, 'EP001_merged_audio.completion.json'), { force: true })
    await assert.rejects(
      prepareUnifiedVideoAssemblyInputs(admitted.slug, 'EP001', { post_audio: { ...POST_AUDIO } } as any),
      /re-mix the audio to add the 25 s closing/,
    )
  })
})

const mergeJob = (slug: string, params: any): any => ({
  job_id: `merge-${Math.random().toString(36).slice(2)}`, project_slug: slug, type: 'audio_merge', episode_id: 'EP001',
  title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(), started_at: null, finished_at: null,
  error: null, output_lines: [], params,
})
const postAudioReq = (basePath: string): any => ({ merged_audio_path: basePath, post_audio: { ...POST_AUDIO } })

describe('a re-mix that was interrupted is recovered, never refused forever', () => {
  /** The process dies here: the record already names the new track, nothing is pinned. */
  async function crashAfterMerge(ep: Awaited<ReturnType<typeof oldMergeEpisode>>) {
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'remix')
    await beginClosingTailRemix(verdict as any)
    await generateAudioMerge(mergeJob(ep.slug, (verdict as any).params))
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), null, 'the fixture really died before the pin')
  }

  test('a complete new track is adopted and pinned, and no second one is made', async () => {
    const ep = await oldMergeEpisode()
    await crashAfterMerge(ep)
    assert.equal((await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })).action, 'recover',
      'after the restart the decision is to finish the interrupted re-mix, not a refusal')
    const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, ep.job)
    assert.equal(after.merged_audio[0]!.filename, 'EP001_merged_audio_v2.mp3')
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), 'EP001_merged_audio_v2.mp3')
    const files = await fs.readdir(ep.mergedDir)
    assert.ok(!files.some(file => file.includes('_v3')), 'the finished track was kept, not re-made')
    assert.ok(!files.some(file => file.includes('remix-intent')), 'the interrupted-work note is gone')
    assert.match(ep.job.output_lines.join('\n'), /interrupted/i)
  })

  test('a stop right after the record names its predecessor is finished at the render, not skipped', async () => {
    const ep = await oldMergeEpisode()
    await crashAfterMerge(ep)
    // pinRemix wrote `closing_tail_remix_of` and the process died before the pin and before dropping the note.
    const recordPath = path.join(ep.mergedDir, 'EP001_merged_audio.completion.json')
    const record = JSON.parse(await fs.readFile(recordPath, 'utf-8'))
    await fs.writeFile(recordPath, JSON.stringify({ ...record, closing_tail_remix_of: 'EP001_merged_audio.mp3' }, null, 2))
    const intentFile = path.join(ep.mergedDir, 'EP001_merged_audio.remix-intent.json')

    // Admission (no job) reports it and changes nothing.
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'recover', 'an interrupted note is never answered with `use` or `remix` before it is recovered')
    const admitted = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    assert.equal(await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), admitted, undefined), admitted)
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), null)
    await fs.access(intentFile)

    // The render finishes it: pinned, note gone, the new track used.
    const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), admitted, ep.job)
    assert.equal(after.merged_audio[0]!.filename, 'EP001_merged_audio_v2.mp3')
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), 'EP001_merged_audio_v2.mp3')
    await assert.rejects(fs.access(intentFile), 'the interrupted-work note is gone')
    assert.ok(!(await fs.readdir(ep.mergedDir)).some(file => file.includes('_v3')))
  })

  test('a half-written one is put back and the re-mix is done again', async () => {
    const ep = await oldMergeEpisode()
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    await beginClosingTailRemix(verdict as any)
    await fs.writeFile(path.join(ep.mergedDir, 'EP001_merged_audio_v2.mp3'), 'half')
    const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, ep.job)
    assert.equal(after.merged_audio[0]!.filename, 'EP001_merged_audio_v2.mp3')
    assert.equal(after.merged_audio[0]!.closing_tail_sec, TAIL_SEC, 'a real track now, not the stub')
    assert.match(ep.job.output_lines.join('\n'), /interrupted/i)
  })

  test('a new track whose narration moved is rolled back to the original', async () => {
    const ep = await oldMergeEpisode()
    const oldRecord = await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8')
    const listing = (await fs.readdir(ep.mergedDir)).sort()
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
      '-c:a', 'libmp3lame', ep.chapter])
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    await beginClosingTailRemix(verdict as any)
    await generateAudioMerge(mergeJob(ep.slug, (verdict as any).params))
    const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    await assert.rejects(guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, ep.job), /narration/)
    assert.equal(await fs.readFile(path.join(ep.mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8'), oldRecord)
    assert.deepEqual((await fs.readdir(ep.mergedDir)).sort(), listing)
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), null)
  })
})

describe('a render retried after its re-mix was pinned', () => {
  test('keeps the re-mixed track instead of refusing on the base it was accepted with', async () => {
    const ep = await oldMergeEpisode()
    const base = ep.original
    await assert.rejects(
      prepareUnifiedVideoAssemblyInputs(ep.slug, 'EP001', { merged_audio_path: base, post_audio: { ...POST_AUDIO } } as any, ep.job),
      /No Scene Plan timeline was found/,
    )
    assert.equal(await readSelectedMergedAudio(ep.mergedDir), 'EP001_merged_audio_v2.mp3')
    const listing = (await fs.readdir(ep.mergedDir)).sort()
    // The render failed later; Retry runs the same accepted params, whose captured path is still the base.
    const retry: any = { ...ep.job, output_lines: [] }
    await assert.rejects(
      prepareUnifiedVideoAssemblyInputs(ep.slug, 'EP001', { merged_audio_path: base, post_audio: { ...POST_AUDIO } } as any, retry),
      /No Scene Plan timeline was found/,
      'Retry reaches the Scene Plan; it is not refused as an unrecorded merge',
    )
    assert.deepEqual((await fs.readdir(ep.mergedDir)).sort(), listing, 'nothing was re-made')
    const req: any = postAudioReq(base)
    const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    const used = await guardClosingTail(ep.slug, 'EP001', req, assets, retry)
    assert.equal(used.merged_audio[0]!.filename, 'EP001_merged_audio_v2.mp3')
    assert.equal(req.merged_audio_path, used.merged_audio[0]!.path)
  })
})

describe('the re-mix of one episode runs one at a time', () => {
  test('two renders asking at once make one new track and both use it', async () => {
    const ep = await oldMergeEpisode()
    const jobs = [{ ...ep.job, job_id: 'va-a', output_lines: [] }, { ...ep.job, job_id: 'va-b', output_lines: [] }]
    const results = await Promise.all(jobs.map(async job => {
      const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
      return guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, job)
    }))
    assert.deepEqual(results.map(r => r.merged_audio[0]!.filename), ['EP001_merged_audio_v2.mp3', 'EP001_merged_audio_v2.mp3'])
    const files = await fs.readdir(ep.mergedDir)
    assert.ok(!files.some(file => file.includes('_v3')), `a second re-mix was made: ${files.join(', ')}`)
    assert.equal(jobs.filter(job => /re-mixing the audio/.test(job.output_lines.join('\n'))).length, 1, 'only one of them mixed')
  })
})

describe('a re-mix keeps what the original merge recorded', () => {
  const lines = (job: any) => job.output_lines.join('\n')

  test("the episode's own music track, gap and opening are reused; the pool is not touched", async () => {
    const ep = await oldMergeEpisode()
    const projectDir = pm.getProjectDir(ep.slug)!
    await fs.mkdir(path.join(projectDir, 'music'), { recursive: true })
    for (const [name, hz] of [['A.mp3', 220], ['B.mp3', 330]] as const) {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`,
        '-c:a', 'libmp3lame', path.join(projectDir, 'music', name)])
    }
    const log = [{ filename: 'A.mp3', episode_code: 'EP001', used_at: '2026-10-01T00:00:00.000Z' }]
    const cfg0 = await pm.getConfig(ep.slug)
    // Since the first merge: the preset moved to the pool, A was switched off, and the lead-in changed.
    await pm.updateConfig(ep.slug, {
      music_pool_strategy: 'sequential', music_pool_cursor: 1, music_pool_usage_log: log,
      music_pool_tracks: [{ filename: 'A.mp3', enabled: false }],
      audio_merge_presets: [{
        id: 'merge-1', name: 'Mix',
        data: { music: { enabled: true, source: 'pool', files: [], volume: 50, post_narration_volume: 60, fade_in: 0, fade_out: 0, lead_in_enabled: true, lead_in_seconds: 3 }, gap_duration: 2, normalize_volume: false },
      }],
    } as any)
    void cfg0
    // The old merge recorded a 7 s gap between chapters.
    const sidecarPath = path.join(ep.mergedDir, '..', 'audio_chapters.json')
    const episodeDir = path.dirname(ep.mergedDir)
    const chapters = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf-8'))
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({ ...chapters, gap_duration_s: 7 }))
    void sidecarPath

    const verdict: any = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'remix')
    assert.equal(path.basename(verdict.params.music.files[0]), 'A.mp3', "the episode's own track, not the pool's next pick")
    assert.equal(verdict.params.music.source, 'manual', 'so the merge does not pick again')
    assert.equal(verdict.params.gap_duration, 7)
    assert.equal(verdict.params.music.lead_in_seconds, LEAD_IN_SEC, 'the lead-in the first merge recorded, not the preset as it is now')

    const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, ep.job)
    near(after.merged_audio[0]!.opening?.lead_in_sec, LEAD_IN_SEC, 0.4)
    const text = lines(ep.job)
    assert.match(text, /music: A\.mp3.*recorded/i)
    assert.match(text, /gap between chapters: 7 s.*recorded/i)
    assert.match(text, /lead-in: 8 s.*recorded/i)
    assert.match(text, /loudness target: not recorded, so the current Audio Assembly and Video Assembly presets apply/i)
    const cfg = await pm.getConfig(ep.slug)
    assert.equal(cfg!.music_pool_cursor, 1)
    assert.deepEqual(cfg!.music_pool_usage_log, log)
  })

  test('a saved closing longer than the one asked for is cut to the one asked for', async () => {
    const ep = await oldMergeEpisode({ savedTail: 40 })
    const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, ep.job)
    near(after.merged_audio[0]!.closing_tail_sec, TAIL_SEC, 0.3)
  })
})

describe('a re-mix and a standalone Audio Assembly of the same episode never run together', () => {
  const queuedMerge = (ep: Awaited<ReturnType<typeof oldMergeEpisode>>, chapters: string[] = []) => jq.enqueue({
    project_slug: ep.slug, type: 'audio_merge', episode_id: 'EP001', title: 'Audio Assembly',
    params: { episode_id: 'EP001', chapters, gap_duration: 0, normalize_volume: false },
  })

  test('a render does not re-mix while an Audio Assembly is queued or running; it says why and changes nothing', async () => {
    const ep = await oldMergeEpisode()
    const listing = (await fs.readdir(ep.mergedDir)).sort()
    await jq.setQueuePaused(true)
    const merge = await queuedMerge(ep)
    try {
      const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
      await assert.rejects(
        guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, ep.job),
        /Audio Assembly of EP001 is queued or running.*closing-tail re-mix/s,
      )
      assert.deepEqual((await fs.readdir(ep.mergedDir)).sort(), listing, 'nothing was written')
      assert.equal(await readSelectedMergedAudio(ep.mergedDir), null)
    } finally {
      await jq.requestJobCancellation(ep.slug, merge.job_id)
      await jq.setQueuePaused(false)
    }
    // Once that Audio Assembly is gone the same render goes ahead.
    const assets = await scanEpisodeAssets(ep.slug, 'EP001', { preferredMergedFilename: 'EP001_merged_audio.mp3' })
    const after = await guardClosingTail(ep.slug, 'EP001', postAudioReq(ep.original), assets, { ...ep.job, output_lines: [] })
    assert.equal(after.merged_audio[0]!.filename, 'EP001_merged_audio_v2.mp3')
  })

  test('an Audio Assembly is refused while a re-mix of that episode is in progress, and not after', async () => {
    const ep = await oldMergeEpisode()
    const claim = await claimClosingTailRemix(ep.slug, 'EP001')
    assert.ok('release' in claim)
    await jq.setQueuePaused(true)
    try {
      await assert.rejects(queuedMerge(ep), (error: any) => error.statusCode === 409 && /closing-tail re-mix.*in progress/i.test(error.message))
      // Anything that gets as far as the executor (a resumed or retried job) is refused there too.
      await assert.rejects(generateAudioMerge(mergeJob(ep.slug, { episode_id: 'EP001', chapters: [], gap_duration: 0 })), /closing-tail re-mix.*in progress/i)
      ;(claim as any).release()
      const allowed = await queuedMerge(ep)
      await jq.requestJobCancellation(ep.slug, allowed.job_id)
    } finally {
      await jq.setQueuePaused(false)
    }
  })
})
