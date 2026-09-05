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
import { setAppSetting, setPaidSubtitleReplacementSetting } from '../services/app-settings.js'
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
  await setAppSetting('paid_subtitle_replacement', { enabled: false, additional_credit_ceiling: 5 })
  for (const section of sections) await recordTaskStrict(outDir, `${section}.srt`, {
    provider: 'genstudio', task_id: `old-${section}`, idempotency_key: `original-${section}`,
    submitted_at: '2026-09-05T00:00:00Z', input_hash: hashInput('input'), last_state: 'failed',
  })
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const confirmations: string[] = []
  const calls: string[] = []
  let original = (id: string) => failed(id)
  let quoteFields: Record<string, unknown> = { quoted_credit_cost: 3, price_version: 'price-v1' }
  let beforeConfirm = async () => {}
  let confirm = async (_key: string): Promise<Response | void> => {}
  let quoteFailure: number | null = null
  let replacement = (id: string) => ({ id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` }) as any
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method || 'GET'} ${url}`)
    if (url.endsWith('/v1/account/overview')) return Response.json({
      credit_balance: 1000, paid_concurrency_limit: 20, paid_active_jobs: 0,
      paid_queued_jobs: 0, max_queued_jobs: 100, generation_submissions_per_minute: 1000,
    })
    if (url.endsWith('/quotes')) {
      if (quoteFailure) { const status = quoteFailure; quoteFailure = null; return Response.json({ detail: 'quote expired' }, { status }) }
      const key = (init!.headers as Record<string, string>)['Idempotency-Key']!
      await beforeConfirm()
      return Response.json({ id: key, ...quoteFields }, { status: 201 })
    }
    if (url.endsWith('/confirm')) {
      const key = (init!.headers as Record<string, string>)['Idempotency-Key']!
      // Physical attempts can replay; the provider creates only one billed task per key.
      if (!confirmations.includes(key)) confirmations.push(key)
      const response = await confirm(key)
      if (response) return response
      return Response.json(replacement(`new-${key}`), { status: 202 })
    }
    if (url.endsWith('/srt')) return new Response(srt)
    const id = decodeURIComponent(url.split('/').pop()!)
    if (url.includes('/by-idempotency-key/')) {
      const section = sections.find(s => id === `original-${s}-confirm`)
      if (section) return Response.json(original(`old-${section}`))
      return confirmations.includes(id)
        ? Response.json(replacement(`new-${id}`)) : Response.json({ detail: 'not found' }, { status: 404 })
    }
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
  return { outDir, run, job, calls, confirmations,
    original: (fn: typeof original) => { original = fn },
    quote: (value: typeof quoteFields) => { quoteFields = value },
    beforeConfirm: (fn: typeof beforeConfirm) => { beforeConfirm = fn },
    confirm: (fn: typeof confirm) => { confirm = fn },
    expireQuote: (status = 410) => { quoteFailure = status },
    replacement: (fn: typeof replacement) => { replacement = fn },
  }
}

test('accepted task is recovered before any POST, even if local state says failed', async t => {
  const f = await fixture(t)
  f.original(id => ({ ...failed(id), state: 'succeeded', srt_url: `/v1/transcriptions/${id}/srt` }))
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.calls.filter(c => c.startsWith('POST')).length, 0)
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

test('Off blocks paid work and leaves an explicit manual purchase state', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run(), /Off/)
  assert.equal(f.confirmations.length, 0)
  assert.equal((f.job.params.subtitle_recovery as any).sections.Chapter_01.manual_action, 'buy_missing_subtitles')
})

test('parallel missing sections share one ceiling and repeated/restarted calls cannot buy twice', async t => {
  const f = await fixture(t, ['Chapter_01', 'Chapter_02'])
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  const result = await Promise.allSettled([f.run('Chapter_01'), f.run('Chapter_02')])
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.confirmations.length, 1)
  await Promise.allSettled([f.run('Chapter_01'), f.run('Chapter_02')])
  assert.equal(f.confirmations.length, 1)
  const state = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  const attempts = Object.values(state.plans).flatMap((p: any) => p.attempts)
  assert.equal(attempts.length, 1)
  assert.equal((attempts[0] as any).originalTaskId.startsWith('old-'), true)
  assert.ok((attempts[0] as any).taskId)
  assert.equal((attempts[0] as any).ceiling, 5)
})

