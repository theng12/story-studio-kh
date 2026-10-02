import assert from 'node:assert/strict'
import test from 'node:test'
import { activityItemForJob } from '../composables/useNotifications.js'
import type { Job } from '../composables/useJobs.js'

test('Notification Center redacts known job identities without mutating durable evidence', () => {
  const job = {
    job_id: 'job_123456789',
    project_slug: 'story',
    type: 'images',
    episode_id: 'episode-1',
    title: 'Episode One',
    status: 'error',
    created_at: '2026-08-30T09:00:00.000Z',
    started_at: '2026-08-30T09:01:00.000Z',
    finished_at: '2026-08-30T09:02:00.000Z',
    error: 'Request provider_1234567890 failed for project 123e4567-e89b-12d3-a456-426614174000',
    output_lines: [],
    params: {},
    genstudio_jobs: [{
      id: 'provider_1234567890',
      operation: 'image.generation',
      state: 'failed',
      updated_at: '2026-08-30T09:02:00.000Z',
    }],
  } as Job

  const item = activityItemForJob(job)

  assert.equal(item.error, 'Request [request hidden] failed for project 123e4567-e89b-12d3-a456-426614174000')
  assert.equal(job.error, 'Request provider_1234567890 failed for project 123e4567-e89b-12d3-a456-426614174000')
  assert.equal(job.genstudio_jobs?.[0]?.id, 'provider_1234567890')
})

test('a new channel with no Gateway key gets a blocking "Connect your Gateway" action, not silence', async () => {
  const calls: string[] = []
  ;(globalThis as any).$fetch = async (url: string) => {
    calls.push(url)
    if (url.endsWith('/upload/accounts')) return { accounts: {} }
    if (url.endsWith('/app-settings/api-keys')) return { providers: [{ providerId: 'genstudio', hasKey: false, keyMasked: '' }] }
    if (url.includes('/models?')) { const e: any = new Error('400'); e.data = { detail: 'Add a Gateway key' }; throw e }
    if (url.endsWith('/ffmpeg/status')) return { installed: true }
    throw new Error(`unexpected ${url}`)
  }
  const { useNotifications } = await import('../composables/useNotifications.js')
  const notifications = useNotifications()
  await notifications.refreshReadiness('new-channel')
  const items = notifications.actionItems('new-channel').value
  const gateway = items.find(item => item.key === 'gateway-key')
  assert.ok(gateway, 'missing Gateway key is an action item')
  assert.equal(gateway!.severity, 'blocking')
  assert.match(gateway!.title, /Connect your Gateway/)
  assert.match(gateway!.detail, /GatewayKH → Settings/)
  assert.equal(items[0]!.key, 'gateway-key', 'blocking first, above the upload warning')
  assert.equal(calls.some(url => url.includes('/models?')), false, 'no doomed catalogue read without a key')
})
