import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

test('thumbnail recipe library scales with searchable classifications, favorites, recents, and generated examples', () => {
  const catalog = source('../components/ThumbnailRecipeLibraryModal.vue')
  const picker = source('../components/ThumbnailRecipePicker.vue')
  assert.match(catalog, /Thumbnail Recipe Library/)
  assert.match(catalog, /previewImages/)
  assert.match(catalog, /Search formats, subjects, layouts, or tags/)
  assert.match(catalog, /Favorites/)
  assert.match(catalog, /Recent/)
  assert.match(catalog, /category:\$\{category\}/)
  assert.match(catalog, /story-studio:thumbnail-recipe-library:favorites/)
  assert.match(catalog, /story-studio:thumbnail-recipe-library:recents/)
  assert.match(catalog, /filter\(template => Boolean\(template\.recipe\)\)/)
  assert.match(picker, /Generated examples included/)
  assert.match(picker, /ThumbnailRecipeLibraryModal/)
})

test('thumbnail prompts can choose a catalog recipe without replacing visual art style', () => {
  const page = source('../pages/projects/[slug]/image-prompts.vue')
  assert.match(page, /ThumbnailRecipePicker/)
  assert.match(page, /thumbnail_template_id/)
  assert.match(page, /<label>Visual art style<\/label>/)
  assert.match(page, /thumb_title_mode: 'ai'/)
  assert.match(page, /renders the exact episode title directly in the thumbnail/i)
})
