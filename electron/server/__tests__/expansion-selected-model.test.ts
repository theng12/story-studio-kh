/**
 * Chapter expansion honours the SELECTED model, and completed chapters
 * survive the change.
 *
 * THE BUG THIS GUARDS (v1.0.786)
 * ------------------------------
 * An episode had 9 of 10 chapters expanded. GenStudio renamed and re-versioned
 * the product the outline had been built with, so the id recorded in the
 * outline sidecar's `generation_params.model` stopped resolving. Expansion
 * preferred that recorded id over the model actually selected in the form, so
 * every attempt at chapter 10 died with
 *
 *   The selected GenStudio language product "genstudio-chat-…-v1" is not
 *   available. Choose a published product before retrying.
 *
 * with a perfectly good model sitting in the form and no way to reach it. A
 * stored model id is a CACHED MODEL REFERENCE — AGENTS.md's first rule forbids
 * exactly this, because catalogue ids go stale and cached ones dead-end.
 *
 * The consistency argument for locking the model (one voice across all
 * chapters) is real, so the fix is not to drop it silently: the request body's
 * model wins, and the change is ANNOUNCED — in the job log here, and in the
 * outline panel before the user clicks Expand.
 *
 * THE COST OF GETTING THE RESUME WRONG IS NINE PAID REGENERATIONS, so the
 * last section proves that a model change touches nothing already on disk.
 *
 * ZERO paid calls: the sole generation boundary points at 127.0.0.1:9 and
 * every case here either short-circuits before any request or asserts on
 * state written locally.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { _setAutomaticRetryForTesting } from '../services/job-retry-policy.js'
// These tests pin which model reaches the queue; writing jobs auto-retry after a minute since R1.
_setAutomaticRetryForTesting(false)

let tempDir: string
let cleanup: () => Promise<void>
let app: any

const EPISODE_ID = 'EP001'
const TITLE = 'Selected Model Test'
const TOTAL_CHAPTERS = 10

/** The id GenStudio re-versioned out from under the outline. */
const STALE_OUTLINE_MODEL = 'genstudio-chat:genstudio-chat-b7abf15650287980589c-v1'
/** What the form has selected now. */
const SELECTED_MODEL = 'genstudio-chat:deepseek-v4-flash'

