/**
 * Tests for the pure pieces of the kie.ai ElevenLabs TTS client
 * (lib/kie-tts-client.ts) — catalog-key → model mapping and the input shape
 * (standard TTS vs the text-to-dialogue-v3 array form).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { kieTtsModelFor, isKieTtsModel, buildKieTtsInput } from '../lib/kie-tts-client.js'

describe('kieTtsModelFor', () => {
  test('maps catalog keys to kie model strings', () => {
    assert.equal(kieTtsModelFor('kie-eleven-turbo-v2.5'), 'elevenlabs/text-to-speech-turbo-2-5')
    assert.equal(kieTtsModelFor('kie-eleven-multilingual-v2'), 'elevenlabs/text-to-speech-multilingual-v2')
    assert.equal(kieTtsModelFor('kie-eleven-v3'), 'elevenlabs/text-to-dialogue-v3')
  })
  test('unknown / undefined → undefined; isKieTtsModel reflects it', () => {
    assert.equal(kieTtsModelFor('eleven_turbo_v2_5'), undefined)
    assert.equal(kieTtsModelFor(undefined), undefined)
    assert.equal(isKieTtsModel('kie-eleven-v3'), true)
    assert.equal(isKieTtsModel('turbo-v2.5'), false)
  })
})

describe('buildKieTtsInput', () => {
  test('standard TTS → {text, voice} + optional settings', () => {
    const input = buildKieTtsInput('elevenlabs/text-to-speech-turbo-2-5', 'hello', {
      voiceId: 'VOICE1', stability: 0.5, similarity: 0.75, style: 0.1, speed: 1.1,
    })
    assert.equal(input.text, 'hello')
    assert.equal(input.voice, 'VOICE1')
    assert.equal(input.stability, 0.5)
    assert.equal(input.similarity_boost, 0.75) // mapped name
    assert.equal(input.style, 0.1)
    assert.equal(input.speed, 1.1)
    assert.ok(!('dialogue' in input))
  })

  test('v3 → dialogue array of a single {text, voice} turn', () => {
    const input = buildKieTtsInput('elevenlabs/text-to-dialogue-v3', 'a line', { voiceId: 'V2', stability: 0.4 })
    assert.deepEqual(input.dialogue, [{ text: 'a line', voice: 'V2' }])
    assert.equal(input.stability, 0.4)
    assert.ok(!('text' in input))
  })

  test('omits undefined numeric settings (no NaN leakage)', () => {
    const input = buildKieTtsInput('elevenlabs/text-to-speech-multilingual-v2', 'x', { voiceId: 'V' })
    assert.deepEqual(Object.keys(input).sort(), ['text', 'voice'])
  })
})
