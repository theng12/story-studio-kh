/**
 * 1.4.329 live case — a saved `unknown_outcome` was final evidence.
 *
 * Science EP13's `scene_plan_run` finished with every other provider task settled, and one
 * chat.response row was still saved as `failed` / `PROVIDER_SUBMISSION_UNCERTAIN` /
 * `recovery_required: true` / `recovery_state: 'unknown_outcome'`. The operator later closed that
 * hold at the Gateway (`failed` / `HOLD_CLOSED`, `recovery_required: false`), and Story Studio
 * could never find out: a held row reads as SETTLED (EP0113 — a held writing job must stay
 * retryable), so `needsHistoryEvidenceRefresh` answered false and the refresh returned before it
 * read anything. Six Idea Campaign rows across Science 1e37ecb6, Refinanced e7364244 and Story
 * Sprout 0c947114 were stuck the same way. The job even claimed "The Gateway confirmed every
 * recorded provider task for this job has finished" over a row nobody had re-read.
 *
 * The refresh re-reads a held row now — one read-only GET, never a POST — and records exactly
 * what the Gateway answers: a closed hold settles the failure, a success becomes a success, and a
 * row the Gateway still holds keeps its hold.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
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
  await setGenStudioUrl('https://chat-held-outcome.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'chat-held-outcome-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  // No background polling in these tests: every read below is an awaited recheck, so the retry
  // timer is set beyond the life of the file rather than raced.
  restoreRetryMs = jq._setHistoryEvidenceRetryMsForTesting(60_000)
  await jq.setQueuePaused(true)
})

after(async () => {
  restoreRetryMs()
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

const CHAT_ID = '0f94462d-9e82-48ed-a11e-d003d5966f66'
const CHAT_KEY = 'story-chat-fcc08899bfa9b2764a19e1fa94065e1bceae5f315069a90'
const CHAT_PATH = `/v1/chat/responses/${CHAT_ID}`

/** What the Gateway publishes for a held unknown outcome (store.py: recovery_required = state == unknown_outcome). */
const HELD_ENVELOPE = {
  id: CHAT_ID,
  state: 'failed',
  failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN',
  dispatch_state: 'dispatched',
  cancellable: false,
  cancelled: false,
  recovery_required: true,
  recovery_state: 'unknown_outcome',
}

/** What it publishes once the operator closes that hold. */
const HOLD_CLOSED_ENVELOPE = {
  ...HELD_ENVELOPE,
  failure_code: 'HOLD_CLOSED',
  recovery_required: false,
  recovery_state: null,
}

function heldChatJob(slug: string, jobId: string): Job {
  return {
    job_id: jobId,
    project_slug: slug,
    type: 'metadata',
    episode_id: 'EP0013',
    title: 'YouTube Finalizer — EP0013',
    status: 'error',
    error: 'The Gateway could not prove whether an earlier request was accepted.',
    created_at: '2026-10-19T10:20:00.000Z',
    started_at: '2026-10-19T10:20:05.000Z',
    finished_at: '2026-10-19T10:31:43.000Z',
    local_execution_complete: true,
    reconciliation_error: null,
    output_lines: [],
    params: {},
    remote_cancellations: {},
    genstudio_jobs: [{
      id: CHAT_ID,
      operation: 'chat.response',
      state: 'failed',
      queue_state: 'failed',
      model_id: 'pool::writing-haiku-gemini-luna-ordered',
      failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN',
      recovery_required: true,
      recovery_state: 'unknown_outcome',
      dispatch_state: 'dispatched',
      cancellable: false,
      cancelled: false,
      request: { method: 'POST', path: '/v1/chat/responses', idempotency_key: CHAT_KEY, captured_at: '2026-10-19T10:20:07.000Z' },
      updated_at: '2026-10-19T10:31:43.000Z',
    }],
  } as unknown as Job
}

/**
 * Install a Gateway stub that answers the one control-plane read this test needs. Every call is
 * asserted to be a GET, because a readback that submitted or replayed work would be the defect.
 */