let slug: string
let scriptDir: string
let sidecarFile: string

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup

  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const mod = await import('../app.js')
  app = mod.app

  const proj = await request(app).post('/api/projects').send({
    name: 'Selected Model Test',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(proj.status, 201)
  slug = proj.body.slug

  // Inert local credentials. A queued job may start the moment a 201 lands,
  // so the URL must never point at a paid or externally reachable provider.
  assert.equal((await request(app)
    .put('/api/app-settings/genstudio')
    .send({ url: 'http://127.0.0.1:9' })).status, 200)
  assert.equal((await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_selected_model_not_real' })).status, 200)

  const { resolveEpisodePaths } = await import('../services/utils.js')
  const paths = await resolveEpisodePaths(slug, EPISODE_ID, TITLE)
  scriptDir = paths.script_dir
  sidecarFile = path.join(scriptDir, `${EPISODE_ID}_chunked-progress.json`)
})

after(async () => { await cleanup() })

/** A v3 sidecar whose generation_params record the now-dead model id. */
async function seedSidecar(opts: { model?: string | null; chaptersDone?: number[] } = {}) {
  const now = new Date().toISOString()
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(sidecarFile, JSON.stringify({
    schema_version: 3,
    episode_id: EPISODE_ID,
    mode: 'listicle',
    total_chapters: TOTAL_CHAPTERS,
    outline: Array.from({ length: TOTAL_CHAPTERS }, (_, i) => ({
      n: i + 1,
      title: `Topic ${i + 1}`,
      hook_line: `Hook ${i + 1}`,
    })),
    outline_completed_at: now,
    outline_approved_at: now,
    outline_edited_at: null,
    chapters_done: opts.chaptersDone ?? [],
    params_hash: 'fakehash00000000',
    last_updated: now,
    generation_params: opts.model === null ? null : {
      model: opts.model ?? STALE_OUTLINE_MODEL,
      words_per_chapter: 400,
      total_words: 4_000,
      style: 'A',
    },
  }, null, 2))
}

/** Write chapter files 1..n so the resume path sees them as real work done. */
async function seedChapterFiles(count: number): Promise<Map<number, string>> {
  const { chapterFilePath } = await import('../lib/narration-assembly.js')
  const written = new Map<number, string>()
  for (let n = 1; n <= count; n++) {
    const body = `## Chapter ${String(n).padStart(2, '0')}: Topic ${n}\n\n`
      + `Paid prose for chapter ${n}. Written by ${STALE_OUTLINE_MODEL}.\n`
    const file = chapterFilePath(scriptDir, EPISODE_ID, n)
    await fs.writeFile(file, body)
    written.set(n, body)
  }
  return written
}

async function readChapterFiles(count: number): Promise<Map<number, string>> {
  const { chapterFilePath } = await import('../lib/narration-assembly.js')
  const seen = new Map<number, string>()
  for (let n = 1; n <= count; n++) {
    const file = chapterFilePath(scriptDir, EPISODE_ID, n)
    seen.set(n, await fs.readFile(file, 'utf-8').catch(() => ''))
  }
  return seen
}

function fakeExpandJob(params: Record<string, unknown>): any {
  return {
    job_id: `test-expand-${Math.random().toString(36).slice(2)}`,
    project_slug: slug,
    type: 'expand_chapters',
    episode_id: EPISODE_ID,
    title: TITLE,
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [] as string[],
    params: { episode_id: EPISODE_ID, title: TITLE, ...params },
  }
}

async function cancelQueuedExpandJobs() {
  const jq = await import('../services/job-queue.js')
  for (const j of await jq.getJobs(slug)) {
    if (j.type === 'expand_chapters') await clearExpandJob(j.job_id)
  }
}

async function clearExpandJob(jobId: string) {
  const jq = await import('../services/job-queue.js')
  const initial = jq.getJob(jobId)
  if (!initial) return
  if (initial.status === 'queued' || initial.status === 'paused') {
    await jq.requestJobCancellation(slug, jobId)
  } else {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || '')) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const terminal = jq.getJob(jobId)
  if (terminal && ['done', 'error', 'cancelled'].includes(terminal.status)) {
    jq.removeTerminalJob(slug, jobId)
  }
}

beforeEach(async () => {
  await cancelQueuedExpandJobs()
  await fs.rm(sidecarFile, { force: true })
  const { chapterFilename } = await import('../lib/narration-assembly.js')
  for (let n = 1; n <= TOTAL_CHAPTERS; n++) {
    await fs.rm(path.join(scriptDir, chapterFilename(EPISODE_ID, n)), { force: true })
  }
})

// ── The route carries the model that will actually be used ────────────────

describe('POST /expand-chapters — which model reaches the queue', () => {
  test('the selected model wins over the outline snapshot', async () => {
    await seedSidecar()
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, model: SELECTED_MODEL })
    assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`)

    const jq = await import('../services/job-queue.js')
    const job = (await jq.getJobs(slug)).find(j => j.job_id === res.body.job_id)
    assert.ok(job, 'queued job must be retrievable')
    assert.equal((job as any).params.model, SELECTED_MODEL,
      'the route must not overwrite the caller\'s model with the outline snapshot\'s')
    assert.notEqual((job as any).params.model, STALE_OUTLINE_MODEL)
    await clearExpandJob(res.body.job_id)
  })

  test('a caller that names no model still falls back to the outline\'s record', async () => {
    // Headless callers (Pipeline) rely on this. The snapshot is a FALLBACK
    // now, not an override — it may fill a gap, never replace a selection.
    await seedSidecar()
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE })
    assert.equal(res.status, 201)

    const jq = await import('../services/job-queue.js')
    const job = (await jq.getJobs(slug)).find(j => j.job_id === res.body.job_id)
    assert.equal((job as any).params.model, STALE_OUTLINE_MODEL)
    await clearExpandJob(res.body.job_id)
  })

  test('a blank model in the body does not shadow the outline\'s record', async () => {
    await seedSidecar()
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/expand-chapters`)
      .send({ episode_id: EPISODE_ID, title: TITLE, model: '   ' })
    assert.equal(res.status, 201)

    const jq = await import('../services/job-queue.js')
    const job = (await jq.getJobs(slug)).find(j => j.job_id === res.body.job_id)
    assert.equal((job as any).params.model, STALE_OUTLINE_MODEL)
    await clearExpandJob(res.body.job_id)
  })
})

// ── The executor: selected model used, and the swap said out loud ─────────

