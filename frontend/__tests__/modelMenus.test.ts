import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const modelMenu = source('../components/ModelMenu.vue')
const pickerDialog = source('../components/PickerDialog.vue')
const modal = source('../components/Modal.vue')
const imagePicker = source('../components/ImageModelPicker.vue')
const imageGenerator = source('../pages/projects/[slug]/images.vue')
const voicePicker = source('../components/VoicePicker.vue')
const modelSelector = source('../components/ModelSelector.vue')
const transcriptionCatalog = source('../composables/useGenStudioTranscription.ts')
const imageCatalog = source('../composables/useGenStudioImageModels.ts')
const appSettings = source('../../electron/server/routes/app-settings.ts')

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
  test('the model dialog is searchable, grouped, accessible, and readable', () => {
    assert.match(modelMenu, /<PickerDialog/)
    assert.match(modelMenu, /type="search"/)
    assert.match(modelMenu, /role="listbox"/)
    assert.match(modelMenu, /role="option"/)
    // Groups are announced as groups instead of being bare headings in a listbox.
    assert.match(modelMenu, /role="group"\s+:aria-label="group\.label"/)
    assert.match(modelMenu, /-webkit-line-clamp:\s*2/)
    assert.match(modelMenu, /overflow-wrap:\s*anywhere/)
    assert.match(modelMenu, /badge\.title \|\| badge\.label/)
    assert.match(modelMenu, /catalogNoticeHref/)
    assert.match(modelMenu, /selectableOptionCount/)
    // Every published fact the anchored panel carried still renders.
    assert.match(modelMenu, /option\.meta \|\| option\.description/)
    assert.match(modelMenu, /option\.disabledReason/)
    assert.match(modelMenu, /\{\{ catalogNotice \}\}/)
  })

  test('the image picker exposes catalog errors and heals stale saved selections silently', () => {
    assert.match(imagePicker, /v-if="error"/)
    assert.match(imagePicker, /notice-error/)
    assert.match(imagePicker, /selectLiveGenStudioModel/)
    assert.doesNotMatch(imagePicker, /Unavailable saved selection|migration required|Historical/)
  })

  test('customer model menus expose one GenStudio KH boundary without execution topology', () => {
    for (const source of [
      imagePicker,
      modelSelector,
      transcriptionCatalog,
      modelSurfaces.audio,
      modelSurfaces.motion,
    ]) {
      assert.match(source, /GenStudio KH/)
      assert.doesNotMatch(source, /provider:\s*model\.execution_label|provider:\s*'GenStudio'/)
    }
    assert.doesNotMatch(imagePicker, /model\.execution_label|model\.description/)
    assert.doesNotMatch(imageCatalog, /execution_label/)
    // AGENTS.md → "Provider Transparency" (2026-08-01) reversed the old masking:
    // what GenStudio publishes about who serves a product now reaches the
    // customer. No catalogue route may delete those fields on the way out.
    assert.doesNotMatch(appSettings, /withoutProviderIdentity|PRIVATE_PROVIDER_IDENTITY_FIELDS/)
    // Transparency is DISPLAY only. Story Studio still never selects a provider
    // and never sends one on a generation request.
    assert.doesNotMatch(appSettings, /provider_id:\s*(?!.*req\.params)/)
  })

  test('thumbnail generator enables reference guidance only for qualified GenStudio models', () => {
    assert.doesNotMatch(imageGenerator, /Reference-image generation is coming soon\./)
    assert.doesNotMatch(imageGenerator, /:disabled="tab\.comingSoon"/)
    assert.match(imageGenerator, /thumbnailReferenceActive \? 'img2img' : 'text2img'/)
    assert.match(imageGenerator, /thumbnail_reference_asset/)
    assert.match(imagePicker, /supports_reference_images/)
    assert.match(imagePicker, /max_reference_images/)
    assert.match(imagePicker, /chargeable/)
  })

  test('image generation quality is automatic and never persists a manual step count', () => {
    assert.match(imageGenerator, /<strong>Automatic<\/strong>/)
    assert.match(imageGenerator, /imageGeneratorPresetForm/)
    assert.match(imageGenerator, /image_steps: _steps/)
    assert.doesNotMatch(imageGenerator, /v-model\.number="activeForm\.image_steps"/)
    assert.doesNotMatch(imageGenerator, /params\.image_steps/)
  })

  test('pickers open as centred dialogs sized by the viewport, not by the trigger', () => {
    // A trigger low in the window used to leave the list a few hundred pixels
    // tall. Nothing may measure the trigger any more.
    assert.doesNotMatch(modelMenu, /panelStyle|getBoundingClientRect/)
    assert.doesNotMatch(voicePicker, /panelStyle|getBoundingClientRect/)
    assert.match(modelMenu, /<PickerDialog/)
    assert.match(voicePicker, /<PickerDialog/)
    // Sized by the viewport, capped, and scrolling internally.
    assert.match(pickerDialog, /max-height:\s*min\(760px,\s*calc\(100dvh - 40px\)\)/)
    assert.match(pickerDialog, /max-height:\s*calc\(100dvh - 20px\)/)
    assert.match(modelMenu, /\.model-menu-list\s*{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/)
    assert.match(voicePicker, /\.vp-list\s*{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/)
    // Above every other dialog and above the toast stack (2500).
    assert.match(pickerDialog, /zIndex: 2600/)
    assert.match(imagePicker, /<ModelMenu/)
    assert.match(imagePicker, /badgeFor\(model\.unlimited_relaxed === true\)/)
    assert.match(modelSelector, /badgeFor\(model\.unlimited_relaxed === true\)/)
    assert.doesNotMatch(imagePicker, /<Teleport to="body">/)
  })

  test('the picker dialog carries real dialog semantics and keyboard handling', () => {
    // Teleport, backdrop dismissal, Escape, focus trap and focus restore all
    // come from the shared Modal primitive rather than a second copy.
    assert.match(pickerDialog, /<Modal/)
    assert.match(pickerDialog, /dialog-class="picker-dialog"/)
    assert.match(pickerDialog, /:labelledby="titleId"/)
    assert.match(modal, /role="dialog"/)
    assert.match(modal, /aria-modal="true"/)
    assert.match(modal, /useFocusTrap\(dialogRef, visibleRef/)
    assert.match(modal, /<Teleport to="body">/)
    // Each picker owns its search field and its list, so both share one
    // keyboard handler: arrows walk the rows, Enter activates a real button.
    for (const picker of [modelMenu, voicePicker]) {
      assert.match(picker, /searchEl\.value\?\.focus\(\{ preventScroll: true \}\)/)
      assert.match(picker, /@keydown="onListKeydown"/)
      assert.match(picker, /event\.key === 'ArrowDown'/)
      assert.match(picker, /event\.key === 'ArrowUp'/)
      // Home/End must not steal the caret while a query is being typed.
      assert.match(picker, /event\.key === 'Home' && !typing/)
      // No component-local Escape or outside-click listener survives.
      assert.doesNotMatch(picker, /addEventListener\('keydown'|closeOnOutside|onClickOutside/)
    }
  })

  test('Voice Studio preserves Hub-owned clone identity in the picker', () => {
    assert.match(voicePicker, /voice_kind === 'studiohub-shared'/)
    assert.match(voicePicker, /`hubvoice:\$\{voice\.id\}`/)
  })

  test('the voice dialog keeps the scope statement, library browser and saved toggle', () => {
    // The scope banner became the dialog header; it still names the list and
    // says where it was read from, and still reads cloud vs local at a glance.
    assert.match(voicePicker, /:title="scopeTitle"/)
    assert.match(voicePicker, /:description="scopeDescription"/)
    assert.match(voicePicker, /scopeFamily === 'cloud' \? 'accent' : 'success'/)
    assert.match(voicePicker, /<VoiceLibraryBrowser @added="onLibraryVoiceAdded" \/>/)
    // The saved filter survived the dialog conversion; it is now one option in
    // the All / Saved / Cloned group rather than a standalone checkbox.
    assert.match(voicePicker, /id: 'saved' as const, label: 'Saved'/)
    assert.match(voicePicker, /aria-label="Filter voices"/)
    assert.match(voicePicker, /voiceCountLabel/)
    // The dialog outranks the toast stack, so a save failure is also stated
    // inside it rather than only in a toast the dialog would cover.
    assert.match(voicePicker, /v-if="saveError"/)
  })

  test('LLM, image, TTS, video, and transcription surfaces use shared menus', () => {
    assert.match(modelSelector, /<ModelMenu/)
    assert.match(modelSurfaces.audio, /media-type="tts"/)
    assert.match(modelSurfaces.motion, /media-type="video"/)
    assert.match(modelSurfaces.subtitles, /media-type="transcription"/)
    assert.match(modelSurfaces.broll, /media-type="transcription"/)
    assert.match(modelSurfaces.sceneReview, /<ImageModelPicker/)
    assert.doesNotMatch(modelSurfaces.sceneReview, /Rewrite LLM|<ModelSelector/)
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
  assert.match(characterSheet, /safe word or sentence boundaries/)
})
