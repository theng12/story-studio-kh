/**
 * Episode Builder end to end, with real FFmpeg and no provider: a music channel draws
 * songs from its pool (and a second channel's pool), stitches them with a crossfade at
 * the loudness target, writes the tracklist and a Scene Plan, and Video Assembly then
 * accepts it as an ordinary Scene Plan episode — with no narration and no subtitles.
 * Plays are recorded only after the render, in the pool each song came from.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

const ffmpeg = (...args: string[]) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
  assert.equal(r.status, 0, r.stderr?.toString())
}
const seconds = (f: string) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString())

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: any
let slug = ''
let pianoSlug = ''
let code = ''

async function musicChannel(name: string, poolId: string, songs: Array<{ id: string; hz: number; db: number; mood: string; bpm: number; scene_idea: string }>) {
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name, episode_prefix: 'CE', episode_digits: 4 } as any)
  const dir = pm.getProjectDir(project.slug)!
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'))
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...meta, niche_id: 'music-mix' }, null, 2))
  const lib = path.join(dir, 'music-library')
  await fs.mkdir(lib, { recursive: true })
  for (const song of songs) {
    ffmpeg('-f', 'lavfi', '-i', `sine=f=${song.hz}:d=21:r=44100`, '-af', `volume=${song.db}dB`, '-ac', '2', '-c:a', 'aac', '-b:a', '128k', path.join(lib, `${song.id}.m4a`))
  }
  await fs.writeFile(path.join(lib, 'library.json'), JSON.stringify({
    schema: 'story-studio.song-pool', version: 1, pool_id: poolId, name, project_slug: project.slug,
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z',
    songs: songs.map(song => ({
      id: song.id, file: `${song.id}.m4a`, status: 'ready', enabled: true, title: `Title ${song.id}`,
      mood: song.mood, tempo_bpm: song.bpm, scene_idea: song.scene_idea, tags: [], source: 'generated',
      created_at: '2026-10-03T00:00:00Z', duration_s: 21, rating: null, episodes: [],
    })),
  }, null, 2))
  return project.slug
}

describe('Episode Builder', () => {
  before(async () => {
    tmp = await useTempDataDir()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    app = (await import('../app.js')).app
    slug = await musicChannel('Cello Evenings', 'pool_cello', [
      { id: 's_a', hz: 330, db: -6, mood: 'tender', bpm: 60, scene_idea: 'A lamp-lit cabin window in snow' },
      { id: 's_b', hz: 440, db: -20, mood: 'tender', bpm: 64, scene_idea: 'Lanterns along a frozen pier' },
      { id: 's_c', hz: 550, db: -12, mood: 'hopeful', bpm: 70, scene_idea: 'A kettle steaming on an old stove' },
    ])
    pianoSlug = await musicChannel('Piano Nights', 'pool_piano', [
      { id: 'p_a', hz: 262, db: -10, mood: 'tender', bpm: 62, scene_idea: 'Moonlight on a quiet lake' },
    ])
  })
  after(async () => { await tmp.cleanup() })

  test('a music formula switches the sidebar to the music flow', async () => {
    const res = await request(app).get(`/api/projects/${slug}/effective-format`)
    assert.equal(res.status, 200)
    assert.equal(res.body.musicChannel, true)
  })

  test('a new episode, then a first draw from two pools to the target length', async () => {
    const created = await request(app).post(`/api/projects/${slug}/music-episodes`).send({ title: 'Snowy Cabin Evenings' })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    code = created.body.code
    assert.match(code, /^CE\d{4}$/)

    const list = await request(app).get(`/api/projects/${slug}/music-episodes`)
    assert.equal(list.body.music_channel, true)
    assert.deepEqual(list.body.pools.map((p: any) => p.pool_id).sort(), ['pool_cello', 'pool_piano'])

    const drawn = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/draw`).send({
      settings: {
        pools: ['pool_cello', 'pool_piano'], target_length_s: 70, order: 'manual',
        join: { style: 'crossfade', seconds: 1 }, theme: 'Cosy',
      },
    })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(drawn.body.songs.length, 4, 'fills 70 s from four 21 s songs (with 1 s crossfades) across both pools')
    assert.equal(drawn.body.draw.shortfall_sec, 0)
    assert.ok(drawn.body.songs.some((s: any) => s.pool_id === 'pool_piano'))
    assert.equal(drawn.body.scenes.length, 4, 'one scene per song is the starting value')
    assert.equal(drawn.body.total_sec, 81)
    for (const scene of drawn.body.scenes) {
      assert.match(scene.prompt, /Cosy mood, no people, no text$/)
      assert.equal(scene.image, 'missing')
    }
  })

  test('the derived Scene Plan is ordinary, contiguous and needs no subtitles', async () => {
    const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js')
    const paths = await resolveEpisodePathsByCode(slug, code)
    const plan = JSON.parse(await fs.readFile(await resolveScenePlanPath(slug, code, paths.episode_dir), 'utf8'))
    assert.equal(plan.scenes.length, 4)
    assert.equal(plan.scenes[0].start_sec, 0)
    for (let i = 1; i < plan.scenes.length; i++) assert.equal(plan.scenes[i].start_sec, plan.scenes[i - 1].end_sec)
    assert.equal(plan.scenes.at(-1).end_sec, plan.total_duration_sec)
    const { assertSubtitleTimelineComplete } = await import('../services/scene-timeline-integrity.js')
    await assertSubtitleTimelineComplete(paths.subtitles_dir, code, { episodeDir: paths.episode_dir, audioDir: paths.audio_dir })
  })

  test('reorder, lock and a fixed scene count are saved; pictures follow their song', async () => {
    const view = (await request(app).get(`/api/projects/${slug}/music-episodes/${code}`)).body
    const reversed = [...view.songs].reverse().map((s: any, i: number) => ({ pool_id: s.pool_id, song_id: s.id, locked: i === 0 }))
    const saved = await request(app).put(`/api/projects/${slug}/music-episodes/${code}`).send({
      songs: reversed, settings: { scenes: { mode: 'count', count: 2 } },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.scenes.length, 2)
    assert.equal(saved.body.songs[0].locked, true)
    assert.equal(saved.body.songs[0].id, view.songs.at(-1).id)

    const dupe = await request(app).put(`/api/projects/${slug}/music-episodes/${code}`).send({ songs: [reversed[0], reversed[0]] })
    assert.equal(dupe.status, 400)
    // back to one scene per song for the rest of the run
    await request(app).put(`/api/projects/${slug}/music-episodes/${code}`).send({ settings: { scenes: { mode: 'per-song' } } })
  })

  test('re-draw keeps the locked song; swap offers free songs only', async () => {
    const before = (await request(app).get(`/api/projects/${slug}/music-episodes/${code}`)).body
    const redrawn = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/draw`).send({})
    assert.equal(redrawn.status, 200)
    assert.equal(redrawn.body.songs[0].song_key, before.songs[0].song_key)
    assert.equal(redrawn.body.doc.draw_round, before.doc.draw_round + 1)
    const swap = await request(app).get(`/api/projects/${slug}/music-episodes/${code}/swap`).query({ song_key: before.songs[1].song_key })
    assert.equal(swap.status, 200)
    const inEpisode = new Set(redrawn.body.songs.map((s: any) => s.song_key))
    assert.ok(swap.body.candidates.every((c: any) => !inEpisode.has(c.song_key)))
  })

  test('the stitch: crossfaded, evened to the target, tracklist from measured lengths', async () => {
    const { generateMusicEpisodeBuild } = await import('../generators/music-episode-build.js')
    const job: any = { job_id: 'test-build', project_slug: slug, episode_id: code, params: { episode_id: code }, output_lines: [], progress: 0 }
    await generateMusicEpisodeBuild(job)
    const merged = job.result.merged_audio as string
    assert.match(path.basename(merged), new RegExp(`^${code}_merged_audio\\.m4a$`))
    assert.ok(Math.abs(seconds(merged) - 81) < 0.5, `mix length ${seconds(merged)}`)
    const tracklist = await fs.readFile(job.result.tracklist, 'utf8')
    assert.deepEqual(tracklist.trim().split('\n').map(line => line.split(' ')[0]), ['0:00', '0:20', '0:40', '1:00'])
    assert.ok(job.output_lines.some((l: string) => /Measured "Title /.test(l)), 'songs with no stored loudness are measured')
    const mixLine = job.output_lines.find((l: string) => l.startsWith('Mix:'))
    const lufs = Number(/(-?\d+\.\d) LUFS/.exec(mixLine)?.[1])
    assert.ok(Math.abs(lufs - -14) < 1.5, `mix loudness ${mixLine}`)
  })

  test('Video Assembly accepts the music episode once every scene has a kept picture', async () => {
    const view = (await request(app).get(`/api/projects/${slug}/music-episodes/${code}`)).body
    const blocked = await request(app).post(`/api/projects/${slug}/generate/video-assembly`).send({ episode_id: code })
    assert.equal(blocked.status, 409)
    assert.match(blocked.body.detail, /missing image/i)

    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const imagesDir = await resolveSceneImagesDir(slug, code, (await resolveEpisodePathsByCode(slug, code)).episode_dir)
    await fs.mkdir(imagesDir, { recursive: true })
    for (const scene of view.scenes) {
      ffmpeg('-f', 'lavfi', '-i', 'color=c=0x334455:s=1280x720', '-frames:v', '1', path.join(imagesDir, `${scene.id}.png`))
      const kept = await request(app).post(`/api/projects/${slug}/music-episodes/${code}/scenes/${scene.id}/keep`)
      assert.equal(kept.status, 200, JSON.stringify(kept.body))
    }
    const after = (await request(app).get(`/api/projects/${slug}/music-episodes/${code}`)).body
    assert.ok(after.scenes.every((s: any) => s.image === 'ready' && s.approved))

    const { scanEpisodeAssets } = await import('../generators/video.js')
    const assets = await scanEpisodeAssets(slug, code)
    assert.equal(assets.music_episode?.frame_rate, 24)
    assert.equal(assets.music_episode?.resolution, '720p')
    assert.equal(assets.scene_plan_timing?.complete, true)
    assert.match(assets.merged_audio[0]!.filename, /_merged_audio\.m4a$/)

    const queued = await request(app).post(`/api/projects/${slug}/generate/video-assembly`).send({
      episode_id: code, subtitles: { enabled: false },
    })
    assert.equal(queued.status, 201, JSON.stringify(queued.body))
    // Let the real render run: existing Video Assembly (camera move + crossfades) on a music episode.
    const jq = await import('../services/job-queue.js')
    await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(queued.body.job_id)?.status || ''), {
      label: 'the music episode render', timeoutMs: 150_000, maxWallClockMs: 150_000, pollMs: 250,
    })
    const job = jq.getJob(queued.body.job_id)
    assert.equal(job?.status, 'done', (job?.output_lines || []).slice(-15).join('\n') + (job?.error || ''))
    assert.ok(job!.output_lines.some(line => /Song plays recorded: \d+ new/.test(line)), 'the render records plays')
  })

  test('plays are recorded after a render, once, in the pool each song came from', async () => {
    const { recordRenderedMusicEpisode, readEpisodeDoc } = await import('../services/music-episode-store.js')
    const lines: string[] = []
    await recordRenderedMusicEpisode(slug, code, line => lines.push(line))
    assert.match(lines[0]!, /recorded: 0 new/, 'the render already recorded them; recording again adds nothing')
    const doc = (await readEpisodeDoc(slug, code))!
    const pm = await import('../services/project-manager.js')
    for (const [owner, poolId] of [[slug, 'pool_cello'], [pianoSlug, 'pool_piano']] as const) {
      const pool = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(owner)!, 'music-library', 'library.json'), 'utf8'))
      for (const ref of doc.songs.filter(r => r.pool_id === poolId)) {
        const song = pool.songs.find((s: any) => s.id === ref.song_id)
        assert.deepEqual(song.episodes.map((e: any) => [e.code, e.project_slug]), [[code, slug]])
      }
    }
  })

  test('the next episode cannot reuse those songs inside the window, and says how many are free', async () => {
    const next = (await request(app).post(`/api/projects/${slug}/music-episodes`).send({ title: 'Next' })).body.code
    const drawn = await request(app).post(`/api/projects/${slug}/music-episodes/${next}/draw`).send({
      settings: { pools: ['pool_cello', 'pool_piano'], target_length_s: 70, no_repeat_episodes: 5 },
    })
    assert.equal(drawn.status, 200)
    assert.equal(drawn.body.songs.length, 0, 'all four songs were in the last episode')
    assert.equal(drawn.body.draw.shortfall_sec, 70)
    assert.equal(drawn.body.draw.songs_missing, 4)
    assert.equal(drawn.body.shortfall_sec, 70, 'the view itself carries the shortfall, so it survives a reload')
    assert.equal(drawn.body.songs_missing, 4)
    assert.deepEqual(drawn.body.window_codes, [code])

    const open = await request(app).post(`/api/projects/${slug}/music-episodes/${next}/draw`).send({ settings: { no_repeat_episodes: 0 } })
    assert.equal(open.body.songs.length, 4, 'window 0 = repeats allowed')
    assert.ok(existsSync(path.join(tmp.dir, 'projects', slug, 'music-episodes.json')))
  })
})