describe('expand-chapters executor — the model swap is visible, never silent', () => {
  test('runs on the selected model when the outline\'s is unavailable, and says so', async () => {
    // Every chapter already on disk, so expansion short-circuits with no
    // request of any kind — this case is about WHICH model was resolved and
    // whether the difference was reported, not about generating anything.
    await seedSidecar()
    await seedChapterFiles(TOTAL_CHAPTERS)

    const { generateExpandChapters } = await import('../generators/episode.js')
    const job = fakeExpandJob({ model: SELECTED_MODEL })
    await generateExpandChapters(job)

    const log = job.output_lines.join('\n')
    // Both ids are named — the owner can see exactly what changed rather than
    // discovering a different voice in the finished script.
    assert.match(log, /Model changed since the outline was built/)
    assert.ok(log.includes(STALE_OUTLINE_MODEL), 'the log must name the outline\'s model')
    assert.ok(log.includes(SELECTED_MODEL), 'the log must name the model expansion will use')
    // And it must say what happens to the work already paid for.
    assert.match(log, /Chapters already on disk are kept/)
  })

  test('says nothing when the selected model matches the outline\'s', async () => {
    // A notice on every run is noise; it fires only on a real difference.
    await seedSidecar({ model: SELECTED_MODEL })
    await seedChapterFiles(TOTAL_CHAPTERS)

    const { generateExpandChapters } = await import('../generators/episode.js')
    const job = fakeExpandJob({ model: SELECTED_MODEL })
    await generateExpandChapters(job)

    assert.doesNotMatch(job.output_lines.join('\n'), /Model changed/)
  })

  test('a stale recorded model can never be the reason expansion refuses to run', async () => {
    // The whole point. With the stale id recorded and a valid one selected,
    // setup must resolve to the valid one and reach the expansion logic —
    // never throw on the recorded id's account.
    await seedSidecar()
    await seedChapterFiles(TOTAL_CHAPTERS)

    const { generateExpandChapters } = await import('../generators/episode.js')
    const job = fakeExpandJob({ model: SELECTED_MODEL })
    await generateExpandChapters(job)

    const log = job.output_lines.join('\n')
    assert.doesNotMatch(log, /isn't available right now/)
    assert.doesNotMatch(log, /Pick another writing model/)
    assert.match(log, /Nothing to do/)
  })
})

// ── NINE PAID CHAPTERS SURVIVE THE CHANGE ────────────────────────────────

describe('resume across a model change', () => {
  test('9 of 10 on disk: a model change re-expands nothing and targets only chapter 10', async () => {
    await seedSidecar({ chaptersDone: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
    const before = await seedChapterFiles(9)

    const { generateExpandChapters } = await import('../generators/episode.js')
    const job = fakeExpandJob({ model: SELECTED_MODEL })
    // The one genuinely missing chapter is attempted against a base URL that
    // refuses connections, so the run ends unsuccessfully. That is the
    // realistic shape of the owner's situation and exactly when regressions
    // here would bite: the failure must not take the finished chapters with it.
    await generateExpandChapters(job).catch(() => {})

    const after = await readChapterFiles(9)
    for (let n = 1; n <= 9; n++) {
      assert.equal(after.get(n), before.get(n),
        `chapter ${n} was rewritten — a model change must never re-expand paid work`)
    }

    const log = job.output_lines.join('\n')
    // Exactly one slot was pending, and it was the missing one.
    assert.match(log, /1 batch\(es\) to run/)
    assert.ok(!/chapters 1-/.test(log), `an earlier chapter entered a batch: ${log}`)

    // The sidecar still records the nine, and does not claim the tenth.
    const sidecar = JSON.parse(await fs.readFile(sidecarFile, 'utf-8'))
    assert.deepEqual(sidecar.chapters_done, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('all 10 on disk: a model change is not a reason to regenerate any of them', async () => {
    await seedSidecar({ chaptersDone: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    const before = await seedChapterFiles(TOTAL_CHAPTERS)

    const { generateExpandChapters } = await import('../generators/episode.js')
    const job = fakeExpandJob({ model: SELECTED_MODEL })
    await generateExpandChapters(job)

    const after = await readChapterFiles(TOTAL_CHAPTERS)
    for (let n = 1; n <= TOTAL_CHAPTERS; n++) {
      assert.equal(after.get(n), before.get(n), `chapter ${n} was rewritten`)
    }
    assert.match(job.output_lines.join('\n'), /All 10 chapters already on disk/)
  })

  test('resume is decided by files on disk — the model is not an input to it', async () => {
    // Structural guard on the mechanism behind the two cases above: the
    // pending set is computed by verifying chapter FILES, and `chapters_done`
    // is reconciled from those files. No branch of it reads a model, so no
    // model change can invalidate a completed chapter.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(new URL('../lib/chunked-narration.ts', import.meta.url)), 'utf8')
    const helperStart = source.indexOf('function validChapterNumbersForOutline(')
    const helperEnd = source.indexOf('\nexport interface ChunkedScriptCompletion', helperStart)
    assert.ok(helperStart >= 0 && helperEnd > helperStart,
      'current-outline chapter verifier not found — this guard needs updating')
    const helperBlock = source.slice(helperStart, helperEnd)
    assert.match(helperBlock, /sidecar\.outline/)
    assert.match(helperBlock, /resolveReadPath\(chapterFilePath\(scriptDir, sidecar\.episode_id, n\)\)/)
    assert.match(helperBlock, /chapterFileLooksValid\(file\) && chapterBelongsToOutline\(sidecar, file\)/)
    assert.ok(!/\bmodel\b/.test(helperBlock),
      'the current-outline chapter verifier must not consult a model')

    const resumeStart = source.indexOf('// Disk verification: the files are authoritative, not chapters_done.')
    const resumeEnd = source.indexOf('const budget = await resolveChunkingBudget', resumeStart)
    assert.ok(resumeStart >= 0 && resumeEnd > resumeStart,
      'resume block not found — this guard needs updating')
    const resumeBlock = source.slice(resumeStart, resumeEnd)
    assert.match(resumeBlock,
      /const verifiedDone = new Set\(validChapterNumbersForOutline\(params\.scriptDir, sidecar\)\)/)
    assert.match(resumeBlock, /chapters_done: actualDone/)
    assert.match(resumeBlock, /sidecar\.outline\.filter\(e => !verifiedDone\.has\(e\.n\)\)/)
    assert.ok(!/\bmodel\b/.test(resumeBlock),
      'the resume/pending computation must not consult a model')
  })
})
