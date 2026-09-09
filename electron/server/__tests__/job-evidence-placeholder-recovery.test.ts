/**
 * A bounded request-preview window must never become a bounded provider
 * identity window. These tests exercise the queue's durable writer and the
 * finished-history recheck, rather than inspecting the correlation field that
 * makes either path safe.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { setGenStudioUrl } from '../services/app-settings.js'

let cleanup: () => Promise<void>
let tempDir: string
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  await setGenStudioUrl('https://placeholder-recovery.test')
  const secrets = await import('../services/app-secrets-store.js')
  await secrets.setApiKey('genstudio', 'placeholder-recovery-key')
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  await jq.setQueuePaused(true)
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await jq.setQueuePaused(false)
  await cleanup()
})

type Evidence = NonNullable<Job['genstudio_jobs']>[number]

function requestKey(index: number): string {
  return `story-stt-${String(index).padStart(4, '0')}`
}

function errorJob(projectSlug: string, jobId: string, evidence: Evidence[]): Job {
  const at = '2026-09-09T00:00:00.000Z'
  return {
    job_id: jobId,
    project_slug: projectSlug,
    type: 'subtitles_transcribe',
    episode_id: `EP-${jobId}`,
    title: 'Placeholder recovery',
    status: 'error',
    created_at: at,
    started_at: at,
    finished_at: at,
    error: 'Interrupted after provider submission.',
    genstudio_jobs: evidence,
    output_lines: [],
    params: {},
  }
}

async function seedPersisted(slug: string, jobs: Job[]): Promise<void> {
  const file = path.join(tempDir, 'projects', slug, 'jobs.json')
  await fs.writeFile(file, JSON.stringify({ jobs }, null, 2))
  await jq.getJobs(slug)
}

async function readPersisted(slug: string): Promise<Job[]> {
  const file = path.join(tempDir, 'projects', slug, 'jobs.json')
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { jobs: Job[] }
  return parsed.jobs
}

function previewCount(job: Job): number {
  return (job.genstudio_jobs || []).filter(entry => entry.request).length
}

test('a 31-request queue batch settles and clears after preview pruning without resurrected placeholders', async () => {
  const project = await pm.createProject({ name: '31 durable subtitle receipts' })
  const job = errorJob(project.slug, 'thirty-one-receipts', [])
  await seedPersisted(project.slug, [job])
  const keys = Array.from({ length: 31 }, (_, index) => requestKey(index))

  // Every request first reaches durable storage with only its local submission
  // key. Preview retention then drops the oldest 23 request bodies before
  // GenStudio has returned every real task id.
  for (const key of keys) {
    await jq.recordGenStudioJob(job.job_id, {
      id: `pending:${key}`,
      operation: 'audio.transcription',
      state: 'submitting',
      updated_at: '2026-09-09T00:00:00.000Z',
      request: { method: 'POST', path: '/v1/audio/transcriptions/quotes', idempotency_key: key, captured_at: '2026-09-09T00:00:00.000Z' },
    })
  }

  let persisted = (await readPersisted(project.slug)).find(candidate => candidate.job_id === job.job_id)
  assert.ok(persisted)
  assert.equal(persisted.genstudio_jobs?.length, 31)
  assert.equal(previewCount(persisted), 8, 'request previews stay bounded while the job is in flight')

  // These are the later provider observations: they deliberately carry no
  // preview, because the source request may already have been pruned.
  for (const [index, key] of keys.entries()) {
    await jq.recordGenStudioJob(job.job_id, {
      id: `transcription-${index}`,
      operation: 'audio.transcription',
      state: 'succeeded',
      updated_at: '2026-09-09T00:01:00.000Z',
      request_key: key,
    } as Evidence)
  }

  persisted = (await readPersisted(project.slug)).find(candidate => candidate.job_id === job.job_id)
  assert.ok(persisted)
  assert.equal(persisted.genstudio_jobs?.length, 31, 'one durable record remains for each provider request')
  assert.equal(persisted.genstudio_jobs?.some(entry => entry.id.startsWith('pending:')), false)
  assert.ok(persisted.genstudio_jobs?.every(entry => entry.state === 'succeeded'))
  assert.ok(previewCount(persisted) <= 8, 'resolved records do not restore pruned request previews')

  // `clearFinished` is the customer-visible proof that the record loaded from
  // disk has no ghost provider work holding its history row.
  assert.equal(await jq.clearFinished(project.slug), 1)
  await waitFor(async () => !(await readPersisted(project.slug)).some(candidate => candidate.job_id === job.job_id), {
    label: 'settled 31-request history removal to persist', timeoutMs: 5_000,
  })
})

test('history refresh resolves only the pruned legacy placeholder and persists one real provider record', async () => {
  const project = await pm.createProject({ name: 'Legacy placeholder history refresh' })
  const key = 'story-legacy-history-key'
  const job = errorJob(project.slug, 'legacy-history', [
    { id: 'provider-history-task', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-09-09T00:00:00.000Z' },
    { id: `pending:${key}`, operation: 'voice.tts', state: 'submitting', updated_at: '2026-09-09T00:00:00.000Z' },
  ])
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
    assert.match(url.pathname, /by-idempotency-key\/story-legacy-history-key$/)
    return Response.json({ id: 'provider-history-task', state: 'succeeded', dispatch_state: 'dispatched', cancellable: false })
  }
  try {
    await seedPersisted(project.slug, [job])
    await jq.recheckJobProviderStatus(project.slug, job.job_id)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(requests.map(request => request.method), ['GET'], 'only the unresolved placeholder is re-read')
  const persisted = (await readPersisted(project.slug)).find(candidate => candidate.job_id === job.job_id)
  assert.ok(persisted)
  assert.equal(persisted.genstudio_jobs?.length, 1, 'disk merge does not union the stale placeholder back in')
  assert.equal(persisted.genstudio_jobs?.[0]?.id, 'provider-history-task')
  assert.equal(await jq.clearFinished(project.slug), 1, 'the resolved history row is clearable')
  await waitFor(async () => !(await readPersisted(project.slug)).some(candidate => candidate.job_id === job.job_id), {
    label: 'resolved legacy history removal to persist', timeoutMs: 5_000,
  })
})

test('ambiguous or cross-operation correlations remain blocked and retain their separate evidence', async () => {
  const project = await pm.createProject({ name: 'Conservative placeholder correlation' })
  const key = 'story-do-not-fold'
  const ambiguous = errorJob(project.slug, 'ambiguous-placeholder', [
    { id: `pending:${key}`, operation: 'voice.tts', state: 'submitting', updated_at: '2026-09-09T00:00:00.000Z' },
    { id: 'provider-a', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-09-09T00:01:00.000Z', request_key: key } as Evidence,
    { id: 'provider-b', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-09-09T00:01:00.000Z', request_key: key } as Evidence,
  ])
  const crossOperation = errorJob(project.slug, 'cross-operation-placeholder', [
    { id: `pending:${key}`, operation: 'voice.tts', state: 'submitting', updated_at: '2026-09-09T00:00:00.000Z' },
    { id: 'transcription-task', operation: 'audio.transcription', state: 'succeeded', updated_at: '2026-09-09T00:01:00.000Z', request_key: key } as Evidence,
  ])
  const originalFetch = globalThis.fetch
  const lookups: string[] = []
  globalThis.fetch = async input => {
    lookups.push(new URL(String(input)).pathname)
    // Keep the placeholder unresolved without leaving a never-settling task
    // behind the test's temporary data directory.
    return Response.json({ id: `pending:${key}`, state: 'running', dispatch_state: 'dispatched', cancellable: false })
  }
  try {
    await seedPersisted(project.slug, [ambiguous, crossOperation])
    await waitFor(() => lookups.length === 2, {
      label: 'both unresolved placeholder history reads to finish', timeoutMs: 2_000,
    })
    await jq._waitForJobPersistenceForTesting()
    assert.equal(await jq.clearFinished(project.slug), 0, 'unresolved evidence still protects both history rows')
    const persisted = await readPersisted(project.slug)
    assert.equal(persisted.find(candidate => candidate.job_id === ambiguous.job_id)?.genstudio_jobs?.length, 3)
    assert.equal(persisted.find(candidate => candidate.job_id === crossOperation.job_id)?.genstudio_jobs?.length, 2)
    assert.ok(persisted.find(candidate => candidate.job_id === crossOperation.job_id)?.genstudio_jobs?.some(entry => entry.operation === 'audio.transcription'))
  } finally {
    globalThis.fetch = originalFetch
  }
})
