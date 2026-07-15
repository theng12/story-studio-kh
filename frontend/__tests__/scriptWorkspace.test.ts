import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const scripts = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)),
  'utf8',
)

describe('Script Generator workspace', () => {
  test('keeps regeneration controls visible without an advanced disclosure', () => {
    assert.match(scripts, /class="script-regeneration-controls"/)
    assert.match(scripts, /<strong>Force regenerate<\/strong>/)
    assert.match(scripts, /Normalize legacy narration/)
    assert.doesNotMatch(scripts, /label="Advanced options"/)
    assert.doesNotMatch(scripts, /scriptAdvancedExpanded/)
  })
})
