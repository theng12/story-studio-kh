import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const templatePath = resolve(root, 'electron/server/thumbnail-templates/annotated-business-board.json')
const businessNichePath = resolve(root, 'electron/server/niches/business-economics.json')
const documentaryTemplatePath = resolve(root, 'electron/server/thumbnail-templates/documentary-label-tableau.json')
const deepTimeNichePath = resolve(root, 'electron/server/niches/deep-time-documentary.json')

test('annotated business board ships an AI-headline recipe and three real browseable examples', () => {
  const recipe = JSON.parse(readFileSync(templatePath, 'utf8'))
  assert.equal(recipe.id, 'annotated-business-board')
  assert.equal(recipe.recipe.titleMode, 'ai')
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

test('documentary label tableau ships a mixed-profile AI-label recipe and three real examples', () => {
  const recipe = JSON.parse(readFileSync(documentaryTemplatePath, 'utf8'))
  assert.equal(recipe.id, 'documentary-label-tableau')
  assert.equal(recipe.recipe.titleMode, 'ai')
  assert.equal(recipe.recipe.headlineMode, 'curiosity-hook')
  assert.match(recipe.recipe.headlineGuidance, /DOCUMENTARY FOR SLEEP/)
  assert.match(recipe.recipe.headlineGuidance, /2–5 word factual label/)
  assert.equal(recipe.previewImages.length, 3)

  for (const preview of recipe.previewImages) {
    assert.match(preview, /^\/thumbnail-recipe-previews\/.+\.webp$/)
    const diskPath = resolve(root, 'frontend/public', preview.replace(/^\//, ''))
    assert.equal(existsSync(diskPath), true, `${preview} exists`)
    assert.ok(statSync(diskPath).size > 20_000, `${preview} is a real raster preview`)
  }
})

test('Deep Time binds its reusable production kit to the documentary recipe', () => {
  const niche = JSON.parse(readFileSync(deepTimeNichePath, 'utf8'))
  assert.equal(niche.defaultThumbnailTemplateId, 'documentary-label-tableau')
  assert.equal(niche.productionKit.recommendedVisualStyleId, 'builtin-paleo-documentary-tableau')
  assert.deepEqual(
    niche.productionKit.episodeProfiles.map((profile: any) => profile.ideaAxisValue),
    ['deep rest documentary', 'immersive documentary'],
  )
  assert.equal(niche.scriptStructure.motionProfile.id, 'ambient-documentary')
})
