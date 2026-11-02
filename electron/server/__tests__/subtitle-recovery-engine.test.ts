import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { waitFor } from './_timing.js'
import { useTempDataDir } from './_helpers.js'
import {
  RETRY_FAILED_REQUESTS_SUBTITLE_KEY,
  setAppSetting,
  setRetryFailedRequestsSetting,
} from '../services/app-settings.js'
import { recordTaskStrict, hashInput } from '../services/task-manifest.js'
import type { Job } from '../models/types.js'

const isolated = await useTempDataDir()
after(() => isolated.cleanup())
const srt = '1\n00:00:00,000 --> 00:00:01,000\nRecovered subtitle.\n'
const failed = (id: string, overrides = {}) => ({
  id, state: 'failed', model_id: 'model', failure_class: 'provider_transient',
  reserved_credits: 3, settled_credits: 3, released_credits: 0, cancelled: false, ...overrides,
})

async function fixture(t: any, sections = ['Chapter_01']) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-recovery-engine-'))
  t.after(() => fs.rm(outDir, { recursive: true, force: true }))
  const audioPath = path.join(outDir, 'audio.wav')
  await fs.writeFile(audioPath, 'RIFF-audio')
  await setRetryFailedRequestsSetting('subtitle', { enabled: false })
  for (const section of sections) await recordTaskStrict(outDir, `${section}.srt`, {
    provider: 'genstudio', task_id: `old-${section}`, idempotency_key: `original-${section}`,
    submitted_at: '2026-09-05T00:00:00Z', input_hash: hashInput('input'), last_state: 'failed',
  })
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const confirmations: string[] = []
  const acceptedConfirmations = new Set<string>()
  const calls: string[] = []
  let original = (id: string) => failed(id)
  let quoteFields: Record<string, unknown> = { quoted_credit_cost: 3, price_version: 'price-v1' }
  let beforeConfirm = async () => {}
  let confirm = async (_key: string): Promise<Response | void> => {}
  let quoteFailure: number | null = null
  let quoteFailureDetail = 'quote expired'
  let originalMissing = false
  let originalArtifact = srt
  let replacementArtifact = srt
  let replacementArtifactError: Error | null = null
  let replacement = (id: string) => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method || 'GET'} ${url}`)
    if (url.endsWith('/v1/account/overview')) return Response.json({
      credit_balance: 1000, paid_concurrency_limit: 20, paid_active_jobs: 0,
      paid_queued_jobs: 0, max_queued_jobs: 100, generation_submissions_per_minute: 1000,
    })
    if (url.endsWith('/quotes')) {
      if (quoteFailure) { const status = quoteFailure; quoteFailure = null; return Response.json({ detail: quoteFailureDetail }, { status }) }
      const key = (init!.headers as Record<string, string>)['Idempotency-Key']!
      await beforeConfirm()
      return Response.json({ id: key, ...quoteFields }, { status: 201 })
    }
    if (url.endsWith('/confirm')) {
      const key = (init!.headers as Record<string, string>)['Idempotency-Key']!
      // Physical attempts can replay; the provider creates only one billed task per key.
      if (!confirmations.includes(key)) confirmations.push(key)
      let response: Response | void
      try { response = await confirm(key) }
      catch (error) { acceptedConfirmations.add(key); throw error }
      if (response) {
        if (response.ok) acceptedConfirmations.add(key)
        return response
      }
      acceptedConfirmations.add(key)
      return Response.json(replacement(`new-${key}`), { status: 202 })
    }
    if (url.endsWith('/srt')) {
      if (!url.includes('/old-') && replacementArtifactError) throw replacementArtifactError
      return new Response(url.includes('/old-') ? originalArtifact : replacementArtifact)
    }
    const id = decodeURIComponent(url.split('/').pop()!)
    if (url.includes('/by-idempotency-key/')) {
      const section = sections.find(s => id === `original-${s}-confirm`)
      if (section) return Response.json(original(`old-${section}`))
      return acceptedConfirmations.has(id)
        ? Response.json(replacement(`new-${id}`)) : Response.json({ detail: 'not found' }, { status: 404 })
    }
    if (id.startsWith('old-') && originalMissing) return Response.json({ detail: 'transcription not found' }, { status: 404 })
    return Response.json(id.startsWith('old-') ? original(id) : replacement(id))
  }
  const job = { job_id: path.basename(outDir), project_slug: '_app_', episode_id: 'EP0001',
    type: 'subtitles_transcribe', status: 'running', params: {}, output_lines: [], progress: 0 } as unknown as Job
  async function run(section = sections[0]!, overrides = {}) {
    const { runSubtitleTranscription } = await import('../services/subtitle-recovery.js')
    return runSubtitleTranscription({
      job, outDir, section, manifestKey: `${section}.srt`, inputHash: hashInput('input'),
      audioHash: 'sha256:audio', apiKey: 'test-key', force: false,
      request: { audioPath, modelId: 'model', requestIdentity: `episode:${section}`, wordTimestamps: true },
      ...overrides,
    })
  }
  return { outDir, audioPath, run, job, calls, confirmations,
    original: (fn: typeof original) => { original = fn },
    quote: (value: typeof quoteFields) => { quoteFields = value },
    beforeConfirm: (fn: typeof beforeConfirm) => { beforeConfirm = fn },
    confirm: (fn: typeof confirm) => { confirm = fn },
    acceptConfirmation: (key: string) => { acceptedConfirmations.add(key) },
    expireQuote: (status = 410, detail = 'quote expired') => { quoteFailure = status; quoteFailureDetail = detail },
    originalMissing: () => { originalMissing = true },
    originalArtifact: (value: string) => { originalArtifact = value },
    replacementArtifact: (value: string) => { replacementArtifact = value },
    replacementArtifactError: (value: Error | null) => { replacementArtifactError = value },
    replacement: (fn: typeof replacement) => { replacement = fn },
    clearOriginal: async () => { await fs.rm(path.join(outDir, '.task-manifest.json'), { force: true }) },
  }
}

test('accepted task is recovered before any POST, even if local state says failed', async t => {
  const f = await fixture(t)
  f.original(id => ({ ...failed(id), state: 'succeeded', srt_url: `/v1/transcriptions/${id}/srt` }))
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.calls.filter(c => c.startsWith('POST')).length, 0)
})

test('one stamped bulk repair action replaces a recovered gap-invalid result once and reconnects after restart', async t => {
  const f = await fixture(t)
  f.original(id => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any)
  f.originalArtifact('1\n00:00:00,000 --> 00:00:01,000\nBefore\n\n2\n00:00:38,000 --> 00:00:39,000\nAfter\n')
  f.replacementArtifact(srt)
  const repair = {
    actionId: 'bulk-repair-ep0083',
    isResultUsable: (candidate: string) => candidate === srt,
  }

  assert.equal((await f.run('Chapter_01', { pipelineRepair: repair } as any)).srt, srt)
  assert.equal(f.confirmations.length, 1, 'only the stamped fresh repair is submitted')
  const ledger = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(ledger.sections['Chapter_01.srt'].pipelineRepairActionId, 'bulk-repair-ep0083')

  const restarted = { ...f.job, params: { ...f.job.params } }
  assert.equal((await f.run('Chapter_01', { job: restarted, pipelineRepair: repair } as any)).srt, srt)
  assert.equal(f.confirmations.length, 1, 'restart reconnects the persisted repair identity')
})

test('bulk repair never replaces an old task unavailable to this account', async t => {
  const f = await fixture(t)
  f.originalMissing()
  await assert.rejects(f.run('Chapter_01', {
    pipelineRepair: { actionId: 'bulk-repair-account', isResultUsable: () => true },
  } as any), /not found with the current Gateway connection\/account/)
  assert.equal(f.confirmations.length, 0)
})

test('a known historical provider cancellation may use the one explicit bulk repair request', async t => {
  const f = await fixture(t)
  f.original(id => failed(id, { cancelled: true, settled_credits: null, released_credits: null }))
  const repair = { actionId: 'bulk-repair-old-cancelled', isResultUsable: (candidate: string) => candidate === srt }
  assert.equal((await f.run('Chapter_01', { pipelineRepair: repair } as any)).srt, srt)
  assert.equal(f.confirmations.length, 1)
})

test('a cancelled current bulk repair sends no fresh confirmation', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.run('Chapter_01', {
    pipelineRepair: { actionId: 'bulk-repair-current-cancel', isResultUsable: () => true },
    request: {
      audioPath: f.audioPath,
      modelId: 'model',
      requestIdentity: 'episode:Chapter_01',
      wordTimestamps: true,
      signal: controller.signal,
      isCancelled: () => true,
    },
  } as any), /stopped by owner/)
  assert.equal(f.confirmations.length, 0)
})

test('bulk repair stops after its one fresh result is still invalid', async t => {
  const f = await fixture(t)
  f.original(id => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any)
  f.originalArtifact('old invalid')
  f.replacementArtifact('still invalid')
  await assert.rejects(f.run('Chapter_01', {
    pipelineRepair: { actionId: 'bulk-repair-once', isResultUsable: () => false },
  } as any), /still invalid after its one fresh repair request/)
  assert.equal(f.confirmations.length, 1)
})

test('bulk repair persists its fresh key before confirm and reuses it after interruption', async t => {
  const f = await fixture(t)
  f.original(id => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any)
  f.originalArtifact('old invalid')
  let interrupted = true
  f.beforeConfirm(async () => {
    if (interrupted) throw new Error('interrupted before confirm POST')
  })
  const repair = { actionId: 'bulk-repair-before-confirm', isResultUsable: (candidate: string) => candidate === srt }
  await assert.rejects(f.run('Chapter_01', { pipelineRepair: repair } as any), /interrupted before confirm POST/)
  const before = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const key = before.sections['Chapter_01.srt'].idempotencyKey
  assert.equal(before.sections['Chapter_01.srt'].pipelineRepairActionId, repair.actionId)
  assert.equal(f.confirmations.length, 0)

  interrupted = false
  assert.equal((await f.run('Chapter_01', { pipelineRepair: repair } as any)).srt, srt)
  const after = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(after.sections['Chapter_01.srt'].idempotencyKey, key)
  assert.equal(f.confirmations.length, 1)
})

test('bulk repair reconnects an accepted task when its first result is lost', async t => {
  const f = await fixture(t)
  f.original(id => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any)
  f.originalArtifact('old invalid')
  f.replacementArtifactError(new Error('accepted result lost'))
  const repair = { actionId: 'bulk-repair-lost-result', isResultUsable: (candidate: string) => candidate === srt }
  await assert.rejects(f.run('Chapter_01', { pipelineRepair: repair } as any), /accepted result lost/)
  const before = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const key = before.sections['Chapter_01.srt'].idempotencyKey
  assert.equal(f.confirmations.length, 1)

  f.replacementArtifactError(null)
  assert.equal((await f.run('Chapter_01', { pipelineRepair: repair } as any)).srt, srt)
  const after = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(after.sections['Chapter_01.srt'].idempotencyKey, key)
  assert.equal(f.confirmations.length, 1)
})

test('a later explicit bulk repair action may replace one failed prior repair once', async t => {
  const f = await fixture(t)
  f.original(id => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any)
  f.originalArtifact('old invalid')
  f.replacement(id => failed(id, { settled_credits: 3, released_credits: 0 }))
  const first = { actionId: 'bulk-repair-first', isResultUsable: (candidate: string) => candidate === srt }
  await assert.rejects(f.run('Chapter_01', { pipelineRepair: first } as any), /one fresh pipeline repair request failed/)
  assert.equal(f.confirmations.length, 1)

  const firstLedger = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const firstTaskId = firstLedger.sections['Chapter_01.srt'].taskId
  f.replacement(id => {
    if (id === firstTaskId) return failed(id, { settled_credits: 3, released_credits: 0 })
    return { id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` } as any
  })
  const second = { actionId: 'bulk-repair-second', isResultUsable: (candidate: string) => candidate === srt }
  assert.equal((await f.run('Chapter_01', { pipelineRepair: second } as any)).srt, srt)
  assert.equal(f.confirmations.length, 2)
  const ledger = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(ledger.sections['Chapter_01.srt'].pipelineRepairActionId, second.actionId)
})

