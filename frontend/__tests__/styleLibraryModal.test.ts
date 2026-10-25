import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const modal = source('../components/ContentPackStyleLibraryModal.vue')
const picker = source('../components/StylePicker.vue')
const projectLibrary = source('../components/ProjectStyleLibrary.vue')
const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')
const imagePrompts = source('../pages/projects/[slug]/image-prompts.vue')
const settings = source('../pages/projects/[slug]/settings.vue')

describe('scalable Content Pack style library', () => {
  test('uses one searchable modal with categories, favorites, recents, and lazy previews', () => {
    assert.match(modal, /Style Library/)
    assert.match(modal, /v-model="query"/)
    assert.match(modal, /category:/)
    assert.match(modal, /FAVORITES_KEY/)
    assert.match(modal, /RECENTS_KEY/)
    assert.match(modal, /loading="lazy"/)
    assert.match(modal, /role="listbox"/)
  })

  test('distinguishes loading, unavailable, installed-empty, and filtered-empty states', () => {
    assert.match(modal, /visualStylesLoading/)
    assert.match(modal, /visualStylesError/)
    assert.match(modal, /Content Pack styles are unavailable/)
    assert.match(modal, /No Content Pack styles installed/)
    assert.match(modal, />Retry</)
    assert.match(modal, /No styles found/)
  })

  test('retains saved downloaded-style favorites while the reactive catalog is loading', () => {
    assert.match(modal, /parsed\.filter\(\(id\): id is string => typeof id === 'string'/)
    assert.doesNotMatch(modal, /parsed\.filter\(id => styles\.value\.some/)
    assert.match(modal, /styles\.value\.filter\(style => favoriteIds\.value\.has\(style\.id\)\)\.length/)
  })

  test('keeps the active style compact instead of rendering the full collection inline', () => {
    assert.match(picker, /style-picker-current/)
    assert.match(picker, /ContentPackStyleLibraryModal/)
    assert.match(picker, /useVisualStyleCatalog/)
    assert.doesNotMatch(picker, /const\s+styles\s*=\s*\[/)
  })

  test('reuses the modal for Content Pack starters in project settings', () => {
    assert.match(projectLibrary, /ContentPackStyleLibraryModal/)
    assert.match(projectLibrary, /useVisualStyleCatalog/)
    assert.match(projectLibrary, /Browse Style Library/)
    assert.doesNotMatch(projectLibrary, /const\s+styles\s*=\s*\[/)
  })

  test('uses the live Gateway image catalog and the same three previews for a channel style', () => {
    assert.match(projectLibrary, /<ImageModelPicker/)
    assert.match(projectLibrary, /useGenStudioImageModels/)
    // A channel style renders the three framings, not one representative proof.
    assert.match(projectLibrary, /Generate Previews/)
    assert.match(projectLibrary, /STYLE_PREVIEW_SLOTS/)
    assert.match(projectLibrary, /channel-style-previews/)
    assert.doesNotMatch(projectLibrary, /id: 'style-proof'/)
    assert.doesNotMatch(projectLibrary, /Generate 5 live samples/)
    assert.doesNotMatch(projectLibrary, /props\.imageModels/)
    assert.match(modal, /<ImageModelPicker/)
    assert.doesNotMatch(modal, /props\.imageModels/)
  })

  test('the bulk action covers the channel\'s own custom styles as well as the owner\'s', () => {
    assert.match(modal, /stylePreviewBulkTargets/)
    assert.match(modal, /channelStyleStates/)
    assert.match(modal, /channel-style-previews/)
    // One image at a time, cancellable between images — the shared queue.
    assert.match(modal, /runPreviewQueue/)
    assert.match(modal, /cancelBulkPreviews/)
    // The model that renders those paid images is the customer's own visible
    // choice, so the picker cannot be hidden behind the broken-preview notice.
    assert.match(modal, /showPreviewModelPicker/)
  })

  test('both preview helpers use the shared locked and Economy-only selection policy', () => {
    for (const source of [modal, projectLibrary]) {
      assert.match(source, /selectLiveGenStudioModel/)
      assert.doesNotMatch(source, /models\.find\(model => model\.available\)\?\.id/)
    }
  })

  test('keeps every project style surface on the shared Content Pack catalog', () => {
    assert.match(characterSheet, /<StylePicker/)
    assert.match(imagePrompts, /<StylePicker/)
    assert.match(settings, /useVisualStyleCatalog/)
    assert.match(settings, /visualStylesError/)
    assert.match(settings, /Installed Content Pack styles are unavailable/)
    assert.match(settings, />Retry</)
  })

  test('reloads a persisted signed style as the selected Settings option', () => {
    assert.match(settings, /:value="s\.id"/)
    assert.match(settings, /visualStyles\.value\.find\(style => style\.id === next\)/)
    assert.doesNotMatch(settings, /`catalog:\$\{s\.id\}`/)
  })

  test('does not call a Formula suggestion uninstalled before catalog resolution', () => {
    assert.match(settings, /v-else-if="visualStylesLoading"/)
    assert.match(settings, /Checking installed Content Pack styles/)
    assert.match(settings, /v-else-if="visualStylesError"/)
    assert.match(settings, /Could not check installed Content Pack styles/)
  })
})
