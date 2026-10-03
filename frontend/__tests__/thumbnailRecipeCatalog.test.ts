import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
  assert.match(page, /The episode title is drawn directly into every thumbnail/i)
  assert.match(page, /its own short text, written to suit it/i)
  assert.match(page, /thumbnailHeadlineMode/)
  assert.match(page, /id: 'bottom-left', label: 'Bottom left'/)
})

test('curiosity-question cartoon ships original examples and recipe-owned short-hook rules', () => {
  const recipe = JSON.parse(source('../../electron/server/thumbnail-templates/curiosity-question-cartoon.json'))
  assert.equal(recipe.recipe.headlineMode, 'curiosity-hook')
  assert.match(recipe.recipe.headlineGuidance, /truthful 1–4 word hook/i)
  assert.equal(recipe.previewImages.length, 3)
  for (const preview of recipe.previewImages) {
    const previewPath = fileURLToPath(new URL(`../public${preview}`, import.meta.url))
    assert.equal(existsSync(previewPath), true, `${preview} exists`)
  }
})

test('Animals defaults to the curiosity recipe without making art style a niche lock', () => {
  const animals = JSON.parse(source('../../electron/server/niches/animals.json'))
  assert.equal(animals.defaultThumbnailTemplateId, 'curiosity-question-cartoon')
})

test('deep-time documentary recipe is browseable, AI-rendered, and profile-aware', () => {
  const recipe = JSON.parse(source('../../electron/server/thumbnail-templates/documentary-label-tableau.json'))
  assert.equal(recipe.category, 'Documentary')
  assert.equal(recipe.recipe.titleMode, 'ai')
  assert.match(recipe.recipe.headlineGuidance, /Deep Rest episode/i)
  assert.match(recipe.recipe.headlineGuidance, /2–5 word factual label/i)
  assert.equal(recipe.previewImages.length, 3)
  for (const preview of recipe.previewImages) {
    const previewPath = fileURLToPath(new URL(`../public${preview}`, import.meta.url))
    assert.equal(existsSync(previewPath), true, `${preview} exists`)
  }

  const formula = JSON.parse(source('../../electron/server/niches/deep-time-documentary.json'))
  assert.equal(formula.defaultThumbnailTemplateId, recipe.id)
  // A Formula binds its recipe, never a visual style — the look is chosen.
  assert.equal(formula.productionKit.recommendedVisualStyleId, undefined)
})

test('archival map investigation is discoverable as an original history recipe', () => {
  const recipe = JSON.parse(source('../../electron/server/thumbnail-templates/archival-map-investigation.json'))
  assert.equal(recipe.category, 'History')
  assert.ok(recipe.tags.includes('archival'))
  assert.equal(recipe.recipe.titleMode, 'ai')
  assert.match(recipe.recipe.compositionRules.join('\n'), /parchment map/i)
  assert.match(recipe.recipe.compositionRules.join('\n'), /exact episode title/i)
  assert.match(recipe.recipe.avoid.join('\n'), /copied creator trade dress/i)
  assert.deepEqual(recipe.previewImages, [
    '/builtin-thumbnail-previews/archival-map-investigation-1.webp',
    '/builtin-thumbnail-previews/archival-map-investigation-2.webp',
    '/builtin-thumbnail-previews/archival-map-investigation-3.webp',
  ])
})