test('a missing source consumes one action-scoped fresh request before a terminal result, then a later action may retry it', async t => {
  const f = await fixture(t)
  await f.clearOriginal()
  f.replacement(id => failed(id, { settled_credits: 3, released_credits: 0 }))
  const first = { actionId: 'bulk-repair-missing-first', isResultUsable: (candidate: string) => candidate === srt }
  await assert.rejects(f.run('Chapter_01', { pipelineRepair: first } as any), /one fresh pipeline repair request failed/)
  assert.equal(f.confirmations.length, 1)
  const before = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const key = before.sections['Chapter_01.srt'].idempotencyKey
  assert.equal(before.sections['Chapter_01.srt'].pipelineRepairActionId, first.actionId)

  await assert.rejects(f.run('Chapter_01', { pipelineRepair: first } as any), /one fresh pipeline repair request failed/)
  assert.equal(f.confirmations.length, 1, 'the same action reconnects its failed task instead of buying another request')
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8')).sections['Chapter_01.srt'].idempotencyKey, key)

  const firstTaskId = before.sections['Chapter_01.srt'].taskId
  f.replacement(id => id === firstTaskId
    ? failed(id, { settled_credits: 3, released_credits: 0 })
    : ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` } as any))
  const second = { actionId: 'bulk-repair-missing-second', isResultUsable: (candidate: string) => candidate === srt }
  assert.equal((await f.run('Chapter_01', { pipelineRepair: second } as any)).srt, srt)
  assert.equal(f.confirmations.length, 2, 'a distinct explicit action may make its one new request')
})

test('a missing source with an invalid first result does not mint a second request for the same action', async t => {
  const f = await fixture(t)
  await f.clearOriginal()
  f.replacementArtifact('still invalid')
  const repair = { actionId: 'bulk-repair-missing-invalid', isResultUsable: (candidate: string) => candidate === srt }
  await assert.rejects(f.run('Chapter_01', { pipelineRepair: repair } as any), /still invalid after its one fresh repair request/)
  assert.equal(f.confirmations.length, 1)
  const before = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const key = before.sections['Chapter_01.srt'].idempotencyKey

  await assert.rejects(f.run('Chapter_01', { pipelineRepair: repair } as any), /still invalid after its one fresh repair request/)
  assert.equal(f.confirmations.length, 1)
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8')).sections['Chapter_01.srt'].idempotencyKey, key)
})

test('whole-track accepted task recovers after transport and artifact download failures with no fresh POST', async t => {
  const f = await fixture(t, ['merged'])
  f.original(id => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any)
  const transport = globalThis.fetch
  let failure: 'transport' | 'download' | null = 'transport'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (failure === 'transport' || (failure === 'download' && url.endsWith('/srt'))) throw new Error(`Temporary ${failure} interruption`)
    return transport(input, init)
  }
  await assert.rejects(f.run(), /interruption/)
  failure = 'download'
  await assert.rejects(f.run('merged', { job: JSON.parse(JSON.stringify(f.job)) }), /interruption/)
  failure = null
  const recovered = await f.run('merged', { job: JSON.parse(JSON.stringify(f.job)) })
  assert.equal(recovered.srt, srt)
  assert.equal(f.confirmations.length, 0)
  assert.equal(f.calls.some(call => call.startsWith('POST ')), false)
})

test('retry Off blocks subtitle retry and leaves an explicit manual action', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run(), /retry is Off/)
  assert.equal(f.confirmations.length, 0)
  assert.equal((f.job.params.subtitle_recovery as any).sections.Chapter_01.manual_action, 'rerun_subtitle_section')
})

test('configured retries allow exactly N physical submissions with same request/model', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.original(id => failed(id))
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /retries exhausted \(2 of 2\)/)
  assert.equal(f.confirmations.length, 2, '2 retries physically confirmed')
  const postCalls = f.calls.filter(c => c.includes('/confirm'))
  assert.equal(postCalls.length, 2)
  assert.equal(f.job.result?.recovery_state, 'needs_attention')
})

test('partial successes saved; retry only failed section', async t => {
  const f = await fixture(t, ['Chapter_01', 'Chapter_02'])
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 3 })
  assert.equal((await f.run('Chapter_01')).srt, srt)
  const failedTasks = new Set<string>()
  f.replacement(id => {
    if (failedTasks.size === 0 || failedTasks.has(id)) {
      failedTasks.add(id)
      return failed(id)
    }
    return { id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }
  })
  assert.equal((await f.run('Chapter_02')).srt, srt)
  const ledger = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(ledger.sections['Chapter_01.srt'].state, 'succeeded')
  assert.equal(ledger.sections['Chapter_02.srt'].state, 'succeeded')
  assert.ok(f.confirmations.length >= 2)
})

test('uncertain outcome or cancellation refuses retry', async t => {
  const fCancelled = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 3 })
  fCancelled.original(id => failed(id, { cancelled: true }))
  await assert.rejects(fCancelled.run(), /owner cancelled/)
  assert.equal(fCancelled.confirmations.length, 0)

  const fHeld = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 3 })
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await baseFetch(input, init)
    if (!String(input).includes('/by-idempotency-key/')) return response
    const job = await response.clone().json().catch(() => null)
    if (!job || typeof job !== 'object' || (job as any).state !== 'failed') return response
    return Response.json({ ...(job as object), recovery_required: true, recovery_state: 'unknown_outcome' })
  }
  await assert.rejects(fHeld.run(), /not eligible/)
  assert.equal(fHeld.confirmations.length, 0)
})

test('restart does not reset retry count; resumes from next ordinal', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 1 })
  f.original(id => failed(id))
  f.beforeConfirm(async () => { throw new Error('restart before quote') })
  await assert.rejects(f.run(), /restart before/)
  f.beforeConfirm(async () => {})
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /retries exhausted \(1 of 1\)/)
  const ledger1 = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const attempts1 = Object.values(ledger1.plans).flatMap((p: any) => p.attempts)
  assert.equal(attempts1.length, 1)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /retries exhausted \(2 of 2\)/)
  const ledger2 = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const attempts2 = Object.values(ledger2.plans).flatMap((p: any) => p.attempts)
  assert.equal(attempts2.length, 2)
})

test('parallel missing sections and repeated/restarted calls cannot duplicate retries', async t => {
  const f = await fixture(t, ['Chapter_01', 'Chapter_02'])
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  const result = await Promise.allSettled([f.run('Chapter_01'), f.run('Chapter_02')])
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 2)
  await Promise.allSettled([f.run('Chapter_01'), f.run('Chapter_02')])
  const state = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const attempts = Object.values(state.plans).flatMap((p: any) => p.attempts)
  assert.equal(attempts.length, 2)
  assert.equal((attempts[0] as any).originalTaskId.startsWith('old-'), true)
  assert.ok((attempts[0] as any).taskId)
})

test('a HELD original transcription refuses automatic retry: its answer may still arrive', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 3 })
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await baseFetch(input, init)
    if (!String(input).includes('/by-idempotency-key/')) return response
    const job = await response.clone().json().catch(() => null)
    if (!job || typeof job !== 'object' || (job as any).state !== 'failed') return response
    return Response.json({ ...(job as object), recovery_required: true, recovery_state: 'unknown_outcome' })
  }
  await assert.rejects(f.run(), /not eligible/)
  assert.equal(f.confirmations.length, 0)
})

test('explicit manual retry works while automatic setting stays Off', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: false })
  assert.equal((await f.run('Chapter_01', { manualPurchase: true })).srt, srt)
  assert.equal(f.confirmations.length, 1)
})

test('retry failure never creates unlimited attempts across restart when setting is Off', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: false })
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /retry is Off/)
  assert.equal(f.confirmations.length, 0)
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /retry is Off/)
  assert.equal(f.confirmations.length, 0)
})

test('removing the ledger replacement flag cannot promote a failed replacement to a new original', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /retries exhausted \(2 of 2\)/)
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  delete ledger.sections['Chapter_01.srt'].replacement
  Object.values(ledger.plans).forEach((p: any) => { p.attempts = [] })
  await fs.writeFile(file, JSON.stringify(ledger))
  f.calls.length = 0
  await assert.rejects(f.run(), /identity|authority/i)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
  assert.equal(f.confirmations.length, 2)
})

test('crash after confirm but before accepted task checkpoint recovers read-only by committed key while Off', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  const controller = new AbortController()
  f.confirm(async key => {
    const ledger = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
    const attempt = Object.values(ledger.plans).flatMap((p: any) => p.attempts)[0] as any
    assert.equal(`${attempt.idempotencyKey}-confirm`, key)
    assert.equal(attempt.replacementOrdinal, 1)
    assert.equal(attempt.originalTaskId, 'old-Chapter_01')
    assert.ok(attempt.committedAt)
    controller.abort()
    throw new Error('connection lost after provider accepted')
  })
  await assert.rejects(f.run('Chapter_01', { request: { audioPath: path.join(f.outDir, 'audio.wav'),
    modelId: 'model', requestIdentity: 'episode:Chapter_01', signal: controller.signal } }))
  f.confirm(async () => { throw new Error('must never submit again') })
  f.calls.length = 0
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
})

test('a corrupt saved ledger cannot silently create fresh retry authority', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.outDir, '.subtitle-recovery.json'), '{')
  await assert.rejects(f.run())
  assert.equal(f.calls.length, 0)
})

test('coherently forged replacement authority must reconcile outside the ledger before any provider POST', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run(), /Off/)
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  const section = ledger.sections['Chapter_01.srt']
  section.replacement = {
    originalTaskId: 'forged-original-task', originalIdempotencyKey: 'forged-original-key',
    failure: { transient: true, cancelled: false },
  }
  section.identityVerified = true
  section.idempotencyKey = `story-stt-${createHash('sha256').update('forged-original-key:subtitle-replacement:1').digest('hex')}`
  section.taskId = ''
  section.confirmStarted = false
  section.state = 'prepared'
  assert.equal(ledger.plans[section.planId].attempts.length, 0)
  await fs.writeFile(file, JSON.stringify(ledger))
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.calls.length = 0
  await assert.rejects(f.run(), /original.*verif|authority.*verif/i)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
  assert.equal(f.confirmations.length, 0)
  assert.equal(f.job.result?.recovery_state, 'needs_attention')
})

for (const replacement of [false, true]) test(`another real failed task cannot supply this section's ${replacement ? 'replacement' : 'initial'} authority`, async t => {
  const f = await fixture(t, ['Chapter_01', 'Chapter_02'])
  if (replacement) {
    await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
    f.beforeConfirm(async () => { throw new Error('restart with pending replacement') })
    await assert.rejects(f.run(), /restart with/)
    f.beforeConfirm(async () => {})
  } else await assert.rejects(f.run(), /Off/)
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  const section = ledger.sections['Chapter_01.srt']
  section.identityVerified = true
  if (replacement) {
    section.replacement.originalTaskId = 'old-Chapter_02'
    section.replacement.originalIdempotencyKey = 'original-Chapter_02'
    section.idempotencyKey = `story-stt-${createHash('sha256').update('original-Chapter_02:subtitle-replacement:1').digest('hex')}`
  } else {
    section.taskId = 'old-Chapter_02'
    section.idempotencyKey = 'original-Chapter_02'
  }
  await fs.writeFile(file, JSON.stringify(ledger))
  const manifestFile = path.join(f.outDir, '.task-manifest.json')
  const manifestBefore = await fs.readFile(manifestFile, 'utf8')
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.calls.length = 0
  await assert.rejects(f.run(), /identity|authority|manifest/i)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
  assert.equal(f.confirmations.length, 0)
  assert.equal(await fs.readFile(manifestFile, 'utf8'), manifestBefore, 'the ledger must not rewrite the independent binding before validation')
})

test('a pending legacy replacement without immutable original manifest fields cannot auto-buy', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.beforeConfirm(async () => { throw new Error('restart before quote') })
  await assert.rejects(f.run(), /restart before/)
  f.beforeConfirm(async () => {})
  const file = path.join(f.outDir, '.task-manifest.json')
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
  delete manifest.tasks['Chapter_01.srt'].subtitle_originals
  await fs.writeFile(file, JSON.stringify(manifest))
  f.calls.length = 0
  await assert.rejects(f.run(), /identity|authority|manifest/i)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
  assert.equal(f.confirmations.length, 0)
})

