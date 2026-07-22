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

  test('keeps presets in the shared command bar and run controls visible without a settings disclosure', () => {
    assert.match(research, /:presets="researchPresets"/)
    assert.match(research, /@preset-renamed="success\('Research preset renamed'\)"/)
    assert.match(research, /class="research-setup-surface"/)
    assert.match(research, /Tune the evidence run/)
    assert.match(research, /<ModelSelector v-model="form\.source_model"/)
    assert.doesNotMatch(research, /<PresetPicker/)
    assert.match(research, /Episode topics remain episode-specific/)
    assert.doesNotMatch(research, /label="Run settings and reusable preset"/)
    assert.doesNotMatch(research, /research_run_settings_open_/)
  })

  test('uses one fixed GenStudio LLM route without a provider selector', () => {
    assert.match(research, />GenStudio LLM</)
    assert.match(research, /Only published GenStudio LLM models appear here/)
    assert.match(research, /<ModelSelector v-model="form\.source_model"/)
    assert.doesNotMatch(research, /form\.source_provider/)
    assert.doesNotMatch(research, /v-for="src in sources"/)
    assert.doesNotMatch(research, /Perplexity \(direct\)/)
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
