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
    assert.match(sceneReviewSource, /:generate-label="finishMissingLabel"/)
    assert.match(sceneReviewSource, /`Finish \$\{missingCount\.value\} missing image\$\{missingCount\.value === 1 \? '' : 's'\} · may use credits`/)
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

  test('scene render controls use server-classified pause or cancellation and retain paused ownership', () => {
    assert.match(sceneReviewSource, /const sceneRenderControls = \(job: any\)/)
    assert.match(sceneReviewSource, /control\.action === 'pause-submissions'/)
    assert.match(sceneReviewSource, /control\.action === 'cancel-before-submit' \|\| control\.action === 'stop-local' \|\| control\.action === 'request-remote-cancel'/)
    assert.match(sceneReviewSource, /const action = control\.action === 'pause-submissions' \? 'pause' : \(isCancellation \? 'cancel' : null\)/)
    assert.match(sceneReviewSource, /post\(`\/projects\/\$\{slug\.value\}\/jobs\/\$\{job\.job_id\}\/\$\{action\}`, \{\}\)/)
    assert.doesNotMatch(sceneReviewSource, /del\(`\/projects\/\$\{slug\.value\}\/jobs\/\$\{job\.job_id\}`\)/)
    assert.match(sceneReviewSource, /Paused — awaiting explicit Resume/)
    assert.match(sceneReviewSource, /\/projects\/\$\{slug\.value\}\/jobs\/\$\{job\.job_id\}\/resume/)
    assert.match(sceneReviewSource, /resolveActiveSceneRenderJob\(episodeId\.value, activeRenderJobFromReview\.value, jobs\.value\)/)
    assert.ok((sceneReviewSource.match(/if \(reviewJobActive\.value\) return/g) || []).length >= 2)
    assert.match(sceneReviewSource, /if \(activeRenderJob\.value\?\.status === 'paused'\) return/)
  })

  test('a paused render is visibly paused, not loading, spinning, or regenerable', () => {
    assert.match(sceneReviewSource, /:generate-loading="\(bulkQueuing && !isRenderPaused\) \|\| isRendering"/)
    assert.doesNotMatch(sceneReviewSource, /:generate-loading="[^"\n]*reviewJobActive/)
    assert.match(sceneReviewSource, /<span v-if="!isRenderPaused && !isQueuedRender" class="review-spinner"/)
    assert.match(sceneReviewSource, /function isSceneGenerating\(scene: ReviewScene\): boolean \{\s*if \(isRenderPaused\.value\) return false/)
    assert.match(sceneReviewSource, /v-else[\s\S]*:class="\['review-thumb-empty', \{ 'is-disabled': usesImagePool \|\| reviewJobActive \}\]"[\s\S]*:aria-disabled="usesImagePool \|\| reviewJobActive"[\s\S]*@click="!usesImagePool && !reviewJobActive && generateOne\(scene\)"/)
    assert.match(sceneReviewSource, /:disabled="usesImagePool \|\| !form\.model \|\| regeneratingId === previewScene\.id \|\| reviewJobActive"/)
    assert.match(sceneReviewSource, /\.review-thumb-empty\.is-disabled[\s\S]*cursor:\s*not-allowed/)
    assert.match(sceneReviewSource, /Resume explicitly\. Story Studio audits saved files/)
  })

  test('a queued episode repair names its hold and links to Jobs', () => {
    assert.match(sceneReviewSource, /Queued for repair/)
    assert.match(sceneReviewSource, /const isQueuedRender = computed\(\(\) => activeRenderJob\.value\?\.status === 'queued'\)/)
    assert.match(sceneReviewSource, /:to="`\/projects\/\$\{slug\}\/jobs`"/)
    assert.match(sceneReviewSource, /<\/span>&nbsp;\s*<NuxtLink/)
    assert.match(sceneReviewSource, />Open Jobs<\/NuxtLink>/)
    assert.match(sceneReviewSource, /<small v-if="isSceneQueuedForRepair\(scene\)">Queued for repair<\/small>/)
    assert.match(sceneReviewSource, /<small v-else-if="isQueuedRecoveryRender">Another repair is queued<\/small>/)
    assert.match(sceneReviewSource, /<small v-else-if="isQueuedRender">Image job queued<\/small>[\s\S]*<small v-else-if="isRenderPaused">Image job paused<\/small>[\s\S]*<small v-else-if="isRendering">Image job running<\/small>[\s\S]*<small v-else>\(click to generate\)<\/small>/)
    assert.match(sceneReviewSource, /reviewJobActive \? sceneRenderBlockReason\(scene\)/)
  })

  test('live SSE state supersedes a matching paused review snapshot', () => {
    assert.match(sceneReviewSource, /import \{ resolveActiveSceneRenderJob \} from '~\/utils\/scene-render-job-state'/)
    assert.match(sceneReviewSource, /const activeRenderJob = computed\(\(\) => resolveActiveSceneRenderJob\(episodeId\.value, activeRenderJobFromReview\.value, jobs\.value\)\)/)
    assert.match(sceneReviewSource, /const activeContinuityRenderJob = computed\(\(\) => resolveActiveSceneRenderJob\(episodeId\.value, activeRenderJobFromReview\.value, jobs\.value, \['continuity_render', 'scene_images_batch'\]\)\)/)
    assert.match(sceneReviewSource, /const isRenderPaused = computed\(\(\) => activeRenderJob\.value\?\.status === 'paused'\)/)
    assert.match(sceneReviewSource, /const isRendering = computed\(\(\) => !!activeRenderJob\.value && !isRenderPaused\.value\)/)
    // Single-flight polling: the next read is armed only after the previous
    // one settles, and no fixed interval can pile reads up behind a slow server.
    assert.match(sceneReviewSource, /watch\(isRendering,[\s\S]*armRenderPoll\(\)/)
    assert.doesNotMatch(sceneReviewSource, /setInterval\(/)
    assert.match(sceneReviewSource, /sceneRenderControls\(activeContinuityRenderJob\)/)
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
    // v1.4.82 — the code is now passed so the SERVER drops that episode's
    // cached status too; without it the refresh returned the pre-approval answer.
    assert.match(sceneReviewSource, /void revalidateAfterMutation\(episodeCode\)\.catch/)
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

  test('review preset controllers are recreated when the project route changes', () => {
    assert.match(sceneReviewSource, /definePageMeta\(\{ layout: 'dashboard', key: route => String\(route\.params\.slug \|\| ''\) \}\)/)
    assert.match(motionReviewSource, /definePageMeta\(\{ layout: 'dashboard', key: route => String\(route\.params\.slug \|\| ''\) \}\)/)
  })

  test('an exact Jobs deep link selects the episode and focuses the requested Scene Review row', () => {
    assert.match(sceneReviewSource, /route\.query\.scene_id/)
    assert.match(sceneReviewSource, /pendingSceneDeepLink/)
    assert.match(sceneReviewSource, /await jumpToScene\(sceneId, \{ focus: true \}\)/)
    assert.match(sceneReviewSource, /el\.focus\(\{ preventScroll: true \}\)/)
    const focusFlow = sceneReviewSource.slice(
      sceneReviewSource.indexOf('async function focusPendingScene'),
      sceneReviewSource.indexOf("watch(() => route.query.episode_id"),
    )
    assert.ok(
      focusFlow.indexOf('await router.replace({ query })') < focusFlow.indexOf('await jumpToScene(sceneId, { focus: true })'),
      'query cleanup must finish before final row focus so navigation cannot steal focus',
    )
    assert.match(focusFlow, /document\.activeElement\?\.id === `sr-scene-\$\{sceneId\}`/)
  })

  test('the subtitle rendering guard distinguishes a measured gap from an incomplete timeline', () => {
    assert.match(sceneReviewSource, /blocking_cue_gaps\?\.length/)
    assert.match(sceneReviewSource, /subtitle timeline is incomplete/i)
  })
})
