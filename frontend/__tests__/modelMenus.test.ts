import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const modelMenu = source('../components/ModelMenu.vue')
const anchoredPanel = source('../composables/useAnchoredPanel.ts')
const imagePicker = source('../components/ImageModelPicker.vue')
const voicePicker = source('../components/VoicePicker.vue')
const modelSelector = source('../components/ModelSelector.vue')

const modelSurfaces = {
  audio: source('../pages/projects/[slug]/audio.vue'),
  motion: source('../pages/projects/[slug]/motion-review.vue'),
  subtitles: source('../pages/projects/[slug]/subtitles.vue'),
  sceneReview: source('../pages/projects/[slug]/scene-review.vue'),
  broll: source('../pages/projects/[slug]/broll.vue'),
  imagePrompts: source('../pages/projects/[slug]/image-prompts.vue'),
  characters: source('../pages/projects/[slug]/characters.vue'),
  formatWizard: source('../components/FormatFromSampleWizard.vue'),
}

describe('shared model menus', () => {
  test('the floating menu is searchable, grouped, accessible, and readable', () => {
    assert.match(modelMenu, /<Teleport to="body">/)
    assert.match(modelMenu, /type="search"/)
    assert.match(modelMenu, /role="listbox"/)
    assert.match(modelMenu, /role="option"/)
    assert.match(modelMenu, /-webkit-line-clamp:\s*2/)
    assert.match(modelMenu, /overflow-wrap:\s*anywhere/)
  })

  test('floating menus avoid clipped cards and stay inside the viewport', () => {
    assert.match(anchoredPanel, /getBoundingClientRect\(\)/)
    assert.match(anchoredPanel, /viewportWidth - width - gutter/)
    assert.match(anchoredPanel, /openAbove = below < 280 && above > below/)
    assert.match(imagePicker, /<Teleport to="body">/)
    assert.match(voicePicker, /<Teleport to="body">/)
  })

  test('LLM, image, TTS, video, and transcription surfaces use shared menus', () => {
    assert.match(modelSelector, /<ModelMenu/)
    assert.match(modelSurfaces.audio, /media-type="tts"/)
    assert.match(modelSurfaces.motion, /media-type="video"/)
    assert.match(modelSurfaces.subtitles, /media-type="transcription"/)
    assert.match(modelSurfaces.broll, /media-type="transcription"/)
    assert.match(modelSurfaces.sceneReview, /<ImageModelPicker/)
    assert.match(modelSurfaces.sceneReview, /<ModelSelector[^>]+label="Rewrite LLM"/)
    assert.match(modelSurfaces.imagePrompts, /title="Reference analysis model"/)
    assert.match(modelSurfaces.characters, /title="Character vision model"/)
  })

  test('the format wizard no longer restores a hardcoded paid model list', () => {
    assert.match(modelSurfaces.formatWizard, /<ModelSelector/)
    assert.doesNotMatch(modelSurfaces.formatWizard, /<option value="gpt-4o"/)
    assert.match(modelSurfaces.formatWizard, /const model = ref\(''\)/)
  })
})
