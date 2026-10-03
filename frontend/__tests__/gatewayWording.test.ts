import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

// "GenStudio" is the paid cloud service and its credits. The Content Store is the Gateway's own
// private shelf (one owner, no purchases, same Gateway key), so its account is the Gateway's.
test('the dashboard footer sends credits and billing to the Usage page, not to "GenStudio"', () => {
  const page = read('../pages/projects/[slug]/index.vue')
  assert.match(page, /Credit balances and billing are on the Usage page\./)
  assert.doesNotMatch(page, /billing live in GenStudio/)
})

test('Content Store account wording names the Gateway', () => {
  for (const file of [
    '../pages/content-store.vue',
    '../pages/content-store/[productId].vue',
    '../components/content-store/ContentInstalledLibraryView.vue',
    '../composables/useFeatureGuide.ts',
  ]) {
    assert.doesNotMatch(read(file), /GenStudio account|Gateway owns for good|Checking with GenStudio/, file)
  }
})

test('Content Store asks for the Gateway key, not a "GenStudio API key"', () => {
  for (const rel of ['../../electron/server/services/content-store.ts', '../../electron/server/services/content-store-delivery.ts']) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    assert.doesNotMatch(src, /'Save a GenStudio API key/)
    assert.match(src, /Save your Gateway key in Settings → This Mac/)
  }
})
