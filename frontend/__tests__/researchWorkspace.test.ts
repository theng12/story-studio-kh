import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const research = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/research.vue', import.meta.url)),
  'utf8',
)

describe('Research workspace flow', () => {
  test('uses a compact brief, gather, and verify workflow', () => {
    assert.match(research, /class="research-flow-rail"/)
    assert.match(research, /> Brief</)
    assert.match(research, /> Gather</)
    assert.match(research, /> Verify</)
    assert.match(research, /title="Define what needs evidence"/)
  })

  test('keeps provider tuning and presets out of the primary brief', () => {
    assert.match(research, /label="Run settings and reusable preset"/)
    assert.match(research, /<ModelSelector v-model="form\.source_model"/)
    assert.match(research, /<PresetPicker/)
    assert.match(research, /Episode topics remain episode-specific/)
  })

  test('makes review completeness and Script handoff explicit', () => {
    assert.match(research, /research-review-score/)
    assert.match(research, /\{\{ reviewProgress \}\}%/)
    assert.match(research, /Only verified claims are passed into Script Generator/)
    assert.match(research, /Save review/)
    assert.match(research, /Sources in the video description/)
  })

  test('continues to describe Research as optional', () => {
    assert.match(research, /Research is optional/)
    assert.match(research, /Research stays optional and never blocks the production pipeline/)
  })
})