async function withGateway(
  answer: () => Response | never,
  body: (reads: string[]) => Promise<void>,
): Promise<void> {
  const reads: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'settling evidence must never send provider work')
    const url = new URL(String(input))
    reads.push(url.pathname)
    return answer()
  }
  try {
    await body(reads)
  } finally {
    globalThis.fetch = original
  }
}

/** Write the job where `recheckJobProviderStatus` will load it, and return its project. */
async function seedJob(jobId: string): Promise<{ slug: string }> {
  const project = await pm.createProject({ name: `Held chat ${jobId}` })
  const job = heldChatJob(project.slug, jobId)
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
  return { slug: project.slug }
}

test('a held chat row the Gateway has since closed settles as a proven failure on recheck', async () => {
  const { slug } = await seedJob('held-then-closed')
  await withGateway(
    () => Response.json(HOLD_CLOSED_ENVELOPE),
    async reads => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'held-then-closed')
      const entry = refreshed.genstudio_jobs![0]!
      // The Gateway's CURRENT answer, recorded exactly: the hold is gone and the failure is settled.
      assert.equal(entry.state, 'failed')
      assert.equal(entry.failure_code, 'HOLD_CLOSED')
      assert.equal(entry.recovery_required, false)
      assert.equal(entry.recovery_state, null)
      // Identity is preserved, so the batch key an Idea Campaign saved still names this row.
      assert.equal(entry.id, CHAT_ID)
      assert.equal(entry.request?.idempotency_key, CHAT_KEY)
      assert.ok(reads.length > 0 && reads.every(p => p === CHAT_PATH), `read ${reads.join(', ')}`)
      // Settled evidence no longer blocks the retry the idea-batch release needs (no 409).
      const retried = jq.retryTerminalJob(slug, 'held-then-closed')
      assert.equal(retried.type, 'metadata')
    },
  )
})

test('a chat row the Gateway still holds keeps its hold, and the job stops claiming otherwise', async () => {
  const { slug } = await seedJob('still-held')
  await withGateway(
    () => Response.json(HELD_ENVELOPE),
    async reads => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'still-held')
      const entry = refreshed.genstudio_jobs![0]!
      // Still held: nothing about the saved row moves, and nothing is settled on its behalf.
      assert.equal(entry.state, 'failed')
      assert.equal(entry.failure_code, 'PROVIDER_SUBMISSION_UNCERTAIN')
      assert.equal(entry.recovery_required, true)
      assert.equal(entry.recovery_state, 'unknown_outcome')
      assert.equal(entry.id, CHAT_ID)
      assert.ok(reads.length > 0 && reads.every(p => p === CHAT_PATH), `read ${reads.join(', ')}`)
      assert.equal(refreshed.history_evidence_check?.state, 'unsettled')
      // Science EP13's misleading line: it may not be said about a row the Gateway is still holding.
      assert.doesNotMatch(refreshed.output_lines.join('\n'), /confirmed every recorded provider task/)
      // A hold is not a reason to refuse a retry (EP0113) — it only asks to be checked again.
      const retried = jq.retryTerminalJob(slug, 'still-held')
      assert.equal(retried.type, 'metadata')
    },
  )
})

test('a readback that cannot reach the Gateway leaves the saved held row exactly as it was', async () => {
  const { slug } = await seedJob('gateway-down')
  await withGateway(
    () => { throw new TypeError('fetch failed') },
    async () => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'gateway-down')
      const entry = refreshed.genstudio_jobs![0]!
      assert.equal(entry.state, 'failed')
      assert.equal(entry.failure_code, 'PROVIDER_SUBMISSION_UNCERTAIN')
      assert.equal(entry.recovery_required, true)
      assert.equal(entry.recovery_state, 'unknown_outcome')
      assert.equal(entry.id, CHAT_ID)
      assert.equal(entry.request?.idempotency_key, CHAT_KEY)
      assert.equal(refreshed.history_evidence_check?.state, 'unreachable')
      assert.doesNotMatch(refreshed.output_lines.join('\n'), /confirmed every recorded provider task/)
    },
  )
})
