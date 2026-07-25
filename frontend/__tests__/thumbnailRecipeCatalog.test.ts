import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

test('thumbnail recipe catalog is browseable and cycles through real preview examples', () => {
  const catalog = source('../components/ThumbnailRecipeLibraryModal.vue')
  assert.match(catalog, /Thumbnail Catalog/)
  assert.match(catalog, /previewImages/)
  assert.match(catalog, /Search recipes, formats, tags/)
  assert.match(catalog, /complete headline/)
  assert.match(catalog, /Headline formats/)
  assert.match(catalog, /filter\(template => Boolean\(template\.recipe\)\)/)
})

test('thumbnail prompts can choose a catalog recipe without replacing visual art style', () => {
  const page = source('../pages/projects/[slug]/image-prompts.vue')
  assert.match(page, /Browse Thumbnail Catalog/)
  assert.match(page, /ThumbnailRecipeLibraryModal/)
  assert.match(page, /thumbnail_template_id/)
  assert.match(page, /Choose the repeatable thumbnail format first/i)
  assert.match(page, /<label>Visual art style<\/label>/)
  assert.match(page, /style below remains separate/i)
  assert.match(page, /thumb_title_mode: 'ai'/)
  assert.match(page, /renders the exact episode title directly in the thumbnail/i)
})
