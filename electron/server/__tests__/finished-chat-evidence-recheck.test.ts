/**
 * 1.4.306 live case: a YouTube Finalizer (`metadata`) job ended `error: fetch failed` while its
 * one chat.response was `running`, because the controller Mac lost power and the Gateway
 * restarted. The finished-job evidence check ran once, at that same moment, could not reach the
 * Gateway, and was never asked again — so Retry answered 409 "Story Studio will reconcile it"
 * forever while nothing reconciled it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let restoreRetryMs: () => void

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  await setGenStudioUrl('https://chat-evidence-recheck.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'chat-evidence-recheck-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  restoreRetryMs = jq._setHistoryEvidenceRetryMsForTesting(25)
  await jq.setQueuePaused(true)
})

after(async () => {
  restoreRetryMs()
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

const CHAT_ID = '0bf33706-5d0e-4f43-9a51-6f0c2b9e1d11'
const CHAT_KEY = 'story-chat-0f6d2c1b9a8e7d6c5b4a39281706f5e4d3c2b1a0918273'

function boundfulFinalizerJob(slug: string): Job {
  return {
    job_id: '46ca639c-finalizer',
    project_slug: slug,
    type: 'metadata',
    episode_id: 'EP0113',
    title: 'YouTube Finalizer — EP0113',
    status: 'error',
    error: 'fetch failed',
    created_at: '2026-10-16T06:49:50.000Z',
    started_at: '2026-10-16T06:49:55.000Z',
    finished_at: '2026-10-16T06:51:32.000Z',
    local_execution_complete: true,
    auto_retry: { eligible: true, reason: 'Writing retries automatically.', attempt: 1, max_attempts: 3 },
    reconciliation_error: null,
    output_lines: [],
    params: {},
    remote_cancellations: {},
    genstudio_jobs: [{
      id: CHAT_ID,
      operation: 'chat.response',
      state: 'running',
      queue_state: 'running',
      model_id: 'pool::writing-haiku-gemini-luna-ordered',
      request: { method: 'POST', path: '/v1/chat/responses', idempotency_key: CHAT_KEY, captured_at: '2026-10-16T06:49:57.000Z' },
      updated_at: '2026-10-16T06:51:32.000Z',
    }],
  } as unknown as Job
}

test('a finished chat job whose only evidence check missed the Gateway is checked again until it settles', async () => {
  const project = await pm.createProject({ name: 'Boundful finalizer' })
  const job = boundfulFinalizerJob(project.slug)
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))

  let gatewayUp = false
  const reads: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'settling evidence must never send provider work')
    if (!gatewayUp) throw new TypeError('fetch failed')
    const url = new URL(String(input))
    reads.push(url.pathname)
    // The Gateway keeps chat jobs in SQLite across a restart; an in-flight cloud chat comes back
    // as a held unknown outcome. Any other route (e.g. the TTS-only /v1/jobs/{id}) is a 404.
    if (url.pathname === `/v1/chat/responses/${CHAT_ID}`) {
      return Response.json({
        id: CHAT_ID, state: 'failed', failure_code: 'UNKNOWN_OUTCOME',
        dispatch_state: 'dispatched', cancellable: false, cancelled: false,
      })
    }
    return Response.json({ code: 'JOB_NOT_FOUND', detail: 'No such job.' }, { status: 404 })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(() => jq.getJob(job.job_id)?.history_evidence_check?.state === 'unreachable', {
      label: 'the boot evidence check to miss the Gateway',
    })
    assert.throws(() => jq.retryTerminalJob(project.slug, job.job_id), /unsettled provider evidence/)

    gatewayUp = true
    await waitFor(() => !jq.hasUnsettledProviderEvidence(jq.getJob(job.job_id)!), {
      label: 'Story Studio to ask the Gateway again on its own',
    })

    const settled = jq.getJob(job.job_id)!
    const entry = settled.genstudio_jobs![0]!
    assert.equal(entry.id, CHAT_ID)
    assert.equal(entry.state, 'failed')
    // The unknown outcome is kept as the Gateway stated it — never rewritten as uncharged.
    assert.equal(entry.failure_code, 'UNKNOWN_OUTCOME')
    assert.equal(entry.request?.idempotency_key, CHAT_KEY)
    assert.doesNotMatch(settled.output_lines.join('\n'), /nothing was charged/)
    assert.ok(reads.length > 0 && reads.every(p => p === `/v1/chat/responses/${CHAT_ID}`))

    // The 409 that promised reconciliation now lets the Retry through.
    const retried = jq.retryTerminalJob(project.slug, job.job_id)
    assert.equal(retried.type, 'metadata')
  } finally {
    globalThis.fetch = original
  }
})