test('balanced transient zero-settlement is free while Off; a paid replacement failure stops', async t => {
  const f = await fixture(t)
  f.original(id => failed(id, { settled_credits: 0, released_credits: 3 }))
  assert.equal((await f.run()).srt, srt)
  const state = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(Object.values(state.plans).flatMap((p: any) => p.attempts).length, 0)
})

test('toggle Off while a quote is pending prevents confirmation', async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  f.beforeConfirm(async () => { await setPaidSubtitleReplacementSetting({ enabled: false, additional_credit_ceiling: 5 }) })
  await assert.rejects(f.run(), /Off/)
  assert.equal(f.confirmations.length, 0)
})

test('missing live price and incomplete settlement fail closed', async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  f.quote({ quoted_credit_cost: 3 })
  await assert.rejects(f.run(), /price/)
  assert.equal(f.confirmations.length, 0)
})

test('explicit manual purchase works while automatic setting stays Off', async t => {
  const f = await fixture(t)
  assert.equal((await f.run('Chapter_01', { manualCreditCeiling: 4 })).srt, srt)
  assert.equal(f.confirmations.length, 1)
})

test('paid replacement failure never purchases another replacement across restart', async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 20 })
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /one paid replacement failed/)
  await assert.rejects(f.run(), /one paid replacement failed/)
  assert.equal(f.confirmations.length, 1)
})

test('removing the ledger replacement flag cannot promote a failed replacement to a new original', async t => {
  const f = await fixture(t)
  await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
  f.replacement(id => failed(id))
  await assert.rejects(f.run(), /one paid replacement failed/)
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  delete ledger.sections['Chapter_01.srt'].replacement
  Object.values(ledger.plans).forEach((p: any) => { p.attempts = [] })
  await fs.writeFile(file, JSON.stringify(ledger))
  f.calls.length = 0
  await assert.rejects(f.run(), /identity|authority/i)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
  assert.equal(f.confirmations.length, 1)
})

test('crash after confirm but before accepted task checkpoint recovers read-only by committed key while Off', async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  const controller = new AbortController()
  f.confirm(async key => {
    const ledger = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
    const attempt = Object.values(ledger.plans).flatMap((p: any) => p.attempts)[0] as any
    assert.equal(`${attempt.idempotencyKey}-confirm`, key)
    assert.equal(attempt.quotedCredits, 3)
    assert.equal(attempt.priceVersion, 'price-v1')
    assert.equal(attempt.replacementOrdinal, 1)
    assert.equal(attempt.originalTaskId, 'old-Chapter_01')
    assert.ok(attempt.committedAt)
    controller.abort()
    throw new Error('connection lost after provider accepted')
  })
  await assert.rejects(f.run('Chapter_01', { request: { audioPath: path.join(f.outDir, 'audio.wav'),
    modelId: 'model', requestIdentity: 'episode:Chapter_01', signal: controller.signal } }))
  await setAppSetting('paid_subtitle_replacement', { enabled: false, additional_credit_ceiling: 5 })
  f.confirm(async () => { throw new Error('must never submit again') })
  f.calls.length = 0
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
})

test('a corrupt saved ledger cannot silently create fresh paid authority', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.outDir, '.subtitle-recovery.json'), '{')
  await assert.rejects(f.run())
  assert.equal(f.calls.length, 0)
})

test('coherently forged replacement authority must reconcile outside the ledger before any paid POST', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run(), /Off/)
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  const section = ledger.sections['Chapter_01.srt']
  section.replacement = {
    originalTaskId: 'forged-original-task', originalIdempotencyKey: 'forged-original-key',
    failure: { transient: true, cancelled: false, reservedCredits: 3, settledCredits: 3, releasedCredits: 0 },
  }
  section.identityVerified = true
  section.idempotencyKey = `story-stt-${createHash('sha256').update('forged-original-key:subtitle-replacement:1').digest('hex')}`
  section.taskId = ''
  section.confirmStarted = false
  section.state = 'prepared'
  assert.equal(ledger.plans[section.planId].attempts.length, 0)
  await fs.writeFile(file, JSON.stringify(ledger))
  await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 5 })
  f.calls.length = 0
  await assert.rejects(f.run(), /original.*verif|authority.*verif/i)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
  assert.equal(f.confirmations.length, 0)
  assert.equal(f.job.result?.recovery_state, 'needs_attention')
})

