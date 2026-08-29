/**
 * v1.4.81 — "Clear finished (6)" must clear six.
 *
 * MEASURED ON THE OWNER'S OWN HISTORY, 2026-08-29. Six Scene Review jobs sat in
 * All Jobs as `cancelled` — abandoned when the queue moved on during a drain.
 * The header read "Clear finished (6)". Clicking it removed nothing. Clicking
 * it again removed nothing. The badge kept promising six.
 *
 * Neither half was broken on its own. There were simply TWO definitions of
 * "this provider task can no longer change":
 *
 *   job-control.ts  terminal = succeeded | failed | cancelled | not_created
 *   job-queue.ts    terminal = cancelled BOOLEAN | succeeded | failed | not_created
 *
 * A task recorded as `state: 'cancelled'` without the boolean was terminal to
 * the button and still-settling to the code behind the button. The badge counted
 * it; `clearFinished` skipped it; nobody said why.
 *
 * This test does not care which module is right. It pins the only property that
 * matters to the owner: THE NUMBER ON THE BUTTON IS THE NUMBER THAT DISAPPEARS.
 * It also pins the other direction, because a badge that agrees by counting
 * everything would be just as wrong — a genuinely unsettled row must still be
 * excluded from both sides.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

/**
 * Listing a finished job with unsettled evidence starts a background provider
 * re-check, and `clearFinished` persists its compacted snapshot behind the
 * response on purpose. Both end in a write. Wait for the file to reach its
 * final shape so nothing lands after the temp data dir is torn down — and so
 * this asserts the DURABLE result rather than only the in-memory one.
 */
async function persistedJobs(jobsFile: string): Promise<Array<{ job_id: string, history_evidence_check?: { state?: string } }>> {
  const raw = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
  return raw.jobs || []
}

/**
 * WAIT FOR THE WRITE, NOT THE FLAG.
 *
 * This previously waited for the in-memory check to leave `'checking'`. That
 * predicate is true at BOTH ends of the re-check — before it starts and after
 * it finishes — and `recordHistoryEvidenceCheck` assigns the finished state
 * synchronously and only THEN awaits `persistJob`. So the wait could pass one
 * tick before the write landed, the test would end, the temp data dir would be
 * torn down, and the write arrived to a dead directory: "job-queue isolation
 * violation … STORY_STUDIO_DATA_DIR=<unset>", roughly one run in three.
 *
 * The second test was the one that failed because its row set never changes,
 * so the id comparison alone gave the write no time at all.
 *
 * Comparing the PERSISTED evidence state against the in-memory one closes it:
 * while a write is still in flight the file still holds the previous value and
 * the two disagree, so the wait continues until the durable state matches.
 */
async function settleTo(jobsFile: string, expected: string[], jq: typeof import('../services/job-queue.js')): Promise<void> {
  await waitFor(async () => {
    const persisted = await persistedJobs(jobsFile)
    const ids = persisted.map(job => job.job_id).sort()
    if (ids.join() !== [...expected].sort().join()) return false
    return expected.every(id => {
      const memory = jq.getJob(id)?.history_evidence_check?.state
      if (memory === 'checking') return false
      const file = persisted.find(job => job.job_id === id)?.history_evidence_check?.state
      return file === memory
    })
  }, { label: `jobs.json to settle to [${expected.join(', ')}]` })
}

function row(
  jobId: string,
  status: 'done' | 'error' | 'cancelled',
  evidence: Array<Record<string, unknown>>,
  project: string,
) {
  return {
    job_id: jobId,
    project_slug: project,
    type: 'continuity_render',
    episode_id: 'DK0060',
    title: `[batch] scene_review — ${jobId}`,
    status,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    error: status === 'error' ? 'something failed' : null,
    output_lines: [],
    params: {},
    remote_cancellations: {},
    genstudio_jobs: evidence.map((entry, index) => ({
      id: `${jobId}-task-${index}`,
      operation: 'image.generation',
      updated_at: new Date().toISOString(),
      ...entry,
    })),
  }
}

test('the badge count equals the rows the bulk clear removes', async () => {
  const project = await pm.createProject({ name: 'Clear Finished Agreement' })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')

  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [
    row('history-done', 'done', [{ state: 'succeeded' }], project.slug),
    row('history-failed', 'error', [{ state: 'failed' }], project.slug),
    // THE OWNER'S SIX. A cancelled provider task, recorded by state rather than
    // by the boolean flag — which is exactly the shape the two definitions
    // disagreed about.
    row('history-cancelled', 'cancelled', [{ state: 'cancelled' }], project.slug),
    // Still genuinely in flight at the provider. Neither side may count it:
    // agreeing by clearing everything would discard live provider evidence.
    row('history-still-settling', 'cancelled', [{ state: 'reserved' }], project.slug),
  ] }))

  const before = await jq.getJobs(project.slug)
  assert.equal(before.length, 4)

  // Exactly the expression the header badge uses: a terminal row the server
  // itself says can be removed.
  const badge = before.filter(job => (
    ['done', 'error', 'cancelled'].includes(job.status)
    && (job.controls || []).some(control => control.enabled && control.action === 'clear-history')
  ))
  assert.deepEqual(badge.map(job => job.job_id).sort(), [
    'history-cancelled', 'history-done', 'history-failed',
  ])

  const cleared = await jq.clearFinished(project.slug)

  // The promise and the result are the same number. This is the whole test.
  assert.equal(cleared, badge.length)

  const remaining = await jq.getJobs(project.slug)
  assert.deepEqual(remaining.map(job => job.job_id), ['history-still-settling'])
  await settleTo(jobsFile, ['history-still-settling'], jq)
})

test('a row the clear will refuse is not counted by the badge', async () => {
  // The inverse guard. If this ever fails, the button has started promising a
  // row it cannot deliver — which is the defect, restated.
  const project = await pm.createProject({ name: 'Clear Finished Refusal' })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')

  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [
    row('only-unsettled', 'cancelled', [{ state: 'running' }], project.slug),
  ] }))

  const listed = await jq.getJobs(project.slug)
  const clearable = (listed[0]!.controls || []).some(
    control => control.enabled && control.action === 'clear-history',
  )
  assert.equal(clearable, false)
  assert.equal(await jq.clearFinished(project.slug), 0)
  await settleTo(jobsFile, ['only-unsettled'], jq)
})
