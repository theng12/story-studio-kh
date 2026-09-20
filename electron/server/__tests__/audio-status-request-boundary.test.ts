/**
 * The Audio Generator's section list must predict the SAME split generation
 * submits — the selected model's published request boundary less Story
 * Studio's head-room — and must never fall back to a chunk size of its own.
 *
 * The regression this pins: `services/audio-reconciler.ts` used to classify the
 * model by id prefix and only plan the GenStudio way when that said
 * 'genstudio'. Its inputs came from `config.audio_models`, which
 * `genStudioOnlyAudioModels()` always returns empty, so a published handle like
 * `fish-audio-s2-1-pro` fell through to `chunkText`'s 4,800-character default —
 * an ElevenLabs-era figure from a retired direct route. A 5,456-character
 * chapter was then shown as "0/2 chunks" while generation submitted it whole at
 * 22,500. Engine-sized chunking belongs to the fleet, not to this client: the
 * only length Story Studio may hold is the one the selected model publishes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveTtsRequestBudget } from '../services/tts-request-plan.js'
import { splitGenStudioApiRequests } from '../lib/genstudio-client.js'

const reconciler = readFileSync(new URL('../services/audio-reconciler.ts', import.meta.url), 'utf8')
const chunker = readFileSync(new URL('../lib/text-chunker.ts', import.meta.url), 'utf8')
const generator = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
const audit = readFileSync(new URL('../services/manifest-audit.ts', import.meta.url), 'utf8')
const ttsText = readFileSync(new URL('../lib/tts-text.ts', import.meta.url), 'utf8')

test('status planning holds no chunk size of its own', () => {
  // No import of the character chunker, and no bare numeric fallback.
  assert.doesNotMatch(reconciler, /from '\.\.\/lib\/text-chunker\.js'/)
  assert.doesNotMatch(reconciler, /\bchunkText\(/)
  assert.doesNotMatch(reconciler, /tts_soft_max_chars/)
  // The boundary comes from the one place that decides it.
  assert.match(reconciler, /resolveTtsRequestBudget\(ttsModel\)\.effective/)
})

test('the boundary is the published figure less head-room, not the published figure', () => {
  // Planning ON the published limit risks a rejection on part N after parts
  // 1..N-1 were already charged, so status must mirror the generator's
  // `effective` budget rather than `maximum_input_characters` itself.
  assert.equal(resolveTtsRequestBudget({ maximum_input_characters: 25000 }).effective, 22500)
  assert.doesNotMatch(reconciler, /splitGenStudioApiRequests\(sectionText, genStudioMaxCharacters\)/)
})

test('a Fish Audio S2.1 Pro chapter is one request, not two', () => {
  // The owner's DK0053 Chapter 25. Under the retired 4,800 default this split;
  // under Fish's published 25,000 less head-room it is a single billed job.
  const chapter = Array.from({ length: 62 }, (_, i) => `Sentence number ${i} of the chapter, written out at a realistic narration length so the paragraph packer sees prose.`).join(' ')
  assert.ok(chapter.length > 5000 && chapter.length < 22500, `fixture length ${chapter.length}`)
  const budget = resolveTtsRequestBudget({ maximum_input_characters: 25000 }).effective
  assert.equal(splitGenStudioApiRequests(chapter, budget).length, 1)
})

test('a model publishing a smaller ceiling still splits on its own figure', () => {
  // ElevenLabs v3 publishes 5,000 → 4,500 planned. The split must follow the
  // SELECTED model, so a shorter ceiling still divides the same chapter.
  const chapter = 'A '.repeat(4000)
  assert.equal(resolveTtsRequestBudget({ maximum_input_characters: 5000 }).effective, 4500)
  assert.equal(splitGenStudioApiRequests(chapter, 4500).length, 2)
})

test('the chunker has no length of its own — the boundary is always passed in', () => {
  // A default is what let callers inherit a figure nobody chose for their
  // model. `maxChars` is required so omitting it cannot compile.
  assert.doesNotMatch(chunker, /maxChars\s*=/)
  assert.doesNotMatch(chunker, /MAX_CHARS/)
  assert.match(chunker, /chunkText\(text: string, maxChars: number\)/)
})

test('no engine-internal chunk size is named anywhere in the TTS path', () => {
  // Story Studio may hold a PUBLISHED contract figure (a model's own
  // maximum_input_characters) but never an engine's internal section size.
  // These are the retired local engines whose caps used to live here.
  for (const source of [chunker, reconciler, generator, audit, ttsText]) {
    assert.doesNotMatch(source, /VoxCPM|F5-TTS|Orpheus|Bark\b/)
    assert.doesNotMatch(source, /tts_soft_max_chars/)
  }
})

test('the generator holds no per-provider chunk branch', () => {
  // Every non-GenStudio path was unreachable: resolveAudioProvider returns
  // 'genstudio' unconditionally. Removing them is what makes the required
  // boundary above enforceable.
  assert.doesNotMatch(generator, /chunkText\(/)
  assert.doesNotMatch(generator, /planRoutedSegments/)
  assert.doesNotMatch(generator, /ttsChunkCap/)
})

test('the manifest audit reads the shared planner instead of predicting again', () => {
  assert.doesNotMatch(audit, /chunkText/)
  assert.match(audit, /getAudioStatus\(slug, code, undefined, undefined, STRICT_IO\)/)
})

test('a caller that knows the selected model overrides remembered job history', () => {
  // The Audio Generator shows the split for the voice being chosen NOW.
  assert.match(reconciler, /selectedModelId\?: string/)
  assert.match(reconciler, /selectedModelId\?\.trim\(\)/)
})
