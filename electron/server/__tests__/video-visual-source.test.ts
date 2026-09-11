import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { buildImagePoolPlayOrder, readVideoVisualSource, resolveImagePoolSelection, writeVideoAssemblySourceStamp } from '../services/video-visual-source.js'
import { getSelectionSidecar, saveSelectionSidecar } from '../services/broll-selection-sidecar.js'
import { resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
const SLUG = 'visual-source-contract'
const EPISODE = 'EP0001'
const IMAGE_HASH = '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d'

async function seedImagePoolEpisode(slug: string, selection: unknown[] = [{ filename: 'one.png', sha256: IMAGE_HASH, target_duration: 4 }]) {
  const projectDir = path.join(tmp.dir, 'projects', slug)
  const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${EPISODE} - Pool`)
  const poolDir = path.join(tmp.dir, `${slug}-image-pool`)
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.mkdir(poolDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug, name: 'Pool Episode', episode_prefix: 'EP', season_size: 20,
    season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'i1', title: 'Pool', status: 'accepted', episode_code: EPISODE }],
    next_episode_number: 2, recycled_numbers: [],
  }))
  await fs.writeFile(path.join(poolDir, 'one.png'), 'image')
  await fs.writeFile(path.join(tmp.dir, 'broll-pools.json'), JSON.stringify({ schema_version: 1, pools: [{
    id: 'images', name: 'Images', folder_path: poolDir, media: 'image', auto_normalize: false,
    fps_target: 24, resolution_target: '1920x1080', created_at: new Date().toISOString(),
  }] }))
  await fs.writeFile(path.join(poolDir, '.story-studio-broll.json'), JSON.stringify({ schema_version: 1, pool_name: 'Images', clips: {
    'one.png': { filename: 'one.png', duration: 0, width: 1, height: 1, fps: 1, size_bytes: 5, sha256: IMAGE_HASH, normalized: false, tags: [], indexed_at: new Date().toISOString() },
  } }))
  await fs.writeFile(path.join(episodeDir, 'broll-selection.json'), JSON.stringify({
    schema_version: 1, episode_code: EPISODE, pool_id: 'images', source: 'image_pool', media: 'image', selection_mode: 'random',
    pacing_mode: 'timed', segment_seconds: 4, broll_volume: 0, selection,
    target_duration: 4, generated_at: 'now', warnings: [],
  }))
  return { projectDir, episodeDir, poolDir }
}

describe('Video Assembly visual source', () => {
  before(async () => {
    tmp = await useTempDataDir()
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('expands a frozen image selection cyclically and trims the final interval', () => {
    const order = buildImagePoolPlayOrder({
      pool_id: 'images',
      selected_images: [
        { filename: 'one.png', sha256: 'one', target_duration: 4 },
        { filename: 'two.png', sha256: 'two', target_duration: 3 },
      ],
      seconds_per_image: 4,
      target_duration: 20,
      generated_at: 'now',
      warnings: [],
      files: [
        { filename: 'one.png', sha256: 'one', path: '/pool/one.png' },
        { filename: 'two.png', sha256: 'two', path: '/pool/two.png' },
      ],
    }, 20)

    assert.deepEqual(order.map(row => [row.filename, row.duration]), [
      ['one.png', 4], ['two.png', 4], ['one.png', 4], ['two.png', 4], ['one.png', 4],
    ])
    assert.equal(order.reduce((sum, row) => sum + row.duration, 0), 20)
  })

  test('keeps a sub-half-second narration remainder as the final interval', () => {
    const order = buildImagePoolPlayOrder({
      pool_id: 'images',
      selected_images: [{ filename: 'one.png', sha256: 'one', target_duration: 3 }],
      seconds_per_image: 3,
      target_duration: 9.2,
      generated_at: 'now',
      warnings: [],
      files: [{ filename: 'one.png', sha256: 'one', path: '/pool/one.png' }],
    }, 9.2)
    assert.equal(order.length, 4)
    assert.deepEqual(order.slice(0, 3).map(row => row.duration), [3, 3, 3])
    assert.ok(Math.abs(order[3]!.duration - 0.2) < 0.001)
    assert.ok(Math.abs(order.reduce((sum, row) => sum + row.duration, 0) - 9.2) < 0.001)
  })

  test('writes a source stamp tied to the exact final file identity', async () => {
    const finalPath = path.join(tmp.dir, 'EP0002_final_video.mp4')
    await fs.writeFile(finalPath, 'rendered')
    await writeVideoAssemblySourceStamp(finalPath, 'EP0002', 'image_pool', {
      pool_id: 'images',
      selected_images: [{ filename: 'one.png', sha256: 'one', target_duration: 4 }],
      seconds_per_image: 4,
      target_duration: 4,
      generated_at: 'now',
      warnings: [],
    })
    const stamp = JSON.parse(await fs.readFile(path.join(tmp.dir, 'EP0002_video_assembly_source.json'), 'utf8'))
    assert.equal(stamp.source, 'image_pool')
    assert.deepEqual(stamp.image_pool.selected_images, [{ filename: 'one.png', sha256: 'one' }])
    assert.equal(stamp.final_video.size, 8)
  })

  test('legacy episodes default to Scene Plan through the public API', async () => {
    const projectDir = path.join(tmp.dir, 'projects', SLUG)
    const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${EPISODE} - Legacy`)
    await fs.mkdir(episodeDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: SLUG, name: 'Visual Source Contract', episode_prefix: 'EP', season_size: 20,
      season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }))
    await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [{ id: 'i1', title: 'Legacy', status: 'accepted', episode_code: EPISODE }],
      next_episode_number: 2, recycled_numbers: [],
    }))

    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const { app } = await import('../app.js')
    const response = await request(app).get(`/api/projects/${SLUG}/video-editor/visual-source/${EPISODE}`)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { source: 'scene_plan', image_pool: null })
  })

  test('reads a legacy selection sidecar without backfilling a source', async () => {
    const seeded = await seedImagePoolEpisode('legacy-selection')
    const sidecarPath = path.join(seeded.episodeDir, 'broll-selection.json')
    const legacy = JSON.parse(await fs.readFile(sidecarPath, 'utf8'))
    delete legacy.source
    await fs.writeFile(sidecarPath, JSON.stringify(legacy))
    const before = await fs.readFile(sidecarPath, 'utf8')

    const state = await readVideoVisualSource('legacy-selection', EPISODE)

    assert.equal(state.source, 'scene_plan')
    assert.equal(state.image_pool, null)
    assert.equal(await fs.readFile(sidecarPath, 'utf8'), before)
  })

  test('records an Image Pool choice before an image selection exists', async () => {
    const projectDir = path.join(tmp.dir, 'projects', 'unready-image-pool')
    const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${EPISODE} - Unready`)
    await fs.mkdir(episodeDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: 'unready-image-pool', name: 'Unready Image Pool', episode_prefix: 'EP', season_size: 20,
      season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }))
    await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [{ id: 'i1', title: 'Unready', status: 'accepted', episode_code: EPISODE }],
    }))

    const { app } = await import('../app.js')
    const response = await request(app)
      .put(`/api/projects/unready-image-pool/video-editor/visual-source/${EPISODE}`)
      .send({ source: 'image_pool' })

    assert.deepEqual(response.body, { source: 'image_pool', image_pool: null })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(episodeDir, 'broll-selection.json'), 'utf8')), {
      schema_version: 1, episode_code: EPISODE, source: 'image_pool',
    })
    assert.equal(await getSelectionSidecar('unready-image-pool', EPISODE, 'Unready'), null)
    await assert.rejects(() => resolveImagePoolSelection('unready-image-pool', EPISODE), /selection is missing/i)

    await saveSelectionSidecar('unready-image-pool', EPISODE, 'Unready', {
      schema_version: 1, episode_code: EPISODE, pool_id: 'images', media: 'image', selection_mode: 'random',
      pacing_mode: 'timed', broll_volume: 0,
      selection: [{ filename: 'one.png', sha256: IMAGE_HASH, target_duration: 4 }],
      target_duration: 4, generated_at: 'now',
    })
    const picked = JSON.parse(await fs.readFile(path.join(episodeDir, 'broll-selection.json'), 'utf8'))
    assert.equal(picked.source, 'image_pool')

    const frozen = await fs.readFile(path.join(episodeDir, 'broll-selection.json'), 'utf8')
    await assert.rejects(() => saveSelectionSidecar('unready-image-pool', EPISODE, 'Unready', {
      schema_version: 1, episode_code: EPISODE, pool_id: 'video-pool', selection_mode: 'random',
      pacing_mode: 'timed', broll_volume: 0,
      selection: [{ filename: 'clip.mp4', sha256: 'video-hash', target_duration: 4 }],
      target_duration: 4, generated_at: 'now',
    }), /B-Roll selection is not used for Image Pool/i)
    assert.equal(await fs.readFile(path.join(episodeDir, 'broll-selection.json'), 'utf8'), frozen)
  })

  test('malformed source sidecars are blocked instead of defaulting to Scene Plan', async () => {
    const projectDir = path.join(tmp.dir, 'projects', 'malformed-source')
    const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${EPISODE} - Broken`)
    await fs.mkdir(episodeDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: 'malformed-source', name: 'Malformed', episode_prefix: 'EP', season_size: 20,
      season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }))
    await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({ ideas: [{ id: 'i1', title: 'Broken', status: 'accepted', episode_code: EPISODE }] }))
    await fs.writeFile(path.join(episodeDir, 'broll-selection.json'), '{not-json')
    const { app } = await import('../app.js')
    const response = await request(app).get(`/api/projects/malformed-source/video-editor/visual-source/${EPISODE}`)
    assert.equal(response.status, 500)
    assert.match(response.body.detail, /malformed/i)
    const sidecarPath = path.join(episodeDir, 'broll-selection.json')
    await assert.rejects(() => saveSelectionSidecar('malformed-source', EPISODE, 'Broken', {
      schema_version: 1, episode_code: EPISODE, pool_id: 'images', selection_mode: 'random', pacing_mode: 'timed',
      broll_volume: 0, selection: [], target_duration: 0, generated_at: 'now',
    }), /malformed/i)
    assert.equal(await fs.readFile(sidecarPath, 'utf8'), '{not-json')
  })

  test('rejects JSON-valid invalid source sidecars without replacing their bytes', async () => {
    const { app } = await import('../app.js')
    for (const [slug, title, raw] of [
      ['invalid-source-array', 'Array', '[]'],
      ['invalid-source-value', 'Value', '{"source":"bogus"}'],
      ['invalid-source-null', 'Null', '{"source":null}'],
    ]) {
      const projectDir = path.join(tmp.dir, 'projects', slug)
      const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${EPISODE} - ${title}`)
      const sidecarPath = path.join(episodeDir, 'broll-selection.json')
      await fs.mkdir(episodeDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
        slug, name: title, episode_prefix: 'EP', season_size: 20,
        season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      }))
      await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
        ideas: [{ id: 'i1', title, status: 'accepted', episode_code: EPISODE }],
      }))
      await fs.writeFile(sidecarPath, raw)

      const response = await request(app).get(`/api/projects/${slug}/video-editor/visual-source/${EPISODE}`)
      assert.equal(response.status, 500)
      await assert.rejects(() => saveSelectionSidecar(slug, EPISODE, title, {
        schema_version: 1, episode_code: EPISODE, pool_id: 'images', selection_mode: 'random', pacing_mode: 'timed',
        broll_volume: 0, selection: [], target_duration: 0, generated_at: 'now',
      }), /malformed|source/i)
      assert.equal(await fs.readFile(sidecarPath, 'utf8'), raw)
    }
  })

  test('rejects empty, missing, offline, and changed Image Pool assets', async () => {
    const empty = await seedImagePoolEpisode('empty-selection', [])
    await assert.rejects(() => resolveImagePoolSelection('empty-selection', EPISODE), /empty or malformed/i)

    const missing = await seedImagePoolEpisode('missing-selection')
    await fs.rm(path.join(missing.poolDir, 'one.png'))
    await assert.rejects(() => resolveImagePoolSelection('missing-selection', EPISODE), /unavailable|missing|offline/i)

    const offline = await seedImagePoolEpisode('offline-selection')
    await fs.rm(offline.poolDir, { recursive: true })
    await assert.rejects(() => resolveImagePoolSelection('offline-selection', EPISODE), /offline/i)

    const changed = await seedImagePoolEpisode('changed-selection')
    await fs.writeFile(path.join(changed.poolDir, 'one.png'), 'changed')
    await assert.rejects(() => resolveImagePoolSelection('changed-selection', EPISODE), /bytes changed/i)
  })

  test('does not expose a partial Image Pool selection when one saved entry is malformed', async () => {
    await seedImagePoolEpisode('malformed-selection', [
      { filename: 'one.png', sha256: IMAGE_HASH, target_duration: 4 },
      { filename: 'invalid.png', sha256: '', target_duration: 4 },
    ])
    const state = await readVideoVisualSource('malformed-selection', EPISODE)
    assert.equal(state.source, 'image_pool')
    assert.equal(state.image_pool, null)
    await assert.rejects(() => resolveImagePoolSelection('malformed-selection', EPISODE), /empty or malformed/i)
  })

  test('promotes a picked image selection only after pool ownership validation', async () => {
    const projectDir = path.join(tmp.dir, 'projects', 'pool-episode')
    const episodeDir = path.join(projectDir, 'episodes', 'Season 001', 'EP0001 - Pool')
    const poolDir = path.join(tmp.dir, 'image-pool')
    await fs.mkdir(episodeDir, { recursive: true })
    await fs.mkdir(poolDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: 'pool-episode', name: 'Pool Episode', episode_prefix: 'EP', season_size: 20,
      season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }))
    await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [{ id: 'i1', title: 'Pool', status: 'accepted', episode_code: EPISODE }],
      next_episode_number: 2, recycled_numbers: [],
    }))
    await fs.writeFile(path.join(poolDir, 'one.png'), 'image')
    await fs.writeFile(path.join(tmp.dir, 'broll-pools.json'), JSON.stringify({ schema_version: 1, pools: [{
      id: 'images', name: 'Images', folder_path: poolDir, media: 'image', auto_normalize: false,
      fps_target: 24, resolution_target: '1920x1080', created_at: new Date().toISOString(),
    }] }))
    await fs.writeFile(path.join(poolDir, '.story-studio-broll.json'), JSON.stringify({ schema_version: 1, pool_name: 'Images', clips: {
      'one.png': { filename: 'one.png', duration: 0, width: 1, height: 1, fps: 1, size_bytes: 5, sha256: '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d', normalized: false, tags: [], indexed_at: new Date().toISOString() },
    } }))
    await fs.writeFile(path.join(episodeDir, 'broll-selection.json'), JSON.stringify({
      schema_version: 1, episode_code: EPISODE, pool_id: 'images', media: 'image', selection_mode: 'random',
      pacing_mode: 'timed', segment_seconds: 4, broll_volume: 0,
      selection: [{ filename: 'one.png', sha256: '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d', target_duration: 4 }],
      target_duration: 4, generated_at: 'now', warnings: [],
    }))

    const { app } = await import('../app.js')
    const response = await request(app)
      .put('/api/projects/pool-episode/video-editor/visual-source/EP0001')
      .send({ source: 'image_pool' })
    assert.equal(response.status, 200)
    assert.equal(response.body.source, 'image_pool')
    assert.equal(response.body.image_pool.pool_id, 'images')
    assert.equal(response.body.image_pool.selected_images[0].filename, 'one.png')
  })

  test('switching sources keeps the saved Image Pool selection intact', async () => {
    const seeded = await seedImagePoolEpisode('source-switch')
    const before = JSON.parse(await fs.readFile(path.join(seeded.episodeDir, 'broll-selection.json'), 'utf8'))
    const { app } = await import('../app.js')

    const scenePlan = await request(app)
      .put(`/api/projects/source-switch/video-editor/visual-source/${EPISODE}`)
      .send({ source: 'scene_plan' })
    assert.deepEqual(scenePlan.body, { source: 'scene_plan', image_pool: null })
    const afterScenePlan = JSON.parse(await fs.readFile(path.join(seeded.episodeDir, 'broll-selection.json'), 'utf8'))
    assert.deepEqual(afterScenePlan.selection, before.selection)

    const imagePool = await request(app)
      .put(`/api/projects/source-switch/video-editor/visual-source/${EPISODE}`)
      .send({ source: 'image_pool' })
    assert.equal(imagePool.status, 200)
    const afterImagePool = JSON.parse(await fs.readFile(path.join(seeded.episodeDir, 'broll-selection.json'), 'utf8'))
    assert.deepEqual(afterImagePool.selection, before.selection)
  })

  test('uses persisted source when the render request tries to forge Scene Plan mode', async () => {
    await seedImagePoolEpisode('persisted-source')
    const { app } = await import('../app.js')
    const response = await request(app)
      .post('/api/projects/persisted-source/generate/video-assembly')
      .send({ episode_id: EPISODE, source: 'scene_plan', scenes: [] })
    assert.equal(response.status, 409)
    assert.match(response.body.detail, /merged audio is missing/i)
    assert.doesNotMatch(response.body.detail, /Scene Plan timeline/i)
    const persisted = await readVideoVisualSource('persisted-source', EPISODE)
    assert.equal(persisted.source, 'image_pool')
  })

  test('source stamp invalidates a final after a new pick or source switch', async () => {
    await seedImagePoolEpisode('stamp-source')
    const paths = await resolveEpisodePathsByCodeWithSidecar('stamp-source', EPISODE, 'broll-selection.json')
    await fs.mkdir(paths.video_dir, { recursive: true })
    const finalPath = path.join(paths.video_dir, `${EPISODE}_final_video.mp4`)
    await fs.writeFile(finalPath, 'rendered')
    const pool = (await readVideoVisualSource('stamp-source', EPISODE)).image_pool!
    await writeVideoAssemblySourceStamp(finalPath, EPISODE, 'image_pool', pool)
    const { computeEpisodeStatus } = await import('../services/asset-status.js')
    assert.equal((await computeEpisodeStatus('stamp-source', EPISODE)).video_assembly, true)

    await fs.writeFile(path.join(paths.episode_dir, 'broll-selection.json'), JSON.stringify({
      ...(await readVideoVisualSource('stamp-source', EPISODE)).sidecar,
      selection: [{ filename: 'one.png', sha256: 'changed-selection', target_duration: 4 }],
    }))
    assert.equal((await computeEpisodeStatus('stamp-source', EPISODE)).video_assembly, false)
  })
})