test('legitimate pending replacement rebinds original provider authority after restart and resumes once', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.beforeConfirm(async () => { throw new Error('restart before replacement quote response') })
  await assert.rejects(f.run(), /restart before/)
  f.beforeConfirm(async () => {})
  for (const remote of [
    (_id: string) => failed('different-original-task'),
  ]) {
    f.original(remote)
    f.calls.length = 0
    await assert.rejects(f.run(), /original.*verif|authority.*verif/i)
    assert.equal(f.calls.some(c => c.startsWith('POST')), false, 'saved settlement and identity cannot override provider truth')
    assert.equal(f.confirmations.length, 0)
  }
  f.original(id => failed(id))
  f.calls.length = 0
  assert.equal((await f.run()).srt, srt)
  const rebound = f.calls.findIndex(c => c.includes('/by-idempotency-key/original-Chapter_01-confirm'))
  const submitted = f.calls.findIndex(c => c.startsWith('POST'))
  assert.ok(rebound >= 0 && rebound < submitted, 'read-only original reconciliation must precede the replacement quote')
  assert.equal(f.confirmations.length, 1)
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations.length, 1)
})

for (const [label, corrupt] of [
  ['missing original task', (s: any) => { s.replacement.originalTaskId = '' }],
  ['missing original key', (s: any) => { delete s.replacement.originalIdempotencyKey }],
  ['unrelated original key', (s: any) => { s.replacement.originalIdempotencyKey = 'unrelated-key' }],
  ['unverified identity', (s: any) => { s.identityVerified = false }],
  ['truthy transient', (s: any) => { s.replacement.failure.transient = 'true' }],
  ['missing cancellation', (s: any) => { delete s.replacement.failure.cancelled }],
  ['missing failure', (s: any) => { delete s.replacement.failure }],
] as const) test(`corrupt persisted replacement provenance (${label}) fails before provider submission`, async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.beforeConfirm(async () => { throw new Error('simulated restart before quote response') })
  await assert.rejects(f.run(), /simulated restart/)
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  corrupt(ledger.sections['Chapter_01.srt'])
  await fs.writeFile(file, JSON.stringify(ledger))
  f.beforeConfirm(async () => {})
  f.calls.length = 0
  await assert.rejects(f.run(), /ledger/)
  assert.equal(f.calls.length, 0, 'invalid durable authority must fail before even quoting')
  assert.equal(f.confirmations.length, 0)
})

