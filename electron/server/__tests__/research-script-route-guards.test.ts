/**
 * Research + Script route guards that protect the producer's work:
 *
 *   - PUT research refuses decisions made against an OLDER run (409) instead
 *     of overwriting the new claims, and re-renders research.md on save.
 *   - DELETE research moves BOTH sidecars to the project _trash.
 *   - Import script refuses while a writer owns the episode, and moves the old
 *     script files to the project _trash instead of deleting them.
 *   - The writer prompt never calls kept research claims "confirmed".
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any
let slug: string
let projectDir: string
const EP = 'EP001'
const TITLE = 'Route Guards Test'

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  const proj = await request(app).post('/api/projects').send({ name: TITLE, episode_prefix: 'EP', episode_digits: 3 })
  assert.equal(proj.status, 201)
  slug = proj.body.slug
  const pm = await import('../services/project-manager.js')
  projectDir = pm.getProjectDir(slug)!
})

after(async () => { await cleanup() })

async function researchPaths() {
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { resolveResearchPaths } = await import('../lib/research-paths.js')
  const paths = await resolveEpisodePathsByCode(slug, EP)
  return resolveResearchPaths(paths.episode_dir, EP)
}

function research(generatedAt: string, status: 'unreviewed' | 'verified' = 'unreviewed') {
  return {
    schema_version: 1,
    source_provider: 'llm-only',
    generated_at: generatedAt,
    topic: 'Volcanoes',
    claims: [{ id: 'c1', text: 'Ash can fertilise soil.', status, citation_indices: [] }],
    citations: [],
  }
}

async function trashFiles(): Promise<string[]> {
  const root = path.join(projectDir, '_trash')
  if (!existsSync(root)) return []
  return (await fs.readdir(root, { recursive: true })).map(String)
}

describe('research PUT / DELETE', () => {
  test('a save made against an older run is refused, and the new run is left alone', async () => {
    const { dir, jsonPath } = await researchPaths()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(jsonPath, JSON.stringify(research('2026-10-02T10:00:00.000Z')))

    const stale = await request(app).put(`/api/projects/${slug}/research/${EP}`)
      .send(research('2026-10-01T09:00:00.000Z', 'verified'))
    assert.equal(stale.status, 409)
    assert.match(stale.body.detail, /run again/)
    const onDisk = JSON.parse(await fs.readFile(jsonPath, 'utf-8'))
    assert.equal(onDisk.claims[0].status, 'unreviewed', 'the newer run must not be overwritten')
  })

  test('a save of the current run writes it and re-renders research.md out of "review pending"', async () => {
    const { dir, jsonPath, mdPath } = await researchPaths()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(jsonPath, JSON.stringify(research('2026-10-02T10:00:00.000Z')))
    await fs.writeFile(mdPath, '> **REVIEW PENDING.** stale')

    const ok = await request(app).put(`/api/projects/${slug}/research/${EP}`)
      .send(research('2026-10-02T10:00:00.000Z', 'verified'))
    assert.equal(ok.status, 200)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.doesNotMatch(md, /REVIEW PENDING/)
    assert.match(md, /\*\*Reviewed\*\*/)
  })

  test('DELETE moves research.json AND research.md to the project _trash', async () => {
    const { jsonPath, mdPath } = await researchPaths()
    assert.ok(existsSync(jsonPath) && existsSync(mdPath))
    const res = await request(app).delete(`/api/projects/${slug}/research/${EP}`)
    assert.equal(res.status, 200)
    assert.equal(existsSync(jsonPath), false)
    assert.equal(existsSync(mdPath), false)
    const trashed = await trashFiles()
    assert.ok(trashed.some(f => f.endsWith('research.json')), 'research.json is in _trash')
    assert.ok(trashed.some(f => f.endsWith('research.md')), 'research.md is in _trash')
    // Idempotent: nothing left to move is still success.
    assert.equal((await request(app).delete(`/api/projects/${slug}/research/${EP}`)).status, 200)
  })
})

