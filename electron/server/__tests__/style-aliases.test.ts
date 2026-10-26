/**
 * Tests for the custom-preset → Store-style alias table
 * (content-packs/style-aliases.ts).
 *
 * WHAT THIS TABLE IS. A fixed, owner-decided mapping from the preset ids the
 * owner's own channels already carry to the Store visual style that now owns
 * that look. It is read at resolution time and never written anywhere: no
 * preset, project config or user style pack is migrated by it.
 *
 * WHAT THESE TESTS PIN.
 *   - one preset id resolves to exactly one style, and never to itself;
 *   - the table stays in the Store namespace, so it can never claim an id the
 *     catalogue owns;
 *   - the ids the owner's channels actually carry are covered, including the
 *     ones that only ever existed inside the shared user style pack;
 *   - an unknown id resolves to nothing, which is the same answer as "no alias".
 *
 * The behavioural half — that a missing Store style falls back to the preset's
 * own prose instead of emptying it — lives in art-style-resolver.test.ts, where
 * the project-manager scaffolding already exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STYLE_ALIASES,
  ALIASED_PRESET_ID_COUNT,
  aliasedVisualStyleId,
} from '../content-packs/style-aliases.js'

const STYLE_NAMESPACE = 'com.storystudio.style.'

test('every preset id resolves to exactly one style and the table is internally consistent', () => {
  assert.ok(STYLE_ALIASES.length > 0)
  const seen = new Map<string, string>()
  for (const alias of STYLE_ALIASES) {
    assert.ok(alias.styleId.startsWith(STYLE_NAMESPACE), `${alias.styleId} is not a Store style id`)
    assert.ok(alias.presetIds.length > 0, `${alias.styleId} aliases no preset`)
    for (const presetId of alias.presetIds) {
      assert.match(presetId, /^[a-z0-9][a-z0-9.-]*$/, `${presetId} is not a plausible preset id`)
      assert.ok(!presetId.startsWith(STYLE_NAMESPACE),
        `${presetId} is already a Store id and must not be aliased`)
      const claimed = seen.get(presetId)
      assert.equal(claimed, undefined,
        `${presetId} is claimed by both ${claimed} and ${alias.styleId}`)
      seen.set(presetId, alias.styleId)
    }
  }
  assert.equal(ALIASED_PRESET_ID_COUNT, seen.size,
    'the exported count must be the number of distinct preset ids the table resolves')
})

test('the adopted styles are all reachable, and the merged and mapped ones point where the triage said', () => {
  const ADOPTED = [
    'carved-woodcut-print', 'lush-painterly-scenery', 'dark-moody-painterly',
    'vintage-copperplate-engraving', 'warm-cosy-interior-illustration',
    'storybook-stick-figure-cartoon', 'muted-isometric-infographic',
    'dark-folk-horror-gouache', 'stained-glass-panel-illustration',
    'clean-editorial-illustration', 'museum-diorama', 'cosy-night-pixel-art',
    'matte-gouache-storybook', 'naturalist-watercolour-plate',
    'painterly-prehistoric-life',
  ]
  for (const slug of ADOPTED) {
    assert.ok(
      STYLE_ALIASES.some(alias => alias.styleId === `${STYLE_NAMESPACE}${slug}`),
      `${slug} was adopted, so its old preset must resolve to it`,
    )
  }

  // Four separate presets were one picture: they must all land on the one style.
  for (const presetId of [
    'dreamlands', 'sleep-from-channel-type',
    'night-atlas-night-blue-watercolour', 'kh.art-styles.soft-luminous-watercolour',
  ]) {
    assert.equal(aliasedVisualStyleId(presetId), `${STYLE_NAMESPACE}dreamlike-luminous-sleep-illustration`,
      `${presetId} was merged into Dreamlike Luminous Sleep Illustration`)
  }

  // Two the triage merged into each other, and one that was only ever a pack style.
  assert.equal(aliasedVisualStyleId('kh.art-styles.golden-hour-painterly'),
    `${STYLE_NAMESPACE}lush-painterly-scenery`)
  assert.equal(aliasedVisualStyleId('kh.art-styles.dark-painterly-folk-horror'),
    `${STYLE_NAMESPACE}dark-folk-horror-gouache`)
  // Painterly Historical Oil was folded into the old-master oil contract.
  assert.equal(aliasedVisualStyleId('kh.art-styles.painterly-historical-oil'),
    `${STYLE_NAMESPACE}oil-painting-classical`)
})

test('every preset id the owner\'s channels carry is covered, project presets and pack styles alike', () => {
  // The 21 preset ids the 21 channels carry today (2026-10-25 audit), minus the
  // one that was skipped: its style is already served, so it has no alias.
  const PROJECT_PRESETS = [
    'dreamlands', 'dark-moody-painterly', 'painterly-prehistoric', 'cozy-bedtime-pixel-art',
    'night-atlas-woodcut', 'night-atlas-night-blue-watercolour', 'night-atlas-lush-painterly',
    'night-atlas-storybook-gouache', 'cosy-caf-illustration', 'vintage-engraving',
    'old-master-still-life', 'naturalist-painting-plate', 'builtin-prehistoric-stick-cartoon',
    'dark-psychology-from-channel-type', 'kh.art-styles.dark-painterly-folk-horror',
    'sleep-from-channel-type', 'bold-illustrated-history', 'animals-from-channel-type',
    'wildlife-field-comic', 'builtin-oil-painting-classical',
  ]
  for (const presetId of PROJECT_PRESETS) {
    assert.ok(aliasedVisualStyleId(presetId), `${presetId} carries no alias`)
  }
  // Nothing can silence a preset by giving it an alias to nothing.
  assert.equal(aliasedVisualStyleId('clean-whiteboard-illustration'), null,
    'the skipped style must keep its own prose, not resolve to a style')

  // ...and the pack-only styles, which never appear as a project preset.
  for (const packStyleId of [
    'kh.art-styles.clean-editorial-illustration',
    'kh.art-styles.museum-diorama',
    'kh.art-styles.muted-isometric-infographic',
    'kh.art-styles.stained-glass-inspired',
    'kh.art-styles.storybook-stick-figure-cartoon',
    'kh.owner.illustrated-history.bold-illustrated-history',
  ]) {
    assert.ok(aliasedVisualStyleId(packStyleId), `${packStyleId} carries no alias`)
  }
})

test('an id with no alias resolves to nothing, and nothing is never guessed', () => {
  assert.equal(aliasedVisualStyleId(null), null)
  assert.equal(aliasedVisualStyleId(undefined), null)
  assert.equal(aliasedVisualStyleId(''), null)
  assert.equal(aliasedVisualStyleId('   '), null)
  assert.equal(aliasedVisualStyleId('a-preset-the-owner-writes-tomorrow'), null)
  assert.equal(aliasedVisualStyleId(`${STYLE_NAMESPACE}quiet-anime-poetry`), null,
    'a Store id is resolved by the catalogue, never by this table')
})