test('forced rerun with only the durable ledger uses a fresh key and reuses it on restart', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  assert.equal((await f.run()).srt, srt)
  const originalKey = f.confirmations[0]
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  const job = { ...f.job, job_id: `${f.job.job_id}-forced`, params: {}, output_lines: [] }
  assert.equal((await f.run('Chapter_01', { force: true, job })).srt, srt)
  assert.equal(f.confirmations.length, 2, 'explicit rerun must not replay the original billed identity')
  assert.notEqual(f.confirmations[1], originalKey)
  assert.equal((await f.run('Chapter_01', { force: true, job })).srt, srt)
  assert.equal(f.confirmations.length, 2, 'restarting that forced job must reuse its new identity')
})

for (const [label, override] of [
  ['refusal despite full refund', { failure_class: 'content_refused' }],
  ['cancellation despite full refund', { cancelled: true }],
] as const) test(`${label} never reaches a new provider quote or confirm`, async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.original(id => failed(id, override))
  await assert.rejects(f.run())
  assert.equal(f.calls.filter(c => c.startsWith('POST')).length, 0)
})

test('manual purchase derives only exact missing sections from the failed job', async () => {
  const { subtitlePurchaseParams } = await import('../services/subtitle-recovery.js')
  const job = { type: 'subtitles_transcribe', status: 'error', episode_id: 'EP0001',
    params: { model: 'model', force: true, per_chapter: true, sections: ['Chapter_01', 'Chapter_02'], subtitle_recovery_plan_id: 'plan' },
    result: { missing_sections: ['Chapter_02'] } } as unknown as Job
  assert.deepEqual(subtitlePurchaseParams(job), {
    ...job.params, force: false, sections: ['Chapter_02'],
    subtitle_purchase: {},
  })
  assert.throws(() => subtitlePurchaseParams({ ...job, result: { missing_sections: [] } }), /missing/)
  assert.throws(() => subtitlePurchaseParams({ ...job, status: 'running' }), /failed/)
})

