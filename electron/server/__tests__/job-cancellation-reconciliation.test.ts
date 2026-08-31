import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { reconcilePendingJobCancellation } from '../services/job-cancellation-reconciler.js'
import { getJobCancellationAuditor, registerJobCancellationAuditor } from '../services/job-cancellation-auditors.js'
import { registerAllExecutors } from '../boot/executors.js'
import { createPool } from '../services/broll-pool-manager.js'
import type { Job } from '../models/types.js'
import { waitFor as waitForScheduled } from './_timing.js'

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
      return Response.json({ id: 'provider-1', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false })
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

test('restart retries cancellation only for an explicitly pre-dispatch task', async () => {
  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ method: (init?.method || 'GET').toUpperCase(), path: new URL(String(input)).pathname })
    return Response.json({ id: 'provider-1', state: 'running', dispatch_state: 'dispatched', cancellable: true, cancelled: false })
  }
  try {
    const result = await reconcilePendingJobCancellation(job('submitting'), 'test-key')
    assert.equal(result.kind, 'pending')
    assert.deepEqual(requests, [{ method: 'GET', path: '/v1/jobs/provider-1' }])
    assert.equal(result.records['voice.tts:provider-1']?.status, 'reconciling')
  } finally {
    globalThis.fetch = original
  }
})

test('a 409 cancellation remains locked and continues read-only reconciliation', async () => {
  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    const request = { method: (init?.method || 'GET').toUpperCase(), path: new URL(String(input)).pathname }
    requests.push(request)
    if (request.method === 'POST') return Response.json({ detail: 'already dispatched' }, { status: 409 })
    return Response.json({ id: 'provider-1', state: 'running', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false })
  }
  try {
    const result = await reconcilePendingJobCancellation(job('submitting'), 'test-key')
    assert.equal(result.kind, 'pending')
    assert.equal(requests.filter(request => request.method === 'POST').length, 1)
    assert.equal(result.records['voice.tts:provider-1']?.status, 'unknown')
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

test('does not terminalize a cancelled Video while an accepted Chat sibling is still running', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const requestPath = new URL(String(input)).pathname
    requests.push(requestPath)
    if (requestPath === '/v1/videos/video-cancelled') {
      return Response.json({ id: 'video-cancelled', state: 'failed', cancelled: true })
    }
    if (requestPath === '/v1/chat/responses/chat-running') {
      return Response.json({ id: 'chat-running', state: 'running' })
    }
    return Response.json({ detail: 'unexpected request' }, { status: 500 })
  }
  try {
    const input = job('unknown')
    input.genstudio_jobs = [
      { id: 'video-cancelled', operation: 'video.generation', state: 'running', updated_at: new Date().toISOString() },
      { id: 'chat-running', operation: 'chat.response', state: 'running', updated_at: new Date().toISOString() },
    ]
    input.remote_cancellations = {
      'video.generation:video-cancelled': {
        status: 'confirmed', operation: 'video.generation', provider_job_id: 'video-cancelled',
        requested_at: new Date().toISOString(), updated_at: new Date().toISOString(), cancelled: true,
      },
    }

    const result = await reconcilePendingJobCancellation(input, 'test-key')

    assert.equal(result.kind, 'pending')
    assert.deepEqual(requests, ['/v1/videos/video-cancelled', '/v1/chat/responses/chat-running'])
  } finally {
    globalThis.fetch = original
  }
})

test('reconciles Music provider evidence through its read-only status endpoint', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const requestPath = new URL(String(input)).pathname
    requests.push(requestPath)
    if (requestPath === '/v1/videos/video-cancelled') {
      return Response.json({ id: 'video-cancelled', state: 'failed', cancelled: true })
    }
    if (requestPath === '/v1/music/jobs/music-running') {
      return Response.json({ id: 'music-running', state: 'running', dispatch_state: 'dispatched', cancelled: false })
    }
    return Response.json({ detail: 'unexpected request' }, { status: 500 })
  }
  try {
    const input = job('unknown')
    input.genstudio_jobs = [
      { id: 'video-cancelled', operation: 'video.generation', state: 'running', updated_at: new Date().toISOString() },
      { id: 'music-running', operation: 'music.generation', state: 'running', updated_at: new Date().toISOString() },
    ]
    input.remote_cancellations = {
      'video.generation:video-cancelled': {
        status: 'confirmed', operation: 'video.generation', provider_job_id: 'video-cancelled',
        requested_at: new Date().toISOString(), updated_at: new Date().toISOString(), cancelled: true,
      },
    }

    const result = await reconcilePendingJobCancellation(input, 'test-key')

    assert.equal(result.kind, 'pending')
    assert.deepEqual(requests, ['/v1/videos/video-cancelled', '/v1/music/jobs/music-running'])
  } finally {
    globalThis.fetch = original
  }
})