for (const replacement of [false, true]) test(`another real failed task cannot supply this section's ${replacement ? 'replacement' : 'initial'} authority`, async t => {
  const f = await fixture(t, ['Chapter_01', 'Chapter_02'])
  if (replacement) {
    await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 5 })
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
  await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 5 })
  f.calls.length = 0
  await assert.rejects(f.run(), /identity|authority|manifest/i)
  assert.equal(f.calls.some(c => c.startsWith('POST')), false)
  assert.equal(f.confirmations.length, 0)
  assert.equal(await fs.readFile(manifestFile, 'utf8'), manifestBefore, 'the ledger must not rewrite the independent binding before validation')
})

test('a pending legacy replacement without immutable original manifest fields cannot auto-buy', async t => {
  const f = await fixture(t)
  await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 5 })
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
  await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 5 })
  f.beforeConfirm(async () => { throw new Error('restart before replacement quote response') })
  await assert.rejects(f.run(), /restart before/)
  f.beforeConfirm(async () => {})
  for (const remote of [
    (id: string) => failed(id, { settled_credits: null }),
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
  ['missing settlement', (s: any) => { delete s.replacement.failure.settledCredits }],
  ['unbalanced settlement', (s: any) => { s.replacement.failure.releasedCredits = 1 }],
  ['missing failure', (s: any) => { delete s.replacement.failure }],
] as const) test(`corrupt persisted replacement provenance (${label}) fails before provider submission`, async t => {
  const f = await fixture(t)
  await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 5 })
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

test('setting Off cannot interleave between the final policy snapshot and physical paid confirmation', async t => {
  const f = await fixture(t)
  await setPaidSubtitleReplacementSetting({ enabled: true, additional_credit_ceiling: 5 })
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const readFile = fs.readFile
  let paused = false
  let competingSettingsReadStarted = false
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const isSettingsRead = path.basename(String(args[0])) === 'app-settings.json'
    if (isSettingsRead && paused) competingSettingsReadStarted = true
    const data = await readFile(...args)
    if (!paused && isSettingsRead) {
      const ledger = JSON.parse(await readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
      if (ledger.sections['Chapter_01.srt']?.confirmStarted) {
        paused = true
        enter()
        await pending // Hold a stale On snapshot at the final authorization boundary.
      }
    }
    return data
  }) as typeof fs.readFile
  t.after(() => { fs.readFile = readFile })
  const running = f.run()
  await entered
  const off = setPaidSubtitleReplacementSetting({ enabled: false, additional_credit_ceiling: 5 })
  // Give an ungated setter its queued microtask. The read hook proves whether
  // it crossed the boundary; this does not depend on wall-clock scheduling.
  await Promise.resolve()
  assert.equal(competingSettingsReadStarted, false,
    'Off must not begin its settings read while an authorized confirm holds the gate')
  release()
  await Promise.all([running, off])
  assert.equal(competingSettingsReadStarted, true, 'Off must proceed once the confirmation gate is released')
  assert.equal(f.confirmations.length, 1)
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
  ['missing settlement', { settled_credits: null }],
  ['unbalanced settlement', { settled_credits: 2 }],
  ['refusal despite full refund', { failure_class: 'content_refused', settled_credits: 0, released_credits: 3 }],
  ['cancellation despite full refund', { cancelled: true, settled_credits: 0, released_credits: 3 }],
] as const) test(`${label} never reaches a new provider quote or confirm`, async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  f.original(id => failed(id, override))
  await assert.rejects(f.run())
  assert.equal(f.calls.filter(c => c.startsWith('POST')).length, 0)
})

test('manual purchase derives only exact missing sections from the failed job', async () => {
  const { subtitlePurchaseParams } = await import('../services/subtitle-recovery.js')
  const job = { type: 'subtitles_transcribe', status: 'error', episode_id: 'EP0001',
    params: { model: 'model', force: true, per_chapter: true, sections: ['Chapter_01', 'Chapter_02'], subtitle_recovery_plan_id: 'plan' },
    result: { missing_sections: ['Chapter_02'] } } as unknown as Job
  assert.deepEqual(subtitlePurchaseParams(job, 4), {
    ...job.params, force: false, sections: ['Chapter_02'],
    subtitle_purchase: { additional_credit_ceiling: 4 },
  })
  assert.throws(() => subtitlePurchaseParams({ ...job, result: { missing_sections: [] } }, 4), /missing/)
  assert.throws(() => subtitlePurchaseParams({ ...job, status: 'running' }, 4), /failed/)
  assert.throws(() => subtitlePurchaseParams(job, 0), /ceiling/)
})

