import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
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
  await setGenStudioUrl('https://reconcile.test')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
})

after(async () => { await cleanup() })

function job(status: 'queued' | 'submitting' | 'requested' | 'unknown' = 'submitting'): Job {
  return {
    job_id: 'story-reconcile', project_slug: 'project', type: 'audio', episode_id: 'EP0001', title: 'Audio',
    status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null,
    error: null, output_lines: [], params: {},
    genstudio_jobs: [{ id: 'provider-1', operation: 'voice.tts', state: 'accepted', updated_at: new Date().toISOString() }],
    remote_cancellations: {
      'voice.tts:provider-1': {
        status, operation: 'voice.tts', provider_job_id: 'provider-1',
        requested_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    },
  }
}

test('reconciles only the existing provider task and sends cancellation only after a cancellable status read', async () => {
  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
    if (url.pathname === '/v1/jobs/provider-1' && (init?.method || 'GET') === 'GET') {
      return Response.json({ id: 'provider-1', state: 'accepted', cancellable: true, cancelled: false })
    }
    if (url.pathname === '/v1/jobs/provider-1/cancel' && init?.method === 'POST') {
      return Response.json({ id: 'provider-1', state: 'accepted', cancellable: false, cancelled: true, released_credits: 4 })
    }
    return Response.json({ detail: 'unexpected request' }, { status: 500 })
  }
  try {
    const result = await reconcilePendingJobCancellation(job(), 'test-key')
    assert.equal(result.kind, 'cancelled')
    assert.deepEqual(requests, [
      { method: 'GET', path: '/v1/jobs/provider-1' },
      { method: 'POST', path: '/v1/jobs/provider-1/cancel' },
    ])
    assert.equal(result.records['voice.tts:provider-1']?.released_credits, 4)
  } finally {
    globalThis.fetch = original
  }
})

test('unknown outcomes remain nonterminal and never send a blind cancellation retry', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(new URL(String(input)).pathname)
    return Response.json({ id: 'provider-1', state: 'running', cancellable: true, cancelled: false })
  }
  try {
    const result = await reconcilePendingJobCancellation(job('unknown'), 'test-key')
    assert.equal(result.kind, 'pending')
    assert.deepEqual(requests, ['/v1/jobs/provider-1'])
    assert.equal(result.records['voice.tts:provider-1']?.status, 'reconciling')
  } finally {
    globalThis.fetch = original
  }
})

test('keeps the duplicate lock while an already-dispatched sibling still settles', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    if (path.endsWith('provider-1')) return Response.json({ id: 'provider-1', state: 'failed', cancelled: true })
    return Response.json({ id: 'provider-2', state: 'running', cancelled: false })
  }
  try {
    const input = job('unknown')
    input.remote_cancellations!['voice.tts:provider-1']!.status = 'requested'
    input.genstudio_jobs!.push({ id: 'provider-2', operation: 'video.generation', state: 'running', updated_at: new Date().toISOString() })
    const result = await reconcilePendingJobCancellation(input, 'test-key')
    assert.equal(result.kind, 'pending')
    assert.deepEqual(requests, ['/v1/jobs/provider-1', '/v1/videos/provider-2'])
  } finally {
    globalThis.fetch = original
  }
})

test('mixed succeeded and cancelled provider targets terminalize as repair-first error, never Done', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('provider-1')) return Response.json({ id: 'provider-1', state: 'failed', cancelled: true })
    return Response.json({ id: 'provider-2', state: 'succeeded', cancelled: false })
  }
  try {
    const input = job('unknown')
    input.remote_cancellations!['voice.tts:provider-1']!.status = 'requested'
    input.genstudio_jobs!.push({ id: 'provider-2', operation: 'video.generation', state: 'running', updated_at: new Date().toISOString() })
    const result = await reconcilePendingJobCancellation(input, 'test-key')
    assert.equal(result.kind, 'failed')
  } finally {
    globalThis.fetch = original
  }
})

test('status failures remain locked with a redacted visible reason', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ detail: 'Bearer secret-value denied' }, { status: 401 })
  try {
    const result = await reconcilePendingJobCancellation(job('unknown'), 'secret-value')
    assert.equal(result.kind, 'pending')
    const reason = result.records['voice.tts:provider-1']?.reconciliation_error || ''
    assert.match(reason, /HTTP 401/)
    assert.doesNotMatch(reason, /secret-value/)
  } finally {
    globalThis.fetch = original
  }
})

test('malformed status responses stay nonterminal rather than guessing a provider result', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{not-json', { status: 200 })
  try {
    const result = await reconcilePendingJobCancellation(job('unknown'), 'test-key')
    assert.equal(result.kind, 'pending')
    assert.match(result.records['voice.tts:provider-1']?.reconciliation_error || '', /invalid JSON/i)
  } finally {
    globalThis.fetch = original
  }
})

test('cold persisted cancellation reconciles outside a generation lane and retains its duplicate lock', async () => {
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'reconcile-test-key')
  const project = await pm.createProject({ name: 'Cold cancellation reconcile' })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  const persisted = job('queued')
  persisted.project_slug = project.slug
  persisted.job_id = 'cold-cancel'
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [persisted] }))

  const original = globalThis.fetch
  const calls: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
    if (url.pathname === '/v1/jobs/provider-1') return Response.json({ id: 'provider-1', state: 'accepted', cancellable: true, cancelled: false })
    if (url.pathname === '/v1/jobs/provider-1/cancel') return Response.json({ id: 'provider-1', state: 'accepted', cancellable: false, cancellation_requested: true, cancelled: false })
    return Response.json({ detail: 'generation POST must never be used by reconciliation' }, { status: 500 })
  }
  try {
    let unrelatedRan = false
    jq.registerExecutor('script-only', async () => { unrelatedRan = true })
    await jq.getJobs(project.slug)
    const deadline = Date.now() + 1_000
    while (Date.now() < deadline && jq.getJob('cold-cancel')?.remote_cancellations?.['voice.tts:provider-1']?.status !== 'requested') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const restored = jq.getJob('cold-cancel')!
    assert.equal(restored.status, 'running')
    assert.equal(restored.finished_at, null)
    assert.equal(jq.isDuplicate(project.slug, 'EP0001', 'audio'), true)
    assert.equal(jq.removeTerminalJob(project.slug, restored.job_id), false)
    assert.throws(() => jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'EP0001', title: 'duplicate', params: {} }))
    const unrelated = jq.enqueue({ project_slug: project.slug, type: 'script-only', episode_id: 'EP0099', title: 'unrelated', params: {} })
    while (Date.now() < deadline && !unrelatedRan) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(unrelatedRan, true)
    while (Date.now() < deadline && jq.getJob(unrelated.job_id)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(jq.getJob(unrelated.job_id)?.status, 'done')
    assert.deepEqual(calls, [
      { method: 'GET', path: '/v1/jobs/provider-1' },
      { method: 'POST', path: '/v1/jobs/provider-1/cancel' },
    ])
    const disk = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs.find((entry: Job) => entry.job_id === 'cold-cancel')
    assert.equal(disk.status, 'running')
    assert.equal(disk.remote_cancellations['voice.tts:provider-1'].status, 'requested')
  } finally {
    globalThis.fetch = original
  }
})
