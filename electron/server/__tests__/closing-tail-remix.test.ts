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
const { planClosingTailRemix } = await import('../services/closing-tail-remix.js')
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
async function oldMergeEpisode(opts: { musicOn?: boolean; savedTail?: number } = {}) {
  const musicOn = opts.musicOn !== false
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
    lead_in_enabled: true, lead_in_seconds: LEAD_IN_SEC,
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
        music: { enabled: musicOn, source: 'manual', files: [musicPath], volume: 50, post_narration_volume: 60, fade_in: 0, fade_out: 0, lead_in_enabled: true, lead_in_seconds: LEAD_IN_SEC },
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
  return { slug, mergedDir, chapter, job, merge, original: path.join(mergedDir, 'EP001_merged_audio.mp3') }
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

  test('a saved Video Assembly preset that disagrees with the request cannot bake the tail asked for', async () => {
    const ep = await oldMergeEpisode({ savedTail: 5 })
    const verdict = await planClosingTailRemix({ slug: ep.slug, code: 'EP001', postAudio: POST_AUDIO })
    assert.equal(verdict.action, 'refuse')
    assert.match((verdict as any).reason, WORDING)
    assert.match((verdict as any).reason, /Save the Video Assembly preset/)
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