test('quote expiry retries for free while Off, with a persisted renewed key', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.outDir, '.task-manifest.json'))
  f.expireQuote()
  assert.equal((await f.run()).srt, srt)
  const state = JSON.parse(await fs.readFile(path.join(f.outDir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(state.sections['Chapter_01.srt'].freeRetries, 1)
  assert.equal(Object.values(state.plans).flatMap((p: any) => p.attempts).length, 0)
})

test('artifact expiry after success never authorizes automatic spending', async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 20 })
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

test('paid replacement zero-settlement retry stays free when owner turns automatic setting Off', async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  let firstKey = ''
  f.confirm(async key => {
    firstKey ||= key
    await setAppSetting('paid_subtitle_replacement', { enabled: false, additional_credit_ceiling: 5 })
  })
  f.replacement(id => id === `new-${firstKey}`
    ? failed(id, { settled_credits: 0, released_credits: 3 })
    : { id, state: 'succeeded', model_id: 'model', srt_url: `/v1/transcriptions/${id}/srt` })
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations.length, 2, 'first reservation refunded, only the second can settle credits')
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
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
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
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
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
  const invalid = await request(app).post(url).send({ additional_credit_ceiling: 0 })
  assert.equal(invalid.status, 409)
  const response = await request(app).post(url).send({ additional_credit_ceiling: 4, sections: ['Chapter_99'], force: true })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.deepEqual(response.body.params.sections, ['Chapter_01'])
  assert.equal(response.body.params.force, false)
  assert.deepEqual(response.body.params.subtitle_purchase, { additional_credit_ceiling: 4 })
  // The isolated fixture has no Audio Assembly; the real executor fails its local preflight, never a provider call.
  await waitFor(
    () => !['queued', 'running'].includes(queue.getJob(response.body.job_id)?.status || ''),
    { label: 'manual subtitle purchase job to leave the queue' },
  )
  assert.equal(f.confirmations.length, 0)
})

test('sections first recovered in separate queue jobs still share the episode recovery ceiling', async t => {
  const f = await fixture(t, ['Chapter_01', 'Chapter_02'])
  for (const section of ['Chapter_01', 'Chapter_02']) {
    const job = { ...f.job, job_id: `${f.job.job_id}-${section}`, params: {}, output_lines: [] }
    await assert.rejects(f.run(section, { job }))
  }
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  const results = await Promise.allSettled([f.run('Chapter_01'), f.run('Chapter_02')])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.confirmations.length, 1)
})

test('an incomplete legacy original identity may recover for free but cannot authorize a purchase', async t => {
  const f = await fixture(t)
  await recordTaskStrict(f.outDir, 'Chapter_01.srt', {
    provider: 'genstudio', task_id: 'old-Chapter_01', input_hash: hashInput('input'), submitted_at: '2026-09-05T00:00:00Z',
  })
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  await assert.rejects(f.run(), /identity/)
  assert.equal(f.confirmations.length, 0)
})

test('a malformed commitment budget in valid JSON fails closed', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run())
  const file = path.join(f.outDir, '.subtitle-recovery.json')
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'))
  Object.values(ledger.plans).forEach((p: any) => p.attempts.push({ section: 'Chapter_00', quotedCredits: 'unavailable' }))
  await fs.writeFile(file, JSON.stringify(ledger))
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  await assert.rejects(f.run(), /ledger/)
  assert.equal(f.confirmations.length, 0)
})

test('expiry after a confirm was attempted reconciles its key before retiring any commitment', async t => {
  const f = await fixture(t)
  await setAppSetting('paid_subtitle_replacement', { enabled: true, additional_credit_ceiling: 5 })
  let first = true
  f.confirm(async () => {
    if (first) { first = false; return Response.json({ detail: 'quote expired' }, { status: 410 }) }
  })
  assert.equal((await f.run()).srt, srt)
  assert.equal(f.confirmations.length, 1, 'the key lookup must discover the already-created task')
})