test('quote expiry HTTP 410 with no provider task stops needs_attention without minting a fresh key', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  f.expireQuote()
  await assert.rejects(f.run(), /quote expired before any provider task was created/)
  assert.equal(f.confirmations.length, 0)
  assert.equal(f.calls.filter(call => call.endsWith('/quotes')).length, 1, 'no automatic renewal quote is created')
  const state = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(state.sections['Chapter_01.srt'].freeRetries, 0, 'no fresh key is minted while Off')
  assert.equal(Object.values(state.plans).flatMap((p: any) => p.attempts).length, 0)
  assert.equal((f.job.params.subtitle_recovery as any).sections.Chapter_01.manual_action, 'rerun_subtitle_section')
})

test('the exact Gateway HTTP 422 confirm expiry with no created task stops without a renewed request', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  f.confirm(async () => Response.json({ detail: 'transcription quote has expired' }, { status: 422 }))
  await assert.rejects(f.run(), /quote expired before any provider task was created/)
  assert.equal(f.confirmations.length, 1, 'the expired confirm is not replayed under a fresh key')
  assert.equal(f.calls.filter(call => call.endsWith('/quotes')).length, 1, 'no renewed quote is created')
  const state = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(state.sections['Chapter_01.srt'].freeRetries, 0, 'no fresh key is minted while Off')
})

