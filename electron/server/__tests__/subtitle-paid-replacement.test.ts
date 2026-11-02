import assert from 'node:assert/strict'
import test from 'node:test'

const base = {
  enabled: true,
  attempts: [] as any[],
  section: 'Chapter_02',
  originalTaskId: 'task-original',
  originalIdempotencyKey: 'story-original',
  inputHash: 'sha256:input',
  outputPath: '/subtitles/EP0001_Chapter_02.srt',
  failure: { transient: true, cancelled: false },
}

test('a cancelled or non-transient failure is never retried', async () => {
  const { decideSubtitleReplacement } = await import('../services/subtitle-paid-replacement.js')
  for (const failure of [
    { transient: false, cancelled: false },
    { transient: true, cancelled: true },
  ]) assert.equal(decideSubtitleReplacement({ ...base, failure }).action, 'blocked')
})

test('Off blocks retries; On commits up to maxRetries with exact physical submissions', async () => {
  const { decideSubtitleReplacement } = await import('../services/subtitle-paid-replacement.js')
  assert.equal(decideSubtitleReplacement({ ...base, enabled: false }).action, 'blocked')
  // Default or disabled retries only allow one additional attempt (ordinal 1)
  assert.equal(decideSubtitleReplacement(base).action, 'commit')
  // With retries set to 2, exactly 2 additional attempts (ordinals 1 and 2)
  const committed1 = decideSubtitleReplacement({ ...base, maxRetries: 2 })
  assert.equal(committed1.action, 'commit')
  if (committed1.action !== 'commit') throw new Error('expected commitment')
  assert.equal(committed1.attempt.replacementOrdinal, 1)
  const committed2 = decideSubtitleReplacement({
    ...base, maxRetries: 2, attempts: [committed1.attempt],
  })
  assert.equal(committed2.action, 'commit')
  if (committed2.action !== 'commit') throw new Error('expected commitment')
  assert.equal(committed2.attempt.replacementOrdinal, 2)
  // A third attempt is blocked when maxRetries is 2
  assert.equal(decideSubtitleReplacement({
    ...base, maxRetries: 2, attempts: [committed1.attempt, committed2.attempt],
  }).action, 'blocked')
  // Different sections are independent
  assert.equal(decideSubtitleReplacement({
    ...base, maxRetries: 2, attempts: [{ ...committed1.attempt, section: 'Chapter_01' }],
  }).action, 'commit')
})
