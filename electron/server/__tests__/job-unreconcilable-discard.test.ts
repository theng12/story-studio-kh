/**
 * v1.2.9 — a finished job the owner cannot leave.
 *
 * THE INCIDENT. His "Dozing Knight" DK0071 subtitles batch recorded 31
 * transcription tasks. Nine were accepted, dispatched, charged (464 credits in
 * total) and saved. The other twenty-two never got a durable GenStudio id: they
 * were snapshotted as `submitting` under the placeholder `pending:<key>` and
 * stayed that way. The job finished as Error.
 *
 * He then had a row with two buttons and no exit:
 *
 *   - "Retry" threw 409 — `retryJob` refuses while unsettled provider evidence
 *     stands and the job is not abandoned.
 *   - "Clear finished (1)" counted the row but `clearFinished` skipped it, for
 *     the same reason. It reported clearing zero.
 *   - "Check GenStudio again" was enabled and could never succeed:
 *     `boundGenStudioRequestPreviews` keeps only the newest 8 `request`
 *     previews, so the reconciler read no `idempotency_key` on the older
 *     entries and returned "cannot reconcile provider evidence without a
 *     durable task identity or saved idempotency key" — permanently.
 *   - "Abandon this job", the v1.2.8 override built precisely for this, was
 *     NOT offered: its dead-end test was `controls.every(c => !c.enabled)`, and
 *     the futile recheck button was enabled.
 *
 * His words: "there's no way for me to clear/remove this failed job. it ask me
 * to check genstudio but i just want to waste credit and regenerate it again."
 *
 * Two defects, asserted separately below:
 *   1. The exit that matters for a finished job is removing the row. A
 *      diagnostic button is not an exit.
 *   2. The placeholder id IS the idempotency key. Claiming there is none,
 *      while holding it, is a false statement that made the recheck futile.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { classifyJobControls } from '../services/job-control.js'
import { reconcilePendingJobCancellation } from '../services/job-cancellation-reconciler.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  await setGenStudioUrl('https://unreconcilable.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'unreconcilable-test-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
})

after(async () => { await cleanup() })

const capabilities = { remoteCancellationAudited: true }

/** The nine that really ran, and were really charged. */
const SETTLED_CREDIT_COST = 44
const SETTLED_COUNT = 9
const PENDING_COUNT = 22
const TOTAL_CHARGED = 464

function settledEntry(index: number): NonNullable<Job['genstudio_jobs']>[number] {
  return {
    id: `job_settled_${index}`,
    operation: 'audio.transcription',
    state: 'succeeded',
    queue_state: 'succeeded',
    dispatch_state: 'dispatched',
    model_id: 'genstudio-transcribe-v1',
    // 8 x 44 + 1 x 112 = 464, matching the real batch total exactly.
    credit_cost: index === 0 ? TOTAL_CHARGED - SETTLED_CREDIT_COST * (SETTLED_COUNT - 1) : SETTLED_CREDIT_COST,
    reserved_credits: index === 0 ? TOTAL_CHARGED - SETTLED_CREDIT_COST * (SETTLED_COUNT - 1) : SETTLED_CREDIT_COST,
    settled_credits: index === 0 ? TOTAL_CHARGED - SETTLED_CREDIT_COST * (SETTLED_COUNT - 1) : SETTLED_CREDIT_COST,
    returned_credits: 0,
    released_credits: 0,
    price_version: 'transcription-price-0251-margin-floor-whisper-large',
    cancelled: false,
    updated_at: '2026-08-28T08:52:50.818Z',
  }
}

/**
 * The twenty-two. Note what they carry and what they do not: a `pending:` id
 * holding the idempotency key, and — for all but the newest three — no
 * `request` preview at all, because the retention window dropped it.
 */
function pendingEntry(index: number): NonNullable<Job['genstudio_jobs']>[number] {
  const key = `story-stt-${index.toString(16).padStart(8, '0')}0155ae1b8150970a2da2a286`
  const entry: NonNullable<Job['genstudio_jobs']>[number] = {
    id: `pending:${key}`,
    operation: 'audio.transcription',
    state: 'submitting',
    queue_state: 'submitting',
    model_id: 'whisper-large',
    updated_at: '2026-08-28T08:42:45.797Z',
  }
  // Only the newest three still carry a preview — exactly as observed.
  if (index >= PENDING_COUNT - 3) {
    entry.request = {
      method: 'POST',
      path: '/v1/transcriptions',
      captured_at: '2026-08-28T08:42:45.000Z',
      idempotency_key: key,
    }
  }
  return entry
}

