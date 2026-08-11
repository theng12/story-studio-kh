import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { reconcilePendingJobCancellation } from '../services/job-cancellation-reconciler.js'
import { getJobCancellationAuditor } from '../services/job-cancellation-auditors.js'
import { registerAllExecutors } from '../boot/executors.js'
import { createPool } from '../services/broll-pool-manager.js'
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

async function waitFor(check: () => boolean, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('Timed out waiting for reconciliation state')
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

test('continues polling an accepted sibling after the requested target is already confirmed cancelled', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const requestPath = new URL(String(input)).pathname
    requests.push(requestPath)
    if (requestPath.endsWith('provider-1')) return Response.json({ id: 'provider-1', state: 'failed', cancelled: true })
    return Response.json({ id: 'provider-2', state: 'running', cancelled: false })
  }
  try {
    const input = job('unknown')
    input.remote_cancellations!['voice.tts:provider-1']!.status = 'confirmed'
    input.remote_cancellations!['voice.tts:provider-1']!.cancelled = true
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

test('the registered image-pool auditor requires every accepted asset at its exact recorded path', async () => {
  registerAllExecutors({ loadSettings: false })
  const poolDir = path.join(tempDir, 'exact-pool-audit')
  await fs.mkdir(poolDir, { recursive: true })
  const pool = await createPool({ name: `Exact pool ${Date.now()}`, folder_path: poolDir, media: 'image' })
  const expected = path.join(poolDir, 'gen-audit-run-0001.png')
  await sharp({ create: { width: 1, height: 1, channels: 3, background: 'black' } }).png().toFile(expected)
  const input: Job = {
    ...job(), type: 'image_pool_generate', project_slug: 'pool-project', episode_id: 'EPPOOL',
    params: {
      pool_id: pool.id,
      run_id: 'audit-run',
      variants: 1,
      prompts: ['one prompt'],
      genstudio_recovery: {
        version: 1, route: 'genstudio', assets: {
          'gen-audit-run-0001.png': { operation: 'image', state: 'accepted', output_path: expected },
        },
      },
    },
  }
  const auditor = getJobCancellationAuditor('image_pool_generate')
  assert.ok(auditor)
  assert.equal(await auditor!(input), 'complete')

  await fs.rm(expected)
  await fs.writeFile(path.join(poolDir, 'gen-audit-run-9999.png'), 'stale extra output')
  assert.equal(await auditor!(input), 'repair-required')
})

test('the registered composition auditor turns a corrupt output into repair-required', async () => {
  registerAllExecutors({ loadSettings: false })
  const project = await pm.createProject({ name: 'Corrupt composition audit' })
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const paths = await resolveEpisodePathsByCode(project.slug, 'EP0002')
  const file = path.join(paths.episode_dir, 'img2img-references', 'composition.png')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'not a decodable image')
  const input: Job = {
    ...job(), type: 'composition_generate', project_slug: project.slug, episode_id: 'EP0002', params: {},
  }
  const auditor = getJobCancellationAuditor('composition_generate')
  assert.ok(auditor)
  assert.equal(await auditor!(input), 'repair-required')
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

test('a cold job with only already-settled cancellation evidence still reaches its terminal cancellation state', async () => {
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'reconcile-test-key')
  const project = await pm.createProject({ name: 'Cold settled cancellation' })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  const persisted = job('unknown')
  persisted.project_slug = project.slug
  persisted.job_id = 'cold-settled-cancel'
  persisted.remote_cancellations!['voice.tts:provider-1']!.status = 'confirmed'
  persisted.remote_cancellations!['voice.tts:provider-1']!.cancelled = true
  persisted.genstudio_jobs![0]!.state = 'failed'
  persisted.genstudio_jobs![0]!.cancelled = true
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [persisted] }))

  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    assert.equal(new URL(String(input)).pathname, '/v1/jobs/provider-1')
    return Response.json({ id: 'provider-1', state: 'failed', cancelled: true })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(() => jq.getJob('cold-settled-cancel')?.status === 'cancelled')
    assert.equal(jq.getJob('cold-settled-cancel')?.finished_at === null, false)
  } finally {
    globalThis.fetch = original
  }
})

