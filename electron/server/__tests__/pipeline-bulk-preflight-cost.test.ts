import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, mock, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let app: any
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let jq: typeof import('../services/job-queue.js')
let statusCache: typeof import('../services/episode-status-cache.js')
let writeMetadataCompletionManifest: typeof import('../services/metadata-completion.js').writeMetadataCompletionManifest
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode
let wasQueuePaused = false

const EPISODE_COUNT = 12

interface Fixture {
  slug: string
  episodeIds: string[]
  configPath: string
  projectPath: string
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;({ app } = await import('../app.js'))
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  jq = await import('../services/job-queue.js')
  statusCache = await import('../services/episode-status-cache.js')
  ;({ writeMetadataCompletionManifest } = await import('../services/metadata-completion.js'))
  wasQueuePaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
})

after(async () => {
  await jq.setQueuePaused(true)
  for (const project of await pm.listProjects()) {
    for (const job of await jq.getJobs(project.slug)) {
      if (!['done', 'error', 'cancelled'].includes(job.status)) {
        await jq.requestJobCancellation(project.slug, job.job_id)
      }
      jq.removeTerminalJob(project.slug, job.job_id)
    }
  }
  await jq._waitForJobPersistenceForTesting()
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  if (!wasQueuePaused) await jq.setQueuePaused(false)
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  await cleanup()
})

async function seedBulkFixture(name: string, metadataDone = true): Promise<Fixture> {
  const project = await pm.createProject({ name })
  await pm.updateConfig(project.slug, {
    metadata_presets: [{ id: 'metadata', name: 'Metadata', data: { model: 'saved-chat-model' } }],
    metadata_last_preset: 'metadata',
    scene_review_genstudio_presets: [{
      id: 'scene-review',
      name: 'Scene Review',
      data: { model: 'saved-image-model', aspect_ratio: '16:9' },
    }],
    'scene_review_genstudio_last_preset_scene-review': 'scene-review',
    video_bundle_presets: [{ id: 'assembly', name: 'Assembly', data: {} }],
    video_bundle_last_preset: 'assembly',
  } as any)

  const ideas = await im.addIdeas(project.slug, Array.from({ length: EPISODE_COUNT }, (_unused, index) => ({
    title: `Bulk episode ${index + 1}`,
    logline: '',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'calm',
  })), 'test-model')
  for (const idea of ideas) await im.acceptIdea(project.slug, idea.id)

  const accepted = await im.getIdeas(project.slug, 'accepted')
  const episodeIds = accepted.map(idea => idea.episode_code!)
  for (const episodeId of episodeIds) {
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    await fs.mkdir(paths.episode_dir, { recursive: true })
    await im.setEpisodeStatusOverrides(project.slug, episodeId, {
      script: true,
      merged_audio: true,
      ...(metadataDone ? { metadata: true } : {}),
      subtitles: true,
      scene_plan: true,
      scene_review: true,
      video_assembly: true,
    })
  }

  const projectDir = path.join(pm.projectsRoot(), project.slug)
  return {
    slug: project.slug,
    episodeIds,
    configPath: path.join(projectDir, 'config.json'),
    projectPath: path.join(projectDir, 'project.json'),
  }
}

async function preflight(slug: string, episodeIds: string[]) {
  return request(app)
    .post(`/api/projects/${slug}/pipeline/preflight`)
    .send({ episode_ids: episodeIds, steps: ['video_assembly'] })
}

test('bulk preflight keeps project fact reads constant as episode count grows', async () => {
  const fixture = await seedBulkFixture('Pipeline shared facts')
  const realReadFile = fs.readFile.bind(fs)
  let configReads = 0
  let projectReads = 0
  const readMock = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
    if (String(file) === fixture.configPath) configReads += 1
    if (String(file) === fixture.projectPath) projectReads += 1
    return realReadFile(file, ...args as [])
  })

  try {
    const single = await preflight(fixture.slug, fixture.episodeIds.slice(0, 1))
    assert.equal(single.status, 200, JSON.stringify(single.body))
    const singleConfigReads = configReads
    const singleProjectReads = projectReads

    configReads = 0
    projectReads = 0
    const bulk = await preflight(fixture.slug, fixture.episodeIds)
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body))
    assert.ok(configReads <= singleConfigReads + 1,
      `config.json reads grew with the batch: one episode=${singleConfigReads}, ${EPISODE_COUNT} episodes=${configReads}`)
    assert.ok(projectReads <= singleProjectReads + 1,
      `project.json reads grew with the batch: one episode=${singleProjectReads}, ${EPISODE_COUNT} episodes=${projectReads}`)
  } finally {
    readMock.mock.restore()
  }
})