test('reconciles pending Chat and Music evidence by the saved key without generation POSTs', async () => {
  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method || 'GET').toUpperCase()
    requests.push({ method, path: url.pathname })
    const [, , kind] = url.pathname.split('/')
    const id = kind === 'chat' ? 'chat-durable' : 'music-durable'
    return Response.json({ id, state: 'running', dispatch_state: 'dispatched', cancellable: false })
  }
  try {
    for (const [operation, path] of [
      ['chat.response', '/v1/chat/responses/by-idempotency-key/chat-key'],
      ['music.generation', '/v1/music/jobs/by-idempotency-key/music-key'],
    ] as const) {
      requests.length = 0
      const input = job('unknown')
      input.genstudio_jobs = [{
        id: `pending:${operation === 'chat.response' ? 'chat-key' : 'music-key'}`,
        operation,
        state: 'submitting',
        updated_at: new Date().toISOString(),
        request: { method: 'POST', path: '/v1/test', captured_at: '2026-08-12T00:00:00.000Z', idempotency_key: operation === 'chat.response' ? 'chat-key' : 'music-key' },
      }]
      input.remote_cancellations = {}

      const result = await reconcilePendingJobCancellation(input, 'test-key')

      assert.equal(result.kind, 'pending')
      assert.deepEqual(requests, [{ method: 'GET', path }])
      assert.equal(result.providerJobs[0]?.job.id, operation === 'chat.response' ? 'chat-durable' : 'music-durable')
    }
  } finally {
    globalThis.fetch = original
  }
})

/**
 * REWRITTEN, NOT DELETED — v1.2.8.
 *
 * Until 1.2.7 this asserted `kind: 'pending'`: a by-key lookup that 404s was
 * treated as "keep waiting". That is the exact defect this release fixes. The
 * owner quit mid-batch, one submission was in flight and therefore never
 * created, and GenStudio answered every subsequent lookup with 404 — so the
 * job polled a task that does not exist for twenty-two minutes and would have
 * done so forever, with forty-eight further items stuck behind it.
 *
 * The half of the old test that still matters is kept and is still the point:
 * exactly ONE GET, and never a POST. Story Studio must not resubmit off the
 * back of a 404; it must only stop waiting for it.
 */
test('a by-key 404 is terminal "never created", with one GET and no generation POST', async () => {
  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ method: (init?.method || 'GET').toUpperCase(), path: new URL(String(input)).pathname })
    return Response.json({ detail: 'not found' }, { status: 404 })
  }
  try {
    const input = job('unknown')
    input.genstudio_jobs = [{
      id: 'pending:music-key', operation: 'music.generation', state: 'submitting', updated_at: new Date().toISOString(),
      request: { method: 'POST', path: '/v1/test', captured_at: '2026-08-12T00:00:00.000Z', idempotency_key: 'music-key' },
    }]
    input.remote_cancellations = {}

    const result = await reconcilePendingJobCancellation(input, 'test-key')

    // Terminal, and terminal as an incomplete output set rather than a success.
    assert.equal(result.kind, 'failed')
    assert.deepEqual(result.absent, [{ operation: 'music.generation', evidence_id: 'pending:music-key' }])
    // No lingering "still waiting" explanation — the question was answered.
    assert.equal(result.reason, undefined)
    assert.equal(result.providerJobs[0]?.job.state, 'not_created')
    assert.equal(result.providerJobs[0]?.job.settled_credits, 0)
    assert.deepEqual(requests, [{ method: 'GET', path: '/v1/music/jobs/by-idempotency-key/music-key' }])
  } finally {
    globalThis.fetch = original
  }
})

