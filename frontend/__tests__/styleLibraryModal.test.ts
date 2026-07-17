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

  test('keeps the active style compact instead of rendering the full collection inline', () => {
    assert.match(picker, /style-picker-current/)
    assert.match(picker, /BuiltInStyleLibraryModal/)
    assert.doesNotMatch(picker, /v-for="style in BUILT_IN_STYLES"/)
  })

  test('reuses the modal for built-in starters in project settings', () => {
    assert.match(projectLibrary, /BuiltInStyleLibraryModal/)
    assert.match(projectLibrary, /Browse Style Library/)
    assert.doesNotMatch(projectLibrary, /v-for="style in BUILT_IN_STYLES"/)
  })
})

