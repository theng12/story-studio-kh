import assert from 'node:assert/strict'
import test from 'node:test'

test('zero settlement cannot bypass refusal/cancellation or an unbalanced reservation', async () => {
  const { decideSubtitleReplacement } = await import('../services/subtitle-paid-replacement.js')
  const input = {
    enabled: true, ceiling: 5, attempts: [], section: 'Chapter_02', originalTaskId: 'original',
    originalIdempotencyKey: 'original-key', inputHash: 'sha256:input', outputPath: '/subtitles/chapter.srt',
    livePrice: { credits: 2, priceVersion: 'v1' },
    failure: { transient: true, cancelled: false, reservedCredits: 3, settledCredits: 2, releasedCredits: 0 },
  }
  assert.equal(decideSubtitleReplacement(input).action, 'blocked')
  for (const failure of [
    { transient: false, cancelled: false, reservedCredits: 3, settledCredits: 0, releasedCredits: 3 },
    { transient: true, cancelled: true, reservedCredits: 3, settledCredits: 0, releasedCredits: 3 },
  ]) assert.equal(decideSubtitleReplacement({ ...input, failure }).action, 'blocked')
})

test('subtitle replacement decisions fail closed and share one ceiling', async () => {
  const { decideSubtitleReplacement } = await import('../services/subtitle-paid-replacement.js')
  const base = {
    enabled: true,
    ceiling: 5,
    attempts: [],
    section: 'Chapter_02',
    originalTaskId: 'task-original',
    originalIdempotencyKey: 'story-original',
    inputHash: 'sha256:input',
    outputPath: '/subtitles/EP0001_Chapter_02.srt',
    failure: { transient: true, cancelled: false, reservedCredits: 3, settledCredits: 3, releasedCredits: 0 },
    livePrice: { credits: 3, priceVersion: 'transcription-v1' },
  }
  assert.equal(decideSubtitleReplacement({ ...base, enabled: false }).action, 'blocked')
  assert.equal(decideSubtitleReplacement({ ...base, failure: { ...base.failure, settledCredits: null } }).action, 'blocked')
  assert.equal(decideSubtitleReplacement({ ...base, failure: { ...base.failure, settledCredits: 0, releasedCredits: 3 } }).action, 'free-retry')
  assert.equal(decideSubtitleReplacement({ ...base, livePrice: null }).action, 'blocked')
  const committed = decideSubtitleReplacement(base)
  assert.equal(committed.action, 'commit')
  if (committed.action !== 'commit') throw new Error('expected commitment')
  assert.equal(committed.attempt.replacementOrdinal, 1)
  assert.equal(decideSubtitleReplacement({ ...base, attempts: [committed.attempt] }).action, 'blocked')
  assert.equal(decideSubtitleReplacement({ ...base, attempts: [{ ...committed.attempt, section: 'Chapter_01', quotedCredits: 3 }] }).action, 'blocked')
})
