import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { reconcilePendingJobCancellation } from '../services/job-cancellation-reconciler.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await setGenStudioUrl('https://reconcile.test')
})

after(async () => { await cleanup() })

function job(status: 'submitting' | 'unknown' = 'submitting'): Job {
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
