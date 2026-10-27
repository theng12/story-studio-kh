/**
 * Audio page controls for narration takes (owner, 2026-10-26): reject a take
 * with a reason, restore it inside the three-day window, see who produced it,
 * and see a chapter that needs narration because its only take was rejected.
 *
 * Source assertions, in this repo's established style for page wiring: the
 * behaviour itself is pinned by the backend suites
 * (`audio-take-rejection.test.ts`, `audio-take-provenance.test.ts`,
 * `audio-merge-music-default.test.ts`); these pin that the page reaches it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const selector = readFileSync(fileURLToPath(new URL('../components/AudioChapterSelector.vue', import.meta.url)), 'utf8')
const merge = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)), 'utf8')
const pool = readFileSync(fileURLToPath(new URL('../components/MusicPoolPanel.vue', import.meta.url)), 'utf8')

test('a take can be rejected only with a reason, through the Audio page', () => {
  assert.match(selector, /\/reject-take`/)
  assert.match(selector, /placeholder="Why\? e\.g\. Khmer narration is gibberish"/)
  assert.match(selector, /:disabled="!rejectReason\.trim\(\) \|\| switchingTake"/)
  assert.match(selector, /Reject take/)
})

test('a rejected take offers Restore inside its window and Use This Version nowhere', () => {
  assert.match(selector, /\/restore-take`/)
  assert.match(selector, /v-if="take\.can_restore"[\s\S]{0,400}>Restore</)
  // The "Use This Version" button is on the v-else of the rejected branch.
  assert.match(selector, /<span v-if="take\.rejected" class="cs-pill pill-stale">Rejected<\/span>/)
  assert.match(selector, /v-else-if="take\.active"[\s\S]{0,900}v-else[\s\S]{0,900}Use This Version/)
  assert.match(selector, /Restorable until/)
})

test('a chapter whose take was rejected says it needs narration', () => {
  assert.match(selector, /v-if="s\.needs_narration"/)
  assert.match(selector, /Needs narration — \{\{ rejectedReason\(s\) \}\}\. Restore it in Versions, or generate this chapter again\./)
})

test('the producer of a take is shown read-only, and "not recorded" is said plainly', () => {
  assert.match(selector, /data-testid="take-provenance"/)
  assert.match(selector, /function describeProvenance\(/)
  assert.match(selector, /Engine: \$\{engine\}/)
  assert.match(selector, /Model: \$\{model\}/)
  assert.match(selector, /Voice: \$\{voice\}/)
  assert.match(selector, /Provider: \$\{provenance\.provider\}/)
  assert.match(selector, /Producer not recorded for this take\./)
  // No name-based reconstruction: the component never maps an id prefix to a provider.
  assert.doesNotMatch(selector, /startsWith\('fish|includes\('eleven|modelId\.split/)
})

test('the 3-day sweep is announced instead of a take silently vanishing', () => {
  assert.match(selector, /sweptNotice/)
  assert.match(selector, /moved to Story’s Trash on/)
})

test('an unset background music level starts at 6%, and a remembered/preset value still wins', () => {
  // The level is defined ONCE, in the contract the generator mixes with
  // (`contracts/music-bed-defaults.ts`); the page and the panel read it rather
  // than keeping their own copies, which is how 6% and 8% coexisted.
  assert.match(merge, /volume: DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT,/)
  assert.doesNotMatch(merge, /volume: 8,/)
  assert.match(merge, /6% \(about 24 dB under\)/)
  // The remembered form still carries the level, so a stored 8% is not overwritten.
  assert.match(merge, /useRememberedForm\('audio-merge-music'[\s\S]*?include: \['enabled', 'source', 'volume'/)
  assert.match(pool, /volume: DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT,/)
})
