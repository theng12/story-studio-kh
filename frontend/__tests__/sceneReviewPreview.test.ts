import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const sceneReviewSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)

describe('Scene Review image preview', () => {
  test('the full thumbnail cell opens the preview for mouse and keyboard users', () => {
    assert.match(sceneReviewSource, /class="review-thumb-cell"[\s\S]*@click="scene\.image_filename && openPreview\(scene\)"/)
    assert.match(sceneReviewSource, /@keydown\.enter\.prevent="scene\.image_filename && openPreview\(scene\)"/)
    assert.match(sceneReviewSource, /@keydown\.space\.prevent="scene\.image_filename && openPreview\(scene\)"/)
  })

  test('render status cannot block preview clicks', () => {
    assert.match(sceneReviewSource, /\.review-thumb-overlay\s*{[\s\S]*pointer-events:\s*none;/)
  })

  test('the preview is teleported above the clipped dashboard', () => {
    assert.match(sceneReviewSource, /<Teleport to="body">[\s\S]*class="sr-lightbox"/)
    assert.match(sceneReviewSource, /\.sr-lightbox\s*{[\s\S]*z-index:\s*10000;/)
    assert.match(sceneReviewSource, /role="dialog"[\s\S]*aria-modal="true"/)
  })
})
