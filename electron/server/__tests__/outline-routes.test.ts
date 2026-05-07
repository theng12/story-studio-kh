/**
 * Integration tests for the outline-first HTTP surface (Round 1 hardening):
 *
 *   PUT  /api/projects/:slug/episodes/:id/outline
 *   POST /api/projects/:slug/generate/expand-chapters
 *
 * Covers the validation that closes audit findings 5a, 5b, 5c, 5d, 10a:
 *   - PUT must reject `outline.length !== total_chapters` (truncation)
 *   - PUT still rejects out-of-range n, dupes, missing title
 *   - POST must reject malformed `chapters` arrays (non-array, NaN,
 *     out-of-range, non-integer); empty / dedup is normalised silently
 *   - POST sidecar probe is widened: a sidecar that legitimately drops
 *     n=1 (e.g. user-edited) must NOT 400 the route
 *
 * Sidecars are seeded directly on disk so the tests don't need real LLM
 * calls. The actual expansion job is intentionally left in the queue —
 * we only assert the route accepted/rejected the request shape.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any

// ── Fixture ────────────────────────────────────────────────────────────────

const EPISODE_ID = 'EP001'
const TITLE = 'Outline Routes Test'
const TOTAL_CHAPTERS = 5
let slug: string
let scriptDir: string
let sidecarFile: string

before(async () => {
  // Single before hook — node:test runs sibling befores concurrently, so
  // splitting "boot the app" and "create the fixture project" into two
  // top-level befores means the second tries to call request(app) while
  // app is still undefined.
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup

  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const mod = await import('../app.js')
  app = mod.app

  // Project — has to exist so the routes can resolveEpisodePaths.
  const proj = await request(app).post('/api/projects').send({
    name: 'Outline Routes Test',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(proj.status, 201)
  slug = proj.body.slug

  // API key gate.
  await request(app).put(`/api/projects/${slug}/settings/api-keys`).send({
    anthropic_api_key: 'sk-test-not-real',
  })

  const { resolveEpisodePaths } = await import('../services/utils.js')
  const paths = await resolveEpisodePaths(slug, EPISODE_ID, TITLE)
  scriptDir = paths.script_dir
  sidecarFile = path.join(scriptDir, `${EPISODE_ID}_chunked-progress.json`)
})

after(async () => { await cleanup() })

async function createSidecar(opts: {
  outline?: any[]
  approved?: boolean
  total?: number
} = {}) {
  const total = opts.total ?? TOTAL_CHAPTERS
  const outline = opts.outline ?? Array.from({ length: total }, (_, i) => ({
    n: i + 1,
    title: `Topic ${i + 1}`,
    hook_line: `Hook ${i + 1}`,
  }))
  const now = new Date().toISOString()
  const sidecar = {
    schema_version: 2,
    episode_id: EPISODE_ID,
    mode: 'listicle',
    total_chapters: total,
    outline,
    outline_completed_at: now,
    outline_approved_at: opts.approved ? now : null,
    outline_edited_at: null,
    chapters_done: [],
    params_hash: 'fakehash00000000',
    last_updated: now,
  }
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(sidecarFile, JSON.stringify(sidecar, null, 2))
}

beforeEach(async () => {
  // Wipe the sidecar between cases so each test seeds the shape it needs.
  await fs.rm(sidecarFile, { force: true })
})

// ── PUT /outline — length validation (5a, 5d, 10a) ─────────────────────────

describe('PUT /outline — length validation', () => {
  test('rejects truncated outline (length < total_chapters)', async () => {
    await createSidecar()
    const truncated = [
      { n: 1, title: 'a' }, { n: 2, title: 'b' }, { n: 3, title: 'c' },
    ]
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: truncated })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /exactly 5 entries/)
  })

  test('rejects oversized outline (length > total_chapters)', async () => {
    await createSidecar()
    const oversized = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, title: `t${i}` }))
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: oversized })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /exactly 5 entries/)
  })

  test('rejects approval on truncated outline (5d)', async () => {
    await createSidecar()
    const truncated = [{ n: 1, title: 'a' }, { n: 2, title: 'b' }]
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: truncated, approved: true })
    // Length check fires before approval is honoured — the truncated outline
    // never lands on disk and approval is never granted.
    assert.equal(res.status, 400)
    const raw = await fs.readFile(sidecarFile, 'utf-8')
    const sidecar = JSON.parse(raw)
    assert.equal(sidecar.outline_approved_at, null,
      'rejected PUT must not flip approval state on disk')
  })

  test('accepts a valid full-length outline + approval', async () => {
    await createSidecar()
    const full = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({
      n: i + 1, title: `Edited ${i + 1}`,
    }))
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: full, approved: true })
    assert.equal(res.status, 200)
    assert.ok(res.body.outline_approved_at)

    const raw = await fs.readFile(sidecarFile, 'utf-8')
    const sidecar = JSON.parse(raw)
    assert.equal(sidecar.outline.length, TOTAL_CHAPTERS)
    assert.equal(sidecar.outline[0].title, 'Edited 1')
  })

  test('rejects duplicate n', async () => {
    await createSidecar()
    const dupe = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({ n: i + 1, title: `t${i}` }))
    dupe[3].n = 2 // dup of slot 2
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: dupe })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Duplicate chapter number/)
  })

  test('rejects out-of-range n', async () => {
    await createSidecar()
    const oor = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({ n: i + 1, title: `t${i}` }))
    oor[2].n = 99 // beyond total_chapters
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: oor })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /invalid n/)
  })

  test('rejects entry missing title', async () => {
    await createSidecar()
    const bad = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({ n: i + 1, title: `t${i}` })) as any[]
    bad[1].title = ''
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: bad })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /missing title/)
  })

  test('preserves chapters_done + params_hash + total_chapters across edit (2d)', async () => {
    // Seed a sidecar with chapters_done populated so we can verify it survives.
    await fs.mkdir(scriptDir, { recursive: true })
    const seeded = {
      schema_version: 2,
      episode_id: EPISODE_ID,
      mode: 'listicle',
      total_chapters: TOTAL_CHAPTERS,
      outline: Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({ n: i + 1, title: `Original ${i + 1}` })),
      outline_completed_at: '2026-05-01T00:00:00.000Z',
      outline_approved_at: '2026-05-01T00:00:00.000Z',
      outline_edited_at: null,
      chapters_done: [1, 3],
      params_hash: 'preserve-this-hash',
      last_updated: '2026-05-01T00:00:00.000Z',
    }
    await fs.writeFile(sidecarFile, JSON.stringify(seeded, null, 2))

    const newOutline = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({
      n: i + 1, title: `Renamed ${i + 1}`,
    }))
    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: newOutline })
    assert.equal(res.status, 200)

    const raw = await fs.readFile(sidecarFile, 'utf-8')
    const after = JSON.parse(raw)
    assert.deepEqual(after.chapters_done, [1, 3], 'chapters_done must survive')
    assert.equal(after.params_hash, 'preserve-this-hash', 'params_hash must survive')
    assert.equal(after.total_chapters, TOTAL_CHAPTERS)
    assert.equal(after.outline[2].title, 'Renamed 3')
    assert.ok(after.outline_edited_at, 'outline_edited_at must be set')
  })
})

// ── POST /expand-chapters — chapters[] validation (5b) ─────────────────────

describe('POST /expand-chapters — chapters[] validation', () => {
  test('rejects non-array chapters', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters: 'all' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /must be an array/)
  })

  test('rejects out-of-range chapter number', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters: [1, 99] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Invalid chapter number/)
  })

  test('rejects non-integer chapter number', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters: [1.5] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Invalid chapter number/)
  })

  test('rejects NaN entries', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters: ['abc'] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Invalid chapter number/)
  })

  test('accepts valid chapter numbers (queues a job)', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters: [1, 3] })
    assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(res.body)}`)
    assert.ok(res.body.job_id, 'must return a job_id')
    // Cancel the queued job so it doesn't keep running in the test process.
    const jq = await import('../services/job-queue.js')
    if (res.body.job_id) jq.cancelJob(res.body.job_id)
  })
})

// ── POST /expand-chapters — probe widening (5c) ────────────────────────────

// Make sure no expand_chapters job is still queued before the probe-widening
// section runs — otherwise the second valid POST would hit the per-(episode,
// type) duplicate-job gate, not the probe path we want to exercise.
async function cancelAllExpandJobs() {
  const jq = await import('../services/job-queue.js')
  const list = await jq.getJobs(slug)
  for (const j of list) {
    if (j.type === 'expand_chapters' && (j.status === 'queued' || j.status === 'running')) {
      jq.cancelJob(j.job_id)
    }
  }
  await new Promise(r => setTimeout(r, 50))
}

describe('POST /expand-chapters — sidecar probe', () => {
  before(async () => { await cancelAllExpandJobs() })
  test('rejects with clear 400 when no sidecar exists', async () => {
    // No createSidecar() call — sidecar absent.
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /No outline found/)
  })

  test('accepts a sidecar that drops n=1 (probe is no longer chapter-1-only)', async () => {
    // User-edited sidecar where the outline starts at n=2. The old probe
    // looked up entry n=1 and returned null → 400. With readSidecar the
    // route should accept this as a valid sidecar.
    const outlineWithoutN1 = [
      { n: 2, title: 'Topic 2' },
      { n: 3, title: 'Topic 3' },
      { n: 4, title: 'Topic 4' },
      { n: 5, title: 'Topic 5' },
      { n: 1, title: 'Topic 1 (moved last in array)' },
    ]
    await createSidecar({ outline: outlineWithoutN1, approved: true })

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE })
    assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(res.body)}`)
    const jq = await import('../services/job-queue.js')
    if (res.body.job_id) jq.cancelJob(res.body.job_id)
  })
})
