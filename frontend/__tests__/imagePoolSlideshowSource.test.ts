import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/image-pool.vue', import.meta.url)), 'utf8')
const assembly = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url)), 'utf8')

test('Image Pool freezes the selection sidecar then persists the episode source', () => {
  assert.match(page, /\/image-pool\/pick/)
  assert.match(page, /visual-source\/\$\{encodeURIComponent\(episodeId\.value\)\}/)
  assert.match(page, /source: 'image_pool'/)
  assert.doesNotMatch(page, /\/image-pool\/materialize/)
  const pick = page.slice(page.indexOf('async function pickImagesForEpisode'))
  assert.ok(pick.indexOf("await put(`/projects/${slug.value}/video-editor/visual-source/") < pick.indexOf('lastLoad.value = { count'))
  assert.match(page, /watch\(\[slug, episodeId, poolId\]/)
})

test('Video Assembly exposes both visual sources and the pool summary', () => {
  assert.match(assembly, /v-model="visualSource" type="radio" value="scene_plan"/)
  assert.match(assembly, /v-model="visualSource" type="radio" value="image_pool"/)
  assert.match(assembly, /imagePoolSummary\.count/)
  assert.match(assembly, /imagePoolSummary\.seconds/)
  assert.match(assembly, /imagePoolSummary\.cycles/)
  assert.match(assembly, /imagePoolAvailability/)
  assert.match(assembly, /imagePoolNeedsRecovery/)
  assert.match(assembly, /role="alert"/)
})

test('episode changes clear source metadata before the fresh scoped load', () => {
  assert.match(assembly, /visualSource\.value = 'scene_plan'/)
  assert.match(assembly, /imagePoolSource\.value = null/)
  assert.match(assembly, /visualSourceSequence\+\+/)
  assert.match(assembly, /request !== visualSourceSequence/)
})