/**
 * The other direction, and the one that costs money to get wrong.
 *
 * A provider Story Studio could not REACH must keep its hold. If an outage
 * were read as "never created", the queue would release the duplicate lock and
 * a later Retry would resubmit work the provider had already taken and billed.
 * That is strictly worse than the wedge this release fixes, so both directions
 * are asserted side by side and deliberately share one fixture shape.
 */
test('an unreachable provider is NOT "never created" — the hold is kept', async () => {
  const original = globalThis.fetch
  for (const failure of [
    { label: 'network failure', respond: async () => { throw new TypeError('fetch failed') } },
    { label: 'HTTP 500', respond: async () => Response.json({ detail: 'boom' }, { status: 500 }) },
    { label: 'HTTP 503', respond: async () => Response.json({ detail: 'unavailable' }, { status: 503 }) },
    { label: 'HTTP 401', respond: async () => Response.json({ detail: 'bad key' }, { status: 401 }) },
    { label: 'HTTP 410', respond: async () => Response.json({ detail: 'gone' }, { status: 410 }) },
  ]) {
    const posts: string[] = []
    globalThis.fetch = async (input, init) => {
      if ((init?.method || 'GET').toUpperCase() === 'POST') posts.push(String(input))
      return failure.respond()
    }
    try {
      const input = job('unknown')
      input.genstudio_jobs = [{
        id: 'pending:music-key', operation: 'music.generation', state: 'submitting', updated_at: new Date().toISOString(),
        request: { method: 'POST', path: '/v1/test', captured_at: '2026-08-12T00:00:00.000Z', idempotency_key: 'music-key' },
      }]
      input.remote_cancellations = {}

      const result = await reconcilePendingJobCancellation(input, 'test-key')

      assert.equal(result.kind, 'pending', failure.label)
      assert.deepEqual(result.absent, [], failure.label)
      assert.ok(result.reason, `${failure.label} must explain that Story Studio is still waiting`)
      assert.deepEqual(posts, [], `${failure.label} must never resubmit`)
    } finally {
      globalThis.fetch = original
    }
  }
})

