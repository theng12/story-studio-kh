import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const settings = readFileSync(new URL('../pages/projects/[slug]/settings.vue', import.meta.url), 'utf8')

test('Settings offers final cleanup only as a verify-and-clear candidate action', () => {
  assert.match(settings, /e\.cleanup_eligible\s*&&\s*\(e\.bytes_final_video/)
  assert.match(settings, /v-if="row\.cleanup_eligible && \(row\.bytes_final_video > 0 \|\| row\.bytes_external_final_video > 0\)"/)
  assert.match(settings, /if \(!row\.cleanup_eligible\) return/)
  const cleanupRow = settings.slice(settings.indexOf('async function cleanupRow('), settings.indexOf('// v1.0.71: chunked-sidecar'))
  assert.ok(cleanupRow.startsWith('async function cleanupRow('))
  assert.doesNotMatch(cleanupRow, /\bforce\s*:/)
  assert.match(settings, /Verify & clear local video/)
  assert.match(settings, /Verify and clear local videos\?/)
  assert.match(settings, /SHA-256/)
  assert.match(settings, /Any file it cannot verify stays local and is reported below/)
  assert.match(settings, /row\.cleanup_reason/)
  assert.match(settings, /v-if="row\.cleanup_eligible" class="upload-badge ok"/)
  assert.match(settings, /v-else-if="row\.uploaded_to_youtube"/)
  assert.match(settings, /⚠ remains local/)
  assert.match(settings, /lastBulkCleanup\.items\.length/)
})
