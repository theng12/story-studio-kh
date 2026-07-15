import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const dashboard = source('../layouts/dashboard.vue')
const credits = source('../composables/useCredits.ts')
const scenePlan = source('../pages/projects/[slug]/scene-plan.vue')
const sceneReview = source('../pages/projects/[slug]/scene-review.vue')
const motionReview = source('../pages/projects/[slug]/motion-review.vue')

describe('app responsiveness guards', () => {
  test('the dashboard does not run a high-frequency countdown repaint', () => {
    assert.doesNotMatch(dashboard, /nextRefreshInMs/)
    assert.doesNotMatch(credits, /countdownInterval|setInterval\([\s\S]{0,180}250\)/)
    assert.match(dashboard, /auto · \{\{ Math\.round\(pollIntervalMs \/ 1000\) \}\}s/)
  })

  test('long scene workspaces skip off-screen rendering work', () => {
    assert.match(scenePlan, /\.scene-row\s*{[\s\S]*content-visibility:\s*auto;[\s\S]*contain-intrinsic-size:/)
    assert.match(sceneReview, /\.review-scene-row\s*{[\s\S]*content-visibility:\s*auto;[\s\S]*contain-intrinsic-size:/)
  })

  test('Scene Plan progressively mounts long plans and computes health in one pass', () => {
    assert.match(scenePlan, /const SCENE_RENDER_BATCH = 60/)
    assert.match(scenePlan, /v-for="\(scene, i\) in renderedScenes"/)
    assert.match(scenePlan, /const sceneDiagnostics = computed/)
    assert.doesNotMatch(scenePlan, /JSON\.stringify\(plan\.value\)/)
  })

  test('media review pages progressively mount cards and defer media downloads', () => {
    assert.match(sceneReview, /v-for="scene in renderedScenes"/)
    assert.match(sceneReview, /class="review-thumb"[\s\S]{0,180}loading="lazy"/)
    assert.match(motionReview, /v-for="scene in renderedScenes"/)
    assert.match(motionReview, /preload="none"/)
  })
})
