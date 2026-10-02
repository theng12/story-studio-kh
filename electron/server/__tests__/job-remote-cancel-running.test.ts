/**
 * Cancelling a RUNNING narration or music job (audit 2026-10-02, release-night e2e).
 *
 * What the owner saw on 1.4.246: Cancel on a running narration answered 200, Story said "waiting for
 * GenStudio to confirm", the Gateway never received a cancel, the Mac finished the work, and the job
 * ended `error` ("Provider output needs repair") instead of `cancelled`. Cancel on a running music
 * top-up answered 409 REMOTE_CANCELLATION_NOT_SUPPORTED (no registered auditor) and the job ended
 * `done`.
 *
 * These tests drive the real queue, the real GenStudio client wait loops and the real reconciler
 * against a fake Gateway that publishes what the 0.2.92 Gateway publishes: a running narration or
 * music job is `cancellable: true`, a cancel answers `cancellation_requested`, and the job later
 * reads `cancelled`. They fail on the old code because the Gateway never sees the cancel POST and
 * the fake finishes the job on its own after `finishAfterMs`, exactly as the Hub did.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { sleep, waitFor } from './_timing.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { registerJobCancellationAuditor } from '../services/job-cancellation-auditors.js'
import { classifyJobControl } from '../services/job-control.js'
import { auditMusicLibraryTopUp, registerAllExecutors } from '../boot/executors.js'
import { generateMusicWithGenStudio, generateTtsToFile } from '../lib/genstudio-client.js'

type FakeKind = 'tts' | 'music'
interface FakeJob { id: string; kind: FakeKind; createdAt: number; cancelRequestedAt: number | null }

/** The Gateway as 0.2.92 publishes it. `legacy` spells a cancelled job `failed` + `cancelled: true`. */
class FakeGateway {
  private server = http.createServer((req, res) => this.handle(req, res))
  baseUrl = ''
  jobs = new Map<string, FakeJob>()
  submits: string[] = []
  cancelPosts: string[] = []
  /** The Hub finishing the work by itself when nobody cancels it (what the e2e saw). */
  finishAfterMs = 12_000
  /** How long after the cancel POST the job reads `cancelled`. */
  settleCancelMs = 150
  legacy = false
  private n = 0

  async start(): Promise<this> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('did not bind a port')
    this.baseUrl = `http://127.0.0.1:${address.port}`
    return this
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    this.server.closeAllConnections?.()
    this.server.close()
    await once(this.server, 'close')
  }

  reset(): void {
    this.jobs.clear(); this.submits = []; this.cancelPosts = []; this.legacy = false; this.n = 0
  }

  private envelope(job: FakeJob): Record<string, unknown> {
    const now = Date.now()
    const cancelled = job.cancelRequestedAt !== null && now - job.cancelRequestedAt >= this.settleCancelMs
    const finished = job.cancelRequestedAt === null && now - job.createdAt >= this.finishAfterMs
    const state = cancelled ? (this.legacy ? 'failed' : 'cancelled') : finished ? 'succeeded' : 'running'
    return {
      id: job.id,
      state,
      model_id: 'fake-model',
      dispatch_state: 'dispatched',
      cancellable: state === 'running' && job.cancelRequestedAt === null,
      cancellation_requested: job.cancelRequestedAt !== null,
      cancelled,
      waiting: null,
      poll_after_ms: 50,
      ...(cancelled ? { failure_code: 'CANCELLED', failure_class: 'cancelled', failure_reason: 'The job was cancelled.' } : {}),
      ...(finished && job.kind === 'tts' ? { audio_url: `/v1/jobs/${job.id}/audio` } : {}),
      ...(finished && job.kind === 'music' ? { outputs: [{ asset_id: '0', url: `/v1/music/jobs/${job.id}/outputs/0` }] } : {}),
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', 'http://fake')
    const send = (status: number, body: unknown): void => {
      const payload = Buffer.from(JSON.stringify(body))
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) })
      res.end(payload)
    }
    const drain = (): Promise<void> => new Promise(resolve => { req.on('data', () => {}); req.on('end', () => resolve()) })
    void (async () => {
      await drain()
      const method = req.method || 'GET'
      const submit = method === 'POST' && (url.pathname === '/v1/audio/jobs' || url.pathname === '/v1/music/generations')
      if (submit) {
        const kind: FakeKind = url.pathname === '/v1/audio/jobs' ? 'tts' : 'music'
        const job: FakeJob = { id: `${kind}-${++this.n}`, kind, createdAt: Date.now(), cancelRequestedAt: null }
        this.jobs.set(job.id, job)
        this.submits.push(job.id)
        return send(202, this.envelope(job))
      }
      const match = url.pathname.match(/^\/v1\/(?:jobs|music\/jobs)\/([^/]+?)(\/cancel)?$/)
      const job = match ? this.jobs.get(match[1]!) : undefined
      if (job && match) {
        if (method === 'POST' && match[2]) {
          this.cancelPosts.push(job.id)
          job.cancelRequestedAt ??= Date.now()
          return send(200, this.envelope(job))
        }
        if (method === 'GET' && !match[2]) return send(200, this.envelope(job))
      }
      send(404, { detail: 'not found', code: 'JOB_NOT_FOUND' })
    })()
  }
}

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let gateway: FakeGateway

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  gateway = await new FakeGateway().start()
  await setGenStudioUrl(gateway.baseUrl)
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'gsk_test_key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  // The real registration, so `music_generate` has (or lacks) its real auditor; each test then
  // swaps in the executor it needs.
  registerAllExecutors({ loadSettings: false })
})