test('cold by-key recovery adopts the durable ID, replaces submitting, and audits after settlement', async () => {
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'reconcile-test-key')
  const project = await pm.createProject({ name: 'Cold by-key adoption' })
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  const persisted = job('unknown')
  persisted.project_slug = project.slug
  persisted.job_id = 'cold-by-key-adoption'
  persisted.type = 'audio_merge'
  persisted.genstudio_jobs = [{
    id: '' as any, operation: 'chat.response', state: 'submitting', queue_state: 'submitting', updated_at: new Date().toISOString(),
    request: { method: 'POST', path: '/v1/chat/responses', captured_at: '2026-08-12T00:00:00.000Z', idempotency_key: 'chat-key' },
  }, {
    id: 'music-sibling', operation: 'music.generation', state: 'running', queue_state: 'running', updated_at: new Date().toISOString(),
  }]
  persisted.remote_cancellations = {}
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [persisted] }))
  let audits = 0
  registerJobCancellationAuditor('audio_merge', async () => {
    audits++
    return 'complete'
  })

  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  let releaseLookup!: () => void
  const lookupReleased = new Promise<void>(resolve => { releaseLookup = resolve })
  globalThis.fetch = async (input, init) => {
    const request = { method: (init?.method || 'GET').toUpperCase(), path: new URL(String(input)).pathname }
    requests.push(request)
    if (request.path === '/v1/chat/responses/by-idempotency-key/chat-key') {
      await lookupReleased
      return Response.json({ id: 'chat-durable', state: 'succeeded', dispatch_state: 'dispatched', cancellable: false })
    }
    if (request.path === '/v1/music/jobs/music-sibling') {
      return Response.json({ id: 'music-sibling', state: 'succeeded', dispatch_state: 'dispatched', cancellable: false })
    }
    return Response.json({ detail: 'generation and cancellation POSTs are forbidden during recovery' }, { status: 500 })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(() => requests.length === 1)
    const locked = jq.getJob('cold-by-key-adoption')!
    assert.equal(locked.status, 'running')
    assert.equal(locked.finished_at, null)
    assert.equal(jq.isDuplicate(project.slug, 'EP0001', 'audio_merge'), true)
    assert.equal(jq.removeTerminalJob(project.slug, locked.job_id), false)
    assert.equal(audits, 0)

    releaseLookup()
    await waitFor(() => jq.getJob('cold-by-key-adoption')?.status === 'done')
    const recovered = jq.getJob('cold-by-key-adoption')!
    assert.deepEqual(requests, [
      { method: 'GET', path: '/v1/chat/responses/by-idempotency-key/chat-key' },
      { method: 'GET', path: '/v1/music/jobs/music-sibling' },
    ])
    assert.equal(recovered.genstudio_jobs?.[0]?.id, 'chat-durable')
    assert.equal(recovered.genstudio_jobs?.[0]?.queue_state, 'succeeded')
    assert.equal(recovered.genstudio_jobs?.[1]?.queue_state, 'succeeded')
    assert.equal(recovered.local_execution_complete, true)
    assert.equal(audits, 1)
  } finally {
    releaseLookup()
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

test('registered audio and image auditors reject an empty authoritative output set', async () => {
  registerAllExecutors({ loadSettings: false })
  const project = await pm.createProject({ name: 'Empty authoritative auditor set' })
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const paths = await resolveEpisodePaths(project.slug, 'EP0001', '')
  await fs.mkdir(paths.script_dir, { recursive: true })
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(paths.narration_docx, '')
  await fs.writeFile(paths.scene_prompts_docx, '')

  const audioAuditor = getJobCancellationAuditor('audio')
  const imageAuditor = getJobCancellationAuditor('thumb_images')
  assert.ok(audioAuditor)
  assert.ok(imageAuditor)
  assert.equal(await audioAuditor!({ ...job(), project_slug: project.slug, episode_id: 'EP0001', type: 'audio' }), 'repair-required')
  assert.equal(await imageAuditor!({ ...job(), project_slug: project.slug, episode_id: 'EP0001', type: 'thumb_images' }), 'repair-required')
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
    if (url.pathname === '/v1/jobs/provider-1') return Response.json({ id: 'provider-1', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false })
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
    assert.throws(() => jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: 'EP0001', title: 'duplicate', params: {} }))
    const unrelated = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'script-only', episode_id: 'EP0099', title: 'unrelated', params: {} })
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
    assert.throws(() => jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: 'EP0001', title: 'duplicate', params: {} }))

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

/**
 * v1.4.81 — a big batch must be able to REACH ITS TAIL.
 *
 * THE BUG. This function shares ONE 30-second budget across every entry on the
 * job, one HTTP round trip each, starting from index 0 every time. A 142-image
 * batch spent that whole budget re-confirming the ~96 tasks it already knew had
 * succeeded, ran out before reaching the unsettled tail, returned `pending`,
 * and was rescheduled five seconds later to do exactly the same thing. It could
 * never finish, so the job could never settle.
 *
 * The owner hit it by force-quitting mid-batch on 2026-08-29: three interrupted
 * renders sat "reconciling" indefinitely, holding no lane, while the scheduler
 * saw free lanes and started three more episodes.
 *
 * A settled entry cannot change state, so re-asking can only return the same
 * answer. These tests pin both halves of that: the call is skipped, and the
 * EVIDENCE is not — because a skipped `failed` sibling that vanished from the
 * outcome would let the rest read as all-succeeded and green-light the job.
 */
function batchJob(entries: Array<{ id: string; state: string }>): Job {
  return {
    job_id: 'story-batch-reconcile', project_slug: 'project', type: 'continuity_render',
    episode_id: 'DK0054', title: '[batch] scene_review — DK0054', status: 'running',
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null,
    error: null, output_lines: [], params: {},
    genstudio_jobs: entries.map(entry => ({
      id: entry.id, operation: 'image.generation' as const, state: entry.state,
      updated_at: new Date().toISOString(),
    })),
    remote_cancellations: {},
  }
}