function dozingKnightJob(jobId: string): Job {
  return {
    job_id: jobId,
    project_slug: 'placeholder',
    type: 'subtitles_transcribe',
    episode_id: 'DK0071',
    title: '[batch] subtitles — DK0071',
    status: 'error',
    created_at: '2026-08-28T08:42:27.850Z',
    started_at: '2026-08-28T08:42:27.857Z',
    finished_at: '2026-08-28T08:55:28.078Z',
    error: 'Transcription incomplete: 9/31 sections ready. Missing: Introduction, Chapter_04.',
    output_lines: [],
    params: {},
    genstudio_jobs: [
      ...Array.from({ length: SETTLED_COUNT }, (_, i) => settledEntry(i)),
      ...Array.from({ length: PENDING_COUNT }, (_, i) => pendingEntry(i)),
    ],
    remote_cancellations: {},
    history_evidence_check: {
      state: 'unreachable',
      at: '2026-08-28T14:02:43.259Z',
      detail: 'Story Studio cannot reconcile provider evidence without a durable task identity or saved idempotency key.',
    },
  } as Job
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

function creditEvidence(job: Job): { charged: number; ids: string[] } {
  const entries = job.genstudio_jobs || []
  return {
    charged: entries.reduce((sum, entry) => sum + (entry.settled_credits || 0), 0),
    ids: entries.map(entry => entry.id),
  }
}

// ---------------------------------------------------------------------------
// Defect 1 — the withheld exit.
// ---------------------------------------------------------------------------

test('a finished job whose only enabled control is a futile re-check is still offered a way out', () => {
  const controls = classifyJobControls(dozingKnightJob('dk-controls'), capabilities)

  // The re-check is still offered — it is not wrong, it is just not an exit.
  const recheck = controls.find(control => control.action === 'recheck-provider-status')
  assert.ok(recheck, 'the diagnostic re-check stays available')
  assert.equal(recheck.enabled, true)

  // This is the regression: an enabled diagnostic used to suppress the override.
  const abandon = controls.find(control => control.action === 'force-abandon')
  assert.ok(abandon, 'the owner override must be offered when the row cannot be removed')
  assert.equal(abandon.enabled, true)
  assert.equal(abandon.label, 'Abandon this job')

  // And it must still be honest about the three things it does not do.
  assert.match(abandon.reason, /does not cancel provider work GenStudio has already accepted/)
  assert.match(abandon.reason, /does not refund credits already spent/)
  assert.match(abandon.reason, /Output may still arrive/)
  assert.equal(abandon.financial_effect, 'provider-work-may-settle')
})

test('the override is withheld exactly when the row can already be removed', () => {
  const settled = dozingKnightJob('dk-settled')
  // Everything terminal: `clear-history` is enabled, so there is no dead end.
  settled.genstudio_jobs = (settled.genstudio_jobs || []).map(entry => ({ ...entry, state: 'succeeded' }))
  delete settled.history_evidence_check

  const controls = classifyJobControls(settled, capabilities)
  assert.equal(controls.find(control => control.action === 'clear-history')?.enabled, true)
  assert.equal(controls.find(control => control.action === 'force-abandon'), undefined)
})

test('an already-abandoned job is not offered the override again', () => {
  const abandoned = dozingKnightJob('dk-abandoned')
  abandoned.status = 'cancelled'
  abandoned.force_abandoned = { at: '2026-08-28T15:00:00.000Z', unsettled: [] }

  const controls = classifyJobControls(abandoned, capabilities)
  assert.equal(controls.find(control => control.action === 'force-abandon'), undefined)
  // It gets the real exit instead.
  assert.equal(controls.find(control => control.action === 'clear-history')?.enabled, true)
})

test('the v1.2.8 shapes still get the override — this is a superset, not a swap', () => {
  // An unfinished job: never offered clear-history, so always offered the override.
  const running = dozingKnightJob('dk-running')
  running.status = 'running'
  delete running.history_evidence_check
  assert.ok(classifyJobControls(running, capabilities).some(control => control.action === 'force-abandon'))

  // A finished job whose only control is DISABLED — the original v1.2.8 dead end.
  const checking = dozingKnightJob('dk-checking')
  delete checking.history_evidence_check
  const controls = classifyJobControls(checking, capabilities)
  assert.equal(controls.find(control => control.action === 'return-later')?.enabled, false)
  assert.ok(controls.some(control => control.action === 'force-abandon'))
})

// ---------------------------------------------------------------------------
// Defect 2 — the idempotency key that was there all along.
// ---------------------------------------------------------------------------

test('a pruned request preview does not make a batch unreconcilable — the key is in the id', async () => {
  const job = dozingKnightJob('dk-reconcile')
  const original = globalThis.fetch
  const lookups: string[] = []
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'reconciliation must never POST')
    const url = new URL(String(input))
    lookups.push(url.pathname)
    // The nine that really ran still answer for themselves.
    if (/\/v1\/transcriptions\/job_settled_\d+$/.test(url.pathname)) {
      return Response.json({ id: url.pathname.split('/').pop(), state: 'succeeded', dispatch_state: 'dispatched', cancellable: false })
    }
    // The twenty-two: GenStudio looked them up by key, and has nothing.
    return Response.json({ detail: 'transcription not found' }, { status: 404 })
  }
  try {
    const outcome = await reconcilePendingJobCancellation(job, 'unreconcilable-test-key', { readOnly: true })

    // The false claim is gone.
    assert.doesNotMatch(
      String(outcome.reason || ''),
      /without a durable task identity or saved idempotency key/,
      'Story Studio held the key the whole time; it must not claim otherwise',
    )
    // It actually asked, by key, for every entry that had no durable id.
    const byKey = lookups.filter(p => p.includes('/by-idempotency-key/'))
    assert.equal(byKey.length, PENDING_COUNT)
    // GenStudio answered "no such task", which is terminal — so the job resolves.
    assert.equal(outcome.absent.length, PENDING_COUNT)
    assert.equal(outcome.kind, 'failed')
  } finally {
    globalThis.fetch = original
  }
})

