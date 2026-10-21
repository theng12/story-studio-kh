import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { FinalRenderRemoteWaitReceiptV1 } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

const HASH = 'c'.repeat(64)
const slug = 'remote-wait-backup'
let dir = ''
let cleanup = async (): Promise<void> => {}
let backup: typeof import('../services/backup.js')

const receipt = (jobId: string): FinalRenderRemoteWaitReceiptV1 => ({
  version: 1,
  phase: 'remote_wait',
  revision: 1,
  job_id: jobId,
  intent_id: 'intent-backup-1',
  story_attempt: 2,
  gateway_attempt_key: 'gateway-attempt-backup-1',
  request_body_sha256: HASH,
  request_body_bytes: 431,
  packet_sha256: HASH,
  render_fingerprint: HASH,
  submission_scope_sha256: HASH,
  destination_fence_sha256: HASH,
  source_generation_fence_sha256: HASH,
  gateway_job_id: null,
  committed_at: '2026-10-15T04:00:00.000Z',
  cancel_requested_at: null,
})

const params = {
  voice: 'Sophea',
  audio: { voice: 'Sophea', pauses: [0.8, 1.2] },
  preset: { id: 'cinematic', transition: 'crossfade' },
  assets: [
    { id: 'scene-a', path: 'accepted/scene-a.png' },
    { id: 'scene-b', path: 'accepted/scene-b.png' },
  ],
  pipeline_chain: [{ type: 'metadata', params: { model: 'accepted-model' } }],
}

before(async () => {
  const temp = await useTempDataDir({ retain: true, settle: async () => {} })
  dir = temp.dir
  cleanup = temp.cleanup
  backup = await import('../services/backup.js')
})

after(async () => { await cleanup() })

test('restore preserves every marked video wait and excludes unmarked active jobs', async () => {
  const sourceLibrary = path.join(dir, 'source-library')
  const drive = path.join(dir, 'backup-drive')
  const restoredLibrary = path.join(dir, 'restored-library')
  const sourceChannel = path.join(sourceLibrary, slug)
  const restoredJobsPath = path.join(restoredLibrary, slug, 'jobs.json')
  await fs.mkdir(sourceChannel, { recursive: true })
  await fs.mkdir(drive, { recursive: true })
  await fs.writeFile(path.join(sourceChannel, 'project.json'), JSON.stringify({ name: 'Remote Wait Backup' }))

  const validId = '11111111-1111-4111-8111-111111111111'
  const valid = {
    job_id: validId,
    project_slug: slug,
    type: 'video_assembly',
    episode_id: 'EP01',
    title: 'Valid remote wait',
    status: 'running',
    created_at: '2026-10-15T03:59:00.000Z',
    started_at: '2026-10-15T03:59:01.000Z',
    finished_at: null,
    error: null,
    output_lines: ['accepted'],
    params,
    final_render_remote_wait: receipt(validId),
  }
  const nullMarker = {
    ...valid,
    job_id: '22222222-2222-4222-8222-222222222222',
    title: 'Null marker recovery hold',
    status: 'queued',
    final_render_remote_wait: null,
  }
  const malformedMarker = {
    ...valid,
    job_id: '33333333-3333-4333-8333-333333333333',
    title: 'Malformed marker recovery hold',
    status: 'paused',
    final_render_remote_wait: {
      version: 99,
      phase: 'future_remote_wait',
      unknown_field: { preserve: 'exactly' },
    },
  }
  const terminal = [
    { job_id: 'terminal-done', type: 'script', status: 'done', params: { proof: 'done' } },
    { job_id: 'terminal-error', type: 'audio', status: 'error', params: { proof: 'error' } },
    { job_id: 'terminal-cancelled', type: 'images', status: 'cancelled', params: { proof: 'cancelled' } },
  ]
  const excluded = [
    { job_id: 'unmarked-queued', type: 'video_assembly', status: 'queued', params },
    { job_id: 'unmarked-running', type: 'video_assembly', status: 'running', params },
    { job_id: 'other-running', type: 'audio', status: 'running', params: { voice: 'Sophea' } },
  ]
  const retainedJobs = [valid, nullMarker, malformedMarker, ...terminal]
  const sourceStore = {
    version: 7,
    owner_order: retainedJobs.map(job => job.job_id),
    jobs: [...retainedJobs, ...excluded],
  }
  await fs.writeFile(path.join(sourceChannel, 'jobs.json'), JSON.stringify(sourceStore))

  const backedUp = await backup.runBackup({
    dataDir: dir,
    libraryRoot: sourceLibrary,
    destination: drive,
    options: {},
    storyVersion: 'backup-remote-wait-test',
    appSettings: {},
  })
  assert.equal(backedUp.complete, true, backedUp.interrupted)
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(backedUp.root, 'library', slug, 'jobs.json'), 'utf8')),
    sourceStore,
    'backup must preserve the raw jobs store before restore filtering',
  )

  const restored = await backup.restoreBackup({
    source: drive,
    target: restoredLibrary,
    channels: [{ slug }],
    app: false,
    dataDir: path.join(dir, 'restored-data'),
    currentSettings: {},
    writeSetting: async () => {},
  })
  assert.equal(restored.interrupted, '')
  assert.deepEqual(restored.damaged, [])
  assert.deepEqual(
    JSON.parse(await fs.readFile(restoredJobsPath, 'utf8')),
    { ...sourceStore, jobs: retainedJobs },
    'restore must keep exact marked waits and terminal history without reviving unmarked work',
  )
})