after(async () => {
  await gateway.close()
  await sleep(500)
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  void cleanup
})

async function until(check: () => boolean, label: string, timeoutMs = 9_000): Promise<void> {
  await waitFor(check, { label, timeoutMs })
}

const TTS_REQUEST = {
  text: 'Hello there.', voiceId: 'voice-1', modelId: 'tts-model', speed: 1, maxInputCharacters: 5_000,
} as const

describe('cancelling a running narration', () => {
  // Legacy shape first: it runs cold, where the executor's own poll can win the claim race.
  for (const legacy of [true, false]) {
    test(`reaches the Gateway, waits for it, ends cancelled and launches no further chunk (${legacy ? 'failed + cancelled:true' : 'state:cancelled'} envelope)`, async () => {
      gateway.reset()
      gateway.legacy = legacy
      registerJobCancellationAuditor('audio', async () => 'complete')
      const project = await pm.createProject({ name: `RunningNarration${legacy ? 'Legacy' : ''}` })
      let chunksLaunched = 0
      jq.registerExecutor('audio', async job => {
        // Three sequential chunks, as the audio generator walks them: a cancel must stop the walk.
        for (let chunk = 1; chunk <= 3; chunk++) {
          if (jq.isCancelled(job.job_id)) return
          chunksLaunched++
          try {
            await generateTtsToFile('gsk_test_key', path.join(tempDir, `chunk-${project.slug}-${chunk}.mp3`), {
              ...TTS_REQUEST, text: `Chunk ${chunk}.`, isCancelled: () => jq.isCancelled(job.job_id),
            })
          } catch (error) {
            if (jq.isCancelled(job.job_id)) return
            throw error
          }
        }
      })
      const job = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'audio', episode_id: `RUN_${legacy ? 'L' : 'N'}`, title: 'narration', params: {},
      })
      await until(() => gateway.submits.length === 1, 'the first chunk to reach the Gateway')
      await until(() => (jq.getJob(job.job_id)?.genstudio_jobs || []).some(entry => entry.cancellable === true), 'cancellable evidence')

      const requested = await jq.requestJobCancellation(project.slug, job.job_id)
      assert.equal(requested.status, 'running', 'the Story job waits for the Gateway to confirm')

      await until(() => gateway.cancelPosts.length > 0, 'the cancel to reach the Gateway')
      await until(() => ['cancelled', 'error', 'done'].includes(jq.getJob(job.job_id)?.status || ''), 'the job to settle')

      const final = jq.getJob(job.job_id)!
      assert.equal(final.status, 'cancelled', `ended ${final.status}: ${final.error ?? ''}`)
      assert.equal(final.error, null)
      assert.equal(gateway.cancelPosts.length, 1, 'exactly one cancel request')
      assert.equal(gateway.submits.length, 1, 'no further chunk was submitted')
      assert.equal(chunksLaunched, 1)
      const record = Object.values(final.remote_cancellations || {})[0]
      assert.equal(record?.status, 'confirmed')
    })
  }
})

describe('cancelling a running music top-up', () => {
  test('is offered (no 409), reaches the Gateway and ends cancelled', async () => {
    gateway.reset()
    const project = await pm.createProject({ name: 'RunningMusic' })
    let requestsLaunched = 0
    jq.registerExecutor('music_generate', async job => {
      for (let request = 1; request <= 3; request++) {
        if (jq.isCancelled(job.job_id)) return
        requestsLaunched++
        try {
          await generateMusicWithGenStudio('gsk_test_key', {
            title: `Track ${request}`, prompt: 'warm piano', instrumental: true, modelId: 'music-model',
            requestIdentity: `${project.slug}:music:${request}`, isCancelled: () => jq.isCancelled(job.job_id),
          })
        } catch (error) {
          if (jq.isCancelled(job.job_id)) return
          throw error
        }
      }
    })
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'music_generate', episode_id: 'MUSIC', title: 'music', params: {},
    })
    await until(() => gateway.submits.length === 1, 'the music request to reach the Gateway')
    await until(() => (jq.getJob(job.job_id)?.genstudio_jobs || []).some(entry => entry.cancellable === true), 'cancellable evidence')

    const requested = await jq.requestJobCancellation(project.slug, job.job_id) // used to throw 409 REMOTE_CANCELLATION_NOT_SUPPORTED
    assert.equal(requested.status, 'running')
    await until(() => gateway.cancelPosts.length > 0, 'the cancel to reach the Gateway')
    await until(() => ['cancelled', 'error', 'done'].includes(jq.getJob(job.job_id)?.status || ''), 'the job to settle')

    const final = jq.getJob(job.job_id)!
    assert.equal(final.status, 'cancelled', `ended ${final.status}: ${final.error ?? ''}`)
    assert.equal(gateway.submits.length, 1, 'no further request was submitted')
    assert.equal(requestsLaunched, 1)
  })
})

