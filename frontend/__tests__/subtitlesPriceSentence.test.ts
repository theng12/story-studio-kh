import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isFreeToRun } from '../utils/genstudio-price-usd'

const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/subtitles.vue', import.meta.url)), 'utf8')

test('Subtitles warns about a possible charge only when the model is not free', () => {
  assert.match(page, /<template v-if="!isFreeToRun\(genstudioSelectedModel\)">, so the model's current price may be charged<\/template>/)
  assert.doesNotMatch(page, /is a new request, so the model's current price may be charged\./)
  // A fleet model is free; a paid cloud model and an unknown model keep the warning.
  assert.equal(isFreeToRun({ price_source: 'local' }), true)
  assert.equal(isFreeToRun({ chargeable: true, price_source: 'provider' }), false)
  assert.equal(isFreeToRun(null), false)
})
