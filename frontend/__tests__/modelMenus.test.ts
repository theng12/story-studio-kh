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
const imageGenerator = source('../pages/projects/[slug]/images.vue')
const voicePicker = source('../components/VoicePicker.vue')
const modelSelector = source('../components/ModelSelector.vue')
const transcriptionCatalog = source('../composables/useGenStudioTranscription.ts')

const modelSurfaces = {
  audio: source('../pages/projects/[slug]/audio.vue'),
  motion: source('../pages/projects/[slug]/motion-review.vue'),
  subtitles: source('../pages/projects/[slug]/subtitles.vue'),
  sceneReview: source('../pages/projects/[slug]/scene-review.vue'),
  broll: source('../pages/projects/[slug]/broll.vue'),
  imagePrompts: source('../pages/projects/[slug]/image-prompts.vue'),
  characters: source('../pages/projects/[slug]/characters.vue'),
  channelCharacters: source('../pages/character-library.vue'),
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
    assert.match(modelMenu, /badge\.title \|\| badge\.label/)
    assert.match(modelMenu, /catalogNoticeHref/)
    assert.match(modelMenu, /selectableOptionCount/)
  })

  test('the image picker exposes catalog errors and heals stale saved selections silently', () => {
    assert.match(imagePicker, /v-if="error"/)
    assert.match(imagePicker, /notice-error/)
    assert.match(imagePicker, /selectLiveGenStudioModel/)
    assert.doesNotMatch(imagePicker, /Unavailable saved selection|migration required|Historical/)
  })

  test('image-to-image is visibly coming soon and cannot restore an unsupported saved mode', () => {
    assert.match(imageGenerator, /Reference-image generation is coming soon\./)
    assert.match(imageGenerator, /:disabled="tab\.comingSoon"/)
    assert.match(imageGenerator, /if \(m === 'img2img'\) return/)
    assert.match(imageGenerator, /if \(mode === 'img2img'\) activeForm\.value\.image_mode = 'text2img'/)
  })

  test('image generation quality is automatic and never persists a manual step count', () => {
    assert.match(imageGenerator, /<strong>Automatic<\/strong>/)
    assert.match(imageGenerator, /imageGeneratorPresetForm/)
    assert.match(imageGenerator, /image_steps: _steps/)
    assert.doesNotMatch(imageGenerator, /v-model\.number="activeForm\.image_steps"/)
    assert.doesNotMatch(imageGenerator, /params\.image_steps/)
  })

  test('floating menus avoid clipped cards and stay inside the viewport', () => {
    assert.match(modelMenu, /<Teleport to="body">/)
    assert.match(modelMenu, /:style="panelStyle"/)
    assert.match(modelMenu, /position:\s*fixed/)
    assert.match(anchoredPanel, /getBoundingClientRect\(\)/)
    assert.match(anchoredPanel, /viewportWidth - width - gutter/)
    assert.match(anchoredPanel, /openAbove = below < 280 && above > below/)
    assert.match(imagePicker, /<ModelMenu/)
    assert.match(imagePicker, /badgeFor\(model\.unlimited_relaxed === true\)/)
    assert.match(modelSelector, /badgeFor\(model\.unlimited_relaxed === true\)/)
    assert.doesNotMatch(imagePicker, /<Teleport to="body">/)
    assert.match(voicePicker, /<Teleport to="body">/)
  })

  test('Voice Studio preserves Hub-owned clone identity in the picker', () => {
    assert.match(voicePicker, /voice_kind === 'studiohub-shared'/)
    assert.match(voicePicker, /`hubvoice:\$\{voice\.id\}`/)
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
    assert.match(modelSurfaces.channelCharacters, /title="Character vision model"/)
  })

  test('transcription keeps dispatch details internal and supports import instead of chapter timing synthesis', () => {
    for (const source of [modelSurfaces.subtitles, modelSurfaces.broll, transcriptionCatalog]) {
      assert.doesNotMatch(source, /single route|ready workers|no ready workers|Transcribe \(GenStudio\)|from-chapters/i)
    }
    assert.match(modelSurfaces.subtitles, /:generate-label="transcribeLabel"/)
    assert.match(modelSurfaces.subtitles, /title="Import subtitles"/)
    assert.doesNotMatch(modelSurfaces.subtitles, /title="Other methods"|From chapters/)
    assert.match(transcriptionCatalog, /disabled: !model\.available/)
    assert.match(transcriptionCatalog, /temporarily unavailable/)
  })

test('the format wizard no longer restores a hardcoded paid model list', () => {
    assert.match(modelSurfaces.formatWizard, /<ModelSelector/)
    assert.doesNotMatch(modelSurfaces.formatWizard, /<option value="gpt-4o"/)
    assert.match(modelSurfaces.formatWizard, /const model = ref\(''\)/)
  })
})

test('Character Sheet exposes strict visual-pacing presets with a custom range', () => {
  const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')
  assert.match(characterSheet, /Visual pacing/)
  assert.match(characterSheet, /1–3 seconds — Rapid & lively/)
  assert.match(characterSheet, /1–4 seconds — Lively storytelling/)
  assert.match(characterSheet, /2–8 seconds — Cinematic & robust/)
  assert.match(characterSheet, /5–10 seconds — Slow & deliberate/)
  assert.match(characterSheet, /Custom range…/)
  assert.match(characterSheet, /strict maximum/)
})