test('bulk preflight overlaps independent episode reads with bounded fanout', async () => {
  const fixture = await seedBulkFixture('Pipeline bounded workers')
  const realReadFile = fs.readFile.bind(fs)
  let active = 0
  let peak = 0
  const readMock = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
    if (!String(file).endsWith('broll-selection.json')) return realReadFile(file, ...args as [])
    active += 1
    peak = Math.max(peak, active)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      return await realReadFile(file, ...args as [])
    } finally {
      active -= 1
    }
  })

  try {
    const response = await preflight(fixture.slug, fixture.episodeIds)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.ok(peak > 1, `episode reads stayed serial (peak=${peak})`)
    assert.ok(peak <= 8, `episode read fanout exceeded the bounded worker limit (peak=${peak})`)
  } finally {
    readMock.mock.restore()
  }
})

test('run-batch reuses the status snapshot computed by its own preflight', async () => {
  const fixture = await seedBulkFixture('Pipeline status reuse')
  const realReadFile = fs.readFile.bind(fs)
  let researchReads = 0
  const readMock = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
    if (path.basename(String(file)) === 'research.json') researchReads += 1
    return realReadFile(file, ...args as [])
  })

  try {
    const response = await request(app)
      .post(`/api/projects/${fixture.slug}/pipeline/run-batch`)
      .send({ episode_ids: fixture.episodeIds, steps: ['metadata'] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    assert.equal(response.body.enqueued, 0)
    assert.equal(researchReads, EPISODE_COUNT,
      `each episode status should be scanned once inside run-batch, got ${researchReads} research reads`)
  } finally {
    readMock.mock.restore()
  }
})

async function metadataDirFor(fixture: Fixture, episodeId: string): Promise<string> {
  const paths = await resolveEpisodePathsByCode(fixture.slug, episodeId)
  await fs.mkdir(paths.metadata_dir, { recursive: true })
  return paths.metadata_dir
}

