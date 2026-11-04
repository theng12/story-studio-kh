/**
 * Scene Review "Reference to Image" — the surface (AGENTS.md §1, §4).
 *
 * The block may exist ONLY where the selected model's live row publishes
 * reference support, and every figure it shows is that row's. The selection is
 * this episode's own characters, decided by the list the backend returned, and
 * an episode change never leaves a foreign id standing silently.
 *
 * Source assertions cover the page wiring the pure helpers cannot: this app's
 * tests read the .vue file for template/script contracts (see
 * sceneReviewPreview.test.ts and modelMenus.test.ts).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  describeSceneReferenceDrops,
  reconcileSceneReferenceCharacters,
  sceneReferenceLimits,
  sceneReferenceNotice,
  sceneReferencePortrait,
  sceneTakesCharacterReferences,
} from '../utils/scene-reference-characters.js'
import { describeImageUnitCost } from '../utils/genstudio-credit-cost.js'

const sceneReviewSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)
const pickerSource = readFileSync(
  fileURLToPath(new URL('../components/ImageModelPicker.vue', import.meta.url)),
  'utf8',
)
const scenePlanSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
  'utf8',
)

const REFERENCE_MODEL = {
  id: 'ref-model',
  display_name: 'Reference Model',
  supports_reference_images: true,
  max_reference_images: 2,
  min_reference_images: 1,
  reference_image_max_dimension: 1024,
  chargeable: true,
  credits_per_image: 4,
  reference_generation_credits: 6,
  aspect_ratios: ['16:9'],
  default_aspect_ratio: '16:9',
}

describe('the reference window comes from the published row', () => {
  test('a model publishing false, no ceiling or no support gets no block', () => {
    assert.equal(sceneReferenceLimits({ supports_reference_images: false, max_reference_images: 4 }), null)
    assert.equal(sceneReferenceLimits({ supports_reference_images: true, max_reference_images: 0 }), null)
    assert.equal(sceneReferenceLimits({ max_reference_images: 2 }), null)
    assert.equal(sceneReferenceLimits(null), null)
  })

  test('a reference model shows the published min, max and pixel ceiling', () => {
    assert.deepEqual(sceneReferenceLimits(REFERENCE_MODEL), { min: 1, max: 2, maxDimension: 1024 })
    // The COUNT window is the model picker's notice, directly above the block;
    // the block adds what the picker cannot say.
    assert.match(pickerSource, /accepts up to \$\{max\} reference image/)
    assert.match(pickerSource, /needs at least \$\{min\}/)
    const notice = sceneReferenceNotice(sceneReferenceLimits(REFERENCE_MODEL)!)
    assert.match(notice, /1,024px on the longest side/)
    assert.match(notice, /scaled down to fit before upload/)
    assert.match(notice, /cutaways render without them/)
  })

  test('a model publishing no pixel ceiling states none', () => {
    const notice = sceneReferenceNotice(sceneReferenceLimits({
      supports_reference_images: true, max_reference_images: 1,
    })!)
    assert.doesNotMatch(notice, /px on the longest side/)
  })

  test('the cost line switches to the model\'s published reference rate', () => {
    const text = describeImageUnitCost(REFERENCE_MODEL as never, null)
    const reference = describeImageUnitCost(REFERENCE_MODEL as never, null, { referenceGuided: true })
    assert.notEqual(reference.text, text)
    assert.match(reference.title, /per reference-guided image/)
  })
})

describe('the selection is this episode\'s own characters', () => {
  const characters = [
    { id: 'mara', name: 'Mara', references: { images: ['mara.png'] } },
    { id: 'kiri', name: 'Kiri', references: { images: ['kiri.png'] } },
    { id: 'blank', name: 'Blank', references: { images: [] } },
  ]

  test('a foreign id is dropped and named, never kept', () => {
    const { kept, dropped } = reconcileSceneReferenceCharacters(['mara', 'other-episode'], characters, 2)
    assert.deepEqual(kept, ['mara'])
    assert.deepEqual(dropped.map(item => item.id), ['other-episode'])
    assert.match(describeSceneReferenceDrops(dropped), /Dropped 1 reference character: other-episode \(not a character of this episode\)/)
  })

  test('a character without a portrait cannot be kept', () => {
    const { kept, dropped } = reconcileSceneReferenceCharacters(['blank'], characters, 2)
    assert.deepEqual(kept, [])
    assert.match(describeSceneReferenceDrops(dropped), /Blank \(no reference image\)/)
    assert.equal(sceneReferencePortrait(characters[2]!), '')
  })

  test('a model switch clamps to the new ceiling and names the tail', () => {
    const { kept, dropped } = reconcileSceneReferenceCharacters(['mara', 'kiri'], characters, 1)
    assert.deepEqual(kept, ['mara'])
    assert.deepEqual(dropped.map(item => item.name), ['Kiri'])
    assert.match(describeSceneReferenceDrops(dropped), /beyond the model's 1 slot/)
  })

  test('nothing dropped says nothing', () => {
    assert.equal(describeSceneReferenceDrops([]), '')
    assert.deepEqual(reconcileSceneReferenceCharacters(['mara'], characters, 2), { kept: ['mara'], dropped: [] })
  })
})

describe('the selection is per scene', () => {
  test('a cutaway may never carry character references', () => {
    assert.equal(sceneTakesCharacterReferences({}), true)
    assert.equal(sceneTakesCharacterReferences({ scene_type: 'character' }), true)
    for (const type of ['event', 'environment', 'map', 'artifact']) {
      assert.equal(sceneTakesCharacterReferences({ scene_type: type }), false)
    }
  })

  test('Scene Plan edits each character scene\'s own cast', () => {
    assert.match(scenePlanSource, /v-if="referenceCandidates.length && sceneTakesCharacterReferences\(scene\)"/)
    assert.match(scenePlanSource, /@change="toggleSceneReference\(scene, character\.id\)"/)
    assert.match(scenePlanSource, /scene\.reference_character_ids = current\.includes\(characterId\)/)
    assert.match(scenePlanSource, /scene\.reference_character_ids = \[\]/,
      'changing a scene to a cutaway clears the cast it can no longer use')
    assert.match(scenePlanSource, /listForEpisode\(episode\)/,
      'the candidates are this episode\'s own list, never a remembered one')
  })

  test('Scene Review edits one scene\'s cast and can apply a default to all', () => {
    assert.match(sceneReviewSource, /function sceneReferenceList\(scene: ReviewScene\): string\[\]/)
    assert.match(sceneReviewSource, /Array\.isArray\(scene\.reference_character_ids\) \? scene\.reference_character_ids : referenceCharacterIds\.value/)
    assert.match(sceneReviewSource, /set-reference-characters/)
    assert.match(sceneReviewSource, /all_character_scenes: true/)
    assert.match(sceneReviewSource, /Apply to all character scenes/)
    assert.match(sceneReviewSource, /sceneTakesCharacterReferences\(previewScene\)/)
  })
})

describe('the page wiring', () => {
  test('the block is gated on the live published capability and ceiling', () => {
    assert.match(sceneReviewSource, /selectedGenStudioModel\.value\?\.image_modes\?\.find\(mode => mode\.id === 'edit' && mode\.available\)/)
    assert.match(sceneReviewSource, /sceneImageMode\.value === 'img2img' && mode \? sceneReferenceLimits/)
    assert.match(sceneReviewSource, /<div v-if="referenceLimits" class="sr-reference-block">/)
    assert.match(sceneReviewSource, /v-model:image-mode="sceneImageMode"/)
    assert.match(sceneReviewSource, /\{\{ referenceWindowNotice \}\}/)
  })

  test('each row shows the portrait and disables a character with none, with the reason', () => {
    assert.match(sceneReviewSource, /characterPortraitUrl\(character\)/)
    assert.match(sceneReviewSource, /:disabled="!sceneReferencePortrait\(character\)"/)
    assert.match(sceneReviewSource, /No reference image — add one on the Character Sheet/)
    assert.match(sceneReviewSource, /\/api\/character-library/)
    assert.match(sceneReviewSource, /character\.source === 'library'/)
  })

  test('every render request carries the selection, and never a path', () => {
    const sends = sceneReviewSource.match(/\.\.\.referenceCharacterBody\.value/g) || []
    assert.ok(sends.length >= 5, `single, batch, finish and replace requests must all carry the selection (found ${sends.length})`)
    assert.match(sceneReviewSource, /image_mode: sceneImageMode\.value/)
    assert.match(sceneReviewSource, /sceneImageMode\.value === 'img2img' && referenceCharacterIds\.value\.length/)
    assert.doesNotMatch(sceneReviewSource, /reference_paths|referenceImagePaths:/, 'the client sends ids only')
  })

  test('an episode change blanks the selection and re-resolves it against the new list', () => {
    assert.match(sceneReviewSource, /referenceCarriedIds\.value = referenceCharacterIds\.value\n\s+referenceCharacterIds\.value = \[\]/)
    assert.match(sceneReviewSource, /void loadReferenceCharacters\(\)/)
    assert.match(sceneReviewSource, /const \{ kept, dropped \} = reconcileSceneReferenceCharacters\(carried, referenceCharacters\.value, max\)/)
    assert.match(sceneReviewSource, /the selection was cleared/)
  })

  test('a model switch that takes no references clears them out loud', () => {
    assert.match(sceneReviewSource, /The selected model accepts no reference images, so /)
    assert.match(sceneReviewSource, /watch\(referenceLimits, \(limits\) => \{/)
  })

  test('the reference render is priced from the published reference row', () => {
    assert.match(sceneReviewSource, /referenceGuided: referenceCharacterIds\.value\.length > 0/)
  })

  test('a second reference model is read from ITS row, not from a known one', () => {
    // Owner 2026-10-26: Qwen Image 2.1 Turbo edit joins Klein as a reference
    // model. Nothing about either may be hardcoded — the block follows whatever
    // window each row publishes (here: one slot, no floor, no pixel ceiling).
    const qwen = {
      display_name: 'Qwen Image 2.1 Turbo edit',
      supports_reference_images: true,
      max_reference_images: 1,
      min_reference_images: 0,
    }
    assert.deepEqual(sceneReferenceLimits(qwen), { min: 0, max: 1 })
    assert.doesNotMatch(sceneReferenceNotice(sceneReferenceLimits(qwen)!), /px on the longest side/)
    assert.doesNotMatch(sceneReviewSource, /klein|qwen/i, 'no model may be named in the page logic')
    assert.doesNotMatch(sceneReviewSource, /max_reference_images\s*[:=]\s*\d/, 'no ceiling may be hardcoded')
  })

  test('the picker offers live modes without filtering the selectable model list', () => {
    // The `img2img` FILTER is untouched: reference capability is a mode of the
    // same model, so Scene Review (`image-mode="text2img"`) must keep every model.
    assert.match(pickerSource, /!props\.allowModeSelection && props\.imageMode === 'img2img'\n\s+\? models\.value\.filter/)
    assert.match(pickerSource, /const referenceMode = computed\(\(\) => props\.imageMode === 'img2img' \|\| props\.referenceActive\)/)
    assert.match(pickerSource, /if \(!referenceMode\.value\) return ''/,
      'the count window notice honours reference-active')
    assert.match(pickerSource, /if \(props\.imageMode !== 'img2img' \|\| props\.referenceActive\) return ''/,
      'the dimension notice keeps its img2img wording; Scene Review fits portraits itself')
    assert.match(pickerSource, /referenceActive\?: boolean/)
    assert.match(sceneReviewSource, /allow-mode-selection/)
    assert.match(pickerSource, /publishedImageModes\(selectedModel\.value\?\.image_modes\)/)
  })
})
