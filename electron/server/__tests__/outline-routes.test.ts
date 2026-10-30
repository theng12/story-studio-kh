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
import { _setAutomaticRetryForTesting } from '../services/job-retry-policy.js'
// These tests pin manual Retry; writing jobs auto-retry after a minute since R1 (2026-10-07).
_setAutomaticRetryForTesting(false)

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

  // Seed the sole generation boundary with inert local test credentials.
  // Queueing may begin immediately after a 201, so the URL must never point
  // at a paid or externally reachable provider.
  const urlResult = await request(app)
    .put('/api/app-settings/genstudio')
    .send({ url: 'http://127.0.0.1:9' })
  assert.equal(urlResult.status, 200)
  const keyResult = await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_outline_routes_not_real' })
  assert.equal(keyResult.status, 200)

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
  episodeId?: string
} = {}) {
  const episodeId = opts.episodeId ?? EPISODE_ID
  const total = opts.total ?? TOTAL_CHAPTERS
  const outline = opts.outline ?? Array.from({ length: total }, (_, i) => ({
    n: i + 1,
    title: `Topic ${i + 1}`,
    hook_line: `Hook ${i + 1}`,
  }))
  const now = new Date().toISOString()
  const sidecar = {
    schema_version: 2,
    episode_id: episodeId,
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
  const targetScriptDir = episodeId === EPISODE_ID
    ? scriptDir
    : (await (await import('../services/utils.js')).resolveEpisodePaths(slug, episodeId, TITLE)).script_dir
  await fs.mkdir(targetScriptDir, { recursive: true })
  await fs.writeFile(path.join(targetScriptDir, `${episodeId}_chunked-progress.json`), JSON.stringify(sidecar, null, 2))
}

async function terminalExpansionJob(
  episodeId: string,
  params: Record<string, unknown> = { model: 'old-model' },
  extraChatEntries: Array<{ id: string, state: string }> = [],
) {
  const jq = await import('../services/job-queue.js')
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  const original = jq.enqueuePreparedForTest({
    project_slug: slug,
    type: 'expand_chapters',
    episode_id: episodeId,
    title: TITLE,
    params,
  })
  await jq.requestJobCancellation(slug, original.job_id)
  if (!wasPaused) await jq.setQueuePaused(false)
  await jq.recordGenStudioJob(original.job_id, {
    id: `job-terminal-${original.job_id}`,
    operation: 'chat.response',
    state: 'failed',
    failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
    updated_at: new Date().toISOString(),
  })
  for (const entry of extraChatEntries) {
    await jq.recordGenStudioJob(original.job_id, {
      ...entry,
      operation: 'chat.response',
      updated_at: new Date().toISOString(),
    })
  }
  return original
}

/**
 * Clear one expand job, and do not return until it is really gone.
 *
 * This used to leak, and the leak surfaced two tests later as a baffling
 * message: a lingering EP001 job made a later POST answer "Chapter expansion
 * already queued/running for EP001" instead of the "same episode" refusal that
 * test was asserting. Two reasons, both load-sensitive:
 *
 *   - cancellation was requested but never waited for. `requestJobCancellation`
 *     is a REQUEST; the job reaches `cancelled` a moment later, so the
 *     `removeTerminalJob` below was skipped on a job that was about to settle.
 *   - the wait was 2 seconds, and only on the other branch. On a busy machine
 *     a running expand job does not always settle that fast.
 *
 * Both are now one path with room to breathe, and the final assertion makes a
 * failure land HERE, naming the job that would not clear, instead of in a
 * later test that never touched it.
 */
async function clearExpandJob(jobId: string) {
  const jq = await import('../services/job-queue.js')
  const initial = jq.getJob(jobId)
  if (!initial) return
  if (initial.status === 'queued' || initial.status === 'paused') {
    await jq.requestJobCancellation(slug, jobId)
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || '')) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const terminal = jq.getJob(jobId)
  if (terminal && ['done', 'error', 'cancelled'].includes(terminal.status)) {
    jq.removeTerminalJob(slug, jobId)
  }
  assert.equal(jq.getJob(jobId), null,
    `expand job ${jobId} was still ${jq.getJob(jobId)?.status} after clearing — `
    + 'a later test will fail on this instead of here')
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

  test('editing a v3 outline preserves its generation snapshot for chapter expansion', async () => {
    const direction = 'Keep every chapter multi-causal and distinguish fact from interpretation.'
    await fs.mkdir(scriptDir, { recursive: true })
    const now = new Date().toISOString()
    const outline = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({
      n: i + 1,
      title: `Topic ${i + 1}`,
      hook_line: `Hook ${i + 1}`,
    }))
    await fs.writeFile(sidecarFile, JSON.stringify({
      schema_version: 3,
      episode_id: EPISODE_ID,
      mode: 'listicle',
      total_chapters: TOTAL_CHAPTERS,
      outline,
      outline_completed_at: now,
      outline_approved_at: null,
      outline_edited_at: null,
      generation_params: {
        model: 'test-model',
        words_per_chapter: 607,
        manual_guidance: direction,
      },
      chapters_done: [],
      params_hash: 'v3-snapshot-hash',
      last_updated: now,
    }, null, 2))

    const putResult = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline, approved: true })
    assert.equal(putResult.status, 200)

    const onDisk = JSON.parse(await fs.readFile(sidecarFile, 'utf-8'))
    assert.equal(onDisk.schema_version, 3)
    assert.equal(onDisk.generation_params.manual_guidance, direction)

    const getResult = await request(app)
      .get(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
    assert.equal(getResult.status, 200)
    assert.equal(getResult.body.generation_params.manual_guidance, direction)
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

  test('preserves outline_approved_at across silent autosave with approved=true (1b)', async () => {
    // First approval — outline_approved_at gets stamped to nowIso.
    await createSidecar()
    const full = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({ n: i + 1, title: `t${i + 1}` }))
    const first = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: full, approved: true })
    assert.equal(first.status, 200)
    const firstApprovedAt = first.body.outline_approved_at
    assert.ok(firstApprovedAt, 'first approval must populate outline_approved_at')

    // Wait long enough that nowIso would change if the route bumped it.
    await new Promise(r => setTimeout(r, 25))

    // Subsequent silent autosave (a frontend keystroke + 600ms debounce
    // re-fires saveEdits with `approved: !!approvedAt.value` === true).
    // The route must NOT re-stamp outline_approved_at — otherwise the UI
    // shows "Approved 0m ago" perpetually as the user keeps editing.
    const edited = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({ n: i + 1, title: `t${i + 1}-edited` }))
    const second = await request(app)
      .put(`/api/projects/${slug}/episodes/${EPISODE_ID}/outline?title=${encodeURIComponent(TITLE)}`)
      .send({ outline: edited, approved: true })
    assert.equal(second.status, 200)
    assert.equal(second.body.outline_approved_at, firstApprovedAt,
      'second PUT with approved=true must preserve the original approval timestamp')

    // outline_edited_at MUST advance — that's the "last-edited" signal,
    // not the approval timestamp.
    assert.ok(second.body.outline_edited_at)
    assert.notEqual(second.body.outline_edited_at, firstApprovedAt,
      'outline_edited_at advances on each edit even when approved-at is preserved')
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
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters_to_expand: 'all' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /must be an array/)
  })

  test('rejects out-of-range chapter number', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters_to_expand: [1, 99] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Invalid chapter number/)
  })

  test('rejects non-integer chapter number', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters_to_expand: [1.5] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Invalid chapter number/)
  })

  test('rejects NaN entries', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters_to_expand: ['abc'] })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Invalid chapter number/)
  })

  test('accepts valid chapter numbers (queues a job)', async () => {
    await createSidecar({ approved: true })
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters_to_expand: [1, 3] })
    assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(res.body)}`)
    assert.ok(res.body.job_id, 'must return a job_id')
    // Cancel the queued job so it doesn't keep running in the test process.
    const jq = await import('../services/job-queue.js')
    if (res.body.job_id) await clearExpandJob(res.body.job_id)
  })

  test('replays an accepted expansion, rejects a changed replay, and permits a new action', async () => {
    await createSidecar({ approved: true })
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    const firstAction = '10000000-0000-4000-8000-000000000001'
    const secondAction = '20000000-0000-4000-8000-000000000002'
    const submit = (operation_id: string, chapters_to_expand: number[]) => request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, chapters_to_expand, operation_id })

    try {
      const first = await submit(firstAction, [1])
      assert.equal(first.status, 201, JSON.stringify(first.body))

      const replay = await submit(firstAction, [1])
      assert.equal(replay.status, 200, JSON.stringify(replay.body))
      assert.equal(replay.body.job_id, first.body.job_id)
      assert.equal(replay.body.reused, true)

      const changedReplay = await submit(firstAction, [2])
      assert.equal(changedReplay.status, 409)
      assert.match(changedReplay.body.detail, /operation_id already belongs to a different chapter expansion/i)

      await clearExpandJob(first.body.job_id)
      const newAction = await submit(secondAction, [2])
      assert.equal(newAction.status, 201, JSON.stringify(newAction.body))
      assert.notEqual(newAction.body.job_id, first.body.job_id)
      await clearExpandJob(newAction.body.job_id)
    } finally {
      await jq.setQueuePaused(wasPaused)
    }
  })
})

describe('POST /expand-chapters — terminal manual retry', () => {
  test('manual redo validates the strict intent and is mutually exclusive with Resume', async () => {
    await createSidecar({ approved: true })
    const operation_id = '30000000-0000-4000-8000-000000000003'
    for (const manual_redo of [
      {},
      { intent: 'replace_unresolved' },
      { intent: 'replace_unresolved', source_job_id: 'source', extra: true },
    ]) {
      const res = await request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send({
        episode_id: EPISODE_ID, title: TITLE, operation_id, manual_redo,
      })
      assert.equal(res.status, 400, JSON.stringify(res.body))
    }
    const both = await request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send({
      episode_id: EPISODE_ID, title: TITLE, operation_id,
      terminal_retry_job_id: 'source',
      manual_redo: { intent: 'replace_unresolved', source_job_id: 'source' },
    })
    assert.equal(both.status, 400)
    assert.match(both.body.detail, /manual_redo.*terminal_retry_job_id|terminal_retry_job_id.*manual_redo/i)
  })

  test('manual redo preserves unresolved source evidence and creates one linked fresh job', async () => {
    await createSidecar({ approved: true })
    const source = await terminalExpansionJob(
      EPISODE_ID,
      { model: 'old-model' },
      [{ id: 'pending:manual-redo-route', state: 'submitting' }],
    )
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    const operation_id = '40000000-0000-4000-8000-000000000004'
    const body = {
      episode_id: EPISODE_ID, title: TITLE, model: 'current-live-model', operation_id,
      manual_redo: { intent: 'replace_unresolved', source_job_id: source.job_id },
    }
    try {
      const first = await request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send(body)
      assert.equal(first.status, 201, JSON.stringify(first.body))
      const replacement = jq.getJob(first.body.job_id)
      const retained = jq.getJob(source.job_id)
      assert.equal(retained?.force_abandoned?.unsettled.length, 1)
      assert.equal(retained?.genstudio_jobs?.some(entry => entry.id === 'pending:manual-redo-route'), true)
      assert.deepEqual(replacement?.params.manual_redo, {
        version: 1,
        intent: 'replace_unresolved',
        source_job_id: source.job_id,
        requested_at: replacement?.params.manual_redo.requested_at,
        target_chapters: [1, 2, 3, 4, 5],
        selected_model_id: 'current-live-model',
      })

      // A late chapter can land before the client retries a lost response.
      // Server-derived missing chapters must stay bound to the accepted action.
      await fs.writeFile(path.join(scriptDir, `${EPISODE_ID}_Chapter_01.md`), 'late valid chapter')

      const replay = await request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send(body)
      assert.equal(replay.status, 200)
      assert.equal(replay.body.job_id, first.body.job_id)

      const changed = await request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send({ ...body, model: 'other-live-model' })
      assert.equal(changed.status, 409)
      await clearExpandJob(first.body.job_id)
      jq.removeTerminalJob(slug, source.job_id)
    } finally {
      await jq.setQueuePaused(wasPaused)
    }
  })

  test('manual redo rejects missing, wrong-project/type/episode, and resolved source evidence', async () => {
    await createSidecar({ approved: true })
    const jq = await import('../services/job-queue.js')
    const submit = (source_job_id: string) => request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        operation_id: crypto.randomUUID(),
        manual_redo: { intent: 'replace_unresolved', source_job_id },
      })

    const missing = await submit('missing-manual-redo-source')
    assert.equal(missing.status, 404)

    const makeStopped = async (project_slug: string, type: 'expand_chapters' | 'chapter-only', episode_id: string) => {
      const wasPaused = jq.isQueuePaused()
      await jq.setQueuePaused(true)
      const job = jq.enqueuePreparedForTest({
        project_slug, type, episode_id, title: TITLE, params: { model: 'old-model', chapter_number: 2 },
      })
      await jq.requestJobCancellation(project_slug, job.job_id)
      if (!wasPaused) await jq.setQueuePaused(false)
      await jq.recordGenStudioJob(job.job_id, {
        id: `pending:${job.job_id}`,
        operation: 'chat.response',
        state: 'submitting',
        updated_at: new Date().toISOString(),
      })
      return job
    }

    const wrongProject = await makeStopped('other-manual-redo-project', 'expand_chapters', EPISODE_ID)
    assert.equal((await submit(wrongProject.job_id)).status, 404)

    const wrongType = await makeStopped(slug, 'chapter-only', EPISODE_ID)
    assert.equal((await submit(wrongType.job_id)).status, 409)

    const wrongEpisode = await terminalExpansionJob('EP999')
    const wrong = await submit(wrongEpisode.job_id)
    assert.equal(wrong.status, 409)

    const resolved = await terminalExpansionJob(EPISODE_ID)
    await (await import('../services/job-queue.js')).recordGenStudioJob(resolved.job_id, {
      id: `job-terminal-${resolved.job_id}`,
      operation: 'chat.response',
      state: 'failed',
      failure_code: 'PROVIDER_REJECTED',
      updated_at: new Date().toISOString(),
    })
    const settled = await submit(resolved.job_id)
    assert.equal(settled.status, 409)
    assert.match(settled.body.detail, /no unresolved Gateway chat request/i)

    jq.removeTerminalJob('other-manual-redo-project', wrongProject.job_id)
    jq.removeTerminalJob(slug, wrongType.job_id)
    jq.removeTerminalJob(slug, wrongEpisode.job_id)
    jq.removeTerminalJob(slug, resolved.job_id)
  })

  test('manual redo cannot overlap a paused targeted chapter writer', async () => {
    await createSidecar({ approved: true })
    const source = await terminalExpansionJob(
      EPISODE_ID,
      { model: 'old-model' },
      [{ id: 'pending:manual-redo-chapter-lane', state: 'submitting' }],
    )
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    const targeted = jq.enqueuePreparedForTest({
      project_slug: slug,
      type: 'chapter-only',
      episode_id: EPISODE_ID,
      title: TITLE,
      params: { chapter_number: 2, model: 'current-live-model' },
    })
    try {
      const res = await request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        operation_id: '50000000-0000-4000-8000-000000000005',
        manual_redo: { intent: 'replace_unresolved', source_job_id: source.job_id },
      })
      assert.equal(res.status, 409)
      assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
    } finally {
      await clearExpandJob(targeted.job_id)
      await jq.forceAbandonJob(slug, source.job_id)
      jq.removeTerminalJob(slug, source.job_id)
      await jq.setQueuePaused(wasPaused)
    }
  })

  test('targeted chapter regeneration cannot overlap a paused expansion writer', async () => {
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    const expansion = jq.enqueuePreparedForTest({
      project_slug: slug,
      type: 'expand_chapters',
      episode_id: EPISODE_ID,
      title: TITLE,
      params: { model: 'current-live-model' },
    })
    try {
      const res = await request(app).post(`/api/projects/${slug}/generate/chapter-only`).send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        chapter_number: 2,
        operation_id: '60000000-0000-4000-8000-000000000006',
      })
      assert.equal(res.status, 409)
      assert.match(res.body.detail, /already queued\/running/i)
    } finally {
      await clearExpandJob(expansion.job_id)
      await jq.setQueuePaused(wasPaused)
    }
  })

  test('simultaneous opposite chapter writers admit only the first lock waiter in both orders', async () => {
    await createSidecar({ approved: true })
    const jq = await import('../services/job-queue.js')

    for (const firstType of ['expand_chapters', 'chapter-only'] as const) {
      const source = await terminalExpansionJob(
        EPISODE_ID,
        { model: 'old-model' },
        [{ id: `pending:opposite-${firstType}`, state: 'submitting' }],
      )
      const wasPaused = jq.isQueuePaused()
      await jq.setQueuePaused(true)
      let release!: () => void
      const released = new Promise<void>(resolve => { release = resolve })
      let firstEntered!: () => void
      const firstAtBarrier = new Promise<void>(resolve => { firstEntered = resolve })
      let bothEntered!: () => void
      const bothAtBarrier = new Promise<void>(resolve => { bothEntered = resolve })
      const arrivals: string[] = []
      const restoreProbe = jq._setEpisodeAdmissionProbeForTesting(async scope => {
        if (scope.project_slug !== slug || scope.episode_id !== EPISODE_ID
          || (scope.type !== 'expand_chapters' && scope.type !== 'chapter-only')) return
        arrivals.push(scope.type)
        if (arrivals.length === 1) firstEntered()
        if (arrivals.length === 2) bothEntered()
        await released
      })
      const manual = () => request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        operation_id: crypto.randomUUID(),
        manual_redo: { intent: 'replace_unresolved', source_job_id: source.job_id },
      }).then(response => response)
      const targeted = () => request(app).post(`/api/projects/${slug}/generate/chapter-only`).send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        chapter_number: 2,
        operation_id: crypto.randomUUID(),
      }).then(response => response)
      const submit = firstType === 'expand_chapters' ? manual : targeted
      const submitOther = firstType === 'expand_chapters' ? targeted : manual
      let responses: any[] = []
      let sourceWasAbandoned = false
      try {
        const first = submit()
        await firstAtBarrier
        const second = submitOther()
        await bothAtBarrier
        release()
        responses = await Promise.all([first, second])
        sourceWasAbandoned = !!jq.getJob(source.job_id)?.force_abandoned
      } finally {
        release()
        restoreProbe()
        for (const response of responses) {
          if (response.status === 201 && response.body.job_id) await clearExpandJob(response.body.job_id)
        }
        if (jq.getJob(source.job_id) && !jq.getJob(source.job_id)?.force_abandoned) {
          await jq.forceAbandonJob(slug, source.job_id)
        }
        jq.removeTerminalJob(slug, source.job_id)
        await jq.setQueuePaused(wasPaused)
      }

      assert.deepEqual(arrivals, [firstType, firstType === 'expand_chapters' ? 'chapter-only' : 'expand_chapters'])
      assert.equal(responses[0]?.status, 201, JSON.stringify(responses[0]?.body))
      assert.equal(responses[1]?.status, 409, JSON.stringify(responses[1]?.body))
      assert.equal(responses.filter(response => response.status === 201).length, 1)
      assert.equal(responses[0]?.body.status, 'queued', 'the queue stayed paused, so no provider work was submitted')
      assert.equal(sourceWasAbandoned, firstType === 'expand_chapters',
        'a refused manual expansion must not abandon its unresolved source')
    }
  })

  test('concurrent identical manual operation IDs adopt the same accepted job', async () => {
    await createSidecar({ approved: true })
    const source = await terminalExpansionJob(
      EPISODE_ID,
      { model: 'old-model' },
      [{ id: 'pending:identical-manual-operation', state: 'submitting' }],
    )
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    let entered!: () => void
    const atBarrier = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let arrivals = 0
    const restoreProbe = jq._setEpisodeAdmissionProbeForTesting(async scope => {
      if (scope.project_slug === slug && scope.episode_id === EPISODE_ID && scope.type === 'expand_chapters') {
        arrivals++
        entered()
        await released
      }
    })
    const body = {
      episode_id: EPISODE_ID,
      title: TITLE,
      model: 'current-live-model',
      operation_id: '70000000-0000-4000-8000-000000000007',
      manual_redo: { intent: 'replace_unresolved', source_job_id: source.job_id },
    }
    let responses: any[] = []
    try {
      const first = request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send(body).then(response => response)
      await atBarrier
      const replay = request(app).post(`/api/projects/${slug}/generate/expand-chapters`).send(body).then(response => response)
      release()
      responses = await Promise.all([first, replay])
    } finally {
      release()
      restoreProbe()
      const accepted = responses.find(response => response.status === 201)
      if (accepted?.body.job_id) await clearExpandJob(accepted.body.job_id)
      jq.removeTerminalJob(slug, source.job_id)
      await jq.setQueuePaused(wasPaused)
    }

    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201])
    assert.equal(responses[0]?.body.job_id, responses[1]?.body.job_id)
    assert.equal(arrivals, 1, 'same-operation replay waits for and adopts the admitted job')
  })

  test('Jobs Retry and manual redo share one chapter-writer admission boundary', async () => {
    await createSidecar({ approved: true })
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)

    const makeRetrySource = async () => {
      const job = jq.enqueuePreparedForTest({
        project_slug: slug,
        type: 'chapter-only',
        episode_id: EPISODE_ID,
        title: TITLE,
        params: { chapter_number: 2, model: 'current-live-model' },
        dedupeParams: (params: any) => Number(params?.chapter_number) === 2,
      })
      await jq.requestJobCancellation(slug, job.job_id)
      assert.equal(jq.getJob(job.job_id)?.status, 'cancelled')
      return job
    }
    const submitManual = (sourceJobId: string) => request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        operation_id: crypto.randomUUID(),
        manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
      })
      .then(response => response)

    try {
      // Manual redo owns admission first and pauses immediately before its
      // destructive source-abandon callback. A synchronous Jobs Retry must see
      // that ownership and lose without entering the queue.
      const manualSource = await terminalExpansionJob(
        EPISODE_ID,
        { model: 'old-model' },
        [{ id: 'pending:jobs-retry-manual-first', state: 'submitting' }],
      )
      const retrySource = await makeRetrySource()
      let releaseManual!: () => void
      const manualReleased = new Promise<void>(resolve => { releaseManual = resolve })
      let manualReserved!: () => void
      const manualAtBoundary = new Promise<void>(resolve => { manualReserved = resolve })
      const restoreBoundaryProbe = jq._setChapterWriterAdmissionCallbackProbeForTesting(async scope => {
        if (scope.project_slug === slug && scope.episode_id === EPISODE_ID && scope.type === 'expand_chapters') {
          manualReserved()
          await manualReleased
        }
      })
      let manualResponse: any
      let retryResponse: any
      try {
        const manual = submitManual(manualSource.job_id)
        await manualAtBoundary
        retryResponse = await request(app).post(`/api/projects/${slug}/jobs/${retrySource.job_id}/retry`).send({})
        releaseManual()
        manualResponse = await manual
      } finally {
        releaseManual()
        restoreBoundaryProbe()
      }
      assert.equal(manualResponse.status, 201, JSON.stringify(manualResponse.body))
      assert.equal(retryResponse.status, 409, JSON.stringify(retryResponse.body))
      assert.ok(jq.getJob(manualSource.job_id)?.force_abandoned)
      assert.equal(jq.getJob(retrySource.job_id)?.status, 'cancelled')
      await clearExpandJob(manualResponse.body.job_id)
      jq.removeTerminalJob(slug, manualSource.job_id)
      jq.removeTerminalJob(slug, retrySource.job_id)

      // Reverse the order with the existing pre-lock barrier: Jobs Retry wins
      // insertion while manual redo is waiting to acquire admission. Manual
      // then loses before its callback, leaving its source byte-for-byte live.
      const reverseManualSource = await terminalExpansionJob(
        EPISODE_ID,
        { model: 'old-model' },
        [{ id: 'pending:jobs-retry-retry-first', state: 'submitting' }],
      )
      const reverseRetrySource = await makeRetrySource()
      let releasePreLock!: () => void
      const preLockReleased = new Promise<void>(resolve => { releasePreLock = resolve })
      let manualReachedPreLock!: () => void
      const manualAtPreLock = new Promise<void>(resolve => { manualReachedPreLock = resolve })
      const restorePreLockProbe = jq._setEpisodeAdmissionProbeForTesting(async scope => {
        if (scope.project_slug === slug && scope.episode_id === EPISODE_ID && scope.type === 'expand_chapters') {
          manualReachedPreLock()
          await preLockReleased
        }
      })
      let reverseManualResponse: any
      let reverseRetryResponse: any
      try {
        const manual = submitManual(reverseManualSource.job_id)
        await manualAtPreLock
        reverseRetryResponse = await request(app).post(`/api/projects/${slug}/jobs/${reverseRetrySource.job_id}/retry`).send({})
        releasePreLock()
        reverseManualResponse = await manual
      } finally {
        releasePreLock()
        restorePreLockProbe()
      }
      assert.equal(reverseRetryResponse.status, 202, JSON.stringify(reverseRetryResponse.body))
      assert.equal(reverseManualResponse.status, 409, JSON.stringify(reverseManualResponse.body))
      assert.equal(jq.getJob(reverseManualSource.job_id)?.force_abandoned, undefined)
      assert.equal(jq.getJob(reverseManualSource.job_id)?.genstudio_jobs?.some(entry => entry.id === 'pending:jobs-retry-retry-first'), true)
      const acceptedRetryId = reverseRetryResponse.body.job?.job_id
      assert.ok(acceptedRetryId)
      await clearExpandJob(acceptedRetryId)
      await jq.forceAbandonJob(slug, reverseManualSource.job_id)
      jq.removeTerminalJob(slug, reverseManualSource.job_id)
      await jq._waitForJobPersistenceForTesting()
      assert.equal(jq.getJob(manualSource.job_id), null)
      assert.equal(jq.getJob(reverseManualSource.job_id), null)
    } finally {
      await jq.setQueuePaused(wasPaused)
    }
  })

  test('terminal-visible opposite chapter writers remain mutually excluded until their executor releases', async () => {
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    await jq.setQueuePaused(false)
    try {
      for (const activeType of ['expand_chapters', 'chapter-only'] as const) {
        const blockedType = activeType === 'expand_chapters' ? 'chapter-only' : 'expand_chapters'
        let terminalVisible!: () => void
        const terminalAtBarrier = new Promise<void>(resolve => { terminalVisible = resolve })
        let releaseWorker!: () => void
        const workerGate = new Promise<void>(resolve => { releaseWorker = resolve })
        let activeJobId = ''
        const restoreExecutor = jq._setExecutorForTesting(activeType, async job => {
          job.status = 'error'
          job.finished_at = new Date().toISOString()
          terminalVisible()
          await workerGate
        })
        try {
          const active = await jq.enqueue({
            project_slug: slug,
            type: activeType,
            episode_id: EPISODE_ID,
            title: TITLE,
            params: { model: 'current-live-model', chapter_number: 2 },
            ...(activeType === 'chapter-only'
              ? { dedupeParams: (params: any) => Number(params?.chapter_number) === 2 }
              : {}),
          })
          activeJobId = active.job_id
          await terminalAtBarrier
          assert.equal(jq.getJob(active.job_id)?.status, 'error')
          assert.equal(jq._isJobWorkerActiveForTesting(active.job_id), true)
          const blockedBefore = (await jq.findJobs(
            slug,
            job => job.episode_id === EPISODE_ID && job.type === blockedType,
          )).length

          await assert.rejects(jq.enqueue({
            project_slug: slug,
            type: blockedType,
            episode_id: EPISODE_ID,
            title: TITLE,
            params: { model: 'current-live-model', chapter_number: 3 },
            ...(blockedType === 'chapter-only'
              ? { dedupeParams: (params: any) => Number(params?.chapter_number) === 3 }
              : {}),
          }), /already queued\/running/i)
          assert.equal((await jq.findJobs(
            slug,
            job => job.episode_id === EPISODE_ID && job.type === blockedType,
          )).length, blockedBefore)
        } finally {
          releaseWorker()
          while (activeJobId && jq._isJobWorkerActiveForTesting(activeJobId)) {
            await new Promise<void>(resolve => setImmediate(resolve))
          }
          restoreExecutor()
          if (activeJobId) jq.removeTerminalJob(slug, activeJobId)
        }
      }
    } finally {
      await jq.setQueuePaused(wasPaused)
    }
  })

  test('uses the current validated model while replacing the referenced terminal job', async () => {
    await createSidecar({ approved: true })
    const original = await terminalExpansionJob(EPISODE_ID)

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        terminal_retry_job_id: original.job_id,
      })

    assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(res.body)}`)
    const jq = await import('../services/job-queue.js')
    const replacement = jq.getJob(res.body.job_id)
    await clearExpandJob(res.body.job_id)
    assert.equal(replacement?.params.model, 'current-live-model')
    assert.equal(replacement?.genstudio_chat_retry_scope, `terminal:job-terminal-${original.job_id}:${original.job_id}`)
    assert.equal(jq.getJob(original.job_id), null, 'replacement removes the terminal source only after enqueue')
  })

  test('rejects a terminal retry job from another episode', async () => {
    await createSidecar({ approved: true })
    const foreignEpisodeJob = await terminalExpansionJob('EP002')

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'current-live-model',
        terminal_retry_job_id: foreignEpisodeJob.job_id,
      })

    assert.equal(res.status, 409)
    assert.match(res.body.detail, /same episode/)
    const jq = await import('../services/job-queue.js')
    assert.equal(jq.getJob(foreignEpisodeJob.job_id)?.status, 'cancelled')
  })

  test('rejects a terminal retry while another chapter expansion is active without replacing either job', async () => {
    await createSidecar({ approved: true })
    const terminalSource = await terminalExpansionJob(EPISODE_ID)
    const jq = await import('../services/job-queue.js')
    await jq.setQueuePaused(true)
    const active = jq.enqueuePreparedForTest({
      project_slug: slug,
      type: 'expand_chapters',
      episode_id: EPISODE_ID,
      title: TITLE,
      params: { model: 'active-model' },
    })

    try {
      const res = await request(app)
        .post(`/api/projects/${slug}/generate/expand-chapters`)
        .send({
          episode_id: EPISODE_ID,
          title: TITLE,
          model: 'current-live-model',
          terminal_retry_job_id: terminalSource.job_id,
        })

      assert.equal(res.status, 409)
      assert.equal(jq.getJob(terminalSource.job_id)?.status, 'cancelled')
      assert.equal(jq.getJob(active.job_id)?.status, 'queued')
    } finally {
      await clearExpandJob(active.job_id)
      await jq.setQueuePaused(false)
    }
  })

  test('replays a mixed chat source with its historical model instead of the current form model', async () => {
    await createSidecar({ approved: true })
    const source = await terminalExpansionJob(
      EPISODE_ID,
      { model: 'old-model' },
      [{ id: 'job-unresolved-route-replay', state: 'running' }],
    )

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'new-selected-model',
        terminal_retry_job_id: source.job_id,
      })

    assert.equal(res.status, 201)
    const jq = await import('../services/job-queue.js')
    const retry = jq.getJob(res.body.job_id)
    await clearExpandJob(res.body.job_id)
    assert.equal(retry?.params.model, 'old-model')
    assert.equal(retry?.genstudio_chat_retry_scope, undefined)
  })

  test('rejects an unreferenced expansion while a terminal source has unresolved chat evidence', async () => {
    await createSidecar({ approved: true })
    const source = await terminalExpansionJob(
      EPISODE_ID,
      { model: 'old-model' },
      [{ id: 'pending:story-chat-route-block', state: 'submitting' }],
    )

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({
        episode_id: EPISODE_ID,
        title: TITLE,
        model: 'new-selected-model',
        chapters_to_expand: [1],
      })

    assert.equal(res.status, 409)
    // Plain words naming the button that finishes it, not queue jargon.
    assert.match(res.body.detail, /stopped part-way/)
    assert.match(res.body.detail, /"Resume writing"/)
    assert.doesNotMatch(res.body.detail, /terminal|evidence/i)
    const jq = await import('../services/job-queue.js')
    assert.equal(jq.getJob(source.job_id)?.status, 'cancelled')
    jq.removeTerminalJob(slug, source.job_id)
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
      await clearExpandJob(j.job_id)
    }
  }
  await new Promise(r => setTimeout(r, 50))
  // Removal intentionally preserves terminal jobs with unsettled evidence.
  // The probe below therefore uses a different episode, rather than trying
  // to erase the preceding fail-closed fixture.
  for (const j of await jq.getJobs(slug)) {
    if (j.type === 'expand_chapters' && ['done', 'error', 'cancelled'].includes(j.status)) {
      jq.removeTerminalJob(slug, j.job_id)
    }
  }
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
    const probeEpisodeId = 'EP002'
    await createSidecar({ outline: outlineWithoutN1, approved: true, episodeId: probeEpisodeId })

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: probeEpisodeId, title: TITLE })
    assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(res.body)}`)
    const jq = await import('../services/job-queue.js')
    if (res.body.job_id) await clearExpandJob(res.body.job_id)
  })
})

describe('an outline edit keeps the outline it replaces (owner rule, 2026-10-30)', () => {
  test('PUT copies the previous sidecar to Story Trash before writing', async () => {
    const episodeId = 'EP003'
    await createSidecar({ approved: true, episodeId })
    const sidecarFile = path.join(
      (await (await import('../services/utils.js')).resolveEpisodePaths(slug, episodeId, TITLE)).script_dir,
      `${episodeId}_chunked-progress.json`,
    )
    const before = await fs.readFile(sidecarFile, 'utf-8')
    const edit = JSON.parse(before)
    edit.outline = edit.outline.map((entry: any) => ({ ...entry, title: `${entry.title} (edited)` }))

    const res = await request(app)
      .put(`/api/projects/${slug}/episodes/${episodeId}/outline`)
      .send({ outline: edit.outline })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.notEqual(await fs.readFile(sidecarFile, 'utf-8'), before, 'the sidecar really was replaced')

    // The previous outline is in Story's Trash under its script-versions folder.
    const trashRoot = path.join(tempDir, 'projects', '_trash', slug, 'script-versions')
    const preserved: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const target = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(target)
        else if (entry.isFile() && entry.name === `${episodeId}_chunked-progress.json`) preserved.push(target)
      }
    }
    await walk(trashRoot)
    assert.equal(preserved.length, 1, `one preserved outline, found ${JSON.stringify(preserved)}`)
    assert.match(preserved[0]!, /[\\/]outline-edit-[0-9]+[\\/]/)
    assert.equal(await fs.readFile(preserved[0]!, 'utf-8'), before, 'the copy is the outline that was replaced')
  })
})
