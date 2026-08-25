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
    assert.doesNotMatch(scripts, /Normalize legacy narration/)
    assert.doesNotMatch(scripts, /label="Advanced options"/)
    assert.doesNotMatch(scripts, /scriptAdvancedExpanded/)
  })

  test('uses a Formula-owned narrator and only surfaces an opening when the Formula supplies one', () => {
    assert.match(scripts, /Formula narrator/)
    assert.match(scripts, /availableNarratorStyles/)
    assert.doesNotMatch(scripts, /A — Warm & intimate first-person/)
    assert.match(scripts, /v-if="openingProfile"/)
    assert.match(scripts, /Include \{\{ openingProfile\.label \}\}/)
    assert.match(scripts, /watch\(openingProfile/)
    assert.doesNotMatch(scripts, /🎬 Introduction/)
    assert.match(scripts, /Episode direction/)
  })

  test('names the model that will write the opening instead of leaving its absence unexplained', () => {
    // The opening deliberately has no picker of its own — it shares the
    // script's. Saying which model that is turns "I cannot pick a model
    // anywhere" into an answer, without adding a second control.
    assert.match(scripts, /class="opening-model-note"/)
    assert.match(scripts, /selectedChatModel\?\.display_name \|\| form\.model/)
    assert.match(scripts, /the same language model as the chapters/)
    // Exactly one language-model picker on this page.
    assert.equal(scripts.match(/<ModelSelector/g)?.length, 1)
  })

  test('has one review-first creation action instead of a competing one-click script chain', () => {
    assert.match(scripts, /generate-label="Create outline"/)
    assert.doesNotMatch(scripts, /⚡ Generate script/)
    assert.doesNotMatch(scripts, /Include introduction/)
    assert.doesNotMatch(scripts, /function generateScript\(/)
  })
})