describe('music_generate registers a cancellation auditor', () => {
  const running = {
    status: 'running', type: 'music_generate', params: {},
    genstudio_jobs: [{
      id: 'music-1', operation: 'music.generation', state: 'running', dispatch_state: 'dispatched', cancellable: true,
      updated_at: new Date().toISOString(),
    }],
  } as any

  test('with the capability the control is a remote cancel; without it, the old 409 reason', () => {
    const offered = classifyJobControl(running, { remoteCancellationAudited: true })
    assert.equal(offered.action, 'request-remote-cancel')
    assert.equal(offered.enabled, true)
    const refused = classifyJobControl(running, { remoteCancellationAudited: false })
    assert.equal(refused.code, 'REMOTE_CANCELLATION_NOT_SUPPORTED')
  })

  test('the queue offers it for a running music_generate job', async () => {
    const project = await pm.createProject({ name: 'MusicControl' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('music_generate', async () => await hold)
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'music_generate', episode_id: 'MUSIC_CTL', title: 'music', params: {},
    })
    await until(() => jq.getJob(job.job_id)?.status === 'running', 'the job to start')
    await jq.recordGenStudioJob(job.job_id, {
      id: 'music-ctl', operation: 'music.generation', state: 'running', dispatch_state: 'dispatched', cancellable: true,
      updated_at: new Date().toISOString(),
    })
    // Throws a JobControlError (409 REMOTE_CANCELLATION_NOT_SUPPORTED) when no auditor is registered.
    await assert.doesNotReject(jq.requestJobCancellation(project.slug, job.job_id))
    release()
  })

  test('the auditor accepts a top-up whose every request saved a track and refuses a short or empty one', async () => {
    const project = await pm.createProject({ name: 'MusicAudit' })
    const { getLibraryDir } = await import('../services/music-library.js')
    const dir = (await getLibraryDir(project.slug))!
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'a-take1.m4a'), 'x')
    await fs.writeFile(path.join(dir, 'b-take1.m4a'), 'x')
    const audit = (result: unknown) => auditMusicLibraryTopUp({ project_slug: project.slug, result })
    assert.equal(await audit({ saved_tracks: ['a-take1.m4a', 'b-take1.m4a'], requests: 2 }), 'complete')
    assert.equal(await audit({ saved_tracks: ['a-take1.m4a'], requests: 2 }), 'repair-required', 'fewer tracks than requests')
    assert.equal(await audit({ saved_tracks: ['gone.m4a'], requests: 1 }), 'repair-required', 'file missing')
    assert.equal(await audit({ saved_tracks: ['../escape.m4a'], requests: 1 }), 'repair-required', 'path outside the library')
    assert.equal(await audit(undefined), 'repair-required', 'no result at all')
  })
})

describe('a cancel that stops every unsettled task keeps the work that already finished', () => {
  test('earlier chunks succeeded, the running one is cancelled: the job is cancelled, not a half-failed error', async () => {
    const project = await pm.createProject({ name: 'SucceededThenCancelled' })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    jq.registerExecutor('audio', async () => await hold)
    registerJobCancellationAuditor('audio', async () => 'complete')
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio', episode_id: 'PARTLY_DONE', title: 'partly done', params: {},
    })
    await until(() => jq.getJob(job.job_id)?.status === 'running', 'the job to start')
    const now = () => new Date().toISOString()
    await jq.recordGenStudioJob(job.job_id, {
      id: 'chunk-1', operation: 'voice.tts', state: 'succeeded', cancellable: false, updated_at: now(),
    })
    await jq.recordGenStudioJob(job.job_id, {
      id: 'chunk-2', operation: 'voice.tts', state: 'running', dispatch_state: 'dispatched', cancellable: true, updated_at: now(),
    })
    await jq.requestJobCancellation(project.slug, job.job_id)
    assert.equal(jq.getJob(job.job_id)?.remote_cancellations?.['voice.tts:chunk-2']?.covers_outstanding, true)
    assert.equal(jq.getJob(job.job_id)?.remote_cancellations?.['voice.tts:chunk-1'], undefined, 'a finished chunk is not cancelled')

    release()
    await jq.recordGenStudioJob(job.job_id, {
      id: 'chunk-2', operation: 'voice.tts', state: 'failed', cancelled: true, updated_at: now(),
    })
    await jq.recordRemoteCancellation(job.job_id, 'voice.tts', 'chunk-2', { status: 'confirmed', state: 'failed', cancelled: true })
    await until(() => jq.getJob(job.job_id)?.status !== 'running', 'the job to settle')
    const final = jq.getJob(job.job_id)!
    assert.equal(final.status, 'cancelled', final.error ?? '')
    assert.equal(final.error, null)
  })
})