test('an entry with genuinely no identity is still refused honestly', async () => {
  const job = dozingKnightJob('dk-truly-keyless')
  job.genstudio_jobs = [
    { id: '' as unknown as string, operation: 'audio.transcription', state: 'submitting', updated_at: '2026-08-28T08:42:45.797Z' },
  ]
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('no lookup should be attempted') }
  try {
    const outcome = await reconcilePendingJobCancellation(job, 'unreconcilable-test-key', { readOnly: true })
    assert.match(String(outcome.reason || ''), /without a durable task identity or saved idempotency key/)
    assert.equal(outcome.kind, 'pending')
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------------------
// Discarding: what it preserves, what it refuses to invent, and what it unblocks.
// ---------------------------------------------------------------------------

test('discarding preserves the charge and every task id, and invents no success', async () => {
  const job = dozingKnightJob('dk-discard')
  const slug = await persist('Dozing Knight discard', job)
  const before = creditEvidence(job)
  assert.equal(before.charged, TOTAL_CHARGED)

  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  try {
    await jq.getJobs(slug)
    const abandoned = await jq.forceAbandonJob(slug, 'dk-discard')

    // Terminal, and terminal as CANCELLED — never as done.
    assert.equal(abandoned.status, 'cancelled')
    assert.notEqual(abandoned.status, 'done')
    assert.ok(abandoned.force_abandoned)

    // The evidence is byte-for-byte intact: the spend and the task ids are the
    // only record that this money left, and a discard must not erase them.
    const after = creditEvidence(abandoned as Job)
    assert.equal(after.charged, TOTAL_CHARGED)
    assert.equal(after.ids.length, SETTLED_COUNT + PENDING_COUNT)
    assert.deepEqual(after.ids, before.ids)

    // No provider entry was rewritten to look settled.
    const states = (abandoned.genstudio_jobs || []).filter(entry => entry.state === 'submitting')
    assert.equal(states.length, PENDING_COUNT, 'unsettled entries stay unsettled')
    assert.ok((abandoned.genstudio_jobs || []).every(entry => entry.state !== 'not_created'))

    // The log states what was walked away from, and claims no success.
    const log = abandoned.output_lines.join('\n')
    assert.match(log, /Abandoned at your request/)
    assert.match(log, /nothing was refunded/)
    assert.match(log, new RegExp(`These ${PENDING_COUNT} provider tasks were still unresolved`))
    assert.doesNotMatch(log, /confirmed every recorded provider task/)
    assert.doesNotMatch(log, /completed successfully/)

    // Still inspectable in history, ledger and all, until he chooses to clear it.
    const still = jq.getJob('dk-discard')
    assert.ok(still, 'a discarded job stays in history')
    assert.equal(creditEvidence(still as Job).charged, TOTAL_CHARGED)

    // And clearing it now works — the counter and the action finally agree.
    assert.equal(await jq.clearFinished(slug), 1)
    assert.equal(jq.getJob('dk-discard'), null)
  } finally {
    globalThis.fetch = original
  }
})

test('an abandon landing mid-check never gains a confirmation nobody has', async () => {
  const job = dozingKnightJob('dk-race')
  const slug = await persist('Dozing Knight mid-check abandon', job)

  const original = globalThis.fetch
  // The check is in flight and slow. He abandons while it is still out.
  let announceLookup!: () => void
  const lookupReached = new Promise<void>(resolve => { announceLookup = resolve })
  let releaseLookup!: () => void
  const lookupHeld = new Promise<void>(resolve => { releaseLookup = resolve })
  globalThis.fetch = async () => {
    announceLookup()
    await lookupHeld
    throw new TypeError('fetch failed')
  }
  try {
    await jq.getJobs(slug)
    await lookupReached
    await jq.forceAbandonJob(slug, 'dk-race')

    // Everything the refresh does from here lands after the abandon, so its
    // own update event is the signal that it finished — no wall-clock guess.
    let refreshLanded = false
    const onUpdate = (updated: { job_id?: string }) => {
      if (updated?.job_id === 'dk-race') refreshLanded = true
    }
    jq.jobEvents.on('update', onUpdate)
    try {
      releaseLookup()
      await waitFor(() => refreshLanded, { label: 'the in-flight check to land on the abandoned job' })
    } finally {
      jq.jobEvents.off('update', onUpdate)
    }

    const after = jq.getJob('dk-race')!
    const log = after.output_lines.join('\n')
    assert.match(log, /Abandoned at your request/)
    // The whole point: abandoning is not evidence, and must never be minuted
    // as though GenStudio had answered.
    assert.doesNotMatch(log, /GenStudio confirmed every recorded provider task/)
    assert.equal(after.status, 'cancelled')
    // The unsettled entries stay unsettled — nothing was rewritten as terminal.
    assert.equal((after.genstudio_jobs || []).filter(entry => entry.state === 'submitting').length, PENDING_COUNT)
  } finally {
    releaseLookup()
    globalThis.fetch = original
  }
})

test('a discarded job does not block a fresh run of the same work', async () => {
  const job = dozingKnightJob('dk-rerun')
  const slug = await persist('Dozing Knight rerun', job)

  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  try {
    await jq.getJobs(slug)

    // His actual trap, reproduced: every exit on the row refuses at once.
    assert.throws(
      () => jq.retryTerminalJob(slug, 'dk-rerun'),
      /unsettled provider evidence/,
      'Retry is refused while the evidence stands',
    )
    assert.equal(jq.removeTerminalJob(slug, 'dk-rerun'), false)
    assert.equal(await jq.clearFinished(slug), 0, '"Clear finished" counts the row but clears nothing')

    const abandoned = await jq.forceAbandonJob(slug, 'dk-rerun')
    assert.equal(abandoned.controls?.find(control => control.action === 'clear-history')?.enabled, true)

    // Regenerating the same work — what he actually wanted — is now allowed.
    const replacement = jq.retryTerminalJob(slug, 'dk-rerun')
    assert.notEqual(replacement.job_id, 'dk-rerun')
    assert.equal(replacement.episode_id, 'DK0071')
    assert.equal(replacement.type, 'subtitles_transcribe')
    // The fresh run carries none of the abandoned job's provider evidence.
    assert.equal((replacement.genstudio_jobs || []).length, 0)
    assert.equal(replacement.force_abandoned, undefined)

    // Stop the successor before the fixture's temp directory goes away, so a
    // half-started run cannot outlive it and write outside the fixture.
    await jq.forceAbandonJob(slug, replacement.job_id)
    await waitFor(() => {
      const current = jq.getJob(replacement.job_id)
      return !current || (current.status !== 'queued' && current.status !== 'running')
    }, { label: 'the replacement job to stop' })
  } finally {
    globalThis.fetch = original
  }
})