test('the same HTTP 422 expiry detail at quote creation stays fail-closed', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  f.expireQuote(422, 'transcription quote has expired')
  await assert.rejects(f.run())
  assert.equal(f.calls.filter(call => call.endsWith('/quotes')).length, 1)
  assert.equal(f.confirmations.length, 0)
})

test('a non-exact HTTP 422 expiry detail at confirm does not mint a fresh request', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  f.confirm(async () => Response.json({ detail: ' Transcription quote has expired ' }, { status: 422 }))
  await assert.rejects(f.run())
  assert.equal(f.calls.filter(call => call.endsWith('/quotes')).length, 1)
  assert.equal(f.confirmations.length, 1)
})

test('a saved transcription task missing from the Gateway offers an explicit fresh section rerun without submitting', async t => {
  const f = await fixture(t)
  f.originalMissing()
  await assert.rejects(f.run(), /not found with the current Gateway connection\/account/i)
  assert.equal(f.calls.some(call => call.startsWith('POST ')), false)
  assert.equal((f.job.params.subtitle_recovery as any).sections.Chapter_01.manual_action, 'rerun_subtitle_section')
})

test('artifact expiry after success never authorizes automatic spending', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.original(id => ({ ...failed(id), state: 'succeeded' }))
  await assert.rejects(f.run(), /artifact expired/)
  assert.equal(f.confirmations.length, 0)
})

test('explicit re-run makes one fresh identity but restart of the same forced job reuses it', async t => {
  const f = await fixture(t)
  assert.equal((await f.run('Chapter_01', { force: true })).srt, srt)
  assert.equal((await f.run('Chapter_01', { force: true })).srt, srt)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.calls.some(c => c.includes('/old-Chapter_01')), false)
})

test('a stamped explicit action survives a successor queue job, while a new action gets one new task', async t => {
  const f = await fixture(t)
  const first = { ...f.job, job_id: 'explicit-action-first', params: {}, output_lines: [] }
  const action = 'fresh-action-one'
  assert.equal((await f.run('Chapter_01', {
    force: true,
    job: first,
    generationActionId: action,
  } as any)).srt, srt)
  assert.equal(f.confirmations.length, 1)

  const retry = { ...f.job, job_id: 'explicit-action-retry', params: {}, output_lines: [] }
  assert.equal((await f.run('Chapter_01', {
    force: true,
    job: retry,
    generationActionId: action,
  } as any)).srt, srt)
  assert.equal(f.confirmations.length, 1, 'Jobs Retry must reconnect the original explicit action')

  const later = { ...f.job, job_id: 'explicit-action-later', params: {}, output_lines: [] }
  assert.equal((await f.run('Chapter_01', {
    force: true,
    job: later,
    generationActionId: 'fresh-action-two',
  } as any)).srt, srt)
  assert.equal(f.confirmations.length, 2, 'a second deliberate action owns one distinct task')
})

