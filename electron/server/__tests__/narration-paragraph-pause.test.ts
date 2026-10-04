/**
 * Pauses inside a chapter (owner 2026-10-04): all narration uses 1.5 s at a
 * paragraph break and 1.0 s after a sentence; a Series Formula may override
 * them per channel, the
 * Audio Generator sends them with every narration request — only to a model
 * that publishes them, clamped to its range — and a request without them is
 * byte-for-byte what it was (same idempotency key).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const { applyNicheToFormat } = await import('../services/format-loader.js')
const { parseContentPackDocument } = await import('../content-packs/schemas.js')
const { contentPackDocumentToNiche } = await import('../content-packs/legacy-adapters.js')
const { buildGenStudioSubmission, resolveTtsPauses } = await import('../lib/genstudio-client.js')

const PUBLISHED = [
  { name: 'paragraph_pause_sec' as const, minimum: 0, maximum: 3, default: 1.0 },
  { name: 'sentence_pause_sec' as const, minimum: 0, maximum: 3, default: 0.6 },
]

void test('no built-in formula overrides the uniform pauses (Sleep included); a formula that sets them does', async () => {
  const shell = JSON.parse(await fs.readFile(path.join(root, 'electron/server/formats/continuity-chain.json'), 'utf8'))
  const nicheDir = path.join(root, 'electron/server/niches')
  for (const file of (await fs.readdir(nicheDir)).filter(name => name.endsWith('.json'))) {
    const niche = JSON.parse(await fs.readFile(path.join(nicheDir, file), 'utf8'))
    assert.equal(applyNicheToFormat(shell, niche).script.narrationPauses, undefined, file)
  }
  const sleep = JSON.parse(await fs.readFile(path.join(nicheDir, 'sleep.json'), 'utf8'))
  assert.deepEqual(applyNicheToFormat(shell, { ...sleep, paragraphPauseSec: 1.5, sentencePauseSec: 0.8 }).script.narrationPauses,
    { paragraphSec: 1.5, sentenceSec: 0.8 })
})

void test('a signed formula carries paragraph_pause_sec / sentence_pause_sec (0-3 s) to the niche', async () => {
  const doc = JSON.parse(await fs.readFile(path.join(root, 'content-packs/free-starters/formula/sleep-story-v1.0.1/content/series-formula.json'), 'utf8'))
  const niche = contentPackDocumentToNiche(parseContentPackDocument('series-formula', { ...doc, paragraph_pause_sec: 1.2, sentence_pause_sec: 0.4 }) as any)
  assert.equal(niche.paragraphPauseSec, 1.2)
  assert.equal(niche.sentencePauseSec, 0.4)
  assert.throws(() => parseContentPackDocument('series-formula', { ...doc, paragraph_pause_sec: 5 }))
  assert.throws(() => parseContentPackDocument('series-formula', { ...doc, sentence_pause_sec: -1 }))
})

void test('pauses are sent only where the model publishes them, clamped to its range', () => {
  assert.deepEqual(resolveTtsPauses(PUBLISHED, { paragraph: 1, sentence: 0.3 }),
    { pauses: { paragraph_pause_sec: 1, sentence_pause_sec: 0.3 }, unsupported: [] })
  assert.deepEqual(resolveTtsPauses([{ ...PUBLISHED[0]!, maximum: 0.8 }], { paragraph: 1, sentence: 0.3 }),
    { pauses: { paragraph_pause_sec: 0.8 }, unsupported: ['sentence'] })
  // An older Hub: nothing is sent, and the caller is told so it can say it.
  assert.deepEqual(resolveTtsPauses(undefined, { paragraph: 1 }), { pauses: {}, unsupported: ['paragraph'] })
  // Nothing wanted: nothing sent, nothing to say.
  assert.deepEqual(resolveTtsPauses(PUBLISHED, {}), { pauses: {}, unsupported: [] })
})

void test('the body carries the pauses only when set, so every old key is unchanged', () => {
  const request = {
    modelId: 'model-alpha', voiceId: 'voice-alpha', text: 'One.\n\nTwo.', speed: 1,
    supportsSpeed: true, minimumSpeed: 0.5, maximumSpeed: 2, maxInputCharacters: 5_000,
    requestIdentity: 'demo:EP001:audio:Chapter_01_part1.mp3',
  }
  const plain = buildGenStudioSubmission(request)
  assert.equal(JSON.stringify(plain.body).includes('pause'), false)
  assert.equal(buildGenStudioSubmission({ ...request, pauses: {} }).idempotencyKey, plain.idempotencyKey)
  const sleep = buildGenStudioSubmission({ ...request, pauses: { paragraph_pause_sec: 1, sentence_pause_sec: 0.3 } })
  assert.equal(sleep.body.paragraph_pause_sec, 1)
  assert.equal(sleep.body.sentence_pause_sec, 0.3)
  assert.notEqual(sleep.idempotencyKey, plain.idempotencyKey)
})
