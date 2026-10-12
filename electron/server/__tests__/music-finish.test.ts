/**
 * Music format phase 4 ("finish"): YouTube chapters from the tracklist and music metadata context,
 * music-aware status (Board / selectors / Pipeline skip), the Pipeline music chain, thumbnails
 * from a scene, the Image Pool stills window, scene-prompt polish and the upscale sharpening.
 * Real FFmpeg, no provider: nothing here spends anything.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

const ffmpeg = (...args: string[]) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
  assert.equal(r.status, 0, r.stderr?.toString())
}
const size = (f: string) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).stdout.toString().trim()

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: any
let slug = ''
let code = ''

async function musicChannel(name: string, poolId: string, ids: string[]) {
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name, episode_prefix: 'MF', episode_digits: 4 } as any)
  const dir = pm.getProjectDir(project.slug)!
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'))
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    ...meta,
    niche_id: 'music-mix',
    niche_overrides: {
      musicFormat: {
        songFormula: { ensembles: [{ value: 'Solo cello', weight: 50 }, { value: 'Harp', weight: 0 }], moods: [{ value: 'Tender', weight: 1 }], never: ['vocals'] },
        episodeDefaults: { target_length_s: 60, join: { style: 'crossfade', seconds: 1 }, scene_themes: ['Snowy'] },
      },
    },
  }, null, 2))
  const lib = path.join(dir, 'music-library')
  await fs.mkdir(lib, { recursive: true })
  for (const [i, id] of ids.entries()) {
    ffmpeg('-f', 'lavfi', '-i', `sine=f=${300 + i * 60}:d=21:r=44100`, '-ac', '2', '-c:a', 'aac', '-b:a', '128k', path.join(lib, `${id}.m4a`))
  }
  await fs.writeFile(path.join(lib, 'library.json'), JSON.stringify({
    schema: 'story-studio.song-pool', version: 1, pool_id: poolId, name, project_slug: project.slug,
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z',
    songs: ids.map((id, i) => ({
      id, file: `${id}.m4a`, status: 'ready', enabled: true, title: `Song ${id}`, mood: 'Tender', tempo_bpm: 60 + i,
      scene_idea: `A lamp-lit cabin window number ${i}`, tags: [], source: 'generated',
      created_at: '2026-10-03T00:00:00Z', duration_s: 21, lufs: -14, rating: null, episodes: [],
    })),
  }, null, 2))
  return project.slug
}

async function newEpisode(title: string): Promise<string> {
  const res = await request(app).post(`/api/projects/${slug}/music-episodes`).send({ title })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.code
}

async function episodeRow(code: string) {
  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
  episodeStatusCache.invalidate(slug, code)
  const res = await request(app).get(`/api/projects/${slug}/episodes`)
  const list = Array.isArray(res.body) ? res.body : res.body.episodes
  return list.find((e: any) => e.episode_code === code)
}

async function sceneImagesDir(episode: string): Promise<string> {
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  return resolveSceneImagesDir(slug, episode, (await resolveEpisodePathsByCode(slug, episode)).episode_dir)
}

describe('YouTube chapters from a tracklist (pure)', () => {
  test('first chapter at 0:00, at least three, each at least 10 s', async () => {
    const { chaptersFromTracklist } = await import('../services/youtube-metadata-finalizer.js')
    const ok = chaptersFromTracklist('0:00 Alpha\n3:40 Beta\n1:02:03 Gamma\n', 3800)
    assert.deepEqual(ok.chapters.map(c => [c.title, c.start_sec]), [['Alpha', 0], ['Beta', 220], ['Gamma', 3723]])
    assert.deepEqual(ok.dropped, [])
    // A song that starts under 10 s after the last kept chapter shares it; so does one under 10 s from the end.
    const tight = chaptersFromTracklist('0:01 A\n0:05 B\n0:30 C\n1:00 D\n1:55 E', 120)
    assert.equal(tight.chapters[0]!.start_sec, 0, 'the first chapter is pinned to 0:00')
    assert.deepEqual(tight.chapters.map(c => c.title), ['A', 'C', 'D'])
    assert.deepEqual(tight.dropped, ['B', 'E'])
    assert.equal(chaptersFromTracklist('not a tracklist').chapters.length, 0)
  })
})

describe('Music format phase 4', () => {
  before(async () => {
    tmp = await useTempDataDir()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    app = (await import('../app.js')).app
    slug = await musicChannel('Cello Finish', 'pool_finish', ['s_1', 's_2', 's_3', 's_4', 's_5', 's_6'])
    // 1.4.300 — these tests pin the Pipeline start stops, i.e. those safety checks on Block.
    const pm = await import('../services/project-manager.js')
    await pm.updateConfig(slug, { safety_checks: { step_fits_channel: 'block', step_preset: 'block', earlier_step_done: 'block' } } as any)
    code = await newEpisode('Snowy Cabin Evenings')
  })
  after(async () => { await tmp.cleanup() })

  test('status before anything: a music episode carries music_episode=false and no narration verdict', async () => {
    const row = await episodeRow(code)
    assert.equal(row.status.music_episode, false)
    assert.equal(row.status.all_done, false)
  })

  test('Pipeline music chain: run-batch draws and stitches an undrawn episode (music_build), never a narration step', async () => {
    const wrong = await request(app).post(`/api/projects/${slug}/pipeline/preflight`).send({ episode_ids: [code], steps: ['audio'] })
    assert.equal(wrong.status, 422)
    assert.match(JSON.stringify(wrong.body.issues), /not part of a music channel/)

    const needsPictures = await request(app).post(`/api/projects/${slug}/pipeline/preflight`).send({ episode_ids: [code], steps: ['music_build', 'video_assembly'] })
    assert.equal(needsPictures.status, 422)
    assert.deepEqual(needsPictures.body.issues.map((i: any) => [i.step, i.requires]), [['video_assembly', 'scene_review']])
    const noPictures = await request(app).post(`/api/projects/${slug}/pipeline/preflight`).send({ episode_ids: [code], steps: ['music_build', 'scene_review'] })
    assert.equal(noPictures.status, 422)
    assert.match(JSON.stringify(noPictures.body.issues), /Open Episode Builder, pick the image model under Scene pictures and save a Pictures preset/)
    const pre = await request(app).post(`/api/projects/${slug}/pipeline/preflight`).send({ episode_ids: [code], steps: ['music_build'] })
    assert.equal(pre.status, 200, JSON.stringify(pre.body))

    const run = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`).send({ episode_ids: [code], steps: ['music_build'] })
    assert.equal(run.status, 201, JSON.stringify(run.body))
    assert.equal(run.body.jobs[0].type, 'music_episode_build')
    const jq = await import('../services/job-queue.js')
    const id = run.body.jobs[0].job_id
    await waitFor(() => ['done', 'error'].includes(jq.getJob(id)?.status || ''), { label: 'pipeline music build', timeoutMs: 60_000, maxWallClockMs: 60_000, pollMs: 200 })
    const job = jq.getJob(id)!
    assert.equal(job.status, 'done', job.output_lines.join('\n') + (job.error || ''))
    assert.ok(job.output_lines.some(line => /^Drew 3 song\(s\)/.test(line)), job.output_lines.join('\n'))

    const row = await episodeRow(code)
    assert.equal(row.status.music_episode, true, 'the stitch is current')
    assert.equal(row.status.scene_plan, true, 'a music Scene Plan needs no subtitle timeline')
    assert.equal(row.status.subtitles, false)
    const again = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`).send({ episode_ids: [code], steps: ['music_build'] })
    assert.deepEqual(again.body.steps_skipped_as_done, [{ episode_id: code, step: 'music_build' }], 'a current stitch is not redone')
  })

  test('a short pool fails the Pipeline draw plainly and stitches nothing', async () => {
    const short = await newEpisode('Too Long')
    await request(app).put(`/api/projects/${slug}/music-episodes/${short}`).send({ settings: { target_length_s: 3600, no_repeat_episodes: 0 } })
    const { generateMusicEpisodeBuild } = await import('../generators/music-episode-build.js')
    const job: any = { job_id: 'short', project_slug: slug, episode_id: short, params: { episode_id: short, draw_if_empty: true }, output_lines: [], progress: 0 }
    await assert.rejects(generateMusicEpisodeBuild(job), /about \d+ more are needed.*Song Pool.*Nothing was drawn or stitched/)
    const { readEpisodeDoc } = await import('../services/music-episode-store.js')
    assert.equal((await readEpisodeDoc(slug, short))?.songs.length ?? 0, 0)
  })

  test('Pipeline music prerequisites and continuation: a failed thumbnail never holds back the Finalizer', async () => {
    const { prerequisitesForStep, stampPipelineStepFacts, MUSIC_STEPS } = await import('../routes/pipeline.js')
    const { splitChainAfterFailure } = await import('../lib/pipeline-continuation.js')
    assert.deepEqual([...MUSIC_STEPS], ['music_build', 'scene_review', 'video_assembly', 'thumb_images', 'metadata'])
    assert.deepEqual(prerequisitesForStep('video_assembly', false, true), ['scene_review', 'music_build'])
    assert.deepEqual(prerequisitesForStep('metadata', false, true), ['music_build'])
    assert.deepEqual(prerequisitesForStep('metadata'), ['script-only', 'audio_merge'], 'narration channels keep their own')
    const chain: Array<{ type: string; params: Record<string, any> }> = [
      { type: 'continuity_render', params: {} },
      { type: 'video_assembly', params: {} },
      { type: 'thumb_images', params: {} },
      { type: 'metadata', params: {} },
    ]
    stampPipelineStepFacts(chain, 'scene_plan', true)
    assert.deepEqual(chain[1]!.params.pipeline_requires, ['scene_review', 'music_build'])
    const afterThumb = splitChainAfterFailure('thumb_images', chain.slice(3))!
    assert.deepEqual(afterThumb.survivors.map(l => l.type), ['metadata'])
    const afterScenes = splitChainAfterFailure('scene_review', chain.slice(1))!
    assert.deepEqual(afterScenes.waiting.map(l => l.type), ['video_assembly'])
    assert.deepEqual(afterScenes.survivors.map(l => l.type), ['thumb_images', 'metadata'])
  })

  test('Pipeline music step params: pictures approved as they arrive, the render uses the episode music settings', async () => {
    const { musicEpisodeStepParams, flattenVideoAssemblyBundle } = await import('../routes/pipeline.js')
    const scenes = await musicEpisodeStepParams(slug, code, 'scene_review', { model: 'm', auto_approve_generated: false })
    assert.equal(('params' in scenes) && scenes.params.auto_approve_generated, true)
    await request(app).put(`/api/projects/${slug}/music-episodes/${code}`).send({ settings: { resolution: '1080p', upscale_sharpen: 'light', frame_rate: 30 } })
    const base = flattenVideoAssemblyBundle({
      fallback: {
        export: { resolution: '720p', fps: 24, video_bitrate_kbps: 8000 },
        subtitles: { enabled: true, source: 'srt' },
        effects: { logo: { enabled: true, image_path: '/x.png', opacity: 50, scale: 20 } },
        intro: { enabled: true, video_path: '/intro.mp4' },
      },
    }, code, 'T')
    assert.equal(base.video_bitrate_kbps, 8000, 'the bitrate cap now survives a batch render')
    const va = await musicEpisodeStepParams(slug, code, 'video_assembly', base)
    assert.ok('params' in va)
    const p = (va as any).params
    assert.equal(p.resolution, '1080p')
    assert.equal(p.fps, 30)
    assert.equal(p.upscale_sharpen, 'light')
    assert.equal(p.video_bitrate_kbps, 5000)
    assert.equal(p.encoding_effort, 'hardware')
    assert.equal(p.subtitles, undefined)
    assert.equal(p.intro, undefined)
    assert.ok(p.logo, "the owner's look stays")
    await request(app).put(`/api/projects/${slug}/music-episodes/${code}`).send({ settings: { resolution: '720p', frame_rate: 24 } })
  })

  test('YouTube Finalizer: chapters from the tracklist; no narration, subtitle or research warnings', async () => {
    const status = await request(app).get(`/api/projects/${slug}/episodes/${code}/youtube-finalization-status`)
    assert.equal(status.status, 200)
    assert.equal(status.body.audio_assembly_ready, true)
    assert.equal(status.body.chapter_count, 3)
    assert.deepEqual(status.body.music_episode, { songs: 3, tracklist_ready: true })
    assert.deepEqual(status.body.warnings, [])
    const { finalizeYouTubeDescription } = await import('../services/youtube-metadata-finalizer.js')
    const result = await finalizeYouTubeDescription({ slug, episodeId: code, description: 'A calm hour of cello.' })
    assert.match(result.description, /^A calm hour of cello\.\n\n<!-- youtube:chapters:start -->\nCHAPTERS\n0:00 Song s_\d\n0:20 Song s_\d\n0:40 Song s_\d\n<!-- youtube:chapters:end -->$/)
  })

  test('Finalizer refuses a stale stitch with the Episode Builder reason, before any model call', async () => {
    const stale = await newEpisode('Stale')
    await request(app).post(`/api/projects/${slug}/music-episodes/${stale}/draw`).send({ settings: { no_repeat_episodes: 0 } })
    const gate = await request(app).post(`/api/projects/${slug}/generate/metadata`).send({ episode_id: stale, title: 'Stale', model: 'any-model' })
    assert.equal(gate.status, 409)
    assert.equal(gate.body.code, 'YOUTUBE_FINALIZER_MUSIC_STITCH_REQUIRED')
    assert.match(gate.body.detail, /not stitched yet/)
  })

  test('music metadata: the model is never picked for the owner; the context is formula + theme + tracklist', async () => {
    const { generateMetadata } = await import('../generators/metadata.js')
    const job: any = { job_id: 'meta', project_slug: slug, episode_id: code, params: { episode_id: code, title: 'Snowy Cabin Evenings' }, output_lines: [] }
    await assert.rejects(generateMetadata(job), /Pick the writing model/)
    const { musicMetadataContext } = await import('../services/music-episode-store.js')
    const context = await musicMetadataContext(slug, code)
    assert.match(context, /instrumental music episode/)
    assert.match(context, /Instruments \/ ensembles: Solo cello\./, 'a zero-weight value is left out')
    assert.match(context, /Never mention: vocals\./)
    assert.match(context, /Episode theme: Snowy\./)
    assert.match(context, /Tracklist .*do not write timestamps.*\n0:00 Song s_\d/s)
  })

  test('thumbnail from a scene picture: copied at 1280x720, pinned, and the thumbnail step reads done', async () => {
    const view = (await request(app).get(`/api/projects/${slug}/music-episodes/${code}`)).body
    const dir = await sceneImagesDir(code)
    await fs.mkdir(dir, { recursive: true })
    ffmpeg('-f', 'lavfi', '-i', 'color=c=0x446688:s=1280x720', '-frames:v', '1', path.join(dir, `${view.scenes[1].id}.png`))
    const info = await request(app).get(`/api/projects/${slug}/music-episodes/${code}/thumbnail`)
    assert.equal(info.body.music, true)
    assert.deepEqual(info.body.scenes.map((s: any) => s.has_image), [false, true, false])
    const noPicture = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/thumbnail/use-scene`).send({ scene_id: view.scenes[0].id })
    assert.equal(noPicture.status, 409)
    assert.match(noPicture.body.detail, /no picture yet/)
    const used = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/thumbnail/use-scene`).send({ scene_id: view.scenes[1].id })
    assert.equal(used.status, 200, JSON.stringify(used.body))
    assert.equal(used.body.filename, `${code}_Thumb_Scene02_v1.png`)
    assert.equal(size(used.body.path), '1280,720')
    const pinned = await request(app).get(`/api/projects/${slug}/episodes/${code}/thumbnails`)
    assert.equal(pinned.body.pinned, used.body.filename)
    assert.equal((await episodeRow(code)).status.thumbnails, true)
  })

  test('thumbnail drawn by the image model: prompts from the scene + theme carry the headline for the model to draw', async () => {
    const view = (await request(app).get(`/api/projects/${slug}/music-episodes/${code}`)).body
    const written = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/thumbnail/prompts`).send({ scene_ids: [view.scenes[2].id] })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    assert.equal(written.body.written, true)
    const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
    const parsed = await parseImagePromptsDocx(written.body.path)
    assert.equal(parsed.thumbnails.length, 1)
    const prompt = parsed.thumbnails[0]!.prompt
    assert.match(prompt, /A lamp-lit cabin window number \d/)
    assert.match(prompt, /Snowy mood/)
    assert.equal((prompt.match(/Snowy mood/g) || []).length, 1, 'the theme is said once')
    assert.match(prompt, /The headline "Snowy Cabin Evenings" printed once, large, in big clean legible letters, spelled exactly "Snowy Cabin Evenings" letter for letter, no other text/)
    assert.doesNotMatch(prompt, /Render the exact title/, 'one headline instruction, not two')
    assert.doesNotMatch(prompt, /no text/)
    const kept = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/thumbnail/prompts`).send({})
    assert.equal(kept.body.written, false, 'an existing prompt file is never overwritten unasked')
  })

  test('Image Pool stills window: a still used in a recent episode is marked and refused unless chosen on purpose', async () => {
    const pools = await import('../services/broll-pool-manager.js')
    const poolDir = path.join(tmp.dir, 'stills')
    await fs.mkdir(poolDir, { recursive: true })
    ffmpeg('-f', 'lavfi', '-i', 'color=c=0x223344:s=1280x720', '-frames:v', '1', path.join(poolDir, 'lake.png'))
    ffmpeg('-f', 'lavfi', '-i', 'color=c=0x443322:s=1280x720', '-frames:v', '1', path.join(poolDir, 'hill.png'))
    const pool = await pools.createPool({ name: 'Stills', folder_path: poolDir, media: 'image' })
    assert.equal((await request(app).post(`/api/broll-pools/${pool.id}/scan`)).status, 200)
    const first = (await request(app).get(`/api/projects/${slug}/music-episodes/${code}`)).body
    const used = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/scenes/${first.scenes[0].id}/use-still`).send({ pool_id: pool.id, filename: 'lake.png' })
    assert.equal(used.status, 200, JSON.stringify(used.body))

    const next = await newEpisode('Next With Stills')
    await request(app).post(`/api/projects/${slug}/music-episodes/${next}/draw`).send({ settings: { no_repeat_episodes: 0, still_no_repeat_episodes: 5 } })
    const listed = await request(app).get(`/api/projects/${slug}/music-episodes/${next}/stills`).query({ pool_id: pool.id })
    assert.equal(listed.body.window_episodes, 5)
    assert.deepEqual(listed.body.stills.map((s: any) => [s.filename, s.used_by]).sort(), [['hill.png', null], ['lake.png', code]])
    const nextView = (await request(app).get(`/api/projects/${slug}/music-episodes/${next}`)).body
    const refused = await request(app).post(`/api/projects/${slug}/music-episodes/${next}/scenes/${nextView.scenes[0].id}/use-still`).send({ pool_id: pool.id, filename: 'lake.png' })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'STILL_IN_WINDOW')
    const onPurpose = await request(app).post(`/api/projects/${slug}/music-episodes/${next}/scenes/${nextView.scenes[0].id}/use-still`).send({ pool_id: pool.id, filename: 'lake.png', allow_repeat: true })
    assert.equal(onPurpose.status, 200)
    await request(app).put(`/api/projects/${slug}/music-episodes/${next}`).send({ settings: { still_no_repeat_episodes: 0 } })
    const off = await request(app).get(`/api/projects/${slug}/music-episodes/${next}/stills`).query({ pool_id: pool.id })
    assert.ok(off.body.stills.every((s: any) => s.used_by === null), 'window 0 = off')
  })

  test('Polish Scene Prompts: the writing model is required at the click; answers are checked per scene', async () => {
    const missing = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/polish-prompts`).send({})
    assert.equal(missing.status, 400)
    assert.match(missing.body.detail, /Pick the writing model/)
    const { parseScenePolish, buildScenePolishPrompt, scenePolishOutputContract } = await import('../generators/music-scene-polish.js')
    const ids = ['ms-aaaaaaaaaaaa', 'ms-bbbbbbbbbbbb']
    const parsed = parseScenePolish('{"scenes":[{"id":"ms-aaaaaaaaaaaa","prompt":"  A snowy  cabin, no people, no text "},{"id":"ms-zzzzzzzzzzzz","prompt":"x"}]}', ids)
    assert.deepEqual(parsed.prompts, { 'ms-aaaaaaaaaaaa': 'A snowy cabin, no people, no text' })
    assert.deepEqual(parsed.missing, ['ms-bbbbbbbbbbbb'])
    const prompt = buildScenePolishPrompt({ theme: 'Snowy', style: 'watercolour', never: ['vocals'], scenes: [{ id: ids[0]!, prompt: 'A cabin', songs: ['Song A'] }] })
    assert.match(prompt, /Episode theme: Snowy\./)
    assert.match(prompt, /- ms-aaaaaaaaaaaa \[Song A\]: A cabin/)
    assert.equal((scenePolishOutputContract(ids) as any).schema.properties.scenes.minItems, 2)
  })
})

describe('Upscale sharpening (pure + real FFmpeg)', () => {
  test('only stills smaller than the canvas are upscaled + lightly sharpened, once each', async () => {
    const { sharpenUpscaledStills, needsUpscale, upscaleSharpenFilter } = await import('../lib/upscale-sharpen.js')
    assert.equal(needsUpscale({ width: 1280, height: 720 }, 1920, 1080), true)
    assert.equal(needsUpscale({ width: 1920, height: 1080 }, 1920, 1080), false)
    assert.match(upscaleSharpenFilter(1920, 1080), /flags=lanczos,unsharp=luma_msize_x=5.*luma_amount=0\.5.*chroma_amount=0$/)
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'sharpen-'))
    try {
      ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1', path.join(dir, 'small.png'))
      ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', path.join(dir, 'big.png'))
      const runs: string[][] = []
      const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
      const lines: string[] = []
      const out = await sharpenUpscaledStills(
        [{ image_path: path.join(dir, 'small.png') }, { image_path: path.join(dir, 'big.png') }, { image_path: path.join(dir, 'small.png') }, { image_path: '/x/clip.mp4' }],
        1920, 1080, dir, async args => { runs.push(args); return runFfmpeg(args) }, line => lines.push(line),
      )
      assert.equal(runs.length, 1, 'one pass per distinct small still')
      assert.equal(out[0]!.image_path, out[2]!.image_path)
      assert.equal(out[1]!.image_path, path.join(dir, 'big.png'))
      assert.equal(out[3]!.image_path, '/x/clip.mp4')
      assert.equal(size(out[0]!.image_path), '1920,1080')
      assert.match(lines[0]!, /1 still\(s\) upscaled to 1920x1080 with light sharpening/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('the music render settings carry the sharpening only at 1080p', async () => {
    const { musicEpisodeRenderParams, STARTING_EPISODE_SETTINGS } = await import('../services/music-episode.js')
    assert.equal(STARTING_EPISODE_SETTINGS.upscale_sharpen, 'light')
    assert.equal(musicEpisodeRenderParams({}, { ...STARTING_EPISODE_SETTINGS, resolution: '720p' }).upscale_sharpen, 'off')
    assert.equal(musicEpisodeRenderParams({}, { ...STARTING_EPISODE_SETTINGS, resolution: '1080p' }).upscale_sharpen, 'light')
    assert.equal(musicEpisodeRenderParams({}, { ...STARTING_EPISODE_SETTINGS, resolution: '1080p', upscale_sharpen: 'off' }).upscale_sharpen, 'off')
    const cut = musicEpisodeRenderParams({}, { ...STARTING_EPISODE_SETTINGS, scene_change: { transition: 'crossfade', seconds: 0 } })
    assert.equal(cut.transition, 'none')
  })

  test('the formula accepts the two new optional episode defaults and still accepts formulas without them', async () => {
    const { EpisodeDefaultsSchema, STARTING_EPISODE_DEFAULTS } = await import('../contracts/song-formula.js')
    assert.equal(EpisodeDefaultsSchema.safeParse(STARTING_EPISODE_DEFAULTS).success, true)
    const { upscale_sharpen: _u, still_no_repeat_episodes: _s, ...older } = STARTING_EPISODE_DEFAULTS
    assert.equal(EpisodeDefaultsSchema.safeParse(older).success, true)
    assert.equal(EpisodeDefaultsSchema.safeParse({ ...STARTING_EPISODE_DEFAULTS, upscale_sharpen: 'heavy' }).success, false)
    const { settingsFromEpisodeDefaults } = await import('../services/music-episode.js')
    assert.equal(settingsFromEpisodeDefaults({ still_no_repeat_episodes: 12, upscale_sharpen: 'off' }).still_no_repeat_episodes, 12)
    assert.equal(settingsFromEpisodeDefaults({}).still_no_repeat_episodes, 0)
  })
})
