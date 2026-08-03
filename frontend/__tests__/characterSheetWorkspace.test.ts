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
// The config shape, defaults, and preset boundary moved out of the SFC so
// tests can import and exercise them — see continuityPresetPacing.test.ts.
const continuityConfig = source('../composables/useContinuityConfig.ts')

describe('Character Sheet workspace', () => {
  test('uses the compact visual anchors, style library, and scene rhythm flow without retired controls', () => {
    assert.match(characterSheet, /<h3>Visual anchors<\/h3>/)
    assert.match(characterSheet, /<h3>Visual art style<\/h3>/)
    assert.match(characterSheet, /<h3>Scene rhythm<\/h3>/)
    assert.match(characterSheet, /Episode visual anchor/)
    assert.doesNotMatch(characterSheet, />3\. Style reference</)
    assert.doesNotMatch(characterSheet, />4\. Continuity settings</)
    assert.doesNotMatch(characterSheet, /Guide character appearance/)
    assert.doesNotMatch(characterSheet, /Each scene references/)
    assert.doesNotMatch(characterSheet, /Variation per scene/)
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

  test('keeps uploaded episode anchors comfortably inspectable and synchronizes legacy sheet flags', () => {
    assert.match(characterSheet, /target="_blank"/)
    assert.match(characterSheet, /View full size/)
    assert.match(characterSheet, /object-fit: contain/)
    assert.match(characterSheet, /const episodeAnchorEnabled = computed/)
    assert.match(characterSheet, /config\.value\.references\.sheet = enabled/)
    assert.match(continuityConfig, /const useEpisodeSheet = value\?\.use_episode_sheet === true \|\| value\?\.references\?\.sheet === true/)
  })

  test('filters retired recipe and composition fields from saved configs and presets', () => {
    assert.match(continuityConfig, /export function normalizeContinuityConfig/)
    assert.doesNotMatch(continuityConfig, /references: \{[^}]*composition:/s)
    assert.doesNotMatch(continuityConfig, /interface ContinuityConfig \{[^}]*recipe:/s)
  })

  test('defaults new continuity sheets to dense one-to-four-second scenes', () => {
    assert.match(continuityConfig, /pacing: \{ min_sec: 1, max_sec: 4 \}/)
    assert.match(continuityRoute, /pacing: \{ min_sec: 1, max_sec: 4 \}/)
    assert.match(continuityRoute, /Number\(b\.pacing\?\.min_sec\) \|\| 1/)
    assert.match(continuityRoute, /Number\(b\.pacing\?\.max_sec\) \|\| 4/)
  })
})
