/**
 * Smoke tests for API routes via supertest.
 * Hits real Express routes with isolated temp data, but does NOT make real
 * calls to OpenAI/Anthropic/kie/fal — those require real keys.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup

  // Ensure projects dir exists before app loads
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })

  // Prevent app.ts from binding a listening port during tests
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  // Import after env vars are set so module-level resolution picks them up
  const mod = await import('../app.js')
  app = mod.app
})

after(async () => { await cleanup() })

describe('Health & meta routes', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health')
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ok')
    assert.ok(res.body.version)
  })

  test('GET /api/ffmpeg/status returns shape', async () => {
    const res = await request(app).get('/api/ffmpeg/status')
    assert.equal(res.status, 200)
    assert.ok(typeof res.body.installed === 'boolean')
    assert.ok(['bundled', 'system', 'not-found'].includes(res.body.source))
  })

  test('direct sibling-Studio and Studio Hub control routes are absent', async () => {
    for (const path of [
      '/api/imagestudio/base-url',
      '/api/voicestudio/base-url',
      '/api/chatstudio/base-url',
      '/api/videostudio/base-url',
      '/api/studiohub/status',
    ]) {
      const res = await request(app).get(path)
      assert.equal(res.status, 404, path)
    }
  })
})

describe('System queue routes', () => {
  test('GET /api/system/queue/status reports global queued work, including another project', async () => {
    const pm = await import('../services/project-manager.js')
    const jq = await import('../services/job-queue.js')
    const project = await pm.createProject({ name: 'Global Queue Status Route' })
    await jq.setQueuePaused(true)
    const queued = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'chapter-only',
      episode_id: 'GQ001',
      title: 'global queue status fixture',
      params: {},
    })

    try {
      const res = await request(app).get('/api/system/queue/status')
      assert.equal(res.status, 200)
      assert.equal(res.body.paused, true)
      assert.equal(typeof res.body.stats?.queued, 'number')
      assert.equal(typeof res.body.stats?.running, 'number')
      assert.ok(res.body.stats.queued >= 1, 'global status must include queued work outside the visible project')
    } finally {
      await jq.requestJobCancellation(project.slug, queued.job_id)
      await jq.setQueuePaused(false)
    }
  })
})

describe('Project routes', () => {
  let projectSlug: string

  test('POST /api/projects creates a project', async () => {
    const res = await request(app).post('/api/projects').send({
      name: 'Route Test Project',
      episode_prefix: 'RT',
      episode_digits: 3,
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.name, 'Route Test Project')
    assert.ok(res.body.slug)
    projectSlug = res.body.slug
  })

  test('GET /api/projects lists projects', async () => {
    const res = await request(app).get('/api/projects')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body))
    const slugs = res.body.map((p: any) => p.slug)
    assert.ok(slugs.includes(projectSlug))
  })

  test('GET /api/projects/:slug returns project meta', async () => {
    const res = await request(app).get(`/api/projects/${projectSlug}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.slug, projectSlug)
    assert.equal(res.body.episode_prefix, 'RT')
  })

  test('GET /api/projects/:slug/youtube/overview is mounted by the production route bootstrap', async () => {
    const projectPath = path.join(tempDir, 'projects', projectSlug, 'project.json')
    const legacy = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    delete legacy.subfolder_names.video_assets
    await fs.writeFile(projectPath, JSON.stringify(legacy, null, 2))

    const res = await request(app).get(`/api/projects/${projectSlug}/youtube/overview`)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'] || '', /application\/json/)
    assert.equal(res.body.assigned_channel, null)
    assert.equal(res.body.unavailable_reason, 'no_oauth_application')
    const after = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    assert.equal(Object.hasOwn(after.subfolder_names, 'video_assets'), false,
      'reading a valid legacy project must not rewrite its metadata')
  })

  test('GET /api/projects/:slug/youtube/overview keeps the shared unknown-project boundary', async () => {
    const res = await request(app).get('/api/projects/nonexistent-slug/youtube/overview')
    assert.equal(res.status, 404)
    assert.match(res.headers['content-type'] || '', /application\/json/)
    assert.deepEqual(res.body, { detail: 'Project not found' })
  })

  test('GET and PUT redact a legacy Research policy without rewriting it', async () => {
    const projectPath = path.join(tempDir, 'projects', projectSlug, 'project.json')
    const legacy = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    legacy.research_required = true
    await fs.writeFile(projectPath, JSON.stringify(legacy, null, 2))

    const get = await request(app).get(`/api/projects/${projectSlug}`)
    assert.equal(get.status, 200)
    assert.equal(Object.hasOwn(get.body, 'research_required'), false)

    const put = await request(app).put(`/api/projects/${projectSlug}`).send({ name: 'Legacy Route Test' })
    assert.equal(put.status, 200)
    assert.equal(Object.hasOwn(put.body, 'research_required'), false)

    const after = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    assert.equal(after.research_required, true, 'API redaction must not rewrite saved project data')
  })

  test('GET /api/projects/ghost returns 404', async () => {
    const res = await request(app).get('/api/projects/nonexistent-slug')
    assert.equal(res.status, 404)
  })

  test('PUT /api/projects/:slug updates metadata', async () => {
    const res = await request(app).put(`/api/projects/${projectSlug}`).send({
      name: 'Updated Name',
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.name, 'Updated Name')
  })
})

describe('Project settings routes', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Settings Test' })
    slug = res.body.slug
  })

  test('GET /api/projects/:slug/settings/config returns safe config', async () => {
    const res = await request(app).get(`/api/projects/${slug}/settings/config`)
    assert.equal(res.status, 200)
    // Should not expose API keys
    const body = JSON.stringify(res.body)
    assert.ok(!body.includes('sk-'), 'should not leak API keys in safe config')
  })

  test('PUT /api/projects/:slug/settings/api-keys is retired by the GenStudio-only boundary', async () => {
    const res = await request(app).put(`/api/projects/${slug}/settings/api-keys`).send({
      openai_api_key: 'sk-test-not-real',
    })
    assert.equal(res.status, 410)
    assert.equal(res.body.code, 'GENSTUDIO_ONLY')
  })

  test('PUT /api/projects/:slug/settings/standards saves text', async () => {
    const res = await request(app).put(`/api/projects/${slug}/settings/standards`).send({
      content: 'Test production standards content',
    })
    assert.equal(res.status, 200)

    const get = await request(app).get(`/api/projects/${slug}/settings/standards`)
    assert.equal(get.status, 200)
    assert.equal(get.body.content, 'Test production standards content')
  })

  test('GET /api/projects/:slug/settings/subfolder-config returns structure', async () => {
    const res = await request(app).get(`/api/projects/${slug}/settings/subfolder-config`)
    assert.equal(res.status, 200)
    assert.ok(res.body.subfolder_names)
    assert.ok(Array.isArray(res.body.linkage))
  })
})

describe('Jobs routes', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Jobs Test' })
    slug = res.body.slug
  })

  test('GET /api/projects/:slug/jobs returns jobs list + stats', async () => {
    const res = await request(app).get(`/api/projects/${slug}/jobs`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.jobs))
    assert.ok(res.body.stats)
  })

  test('POST /api/projects/:slug/jobs/ghost/hide returns 404 without removing another job', async () => {
    const before = await request(app).get(`/api/projects/${slug}/jobs`)
    assert.equal(before.status, 200)
    const res = await request(app).post(`/api/projects/${slug}/jobs/ghost-job-id/hide`)
    assert.equal(res.status, 404)
    const after = await request(app).get(`/api/projects/${slug}/jobs`)
    assert.deepEqual(after.body.jobs, before.body.jobs)
  })
})

describe('Ideas routes', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Ideas Test' })
    slug = res.body.slug
  })

  test('GET /api/projects/:slug/ideas returns ideas object initially', async () => {
    const res = await request(app).get(`/api/projects/${slug}/ideas`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.ideas), 'response wraps ideas in an object')
    assert.equal(res.body.ideas.length, 0)
    assert.ok(typeof res.body.next_episode_number === 'number')
  })

  test('GET /api/projects/:slug/episodes returns empty list initially', async () => {
    const res = await request(app).get(`/api/projects/${slug}/episodes`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body))
  })

  test('whole-episode Mark Done includes new Motion Review status fields', async () => {
    const project = await request(app).post('/api/projects').send({
      name: 'Motion Status Contract Project', episode_prefix: 'MS', episode_digits: 3,
    })
    const isolatedSlug = project.body.slug
    const created = await request(app).post(`/api/projects/${isolatedSlug}/ideas`).send({
      title: 'Motion Status Contract', suggested_chapters: 4,
    })
    assert.equal(created.status, 200)
    const accepted = await request(app)
      .post(`/api/projects/${isolatedSlug}/ideas/${created.body.id}/accept`).send({})
    assert.equal(accepted.status, 200)
    const code = accepted.body.episode_code
    const marked = await request(app)
      .patch(`/api/projects/${isolatedSlug}/episodes/${code}/mark-done`).send({ done: true })
    assert.equal(marked.status, 200)
    const episodes = await request(app).get(`/api/projects/${isolatedSlug}/episodes`)
    const episode = episodes.body.find((row: any) => row.episode_code === code)
    assert.ok(episode)
    assert.equal(episode.status.motion_review, true,
      'new EpisodeStatus fields must survive the /episodes public response')
  })

  test('GET /episodes reports exact scene-image counts when planned images are missing', async () => {
    const project = await request(app).post('/api/projects').send({
      name: 'Scene Image Count Project', episode_prefix: 'SI', episode_digits: 3,
    })
    const isolatedSlug = project.body.slug
    const created = await request(app).post(`/api/projects/${isolatedSlug}/ideas`).send({
      title: 'Missing Images', suggested_chapters: 4,
    })
    assert.equal(created.status, 200)
    const accepted = await request(app)
      .post(`/api/projects/${isolatedSlug}/ideas/${created.body.id}/accept`).send({})
    assert.equal(accepted.status, 200)
    const code = accepted.body.episode_code
    assert.ok(code, 'accepting an idea must return the episode code the rest of this test looks up')
    const episodeDir = path.join(tempDir, 'projects', isolatedSlug, 'episodes', 'Season 001', `${code} - Missing Images`)
    const promptsDir = path.join(episodeDir, `${code} - 03 Scene Prompts`)
    const imagesDir = path.join(episodeDir, `${code} - 05 Scene Images`)
    await fs.mkdir(promptsDir, { recursive: true })
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.writeFile(path.join(promptsDir, 'scene_plan.json'), JSON.stringify({
      scenes: [
        { id: 'scene-1', visual_prompt: 'first unique visual' },
        { id: 'scene-2', visual_prompt: 'second unique visual' },
        { id: 'scene-3', visual_prompt: 'third unique visual' },
      ],
    }))
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), 'image')
    await fs.writeFile(path.join(imagesDir, 'scene-3.png'), 'image')

    const episodes = await request(app).get(`/api/projects/${isolatedSlug}/episodes`)
    const episode = episodes.body.find((row: any) => row.episode_code === code)
    assert.ok(episode, `GET /episodes omitted ${code}: ${JSON.stringify(episodes.body)}`)
    assert.deepEqual(episode.scene_images, { total: 3, present: 2, complete: false })
    assert.equal(episode.status._scene_images, undefined,
      'internal scene image detail must not leak into public status')

    const single = await request(app).get(`/api/projects/${isolatedSlug}/episodes/${code}/status`)
    assert.deepEqual(single.body.scene_images, { total: 3, present: 2, complete: false })
    assert.equal(single.body.status._scene_images, undefined,
      'single-episode status must expose the same public projection without leaking internals')
  })

  test('subtitle status keeps the measured gap visible while the caption-gap policy decides readiness', async () => {
    const videoRoutes = await fs.readFile(new URL('../routes/video.ts', import.meta.url), 'utf-8')
    const lightweightRoute = videoRoutes.slice(
      videoRoutes.indexOf("router.get('/projects/:slug/video-editor/subtitles/timeline-integrity/:episodeId'"),
      videoRoutes.indexOf("router.get('/projects/:slug/video-editor/subtitles/status/:episodeId'"),
    )
    assert.doesNotMatch(lightweightRoute, /inspectSubtitleSourceFreshness|scanEpisodeAssets|inspectAudioAssemblyReadiness/,
      'the Jobs projection must not hash audio or run the full subtitle/assembly status scan')

    const project = await request(app).post('/api/projects').send({
      name: 'Subtitle Gap Status Project', episode_prefix: 'SG', episode_digits: 3,
    })
    const isolatedSlug = project.body.slug
    const created = await request(app).post(`/api/projects/${isolatedSlug}/ideas`).send({
      title: 'Coverage Gap', suggested_chapters: 1,
    })
    const accepted = await request(app)
      .post(`/api/projects/${isolatedSlug}/ideas/${created.body.id}/accept`).send({})
    const code = accepted.body.episode_code
    const episodeDir = path.join(tempDir, 'projects', isolatedSlug, 'episodes', 'Season 001', `${code} - Coverage Gap`)
    await fs.writeFile(path.join(episodeDir, 'continuity.json'), JSON.stringify({
      pacing: { min_sec: 45, max_sec: 60 },
    }))
    const subtitlesDir = path.join(episodeDir, `${code} - 09 Subtitles Output`)
    await fs.mkdir(subtitlesDir, { recursive: true })
    const srt = [
      '1', '00:00:17,880 --> 00:00:18,000', 'before', '',
      '2', '00:00:55,460 --> 00:00:56,000', 'after', '',
    ].join('\n')
    const cues = parseSrt(srt)
    const stitched = path.join(subtitlesDir, `${code}_stitched.srt`)
    await fs.writeFile(stitched, srt)
    await fs.writeFile(`${stitched}.json`, JSON.stringify({
      complete: true, generated_at: '2026-09-11T16:25:00.000Z', missing_sections: [], total_cues: cues.length, timeline: stampFromCues(cues),
      sections: [{ slug: 'Chapter_15', source_srt: `${code}_Chapter_15.srt`, offset_sec: 0, duration_sec: 90, cues_added: 2 }],
    }))

    const lightweight = await request(app)
      .get(`/api/projects/${isolatedSlug}/video-editor/subtitles/timeline-integrity/${code}`)
    assert.equal(lightweight.status, 200)
    assert.equal(lightweight.body.timeline_integrity.caption_gap_mode, 'warn')
    assert.equal(lightweight.body.timeline_integrity.complete, true)
    assert.equal(lightweight.body.timeline_integrity.max_cue_gap_sec, 30)
    assert.deepEqual(lightweight.body.timeline_integrity.blocking_cue_gaps[0].section_slugs, ['Chapter_15'])

    const status = await request(app)
      .get(`/api/projects/${isolatedSlug}/video-editor/subtitles/status/${code}`)
    assert.equal(status.status, 200)
    assert.equal(status.body.completion.complete, true, 'chapter/full-track completion remains a separate fact')
    assert.equal(status.body.timeline_integrity.caption_gap_mode, 'warn')
    assert.equal(status.body.timeline_integrity.complete, true)
    assert.equal(status.body.timeline_integrity.max_cue_gap_sec, 30, 'slow visual pacing must not relax subtitle admission')
    assert.deepEqual(status.body.timeline_integrity.blocking_cue_gaps[0].section_slugs, ['Chapter_15'])
    assert.equal(status.body.planning_transcript_source, 'raw')
    assert.equal(status.body.planning_source_revalidation_required, true)
    assert.equal(status.body.last_stitched_at, '2026-09-11T16:25:00.000Z', 'stitch recency comes from the stitch sidecar, not this status read')

    const pm = await import('../services/project-manager.js')
    await pm.updateConfig(isolatedSlug, { safety_checks: { caption_gap: 'block' } } as any)
    const blockedLightweight = await request(app)
      .get(`/api/projects/${isolatedSlug}/video-editor/subtitles/timeline-integrity/${code}`)
    assert.equal(blockedLightweight.body.timeline_integrity.caption_gap_mode, 'block')
    assert.equal(blockedLightweight.body.timeline_integrity.complete, false)
    assert.deepEqual(blockedLightweight.body.timeline_integrity.blocking_cue_gaps[0].section_slugs, ['Chapter_15'])

    const blockedStatus = await request(app)
      .get(`/api/projects/${isolatedSlug}/video-editor/subtitles/status/${code}`)
    assert.equal(blockedStatus.body.timeline_integrity.caption_gap_mode, 'block')
    assert.equal(blockedStatus.body.timeline_integrity.complete, false)
    assert.deepEqual(blockedStatus.body.timeline_integrity.blocking_cue_gaps[0].section_slugs, ['Chapter_15'])
  })

  test('GET /episodes reports thumbnail counts after thumbnail files go missing or are deleted', async () => {
    const project = await request(app).post('/api/projects').send({
      name: 'Thumbnail Image Count Project', episode_prefix: 'TI', episode_digits: 3,
    })
    const isolatedSlug = project.body.slug
    const created = await request(app).post(`/api/projects/${isolatedSlug}/ideas`).send({
      title: 'Missing Thumbnails', suggested_chapters: 4,
    })
    assert.equal(created.status, 200)
    const accepted = await request(app)
      .post(`/api/projects/${isolatedSlug}/ideas/${created.body.id}/accept`).send({})
    assert.equal(accepted.status, 200)
    const code = accepted.body.episode_code
    const episodeDir = path.join(tempDir, 'projects', isolatedSlug, 'episodes', 'Season 001', `${code} - Missing Thumbnails`)
    const promptsDir = path.join(episodeDir, `${code} - 04 Thumbnail Prompts`)
    const thumbnailsDir = path.join(episodeDir, `${code} - 06 Thumbnail Images`)
    await fs.mkdir(promptsDir, { recursive: true })
    await fs.mkdir(thumbnailsDir, { recursive: true })
    await fs.writeFile(path.join(promptsDir, `${code}_Thumbnail_Prompts.md`), [
      '# Thumbnail Prompts',
      '1. First thumbnail',
      'First thumbnail prompt.',
      '2. Second thumbnail',
      'Second thumbnail prompt.',
      '3. Third thumbnail',
      'Third thumbnail prompt.',
    ].join('\n'))
    await fs.writeFile(path.join(thumbnailsDir, `${code}_Thumb01_v1.png`), 'image')
    const deletedThumbnail = path.join(thumbnailsDir, `${code}_Thumb03_v1.png`)
    await fs.writeFile(deletedThumbnail, 'image')

    const assertThumbnailAggregate = (body: any, expected: { total: number, present: number, complete: boolean }) => {
      assert.deepEqual(body.thumbnail_images, expected)
      assert.equal(body.status.thumbnails, false, 'partial thumbnail files must not count as complete')
      assert.equal(body.status._thumbnail_images, undefined,
        'internal thumbnail image detail must not leak into public status')
    }

    const partialList = await request(app).get(`/api/projects/${isolatedSlug}/episodes?invalidate=${code}`)
    const partialEpisode = partialList.body.find((row: any) => row.episode_code === code)
    assert.ok(partialEpisode)
    assertThumbnailAggregate(partialEpisode, { total: 3, present: 2, complete: false })

    const partialSingle = await request(app).get(`/api/projects/${isolatedSlug}/episodes/${code}/status?invalidate=1`)
    assertThumbnailAggregate(partialSingle.body, { total: 3, present: 2, complete: false })

    await fs.rm(deletedThumbnail)

    const deletedList = await request(app).get(`/api/projects/${isolatedSlug}/episodes?invalidate=${code}`)
    const deletedEpisode = deletedList.body.find((row: any) => row.episode_code === code)
    assert.ok(deletedEpisode)
    assertThumbnailAggregate(deletedEpisode, { total: 3, present: 1, complete: false })

    const deletedSingle = await request(app).get(`/api/projects/${isolatedSlug}/episodes/${code}/status?invalidate=1`)
    assertThumbnailAggregate(deletedSingle.body, { total: 3, present: 1, complete: false })
  })

  test('GET /episodes treats all planned images as complete before Scene Review approval and preserves counts after Mark Done', async () => {
    const project = await request(app).post('/api/projects').send({
      name: 'Scene Image Approval Project', episode_prefix: 'SA', episode_digits: 3,
    })
    const isolatedSlug = project.body.slug
    const created = await request(app).post(`/api/projects/${isolatedSlug}/ideas`).send({
      title: 'Unapproved Images', suggested_chapters: 4,
    })
    assert.equal(created.status, 200)
    const accepted = await request(app)
      .post(`/api/projects/${isolatedSlug}/ideas/${created.body.id}/accept`).send({})
    assert.equal(accepted.status, 200)
    const code = accepted.body.episode_code
    assert.ok(code, 'accepting an idea must return the episode code the rest of this test looks up')
    const episodeDir = path.join(tempDir, 'projects', isolatedSlug, 'episodes', 'Season 001', `${code} - Unapproved Images`)
    const promptsDir = path.join(episodeDir, `${code} - 03 Scene Prompts`)
    const imagesDir = path.join(episodeDir, `${code} - 05 Scene Images`)
    const subtitlesDir = path.join(episodeDir, `${code} - 09 Subtitles Output`)
    await fs.mkdir(promptsDir, { recursive: true })
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.mkdir(subtitlesDir, { recursive: true })
    await fs.writeFile(path.join(promptsDir, 'scene_plan.json'), JSON.stringify({
      scenes: [
        { id: 'scene-1', visual_prompt: 'first unique visual', approved: true },
        { id: 'scene-2', visual_prompt: 'second unique visual', approved: false },
      ],
    }))
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), 'image')
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), 'image')
    const stitched = path.join(subtitlesDir, `${code}_stitched.srt`)
    await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:05,000\nNarration\n')
    await fs.writeFile(`${stitched}.json`, JSON.stringify({
      complete: true,
      missing_sections: [],
      sections: [{ slug: 'Introduction', source_srt: `${code}_Introduction.srt`, cues_added: 1 }],
    }))

    let episodes = await request(app).get(`/api/projects/${isolatedSlug}/episodes`)
    let episode = episodes.body.find((row: any) => row.episode_code === code)
    assert.ok(episode, `GET /episodes omitted ${code}: ${JSON.stringify(episodes.body)}`)
    assert.deepEqual(episode.scene_images, { total: 2, present: 2, complete: true })
    assert.equal(episode.status.scene_review, false,
      'image completion must not bypass Scene Review approval')

    const marked = await request(app)
      .patch(`/api/projects/${isolatedSlug}/episodes/${code}/mark-done`).send({ done: true })
    assert.equal(marked.status, 200)
    episodes = await request(app).get(`/api/projects/${isolatedSlug}/episodes`)
    episode = episodes.body.find((row: any) => row.episode_code === code)
    assert.ok(episode, `GET /episodes omitted ${code} after Mark Done: ${JSON.stringify(episodes.body)}`)
    assert.deepEqual(episode.scene_images, { total: 2, present: 2, complete: true },
      'Mark Done must not discard the image counts computed from the scene plan')
  })

  // ── Paste-import tests ─────────────────────────────────────────────────
  // These pin the validation rules for the `/ideas/import-paste` route so
  // a future tightening of the shape (e.g. requiring suggested_length be
  // one of a fixed list) doesn't silently start rejecting rows the UI
  // accepted yesterday. Also confirms the dry_run contract — preview must
  // never write to ideas.json.

  test('GET /api/projects/:slug/ideas/paste-prompt returns the preset prompt as text', async () => {
    const res = await request(app).get(`/api/projects/${slug}/ideas/paste-prompt`)
    assert.equal(res.status, 200)
    assert.ok(res.headers['content-type']?.startsWith('text/plain'))
    assert.ok(res.text.includes('JSON array'), 'prompt mentions JSON array so the LLM knows the shape')
    assert.ok(res.text.includes('suggested_chapters'), 'prompt lists required keys')
  })

  test('POST /ideas/import-paste dry_run: splits valid vs rejected rows without writing', async () => {
    // One valid row + three that fail different validation rules so a single
    // POST exercises the decision tree: missing title, bad themes type,
    // missing mood. All four should come back in one response.
    const payload = {
      dry_run: true,
      json: JSON.stringify([
        { title: 'The Lantern Keeper', logline: 'A keeper tends one last flame.', themes: ['solitude', 'memory'], suggested_chapters: 10, suggested_length: '45 min', mood: 'quiet resolve' },
        { title: '', logline: 'Missing title', themes: ['x'], suggested_chapters: 8, suggested_length: '45 min', mood: 'tense' },
        { title: 'Bad themes', logline: 'themes is not an array', themes: 'solitude,memory', suggested_chapters: 8, suggested_length: '45 min', mood: 'calm' },
        { title: 'Missing mood', logline: 'mood field is blank', themes: ['a'], suggested_chapters: 8, suggested_length: '45 min', mood: '' },
      ]),
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 200)
    assert.equal(res.body.valid.length, 1)
    assert.equal(res.body.rejected.length, 3)
    assert.equal(res.body.imported, 0, 'dry_run must never write')

    // And confirm the underlying store is still empty — the dry_run contract
    // is the whole point of the preview pane, so belt + braces here.
    const after = await request(app).get(`/api/projects/${slug}/ideas`)
    assert.equal(after.body.ideas.length, 0)
  })

  test('POST /ideas/import-paste commits valid rows to ideas.json', async () => {
    const payload = {
      json: JSON.stringify([
        { title: 'Real Paste One', logline: 'A test idea from paste.', themes: ['test'], suggested_chapters: 8, suggested_length: '45 min', mood: 'calm' },
        { title: 'Real Paste Two', logline: 'Another test idea.', themes: ['test', 'paste'], suggested_chapters: 10, suggested_length: '60 min', mood: 'gentle' },
      ]),
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 200)
    assert.equal(res.body.imported, 2)
    assert.equal(res.body.valid.length, 2)
    assert.ok(res.body.valid[0].id, 'stored ideas get ids assigned server-side')
    assert.equal(res.body.valid[0].model_used, 'paste-import', 'model_used tag lets the UI distinguish paste from generator')
    assert.equal(res.body.valid[0].status, 'new', 'new status matches generator-created ideas — Accept flow is shared')

    // Follow-up fetch must reflect the write.
    const after = await request(app).get(`/api/projects/${slug}/ideas`)
    assert.equal(after.body.ideas.length, 2)
  })

  test('POST /ideas/import-paste rejects empty paste with 400', async () => {
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send({ json: '   ' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Empty paste/i)
  })

  test('POST /ideas/import-paste rejects malformed JSON with 400', async () => {
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send({ json: 'not json at all' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Could not parse|No JSON array/)
  })

  test('POST /ideas/import-paste rejects all-rejected input with 400 (no ideas written)', async () => {
    // All rows fail — server must return 400 so the frontend shows an
    // error instead of success. Also: ideas.json must NOT have been
    // touched, even partially, when every row is bad.
    const before = (await request(app).get(`/api/projects/${slug}/ideas`)).body.ideas.length
    const payload = {
      json: JSON.stringify([
        { title: '', logline: 'no title', themes: ['x'], suggested_chapters: 8, suggested_length: '45 min', mood: 'calm' },
      ]),
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 400)
    assert.ok(res.body.rejected?.length === 1, 'rejected array surfaced so the UI can show reasons')
    const after = (await request(app).get(`/api/projects/${slug}/ideas`)).body.ideas.length
    assert.equal(after, before, 'no ideas should have been written on all-rejected input')
  })

  test('POST /ideas/import-paste tolerates ```json fences around the array', async () => {
    // LLMs often wrap output in markdown fences. parseIdeas strips them;
    // this asserts the tolerance flows all the way through to a successful
    // import (not just a successful parse).
    const payload = {
      json: '```json\n[\n  { "title": "Fenced Idea", "logline": "Wrapped in a code fence.", "themes": ["fence"], "suggested_chapters": 8, "suggested_length": "45 min", "mood": "dry" }\n]\n```',
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 200)
    assert.equal(res.body.imported, 1)
  })
})

describe('Error handling', () => {
  test('Jobs endpoint returns empty list (not 404) for non-existent project', async () => {
    // Design choice: /jobs returns empty list rather than 404
    // since it's a read-only endpoint safe to call optimistically.
    const res = await request(app).get('/api/projects/ghost-slug/jobs')
    assert.equal(res.status, 200)
    assert.equal(res.body.jobs.length, 0)
  })

  test('Image generation without kie key fails gracefully', async () => {
    // Create project, queue image job with no key configured
    const proj = await request(app).post('/api/projects').send({ name: 'NoKey Test' })
    const slug = proj.body.slug
    const res = await request(app).post(`/api/projects/${slug}/generate/images`).send({
      episode_id: 'FAKE001',
      model: 'grok-imagine',
      mode: 'thumbs',
    })
    // Route will accept the job (validation happens at generation time);
    // API key check now moved to provider layer. Either 201 (queued, will fail later)
    // or 400 (early validation). Both are acceptable — we just want no crash.
    assert.ok([201, 400, 409].includes(res.status), `unexpected status ${res.status}`)
  })
})

// ── Retired project-scoped provider/account endpoints ──────────────────────

describe('Account endpoints', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Accounts Route Test' })
    slug = res.body.slug
  })

  const assertGenStudioOnly = (res: request.Response) => {
    assert.equal(res.status, 410)
    assert.equal(res.body.code, 'GENSTUDIO_ONLY')
    assert.match(res.body.detail, /Gateway API Key/i)
  }

  test('GET /settings/accounts is retired', async () => {
    assertGenStudioOnly(await request(app).get(`/api/projects/${slug}/settings/accounts`))
  })

  test('POST /settings/accounts/:providerId is retired before CRUD validation', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/settings/accounts/openai`)
      .send({ label: 'A', apiKey: 'sk-aaaabbbb1111' })
    assertGenStudioOnly(res)
    assert.ok(!JSON.stringify(res.body).includes('aaaabbbb'), 'retired route must not echo the submitted key')
  })

  test('retired account routes do not revive payload validation or CRUD behavior', async () => {
    assertGenStudioOnly(await request(app)
      .post(`/api/projects/${slug}/settings/accounts/openai`)
      .send({ label: '', apiKey: '' }))
  })

  test('unknown legacy account providers receive the same closed boundary', async () => {
    assertGenStudioOnly(await request(app)
      .post(`/api/projects/${slug}/settings/accounts/not-a-provider`)
      .send({ label: 'X', apiKey: 'y' }))
  })

  test('PATCH /settings/accounts/:providerId/:accountId is retired', async () => {
    assertGenStudioOnly(await request(app)
      .patch(`/api/projects/${slug}/settings/accounts/anthropic/default`)
      .send({ label: 'After' }))
  })

  test('DELETE /settings/accounts/:providerId/:accountId is retired', async () => {
    assertGenStudioOnly(await request(app)
      .delete(`/api/projects/${slug}/settings/accounts/anthropic/default`))
  })

  test('GET /settings/config remains credential-safe and does not restore retired accounts', async () => {
    const res = await request(app).get(`/api/projects/${slug}/settings/config`)
    assert.equal(res.status, 200)
    assert.ok(res.body.accounts, 'accounts field present')
    assert.equal('openai' in res.body.accounts, false)
    assert.doesNotMatch(JSON.stringify(res.body), /sk-[a-z0-9-]+/i, 'no raw keys in safe config')
  })
})
