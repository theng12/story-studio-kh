import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { dialectForModel } from '../services/audio-expression.js'

/**
 * `dialectForModel` used to switch on retired direct-provider engine ids
 * (`eleven-v3`, `genaipro-v3`, `fishaudio-s2-pro`) that predate the
 * GenStudio-only gateway (v1.0.669). Story Studio's TTS route now only ever
 * passes a GenStudio tier id (`genstudio-tts-regular` / `-premium` /
 * `-clone`) as `model` — see `resolveStoryTtsModelId` in
 * services/project-manager.ts, which refuses anything else before a job is
 * created — and GenStudio publishes no per-tier/per-voice tag-dialect
 * capability to read instead. These pin the current, honest behaviour: null
 * for every model, including the retired literals, so nothing here silently
 * starts branching on a model name again (AGENTS.md's first rule).
 */
describe('dialectForModel — dead pending a published capability signal', () => {
  it('returns null for current Gateway TTS tier ids', () => {
    assert.equal(dialectForModel('genstudio-tts-regular'), null)
    assert.equal(dialectForModel('genstudio-tts-premium'), null)
    assert.equal(dialectForModel('genstudio-tts-clone'), null)
  })

  it('returns null for the retired direct-provider engine ids', () => {
    assert.equal(dialectForModel('eleven-v3'), null)
    assert.equal(dialectForModel('genaipro-v3'), null)
    assert.equal(dialectForModel('fishaudio-s2-pro'), null)
    assert.equal(dialectForModel('fishaudio-s2.1-pro'), null)
  })

  it('returns null for empty/missing input', () => {
    assert.equal(dialectForModel(undefined), null)
    assert.equal(dialectForModel(null), null)
    assert.equal(dialectForModel(''), null)
  })
})
