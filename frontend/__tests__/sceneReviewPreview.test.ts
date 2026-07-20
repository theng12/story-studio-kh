import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const sceneReviewSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)
const motionReviewSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url)),
  'utf8',
)
const videoAssemblySource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url)),
  'utf8',
)

describe('Scene Review image preview', () => {
  test('render controls use balanced model columns and one GenStudio quality control', () => {
    assert.match(sceneReviewSource, /class="sr-model-grid"[\s\S]*Image model[\s\S]*Rewrite LLM/)
    assert.match(sceneReviewSource, /\.sr-model-grid\s*{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
    assert.match(sceneReviewSource, /id="sr-gen-quality"[\s\S]*Custom steps…/)
    assert.match(sceneReviewSource, /v-if="form\.image_quality === 'custom'"[\s\S]*for="sr-gen-steps">Custom steps/)
    assert.doesNotMatch(sceneReviewSource, /\.sr-llm-pick\s*{\s*display:\s*inline-flex/)
  })

  test('resolution ownership is explicit instead of inventing cloud pixel controls', () => {
    assert.match(sceneReviewSource, /v-if="isLocalModel"[\s\S]*for="sr-size">Resolution/)
    assert.match(sceneReviewSource, /id="sr-gen-size"[\s\S]*selectedGenStudioSizes/)
    assert.match(sceneReviewSource, /Managed by GenStudio/)
    assert.match(sceneReviewSource, /pixel sizes not published/)
    assert.match(sceneReviewSource, /genstudio_size: form\.value\.genstudio_size/)
    assert.match(sceneReviewSource, /width: selectedGenStudioSize\.value\.width, height: selectedGenStudioSize\.value\.height/)
  })

  test('generated-image auto approval is opt-in, preset-saved, and sent through every render action', () => {
    assert.match(sceneReviewSource, /const autoApproveGenerated = ref\(false\)/)
    assert.match(sceneReviewSource, /auto_approve_generated: autoApproveGenerated\.value/)
    assert.match(sceneReviewSource, /autoApproveGenerated\.value = data\.auto_approve_generated === true/)
    assert.match(sceneReviewSource, /Auto-approve generated images/)
    assert.ok(
      (sceneReviewSource.match(/auto_approve_generated: autoApproveGenerated\.value/g) || []).length >= 5,
      'single, repair, missing, continuity, and selected render requests must carry the preset choice',
    )
  })

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

  test('a fully approved episode offers direct, episode-specific next steps', () => {
    assert.match(sceneReviewSource, /v-if="stats\.all_approved && episodeId"[\s\S]*Motion Review \(optional\)/)
    assert.match(sceneReviewSource, /:to="motionReviewLink"/)
    assert.match(sceneReviewSource, /:to="videoAssemblyLink"/)
    assert.match(sceneReviewSource, /const motionReviewLink = computed\(\(\) => `\/projects\/\$\{slug\.value\}\/motion-review\?episode_id=\$\{encodeURIComponent\(episodeId\.value\)\}`\)/)
    assert.match(sceneReviewSource, /const videoAssemblyLink = computed\(\(\) => `\/projects\/\$\{slug\.value\}\/video-assembly\?episode_id=\$\{encodeURIComponent\(episodeId\.value\)\}`\)/)
  })

  test('Motion Review and Video Assembly restore the handed-off episode', () => {
    assert.match(motionReviewSource, /const initialEpisodeId = typeof route\.query\.episode_id === 'string'/)
    assert.match(motionReviewSource, /const episodeId = ref\(initialEpisodeId\)/)
    assert.match(videoAssemblySource, /const initialEpisodeId = typeof route\.query\.episode_id === 'string'/)
    assert.match(videoAssemblySource, /const episodeId = ref\(initialEpisodeId\)/)
  })
})
