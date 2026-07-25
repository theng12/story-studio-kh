import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(process.cwd(), '..')
const templatePath = resolve(root, 'electron/server/thumbnail-templates/annotated-business-board.json')
const businessNichePath = resolve(root, 'electron/server/niches/business-economics.json')

test('annotated business board ships a compositing recipe and three real browseable examples', () => {
  const recipe = JSON.parse(readFileSync(templatePath, 'utf8'))
  assert.equal(recipe.id, 'annotated-business-board')
  assert.equal(recipe.recipe.titleMode, 'composite')
  assert.equal(recipe.recipe.layout, 'annotated-collage')
  assert.ok(recipe.recipe.requiredElements.length >= 3)
  assert.equal(recipe.previewImages.length, 3)

  for (const preview of recipe.previewImages) {
    assert.match(preview, /^\/thumbnail-recipe-previews\/.+\.webp$/)
    const diskPath = resolve(root, 'frontend/public', preview.replace(/^\//, ''))
    assert.equal(existsSync(diskPath), true, `${preview} exists`)
    assert.ok(statSync(diskPath).size > 20_000, `${preview} is a real raster preview`)
  }
})

test('Business Economics uses the catalog recipe as its default thumbnail format', () => {
  const niche = JSON.parse(readFileSync(businessNichePath, 'utf8'))
  assert.equal(niche.defaultThumbnailTemplateId, 'annotated-business-board')
})
