import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isFreeToRun } from '../utils/genstudio-price-usd.js'

test('a free voice is recognised from chargeable:false, a studio-hub provider, or local price', () => {
  assert.equal(isFreeToRun({ chargeable: false }), true)
  assert.equal(isFreeToRun({ chargeable: true, provider_id: 'studio-hub-local' }), true, 'gateway still says chargeable for Hub media rows')
  assert.equal(isFreeToRun({ chargeable: true, provider_id: 'studio-hub-a311' }), true)
  assert.equal(isFreeToRun({ price_source: 'local' }), true)
  assert.equal(isFreeToRun({ chargeable: true, provider_id: 'elevenlabs', price_source: 'provider' }), false)
  assert.equal(isFreeToRun(null), false)
})

test('Audio Generator hides quote and credit UI for a free voice', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(page, /const ttsIsFree = computed\(\(\) => isFreeToRun\(selectedTtsModel\.value\)\)/)
  assert.match(page, /<span v-if="!ttsIsFree" class="audio-context-item">\s*<small>\{\{ quotedCost \? 'Selected quote' : 'Rate' \}\}/)
  assert.match(page, /v-if="!ttsIsFree"\s*type="button"\s*class="btn btn-ghost"/)
  assert.match(page, /<p v-if="selectedTtsModel && ttsIsFree"[^>]*>\s*Cost: free\./)
  assert.match(page, /<div v-else-if="selectedTtsModel" class="form-group mb-2">\s*<label>\s*Cost/)
})
