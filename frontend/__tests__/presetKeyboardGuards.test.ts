import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const presetPicker = source('../components/PresetPicker.vue')
const topActionBar = source('../components/TopActionBar.vue')
const settings = source('../pages/projects/[slug]/settings.vue')
const scripts = source('../pages/projects/[slug]/scripts.vue')
const stylePreview = source('../components/StylePreviewCard.vue')
const imagePrompts = source('../pages/projects/[slug]/image-prompts.vue')

describe('preset modal keyboard guards', () => {
  test('Return confirms on key release and cannot leak into the opener', () => {
    for (const component of [presetPicker, topActionBar, settings, scripts, stylePreview, imagePrompts]) {
      assert.doesNotMatch(component, /@keydown\.enter(?:\.prevent)?="(?:confirmSaveAs|savePreset|confirmSaveCustomStyle|confirmSavePreset|saveStylePreset)"/)
      assert.match(component, /@keyup\.enter\.stop\.prevent="(?:confirmSaveAs|savePreset|confirmSaveCustomStyle|confirmSavePreset|saveStylePreset)"/)
    }
  })

  test('the shared async toolbar accepts only one save at a time and clears its draft', () => {
    assert.match(topActionBar, /if \(!name \|\| savingPreset\.value\) return/)
    assert.match(topActionBar, /newPresetName\.value = ''[\s\S]*showSaveAs\.value = false/)
    assert.match(topActionBar, /:disabled="!newPresetName\.trim\(\) \|\| savingPreset"/)
  })
})
