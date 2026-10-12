/**
 * 1.4.300 — the script, writing and narration safety checks carry on when a channel sets them to
 * Off or Warn, and stop exactly as before on Block (owner 2026-10-12: "same application of control
 * please"). One small test per check; the Audio and Audio Assembly ones live beside their harnesses
 * (audio-chapter-parts-partial-rerun, audio-merge-safety-checks).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let temp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let slug = ''

before(async () => {
  temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  pm = await import('../services/project-manager.js')
  slug = (await pm.createProject({ name: 'Safety Writing', episode_prefix: 'EP', episode_digits: 4 })).slug
})
after(async () => { await temp.cleanup() })

const setMode = (id: string, mode: 'off' | 'warn' | 'block') =>
  pm.updateConfig(slug, { safety_checks: { [id]: mode } } as any)

const makeJob = (extra: Record<string, unknown> = {}) => ({
  job_id: `job-${Math.random().toString(36).slice(2)}`, project_slug: slug, type: 'expand_chapters',
  episode_id: 'EP0001', title: 'Script', status: 'running', created_at: new Date().toISOString(),
  started_at: null, finished_at: null, error: null, output_lines: [] as string[], params: {}, ...extra,
}) as any

/** An outline of two chapters, both already written, so expansion has nothing to ask a model for. */
async function writtenOutline(approved: boolean): Promise<string> {
  const { sidecarPath } = await import('../lib/chunked-narration.js')
  const { chapterFilePath } = await import('../lib/narration-assembly.js')
  const scriptDir = await fs.mkdtemp(path.join(temp.dir, 'script-'))
  const at = new Date(Date.now() - 60_000).toISOString()
  await fs.writeFile(sidecarPath(scriptDir, 'EP0001'), JSON.stringify({
    schema_version: 3, episode_id: 'EP0001', mode: 'narrative', total_chapters: 2,
    outline: [1, 2].map(n => ({ n, title: `Chapter ${n}`, synopsis: 's', key_beats: ['a'] })),
    outline_completed_at: at, outline_approved_at: approved ? at : null, outline_edited_at: null,
    generation_params: null, chapters_done: [1, 2], params_hash: 'x', last_updated: at,
  }))
  for (const n of [1, 2]) await fs.writeFile(chapterFilePath(scriptDir, 'EP0001', n), `# Chapter ${n}\n\nText.`)
  return scriptDir
}

test('outline_approved: Off (default) approves the outline and expands; Block stops as before', async () => {
  const { expandChapters, readSidecar } = await import('../lib/chunked-narration.js')
  const scriptDir = await writtenOutline(false)
  const params = { episode_id: 'EP0001', scriptDir } as any
  await setMode('outline_approved', 'block')
  await assert.rejects(expandChapters(makeJob(), params), /Outline is not approved yet/)
  assert.equal((await readSidecar(scriptDir, 'EP0001'))?.outline_approved_at, null)

  await setMode('outline_approved', 'off')
  const job = makeJob()
  await expandChapters(job, params)
  assert.ok((await readSidecar(scriptDir, 'EP0001'))?.outline_approved_at, 'the approval is written down')
  assert.ok(job.output_lines.some((line: string) => /Outline is not approved yet.*set to Off/.test(line)), job.output_lines.join('\n'))
})

test('saved_request_matches (writing): Warn (default) forgets a stale repair request and carries on; Block stops', async () => {
  const { expandChapters } = await import('../lib/chunked-narration.js')
  const scriptDir = await writtenOutline(true)
  const params = { episode_id: 'EP0001', scriptDir } as any
  const stale = () => makeJob({
    genstudio_chat_recovery: true, genstudio_chat_recovery_purpose: 'narrative-repair',
    genstudio_chat_recovery_chapters: [9], genstudio_chat_recovery_key: 'saved-key',
  })
  await setMode('saved_request_matches', 'block')
  await assert.rejects(expandChapters(stale(), params), /repair identity no longer matches/)

  await setMode('saved_request_matches', 'warn')
  const job = stale()
  await expandChapters(job, params)
  assert.equal(job.genstudio_chat_recovery, undefined, 'the stale request is forgotten, never collected')
  assert.equal(job.genstudio_chat_recovery_key, undefined)
  assert.equal(job.result?.safety_warnings?.[0]?.check, 'saved_request_matches')
})

