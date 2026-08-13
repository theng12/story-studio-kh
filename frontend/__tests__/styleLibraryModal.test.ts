import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const modal = source('../components/BuiltInStyleLibraryModal.vue')
const picker = source('../components/StylePicker.vue')
const projectLibrary = source('../components/ProjectStyleLibrary.vue')
const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')
const imagePrompts = source('../pages/projects/[slug]/image-prompts.vue')
const settings = source('../pages/projects/[slug]/settings.vue')

describe('scalable built-in style library', () => {
  test('uses one searchable modal with categories, favorites, recents, and lazy previews', () => {
    assert.match(modal, /Style Library/)
    assert.match(modal, /v-model="query"/)
    assert.match(modal, /category:/)
    assert.match(modal, /FAVORITES_KEY/)
    assert.match(modal, /RECENTS_KEY/)
    assert.match(modal, /loading="lazy"/)
    assert.match(modal, /role="listbox"/)
  })

  test('retains saved downloaded-style favorites while the reactive catalog is loading', () => {
    assert.match(modal, /parsed\.filter\(\(id\): id is string => typeof id === 'string'/)
    assert.doesNotMatch(modal, /parsed\.filter\(id => styles\.value\.some/)
    assert.match(modal, /styles\.value\.filter\(style => favoriteIds\.value\.has\(style\.id\)\)\.length/)
  })

  test('keeps the active style compact instead of rendering the full collection inline', () => {
    assert.match(picker, /style-picker-current/)
    assert.match(picker, /BuiltInStyleLibraryModal/)
    assert.match(picker, /useVisualStyleCatalog/)
    assert.doesNotMatch(picker, /v-for="style in BUILT_IN_STYLES"/)
  })

  test('reuses the modal for built-in starters in project settings', () => {
    assert.match(projectLibrary, /BuiltInStyleLibraryModal/)
    assert.match(projectLibrary, /useVisualStyleCatalog/)
    assert.match(projectLibrary, /Browse Style Library/)
    assert.doesNotMatch(projectLibrary, /v-for="style in BUILT_IN_STYLES"/)
  })

  test('uses the live GenStudio image catalog and one representative style proof', () => {
    assert.match(projectLibrary, /<ImageModelPicker/)
    assert.match(projectLibrary, /useGenStudioImageModels/)
    assert.match(projectLibrary, /Generate style proof/)
    assert.match(projectLibrary, /id: 'style-proof'/)
    assert.doesNotMatch(projectLibrary, /Generate 5 live samples/)
    assert.doesNotMatch(projectLibrary, /props\.imageModels/)
    assert.match(modal, /<ImageModelPicker/)
    assert.doesNotMatch(modal, /props\.imageModels/)
  })

  test('keeps every project style surface on the shared built-in catalog', () => {
    assert.match(characterSheet, /<StylePicker/)
    assert.match(imagePrompts, /useVisualStyleCatalog/)
    assert.match(imagePrompts, /<StylePicker/)
    assert.match(settings, /useVisualStyleCatalog/)
  })
})
