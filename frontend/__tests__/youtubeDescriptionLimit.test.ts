import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 2026-10-07 — the counter used to show characters against the formula's
// 2,500–4,000 cap. YouTube counts BYTES (5,000; Story Studio keeps 4,900), so a
// Khmer description read "1,900 / 2,500" while being 5,700 bytes.
const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/metadata.vue', import.meta.url)), 'utf8')

test('the description counter counts UTF-8 bytes against 4,900', () => {
  assert.match(page, /const DESCRIPTION_MAX_BYTES = 4900/)
  assert.match(page, /new TextEncoder\(\)\.encode\(preview\.description/)
  assert.match(page, /descriptionBytes\.toLocaleString\(\) \}\} \/ \{\{ DESCRIPTION_MAX_BYTES\.toLocaleString\(\) \}\} bytes/)
  assert.doesNotMatch(page, /descConfig/, 'no per-formula character cap remains')
  assert.doesNotMatch(page, /\bmax_chars: /, 'the page no longer sends a character cap')
})
