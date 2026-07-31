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
  test('render controls expose one GenStudio image model and no invented step control', () => {
    assert.match(sceneReviewSource, /class="sr-model-grid is-single"[\s\S]*Image model/)
    assert.match(sceneReviewSource, /image-mode="text2img"/)
    assert.doesNotMatch(sceneReviewSource, /Rewrite LLM|Rewrite with AI|<ModelSelector/)
    assert.match(sceneReviewSource, /\.sr-model-grid\.is-single\s*{\s*grid-template-columns:\s*minmax\(0, 1fr\)/)
    // GenStudio publishes no step contract and accepts no `steps` field, so
    // the page must not offer a quality/steps control driving a phantom value.
    assert.doesNotMatch(sceneReviewSource, /sr-gen-quality|sr-gen-steps|image_steps|image_quality:|genStudioQualitySteps/)
  })

  test('resolution ownership comes only from the live GenStudio catalog', () => {
    // No pixel menu: `sizes` was never published, so nothing selects one and
    // nothing falls back to a hardcoded table.
    assert.doesNotMatch(sceneReviewSource, /sr-gen-size|selectedGenStudioSizes|genstudio_size|genStudioSizeKey/)
    assert.match(sceneReviewSource, /Managed by GenStudio/)
    assert.match(sceneReviewSource, /selectedGenStudioModel\?\.default_resolution/)
    // Seed is offered only where GenStudio publishes support for one.
    assert.match(sceneReviewSource, /selectedGenStudioModel\.supports_seed !== false/)
    assert.doesNotMatch(sceneReviewSource, /isLocalModel|render_scale|imagestudio:/)
  })

  test('generated-image auto approval is opt-in, preset-saved, and sent through every render action', () => {
    assert.match(sceneReviewSource, /const autoApproveGenerated = ref\(false\)/)
    assert.match(sceneReviewSource, /auto_approve_generated: autoApproveGenerated\.value/)
    assert.match(sceneReviewSource, /autoApproveGenerated\.value = data\.auto_approve_generated === true/)
    assert.match(sceneReviewSource, /Auto-approve generated images/)
    assert.ok(
      (sceneReviewSource.match(/auto_approve_generated: autoApproveGenerated\.value/g) || []).length >= 3,
      'single, missing, and selected render requests must carry the preset choice',
    )
  })

  test('legacy render modes and duplicate actions are removed at the surface', () => {
    assert.doesNotMatch(sceneReviewSource, /render_mode|form\.concurrency|Render sequentially|Render in parallel|Generate \(refs\)|🛠 Repair|⛓ From here|showLivePreview|mode === 'independent'/)
    assert.match(sceneReviewSource, /generate-label="Generate all missing"/)
    assert.match(sceneReviewSource, /Generate image/)
    assert.match(sceneReviewSource, /Regenerate image/)
    assert.match(sceneReviewSource, /Upload replacement…/)
    assert.match(sceneReviewSource, /Approve/)
    assert.match(sceneReviewSource, /configKey: 'scene_review_genstudio'/)
    assert.doesNotMatch(sceneReviewSource, /configKey: 'scene_review'/)
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

  test('approval publishes completion to the shared pending list immediately', () => {
    assert.match(sceneReviewSource, /const \{ updateEpisode: updateCachedEpisode, revalidateAfterMutation \} = useEpisodes\(slug\)/)
    assert.match(sceneReviewSource, /function publishReviewCompletion\(episodeCode: string, reviewStats: ReviewStats\)/)
    assert.match(sceneReviewSource, /updateCachedEpisode\(episodeCode,[\s\S]*scene_review: reviewStats\.all_approved/)
    assert.match(sceneReviewSource, /void revalidateAfterMutation\(\)\.catch/)
    assert.ok(
      (sceneReviewSource.match(/publishReviewCompletion\(episodeId\.value, r\.stats\)/g) || []).length >= 2,
      'single and bulk approval must both synchronize the pending episode list',
    )
  })

  test('Motion Review and Video Assembly restore the handed-off episode', () => {
    assert.match(motionReviewSource, /const initialEpisodeId = typeof route\.query\.episode_id === 'string'/)
    assert.match(motionReviewSource, /const episodeId = ref\(initialEpisodeId\)/)
    assert.match(videoAssemblySource, /const initialEpisodeId = typeof route\.query\.episode_id === 'string'/)
    assert.match(videoAssemblySource, /const episodeId = ref\(initialEpisodeId\)/)
  })
})
