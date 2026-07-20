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