describe('import script', () => {
  test('refuses while a writer job owns the episode', async () => {
    const jq = await import('../services/job-queue.js')
    await jq.setQueuePaused(true)
    const active = jq.enqueuePreparedForTest({
      project_slug: slug, type: 'expand_chapters', episode_id: EP, title: TITLE, params: { model: 'm' },
    })
    try {
      const res = await request(app).post(`/api/projects/${slug}/episodes/${EP}/import-script`)
        .send({ title: TITLE, text: '## Chapter 1: One\nHello.' })
      assert.equal(res.status, 409)
      assert.match(res.body.detail, /still writing/)
      const outline = await request(app).post(`/api/projects/${slug}/episodes/${EP}/import-outline`)
        .send({ title: TITLE, text: 'Chapter 1: One' })
      assert.equal(outline.status, 409)
    } finally {
      await jq.requestJobCancellation(slug, active.job_id)
      await jq.setQueuePaused(false)
      for (let i = 0; i < 50 && jq.getJob(active.job_id)?.status !== 'cancelled'; i++) {
        await new Promise(r => setTimeout(r, 20))
      }
      jq.removeTerminalJob(slug, active.job_id)
    }
  })

  test('re-import moves the old script files to _trash instead of deleting them', async () => {
    const first = await request(app).post(`/api/projects/${slug}/episodes/${EP}/import-script`)
      .send({ title: TITLE, text: '## Chapter 1: One\nFirst.\n\n## Chapter 2: Two\nSecond.' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const before = (await trashFiles()).filter(f => /_Chapter_\d+\./.test(f)).length

    const second = await request(app).post(`/api/projects/${slug}/episodes/${EP}/import-script`)
      .send({ title: TITLE, text: '## Chapter 1: Replacement\nNew.' })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.chapters, 1)
    const trashed = (await trashFiles()).filter(f => /_Chapter_\d+\./.test(f))
    assert.ok(trashed.length > before, 'the previous chapters are kept in _trash')
    assert.ok(trashed.some(f => f.includes(`${EP}_Chapter_02`)), 'chapter 2 from the first import survives in _trash')
  })
})

describe('writer prompt wording (AGENTS.md §9)', () => {
  test('kept research claims are model-generated notes, never "independently confirmed"', async () => {
    const { loadResearchContextBlock } = await import('../lib/chunked-narration.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const paths = await resolveEpisodePathsByCode(slug, EP)
    const { dir, jsonPath } = await researchPaths()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(jsonPath, JSON.stringify(research('2026-10-03T00:00:00.000Z', 'verified')))
    const block = await loadResearchContextBlock(paths.script_dir, EP)
    assert.match(block, /Ash can fertilise soil\./)
    assert.match(block, /generated by a model/)
    assert.match(block, /not independently checked/)
    assert.doesNotMatch(block, /independently researched|confirmed/i)
  })
})

describe('stale outline edits never overwrite a rebuilt outline', () => {
  test('PUT outline refuses edits made on an older build, accepts the current one, and stays back-compatible', async () => {
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const scriptDir = (await resolveEpisodePaths(slug, 'EP002', TITLE)).script_dir
    await fs.mkdir(scriptDir, { recursive: true })
    const sidecarFile = path.join(scriptDir, 'EP002_chunked-progress.json')
    const built = '2026-10-03T10:00:00.000Z'
    const outline = [{ n: 1, title: 'New outline topic' }]
    await fs.writeFile(sidecarFile, JSON.stringify({
      schema_version: 3, episode_id: 'EP002', mode: 'narrative', total_chapters: 1, outline,
      outline_completed_at: built, outline_approved_at: null, outline_edited_at: null,
      generation_params: null, chapters_done: [], params_hash: 'x', last_updated: built,
    }))
    const url = `/api/projects/${slug}/episodes/EP002/outline?title=${encodeURIComponent(TITLE)}`

    const stale = await request(app).put(url).send({
      outline: [{ n: 1, title: 'Old edited topic' }], approved: true, outline_completed_at: '2026-10-01T00:00:00.000Z',
    })
    assert.equal(stale.status, 409)
    assert.match(stale.body.detail, /rebuilt/)
    const after = JSON.parse(await fs.readFile(sidecarFile, 'utf-8'))
    assert.equal(after.outline[0].title, 'New outline topic', 'the rebuilt outline is untouched')
    assert.equal(after.outline_approved_at, null, 'and not approved by the stale save')

    const current = await request(app).put(url).send({
      outline: [{ n: 1, title: 'Edited on the current build' }], approved: false, outline_completed_at: built,
    })
    assert.equal(current.status, 200)
    const legacy = await request(app).put(url).send({ outline: [{ n: 1, title: 'Older client' }], approved: false })
    assert.equal(legacy.status, 200, 'a client that does not send the build marker still saves')
  })
})

describe('research save keeps research.md fresh without a catalogue call', () => {
  test('the model name is carried from the existing research.md', async () => {
    const { dir, jsonPath, mdPath } = await researchPaths()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(jsonPath, JSON.stringify(research('2026-10-04T10:00:00.000Z')))
    await fs.writeFile(mdPath, '# Research — Volcanoes\n\n*Model knowledge only · research ran on 2026-10-04T10:00:00.000Z · Gemini Flash Lite*\n\n> **REVIEW PENDING.**\n')
    const ok = await request(app).put(`/api/projects/${slug}/research/${EP}`)
      .send(research('2026-10-04T10:00:00.000Z', 'verified'))
    assert.equal(ok.status, 200)
    const md = await fs.readFile(mdPath, 'utf-8')
    assert.match(md, /research ran on 2026-10-04T10:00:00\.000Z · Gemini Flash Lite\*/)
    assert.doesNotMatch(md, /REVIEW PENDING/)
  })

  test('a research.md that cannot be written never fails the saved decisions', async () => {
    const { jsonPath, mdPath } = await researchPaths()
    await fs.writeFile(jsonPath, JSON.stringify(research('2026-10-05T10:00:00.000Z')))
    await fs.rm(mdPath, { force: true })
    await fs.mkdir(mdPath)   // a directory where the file should be → write fails
    try {
      const ok = await request(app).put(`/api/projects/${slug}/research/${EP}`)
        .send(research('2026-10-05T10:00:00.000Z', 'verified'))
      assert.equal(ok.status, 200)
      assert.equal(JSON.parse(await fs.readFile(jsonPath, 'utf-8')).claims[0].status, 'verified')
    } finally {
      await fs.rm(mdPath, { recursive: true, force: true })
    }
  })
})