test('settled entries are not re-queried, so the unsettled tail is reached in one pass', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const requestPath = new URL(String(input)).pathname
    requests.push(requestPath)
    return Response.json({ id: requestPath.split('/').pop(), state: 'running', cancelled: false })
  }
  try {
    // The owner's shape: a long head of images that finished while the app was
    // dead, and the still-unsettled remainder at the very end of the list.
    const settled = Array.from({ length: 96 }, (_, i) => ({ id: `job_done_${i}`, state: 'succeeded' }))
    const tail = [{ id: 'job_tail_a', state: 'reserved' }, { id: 'job_tail_b', state: 'reserved' }]
    const result = await reconcilePendingJobCancellation(batchJob([...settled, ...tail]), 'test-key')

    // Only the tail cost a round trip. Before the fix this was 98 calls, and
    // the two that mattered were the ones that ran out of budget.
    assert.deepEqual(requests, ['/v1/images/job_tail_a', '/v1/images/job_tail_b'])
    assert.equal(result.kind, 'pending')
    // Every entry is still accounted for in the outcome, not just the queried
    // ones — the classification below reads this array.
    assert.equal(result.providerJobs.length, 98)
  } finally {
    globalThis.fetch = original
  }
})

test('a failed entry buried among settled ones still decides the outcome without being re-read', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(new URL(String(input)).pathname)
    return Response.json({ id: 'unexpected', state: 'succeeded', cancelled: false })
  }
  try {
    const result = await reconcilePendingJobCancellation(batchJob([
      { id: 'job_ok_1', state: 'succeeded' },
      { id: 'job_dead', state: 'failed' },
      { id: 'job_ok_2', state: 'succeeded' },
    ]), 'test-key')

    // Nothing was asked — every entry was already terminal.
    assert.deepEqual(requests, [])
    // And the failure still wins. If the skip had dropped the evidence instead
    // of reusing it, the remaining two would have read as all-succeeded.
    assert.equal(result.kind, 'failed')
  } finally {
    globalThis.fetch = original
  }
})

test('an all-succeeded batch settles from stored evidence alone', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(new URL(String(input)).pathname)
    return Response.json({ id: 'unexpected', state: 'running', cancelled: false })
  }
  try {
    const result = await reconcilePendingJobCancellation(batchJob([
      { id: 'job_a', state: 'succeeded' },
      { id: 'job_b', state: 'succeeded' },
    ]), 'test-key')
    assert.deepEqual(requests, [])
    assert.equal(result.kind, 'succeeded')
  } finally {
    globalThis.fetch = original
  }
})

test('the generic finalizer keeps a fully released Continuity provider failure classified as error', async () => {
  const project = await pm.createProject({ name: 'Generic Continuity failure finalization' })
  let auditorCalls = 0
  registerJobCancellationAuditor('continuity_render', async () => {
    auditorCalls++
    return 'complete'
  })
  jq.registerExecutor('continuity_render', async runningJob => {
    const now = new Date().toISOString()
    runningJob.remote_cancellations = {
      'image.generation:fleet-failed': {
        status: 'confirmed',
        operation: 'image.generation',
        provider_job_id: 'fleet-failed',
        requested_at: now,
        updated_at: now,
        cancelled: false,
      },
    }
    await jq.recordGenStudioJob(runningJob.job_id, {
      id: 'fleet-failed',
      operation: 'image.generation',
      state: 'failed',
      failure_code: 'SITE_CAPACITY_UNAVAILABLE',
      reserved_credits: 7,
      settled_credits: 0,
      released_credits: 7,
      updated_at: now,
    })
  })
  await jq.setQueuePaused(false)

  let lanePumps = 0
  const stopObserving = jq._observeQueuePumpsForTesting(type => {
    if (type === 'continuity_render') lanePumps++
  })
  let queued!: Job
  try {
    queued = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: 'EP0001',
      title: 'Generic finalizer regression',
      params: {},
    })
    await waitFor(() => lanePumps >= 2, 1_000)
  } finally {
    stopObserving()
  }
  const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
  let persistedStatus = ''
  await waitForScheduled(async () => {
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
    persistedStatus = persisted.jobs.find((item: Job) => item.job_id === queued.job_id)?.status || ''
    return ['done', 'error'].includes(persistedStatus)
  }, { label: 'generic finalizer result to persist', timeoutMs: 2_000 })
  assert.ok(['done', 'error'].includes(persistedStatus), 'generic finalizer result was not persisted')

  const finalized = jq.getJob(queued.job_id)!
  assert.equal(finalized.status, 'error')
  assert.match(finalized.error || '', /provider task failed/i)
  assert.equal(auditorCalls, 0)
})
