import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

import { effectiveGenStudioTaskState } from '../../electron/server/contracts/provider-task-state.js'

const jobs = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)

function extractFunction(name: string): string {
  const start = jobs.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name}() must exist`)
  let depth = 0
  let body = false
  for (let i = start; i < jobs.length; i++) {
    if (jobs[i] === '{') { depth++; body = true }
    if (jobs[i] === '}') {
      depth--
      if (body && depth === 0) return jobs.slice(start, i + 1)
    }
  }
  throw new Error(`could not extract ${name}`)
}

function queueDetail(job: any): string {
  const source = `${extractFunction('formatGenStudioQueueEta')}\n${extractFunction('latestActiveGenStudioRequest')}\n${extractFunction('genStudioQueueDetail')}\nreturn genStudioQueueDetail`
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  return new Function('customerJobText', 'effectiveGenStudioTaskState', js)(
    (text: string) => text,
    effectiveGenStudioTaskState,
  )(job)
}

test('Jobs uses only current provider evidence for a provider queue position and ETA', () => {
  const detail = queueDetail({
    queue_position: 99,
    genstudio_jobs: [
      { state: 'running', queue_position: 8, queue_eta_seconds: 420, updated_at: '2026-09-09T09:00:00.000Z' },
      { state: 'accepted', queue_position: 2, queue_eta_seconds: 120, queue_reason: 'provider_pace', updated_at: '2026-09-09T10:00:00.000Z' },
    ],
  })
  assert.match(detail, /Waiting in the Gateway queue/)
  assert.match(detail, /provider queue position 2/)
  assert.match(detail, /Checking again in about 2 minutes/)
  assert.doesNotMatch(detail, /Estimated/, 'queue_eta_seconds is the gateway retry time, not a provider wait estimate')
  assert.match(detail, /pacing new requests/)
  assert.doesNotMatch(detail, /99|position 8|420/)
})

test('Jobs takes the newest active provider evidence even when it is earlier in the response array', () => {
  const detail = queueDetail({
    genstudio_jobs: [
      { state: 'accepted', queue_position: 3, updated_at: '2026-09-09T11:00:00.000Z' },
      { state: 'accepted', queue_position: 12, updated_at: '2026-09-09T10:00:00.000Z' },
    ],
  })
  assert.match(detail, /^Latest request:/)
  assert.match(detail, /position 3/)
  assert.doesNotMatch(detail, /position 12/)
})

test('Jobs clears provider queue copy once current evidence has no positive queue facts or is terminal', () => {
  const cleared = queueDetail({ genstudio_jobs: [{ state: 'running', queue_position: 0, queue_eta_seconds: null, updated_at: 'now' }] })
  assert.equal(cleared, 'The Gateway is generating.')

  const terminal = queueDetail({ genstudio_jobs: [{ state: 'succeeded', queue_position: 1, queue_eta_seconds: 90, updated_at: 'done' }] })
  assert.equal(terminal, '')

  const cancelled = queueDetail({ genstudio_jobs: [{ state: 'accepted', cancelled: true, queue_position: 1, updated_at: 'done' }] })
  assert.equal(cancelled, '')
})

test('Jobs distinguishes local handoff and Gateway admission without inventing a provider queue position', () => {
  assert.equal(queueDetail({ genstudio_jobs: [{ queue_state: 'waiting_local', updated_at: 'now' }] }), 'Waiting in Story Studio before it is sent.')
  assert.equal(queueDetail({ genstudio_jobs: [{ queue_state: 'waiting_account_capacity', updated_at: 'now' }] }), 'Waiting for a free slot at the Gateway.')
  assert.equal(queueDetail({ genstudio_jobs: [{ queue_state: 'accepted', updated_at: 'now' }] }), 'The Gateway accepted it; it is waiting its turn.')
  assert.match(jobs, /genStudioQueueDetail\(job\)/)
  assert.match(jobs, /remote\.queue_position/)
  assert.match(jobs, /remote\.queue_eta_seconds/)
})

test('Jobs shows a writing-model quota wait in plain words and clears it once work resumes', () => {
  const params = { quota_retry_at: '2026-09-15T08:00:00Z' }
  const job = { status: 'queued', params, genstudio_jobs: [{ state: 'failed' }] }
  assert.match(queueDetail(job), /used up its allowance for now/)
  assert.match(queueDetail(job), /Nothing was charged and finished work is kept/)
  assert.equal(queueDetail({ ...job, status: 'running' }), '')
  assert.equal(queueDetail({ ...job, params: { quota_retry_at: 'invalid' } }), '')
})

/**
 * E-11 (DS-07) — an unreadable queue status is unknown, not "running".
 *
 * `queuePaused` was a two-valued ref whose `catch` kept the last value, so a
 * failed `/system/queue/status` read rendered the queue as running — AGENTS.md
 * §6: "I could not work out the answer" must not share a value with "the
 * answer is none". The page now keeps `null` for unreadable and says so.
 */
test('Jobs renders an unreadable queue status as unknown, never as running', () => {
  assert.match(jobs, /const queuePaused = ref<boolean \| null>\(null\)/,
    'the queue state must have an explicit unknown value')
  const check = extractFunction('checkQueuePaused')
  assert.match(check, /catch\s*\{[\s\S]*?queuePaused\.value = null/,
    'a failed queue-status read must clear to unknown rather than keep the last answer')
  assert.match(jobs, /queueStateUnknown/, 'the page must derive an unknown state')
  assert.match(jobs, /queuePaused === true/, 'the paused banner must require a KNOWN paused state')
  assert.match(jobs, /Queue state could not be read/, 'the page must tell the user the state is unknown')
})

test('a job waiting for a free Mac says so with the next try time, and is never called stale for it', () => {
  const detail = queueDetail({
    genstudio_jobs: [{
      state: 'running', updated_at: '2026-09-30T09:00:00.000Z',
      waiting: { reason: 'No Mac is free', next_try_at: '2026-09-30T09:30:00.000Z', since: '2026-09-30T09:00:00.000Z' },
    }],
  })
  assert.match(detail, /^Waiting for a free Mac — next try \d{1,2}:\d{2}.* \(No Mac is free\)\.$/)
  assert.doesNotMatch(detail, /[Tt]he Gateway is generating/)
  // No next_try_at: the sentence still stands, with no invented time.
  assert.match(queueDetail({ genstudio_jobs: [{ state: 'running', waiting: { reason: null, next_try_at: null, since: null }, updated_at: 'now' }] }),
    /^Waiting for a free Mac\.$/)
  // Older gateway: no `waiting`, nothing changes.
  assert.equal(queueDetail({ genstudio_jobs: [{ state: 'running', updated_at: 'now' }] }), 'The Gateway is generating.')
  assert.match(jobs, /latestActiveGenStudioRequest\(job\)\?\.waiting\) return false/, 'is-stale colouring is suppressed while waiting')
})
