import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)),
  'utf8',
)

test('keeps Audio Assembly mix settings visible and compact', () => {
  assert.match(page, /class="card mt-2 audio-mix-card"/)
  assert.match(page, /Voice, pacing, and optional layers/)
  assert.match(page, /class="audio-mix-section audio-mix-section--voice"/)
  assert.match(page, /class="compact-toggle"/)
  assert.match(page, /class="merge-output-status mt-2"/)
  assert.doesNotMatch(page, /<AdvancedDisclosure/)
  assert.doesNotMatch(page, /audio_merge_advanced_open/)
})
