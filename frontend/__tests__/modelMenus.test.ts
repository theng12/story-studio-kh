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
const voiceLibraryBrowser = source('../components/VoiceLibraryBrowser.vue')
const modelSelector = source('../components/ModelSelector.vue')
const transcriptionCatalog = source('../composables/useGenStudioTranscription.ts')
const imageCatalog = source('../composables/useGenStudioImageModels.ts')
const mediaCatalog = source('../composables/useGenStudioMediaModels.ts')
const voiceCatalog = source('../composables/useGenStudioVoices.ts')
const catalogSettings = source('../components/GenStudioCatalogSettings.vue')
const appSettings = source('../../electron/server/routes/app-settings.ts')

const modelSurfaces = {
  audio: source('../pages/projects/[slug]/audio.vue'),
  motion: source('../pages/projects/[slug]/motion-review.vue'),
  subtitles: source('../pages/projects/[slug]/subtitles.vue'),
  sceneReview: source('../pages/projects/[slug]/scene-review.vue'),
  broll: source('../pages/projects/[slug]/broll.vue'),
  imagePrompts: source('../pages/projects/[slug]/image-prompts.vue'),
  research: source('../pages/projects/[slug]/research.vue'),
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
    assert.match(modelMenu, /v-if="option\.description"/)
    assert.match(modelMenu, /v-if="option\.meta"/)
    assert.match(modelMenu, /model-menu-option-provider/)
    assert.match(modelMenu, /model-menu-option-price/)
    assert.match(modelMenu, /Published rate/)
    assert.match(modelMenu, /option\.provider/)
    assert.match(modelMenu, /option\.disabledReason/)
    assert.match(modelMenu, /\{\{ catalogNotice \}\}/)
  })

  test('the shared model dialog owns accessible published-cost tier tabs', () => {
    // Catches moving the tabs into a modality picker, where catalog policy would diverge.
    assert.match(modelMenu, /role="tablist"/)
    // Catches replacing real tab buttons with non-interactive labels.
    assert.match(modelMenu, /role="tab"/)
    // Catches assistive technology losing the active-tab state.
    assert.match(modelMenu, /:aria-selected="tier\.id === activeTier"/)
    // Catches removing the semantic connection between the selected tab and results.
    assert.match(modelMenu, /:aria-controls="tierPanelId"/)
    assert.match(modelMenu, /:role="tierMode \? 'tabpanel' : undefined"/)
    assert.match(modelMenu, /:aria-labelledby="tierMode \? activeTierTabId : undefined"/)
    // Catches a keyboard-only user being unable to move tiers without a pointer.
    assert.match(modelMenu, /event\.key === 'ArrowRight'/)
    assert.match(modelMenu, /event\.key === 'ArrowLeft'/)
    assert.match(modelMenu, /event\.key === 'Home'/)
    assert.match(modelMenu, /event\.key === 'End'/)
    // Catches a visually compact tab regressing below the app's 44px target.
    assert.match(modelMenu, /\.model-menu-tier-tab\s*{[^}]*min-height:\s*44px/)
    // Catches an empty tier being described as a nonsensical empty search.
    assert.match(modelMenu, /No \$\{tierLabel\(activeTier\.value\)\} models are currently available\./)
  })

  test('account-locked teaser models remain visible with price but cannot be selected', () => {
    assert.match(modelMenu, /:aria-disabled="option\.disabled \|\| undefined"/)
    assert.match(modelMenu, /if \(option\.disabled\) return/)
    assert.match(modelSelector, /genStudioModelLockReason\(model\)/)
    assert.match(imagePicker, /model\.locked === true/)
    assert.match(modelSurfaces.audio, /model\.locked === true/)
    assert.match(modelSurfaces.motion, /model\.locked === true/)
    assert.match(transcriptionCatalog, /model\.locked === true/)
    for (const catalog of [imageCatalog, mediaCatalog, voiceCatalog, transcriptionCatalog]) {
      assert.match(catalog, /locked\?: boolean/)
      assert.match(catalog, /lock_reason\?: string/)
    }
  })

  test('the image picker exposes catalog errors and heals stale saved selections silently', () => {
    assert.match(imagePicker, /v-if="error"/)
    assert.match(imagePicker, /notice-error/)
    assert.match(imagePicker, /selectLiveGenStudioModel/)
    assert.doesNotMatch(imagePicker, /Unavailable saved selection|migration required|Historical/)
  })

  test('customer model menus use only neutral modality and published provider groups', () => {
    // The modality name is still the heading for the direct catalogue. It is
    // now reached through `queueClassGroupLabel`, which swaps it for the
    // relaxed shelf's own heading when GenStudio says a product sells there —
    // and returns this string unchanged for everything else, including every
    // product published before `queue_class` existed.
    assert.match(modelSelector, /queueClassGroupLabel\(model, 'Language models'\)/)
    assert.match(imagePicker, /group: 'Image models'/)
    assert.match(modelSurfaces.audio, /group: queueClassGroupLabel\(model, model\.provider_name \|\| 'Voice models'\)/)
    assert.match(imagePicker, /provider: model\.provider_name \|\| ''/)
    assert.match(modelSelector, /provider: model\.provider_name \|\| ''/)
    assert.match(modelSurfaces.audio, /provider: model\.provider_name \|\| ''/)
    for (const source of [imagePicker, modelSelector, transcriptionCatalog, modelSurfaces.audio]) {
      assert.doesNotMatch(source, /unlimited_relaxed|Unlimited Relaxed|Relaxed eligible|Free \+ paid plans|Paid plan/)
    }
    assert.doesNotMatch(imagePicker, /provider: model\.execution_label/)
    assert.doesNotMatch(modelSelector, /provider: model\.label|provider: model\.id/)
    // Nothing may append the gateway to a model's own name.
    for (const source of [imagePicker, modelSelector, transcriptionCatalog, modelSurfaces.audio, modelSurfaces.motion]) {
      assert.doesNotMatch(source, /\[GenStudio( KH)?\]/)
      assert.doesNotMatch(source, /provider:\s*model\.execution_label|provider:\s*'Gateway'/)
    }
    // Where the catalogue DOES publish who serves a product, that is what the
    // row shows — the real vendor, not the gateway standing in for it.
    // (AGENTS.md → "Provider Transparency".)
    assert.match(transcriptionCatalog, /group: model\.provider \|\| 'Transcription models'/)
    assert.match(transcriptionCatalog, /provider: model\.provider \|\| ''/)
    // An unpublished provider is unknown. It is never backfilled with the
    // gateway's name, and never guessed from an id.
    assert.doesNotMatch(modelSurfaces.audio, /provider_name \|\| '(GenStudio|Gateway)/)
    assert.doesNotMatch(transcriptionCatalog, /provider \|\| '(GenStudio|Gateway)/)
    // The trigger and open rows summarise a PUBLISHED provider, never the plan
    // group. Optional provider fields remain empty until GenStudio publishes
    // them, rather than being guessed from model brands.
    assert.match(modelMenu, /\[option\.provider, option\.meta\]/)
    assert.match(imageCatalog, /provider_name\?: string/)
    // AGENTS.md → "Provider Transparency" (2026-08-01) reversed the old masking:
    // what GenStudio publishes about who serves a product now reaches the
    // customer. No catalogue route may delete those fields on the way out.
    assert.doesNotMatch(appSettings, /withoutProviderIdentity|PRIVATE_PROVIDER_IDENTITY_FIELDS/)
    // Transparency is DISPLAY only. Story Studio still never selects a provider
    // and never sends one on a generation request.
    assert.doesNotMatch(appSettings, /provider_id:\s*(?!.*req\.params)/)
  })

  test('every priced ModelMenu modality maps its published rate through the shared price row', () => {
    assert.match(modelSelector, /describeChatRate/)
    assert.match(modelSelector, /price:\s*rate\.text/)
    assert.match(modelSelector, /priceTitle:\s*rate\.title/)
    assert.match(modelSurfaces.audio, /describeVoiceRate/)
    assert.match(modelSurfaces.audio, /price:\s*rate\.text/)
    assert.match(modelSurfaces.audio, /priceTitle:\s*rate\.title/)
    assert.match(imagePicker, /describeImageModelRate/)
    assert.match(imagePicker, /price:\s*rate\.text/)
    assert.match(imagePicker, /priceTitle:\s*rate\.title/)
    assert.match(modelSurfaces.motion, /describeVideoModelRate/)
    assert.match(modelSurfaces.motion, /price:\s*rate\.text/)
    assert.match(modelSurfaces.motion, /priceTitle:\s*rate\.title/)
    assert.match(transcriptionCatalog, /describeTranscriptionRate/)
    assert.match(transcriptionCatalog, /price:\s*rate\.text/)
    assert.match(transcriptionCatalog, /priceTitle:\s*rate\.title/)
    assert.match(modelSurfaces.research, /describeWebResearchRate/)
    assert.match(modelSurfaces.research, /price:\s*rate\.text/)
    assert.match(modelSurfaces.research, /priceTitle:\s*rate\.title/)
  })

  test('thumbnail generator enables reference guidance only for qualified Gateway models', () => {
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

  test('the picker carries no retired Studio Hub voice identity', () => {
    // v1.0.784 — /voicestudio/voices is 410'd by the retirement middleware, so
    // a studiohub-shared voice can never arrive. Both branches that decoded one
    // were dead code naming a retired routing surface.
    assert.doesNotMatch(voicePicker, /studiohub-shared/)
    assert.doesNotMatch(voicePicker, /hubvoice:/)
    assert.doesNotMatch(voicePicker, /voice_kind === 'voicestudio-pooled'|encodedLocalVoice/)
  })

  test('the voice dialog keeps the scope statement, library browser and saved toggle', () => {
    // The scope banner became the dialog header; it still names the list and
    // says where it was read from, and still reads cloud vs local at a glance.
    assert.match(voicePicker, /:title="scopeTitle"/)
    assert.match(voicePicker, /:description="scopeDescription"/)
    assert.doesNotMatch(voicePicker, /\/macos\/voices|\/voicestudio\/voices/, 'the retired local-voice branch stays gone')
    assert.match(voicePicker, /v-if="compatibleLibrary" #actions/)
    assert.match(voicePicker, /:library="compatibleLibrary"/)
    assert.match(voicePicker, /library\.provider_id === props\.ttsModelProviderId/)
    assert.match(voicePicker, /Clone a voice in the Gateway/)
    assert.match(appSettings, /voices\.filter\(voice => !voice\.tts_model_id \|\| voice\.tts_model_id === modelId\)/)
    assert.match(voiceLibraryBrowser, /v-if="hasMore"/)
    assert.match(voiceLibraryBrowser, /Load more voices/)
    assert.doesNotMatch(voiceLibraryBrowser, /vlb-tabs|selectLibrary|Previous|Next →/)
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
    assert.match(modelSelector, /title="Choose LLM model"/)
    assert.match(imagePicker, /title="Choose an image model"/)
    assert.match(modelSurfaces.audio, /media-type="tts"/)
    assert.match(modelSurfaces.motion, /media-type="video"/)
    assert.match(modelSurfaces.subtitles, /media-type="transcription"/)
    assert.match(modelSurfaces.broll, /media-type="transcription"/)
    assert.match(modelSurfaces.sceneReview, /<ImageModelPicker/)
    assert.doesNotMatch(modelSurfaces.sceneReview, /Rewrite LLM|<ModelSelector/)
    assert.match(modelSurfaces.imagePrompts, /title="Reference analysis model"/)
    assert.match(modelSurfaces.channelCharacters, /title="Character vision model"/)
  })

  test('every customer model menu maps the Gateway published cost tiers', () => {
    assert.match(modelSelector, /costTier:\s*model\.cost_tier/)
    assert.match(imagePicker, /costTier:\s*model\.cost_tier/)
    assert.match(modelSurfaces.audio, /costTier:\s*model\.cost_tier/)
    assert.match(modelSurfaces.motion, /costTier:\s*model\.cost_tier/)
    assert.match(transcriptionCatalog, /costTier:\s*model\.cost_tier/)
    assert.match(modelSurfaces.imagePrompts, /costTier:\s*model\.cost_tier/g)
    assert.match(modelSurfaces.research || '', /costTier:\s*model\.cost_tier/)

    for (const catalog of [imageCatalog, mediaCatalog, voiceCatalog, transcriptionCatalog]) {
      assert.match(catalog, /cost_tier\?: GenStudioCostTier/)
    }
  })

  test('Music preserves the published tier for diagnostics without inventing a picker', () => {
    assert.match(catalogSettings, /cost_tier\?: GenStudioCostTier/)
    assert.match(catalogSettings, /costTier:\s*entry\.cost_tier/)
    assert.doesNotMatch(catalogSettings, /media-type="music"|Choose a music model/)
  })

  test('transcription keeps dispatch details internal and supports import instead of chapter timing synthesis', () => {
    for (const source of [modelSurfaces.subtitles, modelSurfaces.broll, transcriptionCatalog]) {
      assert.doesNotMatch(source, /single route|ready workers|no ready workers|Transcribe \(The Gateway\)|from-chapters/i)
    }
    assert.match(modelSurfaces.subtitles, /:generate-label="subtitleActionLabel\(null, transcribeLabel\)"/)
    // Owner decision 2026-10-03: the section has no third "Transcribe chapters" button.
    assert.equal((modelSurfaces.subtitles.match(/@click="transcribe"/g) || []).length, 1, "only the selection bar's button calls transcribe directly")
    assert.match(modelSurfaces.subtitles, /title="Import subtitles"/)
    assert.doesNotMatch(modelSurfaces.subtitles, /title="Other methods"|From chapters/)
    assert.match(transcriptionCatalog, /disabled: !catalogIsUsable\.value \|\| !model\.available \|\| model\.locked === true/)
    assert.match(transcriptionCatalog, /Last-known catalog only\. Refresh the Gateway before starting paid transcription\./)
    assert.match(transcriptionCatalog, /temporarily unavailable/)
  })

test('the format wizard no longer restores a hardcoded paid model list', () => {
    assert.match(modelSurfaces.formatWizard, /<ModelSelector/)
    assert.doesNotMatch(modelSurfaces.formatWizard, /<option value="gpt-4o"/)
    assert.match(modelSurfaces.formatWizard, /const model = ref\(''\)/)
  })
})

test('Scene Plan owns strict episode timing without a duplicate Character Sheet card', () => {
  const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')
  const scenePlan = source('../pages/projects/[slug]/scene-plan.vue')
  const visualTimingMotion = source('../components/VisualTimingMotion.vue')
  assert.doesNotMatch(characterSheet, /<h3>Visual timing & motion<\/h3>/)
  assert.doesNotMatch(characterSheet, /Custom range…|safe word or sentence boundaries/)
  assert.match(scenePlan, /<VisualTimingMotion/)
  assert.match(scenePlan, /id="visual-timing"/)
  assert.match(visualTimingMotion, /<legend>Scene timing<\/legend>/)
  assert.match(visualTimingMotion, /min="1" max="60"/)
  assert.match(visualTimingMotion, /parseScenePacing\(draft\.value\.pacing\)/)
})