test('all_chapters_written: Block (default) stops; Off carries on once automatic retries are used up', async () => {
  const { carryOnWithoutChapters } = await import('../lib/chunked-narration.js')
  const { isNonRetryableError } = await import('../services/job-retry-policy.js')
  await setMode('all_chapters_written', 'block')
  const blocked = await carryOnWithoutChapters(makeJob(), 'Chapter 2 is missing.').catch(error => error)
  assert.ok(blocked instanceof Error && !isNonRetryableError(blocked), 'Block keeps the old retryable stop')

  await setMode('all_chapters_written', 'off')
  const retrying = makeJob({ auto_retry: { eligible: true, reason: '', attempt: 1, max_attempts: 3 } })
  await assert.rejects(carryOnWithoutChapters(retrying, 'Chapter 2 is missing.'), /Chapter 2 is missing/,
    'a retry still to come asks for the missing chapter first')
  const last = makeJob({ auto_retry: { eligible: true, reason: '', attempt: 3, max_attempts: 3 } })
  await carryOnWithoutChapters(last, 'Chapter 2 is missing.')
  assert.ok(last.output_lines.some((line: string) => /carries on with the chapters that were written/.test(line)))
})

test('chapter_once: a chapter saved twice is read once (Off, default) or stops the step (Block)', async () => {
  const { selectNarrationSections } = await import('../services/tts-request-plan.js')
  const repeated: string[] = []
  const sections = [{ slug: 'Chapter_01', label: 'Chapter 1', text: 'a' }, { slug: 'Chapter_01', label: 'Chapter 1', text: 'a' }]
  assert.equal(selectNarrationSections(sections as any, 'all', repeated).length, 1)
  assert.deepEqual(repeated, ['Chapter_01'])

  const { assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
  const scriptDir = await writtenOutline(true)
  await fs.writeFile(path.join(scriptDir, 'EP0001_Chapter_02.docx'), 'legacy copy')
  const assembled = await assembleUnifiedNarration(scriptDir, 'EP0001', 'Title')
  assert.deepEqual([assembled.chapter_numbers, assembled.repeated_chapters], [[1, 2], [2]])

  const { chapterOnce } = await import('../generators/episode.js')
  const off = makeJob()
  await chapterOnce(off, assembled)
  assert.ok(off.output_lines.some((line: string) => /Chapter 2 is saved more than once/.test(line)))
  await setMode('chapter_once', 'block')
  await assert.rejects(chapterOnce(makeJob(), assembled), /Chapter 2 is saved more than once/)
})

test('lost_writing_request: Off (default) resends once; Block stops after the first send', async () => {
  const jq = await import('../services/job-queue.js')
  const { callChatWithGenStudio, clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  let posts = 0
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/models')) {
      return Response.json([{
        id: 'writer-alpha', display_name: 'Writer Alpha', available: true, qualification_only: false,
        context_window_tokens: 100_000, max_output_tokens: 4_096, controls: ['max_output_tokens'],
        activation_blockers: [], structured_output_mode: 'json_object', supports_structured_output: true,
      }])
    }
    if (url.endsWith('/v1/account/overview')) {
      return Response.json({ paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 25, generation_submissions_per_minute: 30 })
    }
    const state = (init?.method || 'GET').toUpperCase() === 'POST'
      ? (posts++, { state: 'running' })
      : { state: 'failed', failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' }
    return Response.json({
      id: `chat-${posts}`, operation: 'chat.response', dispatch_mode: 'asynchronous', model_id: 'writer-alpha',
      output_text: null, output_retained: false, finish_reason: null, failure_code: null, routing_status_code: null,
      credit_cost: 0, remaining_credits: 900, idempotent_replay: false, ...state,
    }, { status: (init?.method || 'GET').toUpperCase() === 'POST' ? 202 : 200 })
  }
  let run = 0
  jq.registerExecutor('metadata', async () => {
    await callChatWithGenStudio(`safety-lost-${run}`, {
      modelId: 'writer-alpha', system: '', userMessage: `Write ${run}.`, outputContract: { mode: 'json_object' },
    })
  })
  const settle = async () => {
    run++
    clearGenStudioCatalogCache()
    const queued = jq.enqueuePreparedForTest({
      project_slug: slug, type: 'metadata', episode_id: 'EP0001', title: 'Metadata', params: { auto_retry: false },
    })
    await waitFor(() => ['done', 'error'].includes(jq.getJob(queued.job_id)?.status || ''), { label: 'metadata settles' })
    return jq.getJob(queued.job_id)!
  }
  try {
    await setMode('lost_writing_request', 'block')
    const blocked = await settle()
    assert.equal(blocked.status, 'error')
    assert.match(blocked.error || '', /lost track of this request/i)
    assert.equal(posts, 1, 'Block never sends the lost request again')

    await setMode('lost_writing_request', 'off')
    posts = 0
    const resent = await settle()
    assert.equal(resent.status, 'error', 'the resend is lost too in this fixture')
    assert.equal(posts, 2, 'Off sends it once more, as 1.4.296 does')
    assert.ok(resent.output_lines.some(line => /lost track of a writing request.*set to Off/.test(line)), resent.output_lines.join('\n'))
  } finally {
    globalThis.fetch = original
    clearGenStudioCatalogCache()
    await jq.drainJobPersistenceForShutdown(2_000)
  }
})
