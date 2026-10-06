import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const settingsSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url)),
  'utf8',
)

// v1.4.257 — an implicit `auto` grid column let the storage table's min-width (760px)
// widen every settings card past the window at 1280px. The column must be shrinkable.
test('settings content column can shrink below its widest child (Free up space card fits the window)', () => {
  const rule = settingsSource.match(/^\.settings-content \{([^}]*)\}/m)?.[1] ?? ''
  assert.match(rule, /display:\s*grid/)
  assert.match(rule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(rule, /min-width:\s*0/)
})
