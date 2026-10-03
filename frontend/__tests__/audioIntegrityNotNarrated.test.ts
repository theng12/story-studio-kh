import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// A fresh episode showed "⚠ 12 of 12 audio files missing" + "Repair missing (12)"
// before anything was ever narrated (Dreamlands E2E, 2026-10-03).
test('Audio integrity: nothing narrated yet is neutral and offers no Repair', () => {
  const src = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(src, /v-else-if="audioStatus\.present === 0">\s*Not narrated yet/)
  assert.match(src, /v-if="audioStatus\.missing > 0 && audioStatus\.present > 0"/)
})