test('a cold cancelled target keeps its restart reconciler active until an accepted sibling settles', async () => {
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'reconcile-test-key')
  const project = await pm.createProject({ name: 'Cold sibling settlement' })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  const persisted = job('unknown')
  persisted.project_slug = project.slug
  persisted.job_id = 'cold-sibling'
  persisted.remote_cancellations!['voice.tts:provider-1']!.status = 'confirmed'
  persisted.remote_cancellations!['voice.tts:provider-1']!.cancelled = true
  persisted.genstudio_jobs!.push({ id: 'provider-2', operation: 'video.generation', state: 'running', updated_at: new Date().toISOString() })
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [persisted] }))
  const preservedEvidence = path.join(tempDir, 'projects', project.slug, 'provider-evidence.txt')
  await fs.writeFile(preservedEvidence, 'provider evidence survives history cleanup')

  const original = globalThis.fetch
  let siblingSettled = false
  let siblingReads = 0
  const updates: Array<{ job_id: string; status: string }> = []
  const onUpdate = (entry: Job) => updates.push({ job_id: entry.job_id, status: entry.status })
  jq.jobEvents.on('update', onUpdate)
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.method || 'GET').toUpperCase(), 'GET')
    const requestPath = new URL(String(input)).pathname
    if (requestPath === '/v1/jobs/provider-1') return Response.json({ id: 'provider-1', state: 'failed', cancelled: true })
    if (requestPath === '/v1/videos/provider-2') {
      siblingReads++
      return Response.json({ id: 'provider-2', state: siblingSettled ? 'succeeded' : 'running', cancelled: false })
    }
    return Response.json({ detail: 'unexpected request' }, { status: 500 })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(() => siblingReads >= 1)
    const during = jq.getJob('cold-sibling')!
    assert.equal(during.status, 'running')
    assert.equal(jq.isDuplicate(project.slug, 'EP0001', 'audio'), true)
    assert.equal(jq.removeTerminalJob(project.slug, during.job_id), false)
    assert.throws(() => jq.retryTerminalJob(project.slug, during.job_id))
    assert.throws(() => jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'EP0001', title: 'duplicate', params: {} }))

    siblingSettled = true
    await waitFor(() => jq.getJob('cold-sibling')?.status === 'error')
    await waitFor(() => updates.some(update => update.job_id === 'cold-sibling' && update.status === 'error'))
    assert.ok(siblingReads >= 2)
    assert.equal(jq.getJob('cold-sibling')?.result?.repair_required, true)
    assert.ok(updates.some(update => update.job_id === 'cold-sibling' && update.status === 'running'))
    assert.equal(jq.removeTerminalJob(project.slug, 'cold-sibling'), true)
    assert.equal(await fs.readFile(preservedEvidence, 'utf8'), 'provider evidence survives history cleanup')
  } finally {
    jq.jobEvents.off('update', onUpdate)
    globalThis.fetch = original
  }
})

test('a sibling status read error remains visible and retries on the next reconciliation cycle', async () => {
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'reconcile-test-key')
  const project = await pm.createProject({ name: 'Cold sibling status retry' })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  const persisted = job('unknown')
  persisted.project_slug = project.slug
  persisted.job_id = 'cold-sibling-status-retry'
  persisted.remote_cancellations!['voice.tts:provider-1']!.status = 'confirmed'
  persisted.remote_cancellations!['voice.tts:provider-1']!.cancelled = true
  persisted.genstudio_jobs!.push({ id: 'provider-2', operation: 'video.generation', state: 'running', updated_at: new Date().toISOString() })
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [persisted] }))

  const original = globalThis.fetch
  let siblingReads = 0
  globalThis.fetch = async (input) => {
    const requestPath = new URL(String(input)).pathname
    if (requestPath === '/v1/jobs/provider-1') return Response.json({ id: 'provider-1', state: 'failed', cancelled: true })
    if (requestPath === '/v1/videos/provider-2') {
      siblingReads++
      return siblingReads === 1
        ? Response.json({ detail: 'Bearer secret-value denied' }, { status: 401 })
        : Response.json({ id: 'provider-2', state: 'succeeded', cancelled: false })
    }
    return Response.json({ detail: 'unexpected request' }, { status: 500 })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(() => Boolean(jq.getJob('cold-sibling-status-retry')?.reconciliation_error))
    const waiting = jq.getJob('cold-sibling-status-retry')!
    assert.match(waiting.reconciliation_error || '', /HTTP 401/)
    assert.doesNotMatch(waiting.reconciliation_error || '', /secret-value/)
    assert.equal(waiting.control?.action, 'return-later')
    assert.match(waiting.control?.reason || '', /HTTP 401/)

    await waitFor(() => jq.getJob('cold-sibling-status-retry')?.status === 'error')
    assert.ok(siblingReads >= 2)
  } finally {
    globalThis.fetch = original
  }
})
