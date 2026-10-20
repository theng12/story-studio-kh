/**
 * 1.4.335 live case — a legacy saved unknown outcome was never re-read.
 *
 * Rows written before 1.4.327 kept the Gateway's `failure_code: "UNKNOWN_OUTCOME"` but not the
 * `recovery_required` / `recovery_state` pair that names the hold, so every reader keyed on the
 * pair called them a proven failure. `shouldRecheckStoredUnknownOutcome` answered false, so
 * `needsHistoryEvidenceRefresh` did too and `recheckJobProviderStatus` returned before it read
 * anything: four held idea campaigns (Boundful 5864f738, Brain Wise a257d9f4, Capi b21f6250,
 * Domnak 14c50bed, 2026-10-20) could never learn that the Gateway had closed their hold. Boundful
 * has TWO such children, so "the second child already says HOLD_CLOSED" does not cover it either.
 *
 * The failure code is the same statement the pair makes, so a stored `failed` row that carries it
 * with both hold fields ABSENT is re-read like a held one: one read-only GET by its own job id,
 * recording exactly what the Gateway answers. Identity is preserved, nothing is resubmitted or
 * discarded, and a readback that cannot reach the Gateway leaves the row exactly as it was.
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
  await setGenStudioUrl('https://legacy-unknown-outcome.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'legacy-unknown-outcome-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  // Every read below is an awaited recheck, so the retry timer is set beyond the life of the file
  // rather than raced.
  restoreRetryMs = jq._setHistoryEvidenceRetryMsForTesting(60_000)
  await jq.setQueuePaused(true)
})

after(async () => {
  restoreRetryMs()
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

/** Boundful 5864f738's own two children, ids and keys verbatim from the held-campaign receipts. */
const CHILDREN = [
  { id: '2ab58798-cfbc-4751-aeb5-f50354ea6585', key: 'story-chat-008bc99442e8e7e6908c74ca1d5f40136b9aefa0e18e3f9' },
  { id: '1bc2fc67-655f-4726-bbef-26f207eb7d96', key: 'story-chat-resend-7bfb0c633b6f55c76e1ed4c5d28c50df2bbc6369' },
]

/**
 * The exact stored shape production has: `state: failed`, `failure_code: UNKNOWN_OUTCOME`, and BOTH
 * `recovery_required` and `recovery_state` ABSENT (not null — the keys are not there at all).
 */
function legacyChild(child: { id: string; key: string }) {
  return {
    id: child.id,
    operation: 'chat.response',
    state: 'failed',
    queue_state: 'failed',
    failure_code: 'UNKNOWN_OUTCOME',
    model_id: 'pool::writing-haiku-gemini-luna-ordered',
    request_key: child.key,
    request: { method: 'POST', path: '/v1/chat/responses', idempotency_key: child.key, captured_at: '2026-10-19T04:44:48.365Z' },
    updated_at: '2026-10-19T04:49:58.792Z',
  }
}

function legacyCampaignJob(slug: string, jobId: string, children: Array<{ id: string; key: string }> = [CHILDREN[0]!]): Job {
  return {
    job_id: jobId,
    project_slug: slug,
    type: 'idea_campaign',
    episode_id: '',
    title: 'Idea campaign',
    status: 'error',
    error: 'The Gateway could not prove whether an earlier request was accepted.',
    created_at: '2026-10-19T04:44:00.000Z',
    started_at: '2026-10-19T04:44:05.000Z',
    finished_at: '2026-10-19T04:49:58.000Z',
    local_execution_complete: true,
    reconciliation_error: null,
    output_lines: [],
    params: {},
    remote_cancellations: {},
    genstudio_jobs: children.map(legacyChild),
  } as unknown as Job
}

/** Write the job where `recheckJobProviderStatus` will load it, and return its project. */
async function seedJob(jobId: string, children?: Array<{ id: string; key: string }>): Promise<{ slug: string }> {
  const project = await pm.createProject({ name: `Legacy unknown ${jobId}` })
  const job = legacyCampaignJob(project.slug, jobId, children)
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
  return { slug: project.slug }
}

/** The Gateway's own envelope for a chat job, with the field the test is about varied. */
function envelope(id: string, fields: Record<string, unknown>) {
  return {
    id, state: 'failed', dispatch_state: 'dispatched', cancellable: false, cancelled: false,
    failure_code: null, recovery_required: false, recovery_state: null, ...fields,
  }
}

