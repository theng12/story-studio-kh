import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const settings = readFileSync(new URL('../pages/projects/[slug]/settings.vue', import.meta.url), 'utf8')

test('Settings gates ordinary and bulk final cleanup on exact usable-render proof', () => {
  assert.match(settings, /e\.cleanup_eligible\s*&&\s*\(e\.bytes_final_video/)
  assert.match(settings, /if \(!row\.cleanup_eligible\)/)
  assert.match(settings, /\{ force: !row\.cleanup_eligible \}/)
  assert.doesNotMatch(settings, /\{ force: !row\.uploaded_to_youtube \}/)
  assert.match(settings, /row\.cleanup_reason/)
  assert.match(settings, /v-if="row\.cleanup_eligible" class="upload-badge ok"/)
  assert.match(settings, /v-else-if="row\.uploaded_to_youtube"/)
  assert.match(settings, /recorded, not cleanup-safe/)
})
