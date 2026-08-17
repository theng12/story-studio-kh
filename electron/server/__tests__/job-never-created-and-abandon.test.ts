/**
 * v1.2.8 — quitting the app mid-batch must not manufacture a permanent wedge,
 * and a wedged job must always have an exit.
 *
 * THE INCIDENT. The owner quit Story Studio during a Scene Review image batch,
 * updated, and reopened. GenStudio held exactly 50 succeeded image jobs and had
 * charged for 50. Story Studio was waiting on a 51st whose submission was in
 * flight when the app closed, so it was never created and never charged.
 * GenStudio answered every status lookup for it with HTTP 404. Story Studio
 * read that 404 as "not yet", polled it for twenty-two minutes, and would have
 * polled it forever — with 48 further items of the same batch stuck behind it.
 * Two more of his jobs reached the identical state at the same time, and no
 * button or API call in the product could clear any of them.
 *
 * Three things are asserted here, and the middle one is the one that costs real
 * money if it is ever got backwards:
 *
 *   1. A provider 404 is TERMINAL. The job reaches a definite state on its own.
 *   2. An UNREACHABLE provider is not. The hold is kept and nothing resubmits.
 *   3. Whatever else is true, the owner can always abandon the job and re-run.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  await setGenStudioUrl('https://never-created.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'never-created-test-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  // Deliberately no executors: this file is about the queue's own bookkeeping
  // — reconciliation, terminal classification, controls — and registering the
  // real generators would have a retried scene render actually start rendering
  // and outlive the test's temp directory.
})

after(async () => { await cleanup() })

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for: ${what}`)
}

/**
 * His batch, in miniature: two provider tasks GenStudio really has, and one
 * whose POST never landed — recorded only by its idempotency key, because that
 * is all Story Studio had when the process died.
 */
function interruptedBatch(jobId: string, projectSlug: string): Job {
  return {
    job_id: jobId,
    project_slug: projectSlug,
    type: 'continuity_render',
    episode_id: 'EP0053',
    title: 'Scene Review images',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    genstudio_jobs: [
      { id: 'image-settled-1', operation: 'image.generation', state: 'accepted', updated_at: new Date().toISOString() },
      { id: 'image-settled-2', operation: 'image.generation', state: 'accepted', updated_at: new Date().toISOString() },
      {
        id: '' as unknown as string,
        operation: 'image.generation',
        state: 'submitting',
        queue_state: 'submitting',
        updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/images', captured_at: '2026-08-15T00:00:00.000Z',
          idempotency_key: 'story-image-inflight',
        },
      },
    ],
    remote_cancellations: {},
  }
}

async function persist(projectName: string, job: Job): Promise<string> {
  const project = await pm.createProject({ name: projectName })
  job.project_slug = project.slug
  await fs.writeFile(
    path.join(tempDir, 'projects', project.slug, 'jobs.json'),
    JSON.stringify({ jobs: [job] }),
  )
  return project.slug
}

test('restarting after a mid-batch quit settles every item — a provider 404 is "never created", not "not yet"', async () => {
  const job = interruptedBatch('restart-404', 'placeholder')
  const slug = await persist('Restart 404 is terminal', job)

  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    const method = (init?.method || 'GET').toUpperCase()
    const url = new URL(String(input))
    requests.push({ method, path: url.pathname })
    if (method !== 'GET') {
      return Response.json({ detail: 'no POST may be sent during restart reconciliation' }, { status: 500 })
    }
    if (url.pathname === '/v1/images/image-settled-1' || url.pathname === '/v1/images/image-settled-2') {
      return Response.json({ id: url.pathname.split('/').pop(), state: 'succeeded', dispatch_state: 'dispatched', cancellable: false })
    }
    // The in-flight submission. GenStudio looked, and has nothing.
    return Response.json({ detail: 'image generation not found' }, { status: 404 })
  }
  try {
    await jq.getJobs(slug)
    await waitFor(() => {
      const current = jq.getJob('restart-404')
      return !!current && current.status !== 'running'
    }, 'the restarted job to reach a definite state without human intervention')

    const settled = jq.getJob('restart-404')!

    // 1. Definite. Not "running" forever.
    assert.equal(settled.status, 'error')
    // 2. Nothing left claiming Story Studio is still waiting for an answer.
    assert.equal(settled.reconciliation_error, undefined)
    // 3. The never-created task is recorded as such — not as a provider failure.
    const inflight = settled.genstudio_jobs!.find(entry => entry.request?.idempotency_key === 'story-image-inflight')
      ?? settled.genstudio_jobs!.find(entry => entry.state === 'not_created')
    assert.equal(inflight?.state, 'not_created')
    // 4. The log answers the only question the user actually has: was I charged?
    const log = settled.output_lines.join('\n')
    assert.match(log, /GenStudio has no record of image\.generation/)
    assert.match(log, /never created, so nothing was generated and nothing was charged/)
    assert.match(log, /will not resend it on its own/)
    // 5. Exactly one lookup per recorded task, and never a POST.
    assert.deepEqual(requests.filter(r => r.method !== 'GET'), [])
    assert.equal(requests.length, 3)
    // 6. The way forward is on the row: history can be cleared, and Retry works.
    assert.equal(settled.control?.action, 'clear-history')
    assert.equal(settled.control?.enabled, true)
  } finally {
    globalThis.fetch = original
  }
})