/**
 * Install a Gateway stub that answers the one control-plane read this test needs. Every call is
 * asserted to be a GET, because a readback that submitted or replayed work would be the defect.
 */
async function withGateway(
  answer: (id: string) => Response | never,
  body: (reads: string[]) => Promise<void>,
): Promise<void> {
  const reads: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'settling evidence must never send provider work')
    const url = new URL(String(input))
    reads.push(url.pathname)
    const id = url.pathname.split('/').pop() || ''
    return answer(id)
  }
  try {
    await body(reads)
  } finally {
    globalThis.fetch = original
  }
}

test('a legacy unknown-outcome chat row is re-read, and a closed hold settles it as a failure', async () => {
  const { slug } = await seedJob('legacy-closed')
  const { id, key } = CHILDREN[0]!
  await withGateway(
    childId => Response.json(envelope(childId, { failure_code: 'HOLD_CLOSED' })),
    async reads => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'legacy-closed')
      const entry = refreshed.genstudio_jobs![0]!
      // The Gateway's CURRENT answer, recorded exactly: the hold is gone and the failure is settled.
      assert.equal(entry.state, 'failed')
      assert.equal(entry.failure_code, 'HOLD_CLOSED')
      assert.equal(entry.recovery_required, false)
      assert.equal(entry.recovery_state, null)
      // Identity is preserved: the key the campaign saved still names this row.
      assert.equal(entry.id, id)
      assert.equal(entry.request?.idempotency_key, key)
      assert.deepEqual(reads, [`/v1/chat/responses/${id}`], `read ${reads.join(', ')}`)
      assert.equal(refreshed.history_evidence_check, undefined)
      // Settled evidence no longer blocks the retry the idea-batch release needs (no 409).
      const retried = jq.retryTerminalJob(slug, 'legacy-closed')
      assert.equal(retried.type, 'idea_campaign')
    },
  )
})

test('a legacy unknown-outcome row the Gateway has since finished is recorded as a success', async () => {
  const { slug } = await seedJob('legacy-succeeded')
  const { id } = CHILDREN[0]!
  await withGateway(
    childId => Response.json(envelope(childId, { state: 'succeeded', failure_code: null })),
    async reads => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'legacy-succeeded')
      assert.equal(refreshed.genstudio_jobs![0]!.state, 'succeeded')
      assert.equal(refreshed.genstudio_jobs![0]!.id, id)
      assert.deepEqual(reads, [`/v1/chat/responses/${id}`], `read ${reads.join(', ')}`)
    },
  )
})

test('a legacy unknown-outcome row the Gateway still holds keeps its hold', async () => {
  const { slug } = await seedJob('legacy-still-held')
  const { id } = CHILDREN[0]!
  await withGateway(
    childId => Response.json(envelope(childId, {
      failure_code: 'UNKNOWN_OUTCOME', recovery_required: true, recovery_state: 'unknown_outcome',
    })),
    async reads => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'legacy-still-held')
      const entry = refreshed.genstudio_jobs![0]!
      assert.equal(entry.state, 'failed')
      assert.equal(entry.failure_code, 'UNKNOWN_OUTCOME')
      assert.equal(entry.recovery_required, true)
      assert.equal(entry.recovery_state, 'unknown_outcome')
      assert.equal(entry.id, id)
      assert.equal(refreshed.history_evidence_check?.state, 'unsettled')
      assert.doesNotMatch(refreshed.output_lines.join('\n'), /confirmed every recorded provider task/)
      assert.ok(reads.every(p => p === `/v1/chat/responses/${id}`), `read ${reads.join(', ')}`)
      // A hold is still not a reason to refuse a retry (EP0113) — the readback only asks a question.
      assert.equal(jq.hasUnsettledProviderEvidence(refreshed), false, 'the Retry gate did not move')
      assert.equal(jq.retryTerminalJob(slug, 'legacy-still-held').type, 'idea_campaign')
    },
  )
})

