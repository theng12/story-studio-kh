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
