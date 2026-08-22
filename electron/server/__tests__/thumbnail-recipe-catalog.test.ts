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
const hiddenMechanicsNichePath = resolve(root, 'electron/server/niches/hidden-mechanics-history.json')
const archivalMapTemplatePath = resolve(root, 'electron/server/thumbnail-templates/archival-map-investigation.json')
const centeredHeroTemplatePath = resolve(root, 'electron/server/thumbnail-templates/centered-hero-headline.json')
const portraitBlockTemplatePath = resolve(root, 'electron/server/thumbnail-templates/portrait-block-right.json')

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

test('archival map investigation is an original, evidence-led AI-title recipe', () => {
  const recipe = JSON.parse(readFileSync(archivalMapTemplatePath, 'utf8'))
  assert.equal(recipe.id, 'archival-map-investigation')
  assert.equal(recipe.category, 'History')
  assert.equal(recipe.recipe.titleMode, 'ai')
  assert.equal(recipe.recipe.layout, 'annotated-collage')
  assert.match(recipe.recipe.compositionRules.join('\n'), /parchment map/i)
  assert.match(recipe.recipe.compositionRules.join('\n'), /two to four stacked white headline bands/i)
  assert.match(recipe.recipe.avoid.join('\n'), /sole-cause claim/i)
  assert.ok(recipe.recommendedNicheIds.includes('hidden-mechanics-history'))
  assert.equal(recipe.previewImages.length, 3)
  for (const preview of recipe.previewImages) {
    assert.match(preview, /^\/builtin-thumbnail-previews\/archival-map-investigation-[123]\.webp$/)
    const diskPath = resolve(root, 'frontend/public', preview.replace(/^\//, ''))
    assert.equal(existsSync(diskPath), true, `${preview} exists`)
    assert.ok(statSync(diskPath).size > 20_000, `${preview} is a real raster preview`)
  }
})

test('Hidden Mechanics of History binds its visual style and thumbnail recipe as one production kit', () => {
  const niche = JSON.parse(readFileSync(hiddenMechanicsNichePath, 'utf8'))
  assert.equal(niche.defaultThumbnailTemplateId, 'archival-map-investigation')
  assert.equal(niche.productionKit.recommendedVisualStyleId, 'builtin-archival-documentary-reconstruction')
})

test('centered and portrait legacy templates expose three source-backed browseable previews without changing their first URL', () => {
  for (const [templatePath, id, expected] of [
    [
      centeredHeroTemplatePath,
      'centered-hero-headline',
      [
        '/thumbnail-recipe-previews/centered-hero-headline.webp',
        '/thumbnail-recipe-previews/centered-hero-headline-dozing-knight-01.webp',
        '/thumbnail-recipe-previews/centered-hero-headline-dozing-knight-05.webp',
      ],
    ],
    [
      portraitBlockTemplatePath,
      'portrait-block-right',
      [
        '/thumbnail-recipe-previews/portrait-block-right.webp',
        '/thumbnail-recipe-previews/portrait-block-right-capi-01.webp',
        '/thumbnail-recipe-previews/portrait-block-right-abiding-faith-01.webp',
      ],
    ],
  ] as const) {
    const recipe = JSON.parse(readFileSync(templatePath, 'utf8'))
    assert.equal(recipe.id, id)
    assert.deepEqual(recipe.previewImages, expected)
    for (const preview of recipe.previewImages) {
      const diskPath = resolve(root, 'frontend/public', preview.replace(/^\//, ''))
      assert.equal(existsSync(diskPath), true, `${preview} exists`)
      assert.ok(statSync(diskPath).size > 20_000, `${preview} is a real raster preview`)
    }
  }
})