test('an unreachable GenStudio keeps the hold — a network outage is never read as "never created"', async () => {
  const job = interruptedBatch('restart-unreachable', 'placeholder')
  const slug = await persist('Restart unreachable holds', job)

  const original = globalThis.fetch
  const posts: string[] = []
  globalThis.fetch = async (input, init) => {
    if ((init?.method || 'GET').toUpperCase() !== 'GET') posts.push(String(input))
    throw new TypeError('fetch failed')
  }
  try {
    await jq.getJobs(slug)
    await waitFor(
      () => !!jq.getJob('restart-unreachable')?.reconciliation_error,
      'the job to record that Story Studio could not reach GenStudio',
    )

    const held = jq.getJob('restart-unreachable')!
    // Still held, because nothing has been established about the provider.
    assert.equal(held.status, 'running')
    assert.ok(held.genstudio_jobs!.every(entry => entry.state !== 'not_created'))
    // The message is about Story Studio's reach, not about a provider verdict.
    assert.match(held.reconciliation_error!, /GenStudio status check is waiting/)
    assert.doesNotMatch(held.output_lines.join('\n'), /never created/)
    // And above all: no resubmission. This is the double-charge direction.
    assert.deepEqual(posts, [])
  } finally {
    globalThis.fetch = original
  }
})

test('a job with no other way out can always be abandoned, and re-run from the same row', async () => {
  const job = interruptedBatch('abandon-me', 'placeholder')
  const slug = await persist('Abandon always available', job)

  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  try {
    await jq.getJobs(slug)
    await waitFor(
      () => !!jq.getJob('abandon-me')?.reconciliation_error,
      'the job to become genuinely wedged',
    )

    // The dead end, reproduced: every ordinary exit refuses.
    const wedged = jq.getJob('abandon-me')!
    await assert.rejects(() => jq.requestJobCancellation(slug, 'abandon-me'))
    assert.equal(jq.removeTerminalJob(slug, 'abandon-me'), false)
    assert.throws(() => jq.retryTerminalJob(slug, 'abandon-me'))

    // …and the override is nevertheless offered, enabled, and honest.
    const escape = wedged.controls!.find(control => control.action === 'force-abandon')
    assert.ok(escape, 'a wedged job must offer force-abandon')
    assert.equal(escape.enabled, true)
    assert.equal(escape.label, 'Abandon this job')
    assert.match(escape.reason, /does not cancel provider work GenStudio has already accepted/)
    assert.match(escape.reason, /does not refund credits already spent/)
    assert.match(escape.reason, /Output may still arrive, and it stays recoverable/)

    const abandoned = await jq.forceAbandonJob(slug, 'abandon-me')
    assert.equal(abandoned.status, 'cancelled')
    assert.ok(abandoned.force_abandoned)
    assert.equal(abandoned.reconciliation_error, undefined)
    // Provider evidence is untouched — abandoning taught Story Studio nothing
    // about GenStudio, so it invents nothing about GenStudio.
    assert.equal(abandoned.genstudio_jobs!.length, 3)
    assert.ok(abandoned.genstudio_jobs!.every(entry => entry.state !== 'not_created'))
    assert.equal(abandoned.force_abandoned!.unsettled.length, 3)
    assert.match(abandoned.output_lines.join('\n'), /No cancellation was sent to GenStudio and nothing was refunded/)

    // Abandoning twice is a no-op, not a second cancellation.
    const again = await jq.forceAbandonJob(slug, 'abandon-me')
    assert.equal(again.force_abandoned!.at, abandoned.force_abandoned!.at)

    // The row is now usable: history can be cleared, and "generate a new one in
    // its replacement" is the Retry that sits beside it — the same Retry the
    // unsettled-evidence gate refused a moment ago.
    assert.equal(abandoned.control?.action, 'clear-history')
    assert.equal(abandoned.control?.enabled, true)
    const replacement = jq.retryTerminalJob(slug, 'abandon-me')
    assert.notEqual(replacement.job_id, 'abandon-me')
    assert.equal(replacement.episode_id, 'EP0053')
    assert.equal(replacement.type, 'continuity_render')
    // Retry replaces the row, as it always has: the abandoned job is gone and
    // its successor is queued in its place.
    assert.equal(jq.getJob('abandon-me'), null)

    // Stop the successor before this test's temp directory goes away, so a
    // half-started render cannot outlive the fixture and write outside it.
    await jq.forceAbandonJob(slug, replacement.job_id)
    await waitFor(() => {
      const current = jq.getJob(replacement.job_id)
      return !current || (current.status !== 'queued' && current.status !== 'running')
    }, 'the retried job to stop')
  } finally {
    globalThis.fetch = original
  }
})
