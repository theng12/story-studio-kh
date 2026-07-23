import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const presetPicker = source('../components/PresetPicker.vue')
const topActionBar = source('../components/TopActionBar.vue')
const settings = source('../pages/projects/[slug]/settings.vue')
const scripts = source('../pages/projects/[slug]/scripts.vue')
const imagePrompts = source('../pages/projects/[slug]/image-prompts.vue')
const usePresets = source('../composables/usePresets.ts')
const systemRoutes = source('../../electron/server/routes/system.ts')

describe('preset modal keyboard guards', () => {
  test('Return confirms on key release and cannot leak into the opener', () => {
    for (const component of [presetPicker, topActionBar, settings, scripts, imagePrompts]) {
      assert.doesNotMatch(component, /@keydown\.enter(?:\.prevent)?="(?:confirmSaveAs|savePreset|confirmSaveCustomStyle|confirmSavePreset|saveStylePreset)"/)
      assert.match(component, /@keyup\.enter\.stop\.prevent="(?:confirmSaveAs|confirmRename|savePreset|confirmSaveCustomStyle|confirmSavePreset|saveStylePreset)"/)
    }
  })

  test('the shared async toolbar accepts only one save at a time and clears its draft', () => {
    assert.match(topActionBar, /if \(!name \|\| savingPreset\.value\) return/)
    assert.match(topActionBar, /newPresetName\.value = ''[\s\S]*showSaveAs\.value = false/)
    assert.match(topActionBar, /:disabled="!newPresetName\.trim\(\) \|\| savingPreset"/)
  })

  test('the shared toolbar renames the active preset in place with the same keyboard guard', () => {
    assert.match(topActionBar, />Rename<\/button>/)
    assert.match(topActionBar, /@keyup\.enter\.stop\.prevent="confirmRename"/)
    assert.match(topActionBar, /await props\.presets\?\.rename\(name\)/)
    assert.match(topActionBar, /emit\('preset-renamed'\)/)
  })

  test('preset storage exposes one local list without device or cloud scope controls', () => {
    for (const component of [presetPicker, topActionBar, usePresets]) {
      assert.doesNotMatch(component, /showAllDevices|crossDeviceCount|activePresetIsCrossDevice/)
      assert.doesNotMatch(component, /All devices|This device/)
    }

    assert.doesNotMatch(systemRoutes, /system\/machine-label/)
    assert.equal(
      existsSync(fileURLToPath(new URL('../composables/useMachineLabel.ts', import.meta.url))),
      false,
      'the retired machine-label composable must not return',
    )
  })

  test('the split prompt workspace hydrates both canonical preset stores', () => {
    assert.match(imagePrompts, /thumbnailPresets\.load\(\)/)
    assert.match(imagePrompts, /scenePresets\.load\(\)/)
  })
})