test('a legacy readback that cannot reach the Gateway leaves the saved row exactly as it was', async () => {
  const { slug } = await seedJob('legacy-gateway-down')
  const { id, key } = CHILDREN[0]!
  await withGateway(
    () => { throw new TypeError('fetch failed') },
    async () => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'legacy-gateway-down')
      const entry = refreshed.genstudio_jobs![0]!
      assert.equal(entry.state, 'failed')
      assert.equal(entry.failure_code, 'UNKNOWN_OUTCOME')
      assert.equal(Object.hasOwn(entry, 'recovery_required'), false, 'no hold value is invented')
      assert.equal(Object.hasOwn(entry, 'recovery_state'), false)
      assert.equal(entry.id, id)
      assert.equal(entry.request?.idempotency_key, key)
      assert.equal(refreshed.history_evidence_check?.state, 'unreachable')
      assert.doesNotMatch(refreshed.output_lines.join('\n'), /confirmed every recorded provider task/)
    },
  )
})

test("Boundful's two legacy children are each re-read by their own id", async () => {
  const { slug } = await seedJob('legacy-two-children', CHILDREN)
  await withGateway(
    // Each child answers for itself: the first is still held, the second the operator closed.
    childId => childId === CHILDREN[0]!.id
      ? Response.json(envelope(childId, {
        failure_code: 'UNKNOWN_OUTCOME', recovery_required: true, recovery_state: 'unknown_outcome',
      }))
      : Response.json(envelope(childId, { failure_code: 'HOLD_CLOSED' })),
    async reads => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'legacy-two-children')
      const entries = refreshed.genstudio_jobs!
      assert.equal(entries.length, 2)
      // Both children were asked about, each by its own job id — the "second child already says
      // HOLD_CLOSED" reading does not stand in for the first. (A boot refresh may run a second pass
      // beside this one, so the SET of paths is what is pinned, not how many passes there were.)
      assert.deepEqual(
        [...new Set(reads)].sort(),
        [`/v1/chat/responses/${CHILDREN[0]!.id}`, `/v1/chat/responses/${CHILDREN[1]!.id}`].sort(),
        `read ${reads.join(', ')}`,
      )
      // Each child kept its own identity and the answer the Gateway gave about it.
      assert.equal(entries[0]!.id, CHILDREN[0]!.id)
      assert.equal(entries[0]!.state, 'failed')
      assert.equal(entries[0]!.failure_code, 'UNKNOWN_OUTCOME')
      assert.equal(entries[0]!.recovery_required, true)
      assert.equal(entries[0]!.request?.idempotency_key, CHILDREN[0]!.key)
      assert.equal(entries[1]!.id, CHILDREN[1]!.id)
      assert.equal(entries[1]!.state, 'failed')
      assert.equal(entries[1]!.failure_code, 'HOLD_CLOSED')
      assert.equal(entries[1]!.recovery_required, false)
      assert.equal(entries[1]!.request?.idempotency_key, CHILDREN[1]!.key)
      assert.ok(entries.every(entry => entry.state !== 'not_created'), 'no child is declared never created')
    },
  )
})

test('a 404 on a legacy row is not proof it was never created', async () => {
  const { slug } = await seedJob('legacy-absent-404')
  const { id, key } = CHILDREN[0]!
  await withGateway(
    // A wrong-route read once answered exactly this for a task that later succeeded (2026-10-16).
    () => Response.json({ code: 'JOB_NOT_FOUND', detail: 'No such job.' }, { status: 404 }),
    async () => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'legacy-absent-404')
      const entry = refreshed.genstudio_jobs![0]!
      assert.equal(entry.state, 'failed')
      assert.equal(entry.failure_code, 'UNKNOWN_OUTCOME')
      assert.equal(entry.id, id)
      assert.equal(entry.request?.idempotency_key, key)
      assert.equal(refreshed.history_evidence_check?.state, 'unreachable')
      assert.doesNotMatch(refreshed.output_lines.join('\n'), /confirmed every recorded provider task/)
    },
  )
})

test('a legacy row still settles for Retry, so the fix cannot re-trap it', async () => {
  const { slug } = await seedJob('legacy-settled-gates')
  await withGateway(
    () => { throw new TypeError('fetch failed') },
    async () => {
      const refreshed = await jq.recheckJobProviderStatus(slug, 'legacy-settled-gates')
      // The readback asks a question; it does not move what "settled" means (EP0113). Reading the
      // code as a hold must not turn a retryable row into one nothing can clear.
      assert.equal(jq.hasUnsettledProviderEvidence(refreshed), false)
      assert.equal(jq.retryTerminalJob(slug, 'legacy-settled-gates').type, 'idea_campaign')
    },
  )
})