test('retry failure stops even if owner turns automatic setting Off', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  let firstKey = ''
  f.confirm(async key => {
    firstKey ||= key
    await setRetryFailedRequestsSetting('subtitle', { enabled: false })
  })
  f.original(id => failed(id))
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /retry is Off/)
  assert.equal(f.confirmations.length, 1)
})

test('valid JSON with an invalid manifest schema does not authorize a fresh task', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.outDir, '.task-manifest.json'), JSON.stringify({ schema_version: 99, tasks: {} }))
  await assert.rejects(f.run(), /manifest/)
  assert.equal(f.confirmations.length, 0)
})

for (const status of [400, 401, 404, 409, 422]) test(`quote HTTP ${status} is not free expiry authority`, async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  f.expireQuote(status)
  await assert.rejects(f.run())
  assert.equal(f.confirmations.length, 0)
  assert.equal(f.calls.filter(c => c.startsWith('POST')).length, 1)
})

test('lost task-id persistence after provider confirmation is recovered by the saved key', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  const rename = fs.rename
  try {
    fs.rename = async (from, to) => {
      if (String(to) === path.join(f.outDir, '.subtitle-recovery.json')) {
        const ledger = JSON.parse(await fs.readFile(from, 'utf8'))
        if (ledger.sections['Chapter_01.srt']?.taskId.startsWith('new-')) throw new Error('simulated disk failure after confirm')
      }
      return rename(from, to)
    }
    await assert.rejects(f.run(), /disk failure/)
  } finally { fs.rename = rename }
  f.calls.length = 0
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
})

test('crash immediately before charged POST retains commitment; restart reuses it once', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  const rename = fs.rename
  const controller = new AbortController()
  try {
    fs.rename = async (from, to) => {
      const result = await rename(from, to)
      if (String(to) === path.join(f.outDir, '.subtitle-recovery.json')) {
        const ledger = JSON.parse(await fs.readFile(to, 'utf8'))
        if (ledger.sections['Chapter_01.srt']?.confirmStarted) controller.abort()
      }
      return result
    }
    await assert.rejects(f.run('Chapter_01', { request: {
      audioPath: path.join(f.outDir, 'audio.wav'), modelId: 'model', requestIdentity: 'episode:Chapter_01', signal: controller.signal,
    } }))
  } finally { fs.rename = rename }
  assert.equal(f.confirmations.length, 0)
  const before = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations[0], `${before.sections['Chapter_01.srt'].idempotencyKey}-confirm`)
})

test('HTTP manual action ignores caller section widening and enqueues exact failed-job scope', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run())
  const queue = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Subtitle manual purchase route' })
  f.job.project_slug = project.slug
  f.job.status = 'error'
  f.job.params.model = 'model'
  f.job.params.per_chapter = true
  await queue.checkpointJobState(f.job)
  const { router } = await import('../routes/video.js')
  const app = express().use(express.json()).use(router)
  const url = `/projects/${project.slug}/video-editor/subtitles/buy-missing/${f.job.job_id}`
  const response = await request(app).post(url).send({ sections: ['Chapter_99'], force: true })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.deepEqual(response.body.params.sections, ['Chapter_01'])
  assert.equal(response.body.params.force, false)
  assert.deepEqual(response.body.params.subtitle_purchase, {})
  // The isolated fixture has no Audio Assembly; the real executor fails its local preflight, never a provider call.
  await waitFor(
    () => !['queued', 'running'].includes(queue.getJob(response.body.job_id)?.status || ''),
    { label: 'manual subtitle purchase job to leave the queue' },
  )
  assert.equal(f.confirmations.length, 0)
})

test('sections first recovered in separate queue jobs both fulfill without a ceiling', async t => {
  const f = await fixture(t, ['Chapter_01', 'Chapter_02'])
  for (const section of ['Chapter_01', 'Chapter_02']) {
    const job = { ...f.job, job_id: `${f.job.job_id}-${section}`, params: {}, output_lines: [] }
    await assert.rejects(f.run(section, { job }))
  }
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  const results = await Promise.allSettled([f.run('Chapter_01'), f.run('Chapter_02')])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2)
  assert.equal(f.confirmations.length, 2)
})

test('an incomplete legacy original identity may recover for free but cannot authorize a purchase', async t => {
  const f = await fixture(t)
  await recordTaskStrict(f.outDir, 'Chapter_01.srt', {
    provider: 'genstudio', task_id: 'old-Chapter_01', input_hash: hashInput('input'), submitted_at: '2026-09-05T00:00:00Z',
  })
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  await assert.rejects(f.run(), /identity/)
  assert.equal(f.confirmations.length, 0)
})

test('a malformed commitment budget in valid JSON fails closed', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run())
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  Object.values(ledger.plans).forEach((p: any) => p.attempts.push({ section: 'Chapter_00', idempotencyKey: null, replacementOrdinal: 0 }))
  await fs.writeFile(file, JSON.stringify(ledger))
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  await assert.rejects(f.run(), /ledger/)
  assert.equal(f.confirmations.length, 0)
})

