/**
 * Dead UI removed with the owner's approval (2026-10-03): the hidden Image Prompts blocks and the
 * code only they used, the Scene Review leftovers, stale B-Roll / Breadcrumb text, and the duplicate
 * "generate missing" and "spot effect" buttons. Source-level pins, the repo's usual style.
 * Cannot catch: layout, or a removed block being re-added under a different class name.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('Image Prompts has no hidden blocks and no scene mode, history or old style editor', () => {
  const page = read('../pages/projects/[slug]/image-prompts.vue')
  assert.doesNotMatch(page, /v-if="false/)
  for (const gone of ['formTab', 'form.scene', 'SceneForm', 'generatedPrompts', 'history.value', 'showCapsTable',
    'capPreviewModel', 'extractStyle', 'referenceImagePath', 'saveToFile', 'saveStylePreset', 'onStyleChange',
    'promptGenerating', 'actualChapterCount', 'scenePresets', 'loadVisionCaps', '/outline']) {
    assert.equal(page.includes(gone), false, `${gone} should be gone`)
  }
  assert.doesNotMatch(page, /analyze-style|image-prompts\/save/)
  // What the visible page does is unchanged: thumbnails only, one pulse flag, the review panel.
  assert.match(page, /mode: 'thumbnails'/)
  assert.match(page, /thumbPromptGenerating\.value = true/)
  assert.match(page, /<PromptReviewPanel/)
  assert.doesNotMatch(page, /pool="/)
})

test('the two routes that only the hidden blocks called are gone', () => {
  assert.doesNotMatch(read('../../electron/server/routes/vision.ts'), /analyze-style/)
  assert.doesNotMatch(read('../../electron/server/routes/scripts.ts'), /image-prompts\/save/)
  assert.doesNotMatch(read('../composables/useGenerating.ts'), /promptGenerating/)
})

test('Prompt Review and its route are thumbnail-only', () => {
  const panel = read('../components/PromptReviewPanel.vue')
  assert.doesNotMatch(panel, /scenes|scenePromptCap|sceneModelLabel|pool\?:|kind === 'scene'/)
  const route = read('../../electron/server/routes/image-prompts-edit.ts')
  assert.doesNotMatch(route, /kind === 'scene'|'scene' \| 'thumbnail'|z\.enum\(\['scene'/)
  assert.match(route, /kind: z\.literal\('thumbnail'\)/)
})

test('Scene Review keeps no dead animate code or CSS (Motion Review owns clips)', () => {
  const page = read('../pages/projects/[slug]/scene-review.vue')
  assert.doesNotMatch(page, /sr-lb-stage|sr-blocking-warning|sr-legacy-note/)
  assert.doesNotMatch(page, /animateScene|animateMissing|uploadClipOne|setAnimateMinSeconds|animateMinSeconds|i2vModels|videoModel/)
  // The duration floor lives on in Motion Review.
  assert.match(read('../pages/projects/[slug]/motion-review.vue'), /animateMinSeconds/)
})

test('stale B-Roll, Breadcrumb and import-button text is gone', () => {
  const broll = read('../pages/projects/[slug]/broll.vue')
  assert.doesNotMatch(broll, /Scene Generator|pages are hidden|Phase 2|Phase 3|genstudio-settings/)
  assert.match(broll, /settings#connections/)
  const crumb = read('../components/Breadcrumb.vue')
  assert.doesNotMatch(crumb, /Scene Prompts|Scene Generator/)
  assert.doesNotMatch(read('../components/EpisodeImportButton.vue'), /Scene Generator/)
})

test('Sound Design keeps one Add Spot Effect button, in the top bar', () => {
  const page = read('../pages/projects/[slug]/sound-design.vue')
  assert.match(page, /generate-label="Add Spot Effect"/)
  assert.equal((page.match(/@click="addSpot"/g) || []).length, 0)
  assert.match(page, /@generate="addSpot"/)
  assert.match(page, /@click="addBed">\+ Ambient bed/)
})
