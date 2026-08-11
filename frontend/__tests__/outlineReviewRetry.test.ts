import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../components/OutlineReviewPanel.vue', import.meta.url)),
  'utf8',
)

function productionRetrySelector(jobs: any[], episodeId = 'EP001'): () => any | undefined {
  const match = source.match(/function terminalExpansionRetryJob\(\): any \| undefined \{([\s\S]*?)\n\}/)
  assert.ok(match, 'OutlineReviewPanel must expose the terminal retry selector')
  const executableBody = match[1]
    .replace(/\((job|entry|a|b): any\)/g, '($1)')
    .replace(/\((a|b): any, (a|b): any\)/g, '($1, $2)')
  return new Function('jobs', 'props', `return function () {${executableBody}\n}`)(
    { value: jobs },
    { episodeId },
  )
}

function expansionJob(input: {
  id: string
  finishedAt: string
  evidence: Array<{ id: unknown; state: string }>
}) {
  return {
    job_id: input.id,
    project_slug: 'history',
    episode_id: 'EP001',
    type: 'expand_chapters',
    status: 'error',
    created_at: input.finishedAt,
    finished_at: input.finishedAt,
    genstudio_jobs: input.evidence.map(entry => ({
      ...entry,
      operation: 'chat.response',
    })),
  }
}

test('Script Resume prioritizes unresolved terminal evidence before a newer settled failure', () => {
  const olderUnresolved = expansionJob({
    id: 'older-unresolved',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: 'pending:story-chat-old', state: 'submitting' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderUnresolved, newerSettled])()?.job_id,
    'older-unresolved',
  )
})

test('Script Resume uses the newest terminal failure after all evidence resolves', () => {
  const olderSettled = expansionJob({
    id: 'older-settled',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: 'job-old', state: 'failed' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderSettled, newerSettled])()?.job_id,
    'newer-settled',
  )
})

test('Script Resume treats a terminal chat without a real job id as unresolved', () => {
  const olderMissingId = expansionJob({
    id: 'older-missing-id',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: '', state: 'failed' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderMissingId, newerSettled])()?.job_id,
    'older-missing-id',
  )
})

test('Script Resume treats a malformed non-string job id as unresolved', () => {
  const olderMalformedId = expansionJob({
    id: 'older-malformed-id',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: 123, state: 'failed' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderMalformedId, newerSettled])()?.job_id,
    'older-malformed-id',
  )
})
