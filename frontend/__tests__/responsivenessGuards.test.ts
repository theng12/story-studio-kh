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
const modal = source('../components/Modal.vue')
const appSettingsModal = source('../components/AppSettingsModal.vue')
const thisMacSettings = source('../components/ThisMacSettings.vue')
const serverModeSettings = source('../components/ServerModeSettingsPanel.vue')

describe('app responsiveness guards', () => {
  test('the dashboard does not run a high-frequency countdown repaint', () => {
    assert.doesNotMatch(dashboard, /nextRefreshInMs/)
    assert.doesNotMatch(credits, /countdownInterval|setInterval\([\s\S]{0,180}250\)/)
    assert.match(dashboard, /Balances refresh automatically every \$\{Math\.round\(pollIntervalMs \/ 1000\)\} seconds/)
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

  test('project-selection settings reflow inside the modal instead of using viewport breakpoints', () => {
    assert.match(modal, /size\?: 'sm' \| 'md' \| 'lg' \| 'xl' \| 'xxl'/)
    assert.match(modal, /\.size-xxl\s*{\s*max-width:\s*1120px/)
    assert.match(appSettingsModal, /size="xxl"/)
    assert.match(appSettingsModal, /dialog-class="app-settings-dialog"/)
    assert.match(appSettingsModal, /\.modal-body\s*{[\s\S]*overflow-y:\s*auto/)
    assert.match(thisMacSettings, /container-name:\s*this-mac-settings/)
    assert.match(thisMacSettings, /@container this-mac-settings \(max-width:\s*760px\)/)
    assert.match(serverModeSettings, /container-name:\s*server-mode-settings/)
    assert.match(serverModeSettings, /@container server-mode-settings \(max-width:\s*820px\)/)
    assert.match(serverModeSettings, /repeat\(auto-fit,\s*minmax\(180px,\s*1fr\)\)/)
  })
})
