import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('the retired Brand profile system stays removed from backend contracts and routing', () => {
  const routing = source('../routes/index.ts')
  const contracts = source('../contracts/index.ts')
  const models = source('../models/types.ts')

  assert.doesNotMatch(routing, /brandsRouter|\.\/brands\.js/)
  assert.doesNotMatch(contracts, /brand_id|BrandSchema|SetProjectBrand/)
  assert.doesNotMatch(models, /brand_id|export interface Brand\b|BrandPronunciation/)
})

test('the retired Brand profile system stays removed from project UI and generators', () => {
  const home = source('../../../frontend/pages/index.vue')
  const settings = source('../../../frontend/pages/projects/[slug]/settings.vue')
  const aiClient = source('../lib/ai-client.ts')
  const episodeGenerator = source('../generators/episode.ts')

  assert.doesNotMatch(home, /to=["']\/brands["']/)
  assert.doesNotMatch(settings, /useBrands|brand_id/)
  assert.doesNotMatch(aiClient, /brand-loader|brand-prompt|getEffectiveBrand/)
  assert.doesNotMatch(episodeGenerator, /brand-loader|brand-prompt|getEffectiveBrand/)
})
