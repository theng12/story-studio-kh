import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')
const stylePicker = source('../components/StylePicker.vue')
const continuityRoute = source('../../electron/server/routes/continuity.ts')

describe('Character Sheet workspace', () => {
  test('ends at continuity settings without the retired Visual Recipe step', () => {
    assert.match(characterSheet, /<h3>4\. Continuity settings<\/h3>/)
    assert.doesNotMatch(characterSheet, />5\. Visual Recipe</)
    assert.doesNotMatch(characterSheet, /config\.recipe/)
    assert.doesNotMatch(characterSheet, /generateComposition|onCompositionFiles|removeComposition/)
  })

  test('uses built-in styles without project custom-style authoring', () => {
    assert.match(characterSheet, /:show-custom-styles="false"/)
    assert.match(stylePicker, /v-if="showCustomStyles !== false"/)
    assert.match(stylePicker, /showCustomStyles\?: boolean/)
    assert.match(characterSheet, /:active-style-bible="config\.style_bible"/)
  })

  test('filters retired recipe and composition fields from saved configs and presets', () => {
    assert.match(characterSheet, /function normalizeConfig/)
    assert.doesNotMatch(characterSheet, /references: \{[^}]*composition:/s)
    assert.doesNotMatch(characterSheet, /interface ContinuityConfig \{[^}]*recipe:/s)
  })

  test('defaults new continuity sheets to dense one-to-four-second scenes', () => {
    assert.match(characterSheet, /pacing: \{ min_sec: 1, max_sec: 4 \}/)
    assert.match(continuityRoute, /pacing: \{ min_sec: 1, max_sec: 4 \}/)
    assert.match(continuityRoute, /Number\(b\.pacing\?\.min_sec\) \|\| 1/)
    assert.match(continuityRoute, /Number\(b\.pacing\?\.max_sec\) \|\| 4/)
  })
})