async function runWithDispatchMutation(
  fixture: Fixture,
  episodeId: string,
  mutate: () => Promise<void>,
) {
  const realReadFile = fs.readFile.bind(fs)
  let cleanupReads = 0
  let mutated = false
  const readMock = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
    if (path.basename(String(file)) === 'local_media_cleanup.json') {
      cleanupReads += 1
      if (cleanupReads === 2) {
        await mutate()
        mutated = true
      }
    }
    return realReadFile(file, ...args as [])
  })
  try {
    const response = await request(app)
      .post(`/api/projects/${fixture.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['metadata'] })
    assert.equal(mutated, true, 'the fixture must change disk between preflight status and admission')
    return response
  } finally {
    readMock.mock.restore()
  }
}

test('run-batch does not buy metadata again when an external artifact appears after preflight', async () => {
  const fixture = await seedBulkFixture('Pipeline late external completion', false)
  const episodeId = fixture.episodeIds[0]!
  const metadataDir = await metadataDirFor(fixture, episodeId)
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(metadataDir, old, old)

  const response = await runWithDispatchMutation(fixture, episodeId, async () => {
    await fs.writeFile(path.join(metadataDir, 'description.txt'), 'completed outside Pipeline')
  })

  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.enqueued, 0, 'fresh disk completion must suppress a paid duplicate')
  assert.deepEqual(response.body.steps_skipped_as_done, [{ episode_id: episodeId, step: 'metadata' }])
})

test('run-batch regenerates metadata removed after preflight', async () => {
  const fixture = await seedBulkFixture('Pipeline late external removal', false)
  const episodeId = fixture.episodeIds[0]!
  const metadataDir = await metadataDirFor(fixture, episodeId)
  const artifact = path.join(metadataDir, 'description.txt')
  const projectDir = pm.getProjectDir(fixture.slug)
  if (!projectDir) throw new Error('project dir missing')
  const trashDir = path.join(projectDir, '_trash', 'pipeline-status-fixture')
  await fs.mkdir(trashDir, { recursive: true })
  await fs.writeFile(artifact, 'present during preflight')
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(metadataDir, old, old)

  const response = await runWithDispatchMutation(fixture, episodeId, async () => {
    await fs.rename(artifact, path.join(trashDir, 'description.txt'))
  })

  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.enqueued, 1, 'an artifact removed before admission must be regenerated')
  assert.deepEqual(response.body.steps_skipped_as_done, [])
})

test('run-batch rechecks an in-place metadata rewrite whose parent mtime is unchanged', async () => {
  const fixture = await seedBulkFixture('Pipeline in-place external rewrite', false)
  const episodeId = fixture.episodeIds[0]!
  const metadataDir = await metadataDirFor(fixture, episodeId)
  const outputFilename = `${episodeId}_Metadata.json`
  const artifact = path.join(metadataDir, outputFilename)
  await fs.writeFile(artifact, JSON.stringify({
    description: 'Complete during preflight',
    title_options: ['First title', 'Second title'],
    tags: ['one', 'two'],
  }))
  await writeMetadataCompletionManifest(metadataDir, episodeId, outputFilename, 2, 2)
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(metadataDir, old, old)

  const response = await runWithDispatchMutation(fixture, episodeId, async () => {
    const before = await fs.stat(metadataDir)
    await fs.writeFile(artifact, JSON.stringify({
      description: '',
      title_options: ['First title'],
      tags: ['one'],
    }))
    await fs.utimes(metadataDir, before.atime, before.mtime)
  })

  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.enqueued, 1, 'an in-place partial rewrite must be repaired')
  assert.deepEqual(response.body.steps_skipped_as_done, [])
})

test('a job completion invalidation prevents stale status reuse at admission', async () => {
  const fixture = await seedBulkFixture('Pipeline job completion invalidation', false)
  const episodeId = fixture.episodeIds[0]!
  const metadataDir = await metadataDirFor(fixture, episodeId)
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(metadataDir, old, old)

  const response = await runWithDispatchMutation(fixture, episodeId, async () => {
    const before = await fs.stat(metadataDir)
    await fs.writeFile(path.join(metadataDir, 'description.txt'), 'completed by an earlier running job')
    await fs.utimes(metadataDir, before.atime, before.mtime)
    statusCache.invalidateForFinishedJob({
      project_slug: fixture.slug,
      episode_id: episodeId,
      status: 'done',
    })
  })

  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.enqueued, 0, 'a terminal job must invalidate the preflight status before admission')
  assert.deepEqual(response.body.steps_skipped_as_done, [{ episode_id: episodeId, step: 'metadata' }])
})

test('Start sees contextual cues enabled after a disabled-cue preflight cache warmup', async () => {
  const fixture = await seedBulkFixture('Pipeline config freshness')
  const episodeId = fixture.episodeIds[0]!
  const paths = await resolveEpisodePathsByCode(fixture.slug, episodeId)
  const scenePlanPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(scenePlanPath, JSON.stringify({
    generated_at: '2026-10-06T00:00:00.000Z',
    total_duration_sec: 6,
    scenes: [{
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 6,
      transcript_segment: 'A pending contextual cue.', visual_prompt: 'A complete visual prompt.',
    }],
  }))
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'contextual_cues.json'), JSON.stringify({
    schema_version: 1,
    generated_at: '2026-10-06T00:00:00.000Z',
    source_scene_plan_generated_at: '2026-10-06T00:00:00.000Z',
    cues: [{
      id: 'cue-1', scene_id: 'scene-1', start_sec: 0.5, end_sec: 4.5,
      title: 'Needs review', kind: 'location_date', placement: 'top-right',
      template: 'documentary-label', entrance: 'fade', exit: 'fade', status: 'proposed',
      created_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z',
    }],
  }))

  const preview = await request(app)
    .post(`/api/projects/${fixture.slug}/pipeline/preflight`)
    .send({ episode_ids: [episodeId], steps: ['scene_review'] })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))

  const enable = await request(app)
    .put(`/api/projects/${fixture.slug}/contextual-cues/config`)
    .send({ enabled: true, auto_approve_cues: false })
  assert.equal(enable.status, 200, JSON.stringify(enable.body))

  const response = await request(app)
    .post(`/api/projects/${fixture.slug}/pipeline/run-batch`)
    .send({ episode_ids: [episodeId], steps: ['scene_review'] })
  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.ok(response.body.issues?.some((issue: any) =>
    issue.episode_id === episodeId
      && issue.step === 'scene_review'
      && issue.requires === 'contextual_cues'),
  'Start must block Scene Review on the newly-enabled unresolved cue proposal')
})
