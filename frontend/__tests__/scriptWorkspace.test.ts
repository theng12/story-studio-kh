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

  test('uses a Formula-owned narrator', () => {
    assert.match(scripts, /Formula narrator/)
    assert.match(scripts, /availableNarratorStyles/)
    assert.doesNotMatch(scripts, /A — Warm & intimate first-person/)
    assert.match(scripts, /Episode direction/)
  })

  test('the channel opening is no longer configured on this page at all', () => {
    // v1.4.73 — it was a checkbox on the Outline tab, gated on the niche's
    // `openingProfile`, which one niche of twenty-one declares. Seven of ten
    // channels had no control and no explanation. It is its own optional
    // stage now; see introductionSidebarStage.test.ts for the rendered proof.
    assert.doesNotMatch(scripts, /v-if="openingProfile"/,
      'the niche must not gate a control again')
    assert.doesNotMatch(scripts, /Include \{\{ openingProfile\.label \}\}/)
    assert.doesNotMatch(scripts, /watch\(openingProfile/,
      'nothing may reset the channel\'s answer on a context reload')
    assert.doesNotMatch(scripts, /class="opening-model-note"/)
    assert.doesNotMatch(scripts, /🎬 Introduction/)
    // Exactly one language-model picker on this page, as before.
    assert.equal(scripts.match(/<ModelSelector/g)?.length, 1)
  })

  test('the Introduction page owns the opening\u2019s model choice, not this one', () => {
    // REVERSES the v1.4.73 rule that used to be asserted here.
    //
    // The opening shipped with no picker at all, on the reasoning that one
    // language-model choice is easier to trust than two that can disagree.
    // The owner overruled it: "what is the model picker not added. i don't
    // care if it's the same model or a different model writing it."
    //
    // So the choice exists on the Introduction page, and the DEFAULT is still
    // the shared one — a blank saved model means "follow the Script
    // Generator", which is what every channel already had. The Script page
    // still keeps exactly one picker: this is not a second control here.
    const page = readFileSync(
      fileURLToPath(new URL('../pages/projects/[slug]/introduction.vue', import.meta.url)), 'utf8')
    assert.match(page, /<ModelSelector/, 'the owner asked for the picker; it must exist')
    assert.match(page, /The same one as the chapters/,
      'and the shared model must still be offered as the default choice')
    assert.equal(scripts.match(/<ModelSelector/g)?.length, 1,
      'the Script Generator still has exactly one picker of its own')
  })

  test('has one review-first creation action instead of a competing one-click script chain', () => {
    assert.match(scripts, /generate-label="Create outline"/)
    assert.doesNotMatch(scripts, /⚡ Generate script/)
    assert.doesNotMatch(scripts, /Include introduction/)
    assert.doesNotMatch(scripts, /function generateScript\(/)
  })
})
