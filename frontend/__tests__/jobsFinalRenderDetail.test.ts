import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

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

function detail(state: string | undefined, enabled: boolean | null = true, paused: boolean | null = false, cancelled = false): string {
  const js = ts.transpileModule(`${extractFunction('finalRenderDetail')}\nreturn finalRenderDetail`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  const finalRenderDetail = new Function('privateFleetEnabled', 'queuePaused', js)({ value: enabled }, { value: paused })
  return finalRenderDetail(state === undefined ? {} : {
    final_render_wait: { state, cancellation_requested: cancelled, gateway_id_known: false, committed_at: null },
  })
}

test('each public final_render_wait state reads as plain fleet progress', () => {
  const expected: Record<string, string> = {
    intent_staged: 'Sending to the fleet',
    request_persisted: 'Sending to the fleet',
    send_may_start: 'Checking whether the fleet received it',
    send_unknown: 'Checking whether the fleet received it',
    remote_wait: 'Rendering on another Mac',
    output_ready: 'Importing the finished video',
    importing: 'Importing the finished video',
    imported: 'Importing the finished video',
    acknowledged: 'Importing the finished video',
    recovery_hold: 'Needs recovery',
  }
  for (const [state, text] of Object.entries(expected)) assert.equal(detail(state), text, state)
  assert.equal(detail(undefined), '', 'an ordinary job shows nothing')
  assert.equal(detail('intent_staged', null), 'Sending to the fleet', 'an unread setting claims nothing')
})

test('with the setting off, a staged or importing render says it needs recovery instead of looking busy', () => {
  for (const state of ['intent_staged', 'request_persisted', 'output_ready', 'importing', 'imported', 'acknowledged']) {
    assert.equal(detail(state, false), 'Needs recovery', state)
  }
  assert.equal(detail('remote_wait', false), 'Rendering on another Mac', 'accepted work is still watched')
  assert.equal(detail('send_unknown', false), 'Checking whether the fleet received it')
})

test('a paused queue says the render waits for it, except where cancellation still runs', () => {
  for (const state of ['intent_staged', 'request_persisted']) {
    assert.equal(detail(state, true, true), 'Paused — will send when the queue resumes', state)
  }
  for (const state of ['output_ready', 'importing', 'imported', 'acknowledged']) {
    assert.equal(detail(state, true, true), 'Paused — will import when the queue resumes', state)
  }
  assert.equal(detail('remote_wait', true, true), 'Rendering on another Mac', 'monitoring continues while paused')
  assert.equal(detail('importing', true, true, true), 'Importing the finished video', 'a cancelled import still settles')
  assert.equal(detail('intent_staged', false, true), 'Needs recovery', 'resuming the queue alone would not send it')
  assert.equal(detail('intent_staged', true, null), 'Sending to the fleet', 'an unknown queue state claims nothing')
})
