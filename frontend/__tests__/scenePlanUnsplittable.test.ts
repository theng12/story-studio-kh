import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Dreamlands E2E 2026-10-03: "Repair 23 Out-of-Range Scenes" stayed offered after
// the server said those scenes cannot be split (only a toast said so).
test('Scene Plan replaces the Repair button with a plain note once the server says the scenes cannot be split', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url), 'utf8')
  assert.match(page, /v-if="overlongSceneCount && longScenesAllUnsplittable"/)
  assert.match(page, /<Popover v-else-if="overlongSceneCount" placement="top">/)
  assert.match(page, /noteUnsplittable\(e\?\.data\?\.unsplittable_count\)/)
  assert.match(page, /noteUnsplittable\(result\.unsplittable_count\)/)
  // Tied to the plan it measured: a rebuilt plan or a new pace offers Repair again.
  assert.match(page, /longScenePlanKey = computed\(\(\) => `\$\{episodeId\.value\}:\$\{plan\.value\?\.generated_at \|\| ''\}:\$\{overlongSceneCount\.value\}`\)/)
})