test('expiry after a confirm was attempted reconciles its key before retiring any commitment', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  let first = true
  f.confirm(async key => {
    if (first) {
      first = false
      f.acceptConfirmation(key)
      return Response.json({ detail: 'quote expired' }, { status: 410 })
    }
  })
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations.length, 1, 'the key lookup must discover the already-created task')
})

// All subtitle requests follow retry_failed_requests_subtitle uniformly regardless of model name.
const fleetModel = 'studio-hub::mlx-community/whisper-large-v3-turbo'
const fleetRun = (f: Awaited<ReturnType<typeof fixture>>, section = 'Chapter_01') => f.run(section, {
  request: { audioPath: f.audioPath, modelId: fleetModel, requestIdentity: `episode:${section}`, wordTimestamps: true },
})

test('free-named model: dead saved task with retry Off makes zero extra requests and blocks', async t => {
  const f = await fixture(t)
  await assert.rejects(fleetRun(f), /automatic subtitle retry is Off/)
  assert.equal(f.confirmations.length, 0, 'Off means zero extra requests')
  assert.equal((f.job.params.subtitle_recovery as any).sections.Chapter_01.manual_action, 'rerun_subtitle_section')
})

test('free-named model: with retry On and maxRetries=2 makes exactly two extra attempts before exhausting', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  f.replacement(id => failed(id))
  await assert.rejects(fleetRun(f), /Automatic subtitle retries exhausted \(2 of 2\)/)
  assert.equal(f.confirmations.length, 2, 'On 2 means exactly two extra requests')
  const ledger = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const attempts = Object.values(ledger.plans).flatMap((p: any) => p.attempts)
  assert.equal(attempts.length, 2, 'two replacement attempts recorded in ledger')
})

test('free-named model: with retry On succeeds on additional attempt within budget', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  let tries = 0
  f.replacement(id => {
    tries++
    if (tries < 2) return failed(id)
    return { id, state: 'succeeded', model_id: fleetModel, srt_url: `/v1/transcriptions/${id}/srt` } as any
  })
  assert.equal((await fleetRun(f)).srt, srt)
  assert.equal(f.confirmations.length, 2, 'succeeded on second retry attempt')
})

test('free-named model: unknown outcome makes no fresh request and reconnects by same key', async t => {
  const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }
  const f = await fixture(t)
  await f.clearOriginal()
  let attempts = 0
  f.confirm(async () => {
    attempts++
    if (attempts === 1) timeout()
  })
  await assert.rejects(fleetRun(f), /did not answer within the request time limit/)
  assert.equal(f.confirmations.length, 1, 'only one key submitted; no extra key minted on unknown outcome')
  const message = (f.job.params.subtitle_recovery as any).sections.Chapter_01.message
  assert.match(message, /Subtitle request interrupted \(The Gateway did not answer/)

  // Re-running reconnects under the exact same key without minting a fresh request
  assert.equal((await fleetRun(f)).srt, srt)
  assert.equal(f.confirmations.length, 1, 'reconnected using existing key with zero additional requests')
})

test('free-named model: restart preserves retry budget across separate runs', async t => {
  const f = await fixture(t)
  await setRetryFailedRequestsSetting('subtitle', { enabled: true, retries: 2 })
  let attemptCount = 0
  f.confirm(async () => {
    attemptCount++
    if (attemptCount === 1) return Response.json(failed('new-att-1'), { status: 202 })
    throw new Error('simulated process interruption')
  })
  await assert.rejects(fleetRun(f), /simulated process interruption/)
  assert.equal(f.confirmations.length, 2)

  f.confirm(async () => Response.json(failed('new-att-2'), { status: 202 }))
  await assert.rejects(fleetRun(f), /Automatic subtitle retries exhausted \(2 of 2\)/)
  assert.equal(f.confirmations.length, 2, 'retry budget of 2 was strictly preserved across restart')
})

test('free-named model: a saved task missing from the Gateway blocks with rerun offer', async t => {
  const missing = await fixture(t)
  missing.originalMissing()
  await assert.rejects(fleetRun(missing), /not found with the current Gateway connection\/account/i)
  assert.equal(missing.confirmations.length, 0)
  assert.equal((missing.job.params.subtitle_recovery as any).sections.Chapter_01.manual_action, 'rerun_subtitle_section')
})

test('free-named model: an expired artifact after success never authorizes automatic requests', async t => {
  const expired = await fixture(t)
  expired.original(id => ({ ...failed(id), state: 'succeeded' }))
  await assert.rejects(fleetRun(expired), /artifact expired/i)
  assert.equal(expired.confirmations.length, 0)
})

test('free-named model: a cancelled task is still the owner stop, not a fresh request', async t => {
  const f = await fixture(t)
  f.original(id => failed(id, { cancelled: true }))
  await assert.rejects(fleetRun(f), /cancelled/)
  assert.equal(f.confirmations.length, 0)
})

test('episode recovery names each distinct section message once', async () => {
  const { subtitleStatesMessage } = await import('../services/episode-recovery.js')
  const same = 'Subtitle request interrupted (timeout); its saved task/key is kept and the next retry reconnects to it.'
  const message = subtitleStatesMessage({
    Chapter_01: { message: same }, Chapter_02: { message: same }, Chapter_03: { message: same },
    Chapter_05: { message: 'Subtitle task recovered; verifying its artifact and stitch next.' }, Chapter_06: {},
  })
  assert.equal(message.split(same).length - 1, 1)
  assert.equal(message, `Chapter_01, Chapter_02, Chapter_03: ${same} Chapter_05: Subtitle task recovered; verifying its artifact and stitch next.`)
  assert.equal(subtitleStatesMessage(undefined), '')
})
