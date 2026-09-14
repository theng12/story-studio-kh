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
  assert.match(detail, /Waiting in the GenStudio provider queue/)
  assert.match(detail, /provider queue position 2/)
  assert.match(detail, /about 2 minutes/)
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
  assert.equal(cleared, 'GenStudio is generating.')

  const terminal = queueDetail({ genstudio_jobs: [{ state: 'succeeded', queue_position: 1, queue_eta_seconds: 90, updated_at: 'done' }] })
  assert.equal(terminal, '')

  const cancelled = queueDetail({ genstudio_jobs: [{ state: 'accepted', cancelled: true, queue_position: 1, updated_at: 'done' }] })
  assert.equal(cancelled, '')
})

test('Jobs distinguishes local handoff and GenStudio admission without inventing a provider queue position', () => {
  assert.equal(queueDetail({ genstudio_jobs: [{ queue_state: 'waiting_local', updated_at: 'now' }] }), 'Waiting in Story Studio before provider submission.')
  assert.equal(queueDetail({ genstudio_jobs: [{ queue_state: 'waiting_account_capacity', updated_at: 'now' }] }), 'Waiting for GenStudio account admission.')
  assert.equal(queueDetail({ genstudio_jobs: [{ queue_state: 'accepted', updated_at: 'now' }] }), 'GenStudio accepted the latest request; it is queued remotely.')
  assert.match(jobs, /genStudioQueueDetail\(job\)/)
  assert.match(jobs, /remote\.queue_position/)
  assert.match(jobs, /remote\.queue_eta_seconds/)
})

test('Jobs shows a local lineup availability wait and clears it once work resumes', () => {
  const params = { llm_lineup_retry_at: '2026-09-15T08:00:00Z' }
  const job = { status: 'queued', params, genstudio_jobs: [{ state: 'failed' }] }
  assert.match(queueDetail(job), /Waiting for model availability/)
  assert.match(queueDetail(job), /Completed work is kept/)
  assert.equal(queueDetail({ ...job, status: 'running' }), '')
  assert.equal(queueDetail({ ...job, params: { llm_lineup_retry_at: 'invalid' } }), '')
})
