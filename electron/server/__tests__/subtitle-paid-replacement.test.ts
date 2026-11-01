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
  livePrice: { credits: 3, priceVersion: 'transcription-v1' },
}

test('a cancelled or non-transient failure is never bought, whatever else is true', async () => {
  const { decideSubtitleReplacement } = await import('../services/subtitle-paid-replacement.js')
  for (const failure of [
    { transient: false, cancelled: false },
    { transient: true, cancelled: true },
  ]) assert.equal(decideSubtitleReplacement({ ...base, failure }).action, 'blocked')
})

test('the switch alone decides: Off blocks, On commits with no ceiling in the way', async () => {
  const { decideSubtitleReplacement } = await import('../services/subtitle-paid-replacement.js')
  assert.equal(decideSubtitleReplacement({ ...base, enabled: false }).action, 'blocked')
  assert.equal(decideSubtitleReplacement({ ...base, livePrice: null }).action, 'blocked')
  const committed = decideSubtitleReplacement(base)
  assert.equal(committed.action, 'commit')
  if (committed.action !== 'commit') throw new Error('expected commitment')
  assert.equal(committed.attempt.replacementOrdinal, 1)
  assert.equal(committed.attempt.quotedCredits, 3)
  assert.equal(committed.attempt.priceVersion, 'transcription-v1')
  // One attempt per section, no matter how cheap the next quote is.
  assert.equal(decideSubtitleReplacement({ ...base, attempts: [committed.attempt] }).action, 'blocked')
  assert.equal(decideSubtitleReplacement({
    ...base, attempts: [{ ...committed.attempt, section: 'Chapter_01' }],
  }).action, 'commit')
})
