import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sceneReview = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)
const scenePlan = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
  'utf8',
)
const visualTimingMotion = readFileSync(
  fileURLToPath(new URL('../components/VisualTimingMotion.vue', import.meta.url)),
  'utf8',
)
const sceneReviewRoute = readFileSync(
  fileURLToPath(new URL('../../electron/server/routes/scene-review.ts', import.meta.url)),
  'utf8',
)
const scenePlanRoute = readFileSync(
  fileURLToPath(new URL('../../electron/server/routes/scene-plan.ts', import.meta.url)),
  'utf8',
)
const { pacingBandAt, parseSavedScenePlanPacing, parseScenePacing } = await import('../../electron/server/contracts/pacing.js')

test('Scene Review flags over-long scenes against the pacing saved with the plan', () => {
  assert.doesNotMatch(sceneReview, /const OVERLONG_SEC|\|\| 20/, 'no hardcoded over-long fallback remains')
  assert.match(
    sceneReviewRoute,
    /pacing: plan\.pacing === undefined \? undefined : parseSavedScenePlanPacing\(plan\.pacing\)/,
    'the review response normalizes historical plan timing without rewriting it',
  )
  assert.match(sceneReview, /pacing\?: ScenePacing/, 'the page retains that snapshot with the plan metadata')
  assert.match(
    sceneReview,
    /function pacingMaximumSecAt\(scene: ReviewScene\): number \{[\s\S]*?pacingBandAt\(plan\.value\.pacing, scene\.start_sec\)\.max_sec[\s\S]*?: Infinity/,
    'missing legacy plan timing stays unknown instead of inventing a cap',
  )
  assert.match(sceneReview, /if \(dur > pacingMaximumSecAt\(s\)\) reasons\.push/)
})

test('Scene Review and Scene Plan resolve variable pacing at each scene start', () => {
  assert.match(
    scenePlanRoute,
    /pacing: parseSavedScenePlanPacing\(scenePlan\.pacing\)/,
    'the plan workspace receives the same canonical pacing contract as review',
  )
  assert.match(scenePlan, /pacingBandAt\(plan\.value\.pacing, scene\.start_sec\)\.max_sec/)
  assert.match(sceneReview, /pacingBandAt\(plan\.value\.pacing, scene\.start_sec\)\.max_sec/)
  assert.match(
    visualTimingMotion,
    /pacing\.mode === 'variable'[\s\S]*?pacing\.periods\.length}[\s\S]*?ordered periods/,
    'the canonical panel labels historical documentary plans as variable periods',
  )

  const pacing = parseScenePacing({
    mode: 'variable',
    periods: [
      { start_sec: 0, end_sec: 20, min_sec: 1, max_sec: 3 },
      { start_sec: 20, end_sec: null, min_sec: 6, max_sec: 12 },
    ],
  })
  assert.equal(pacingBandAt(pacing, 19.999).max_sec, 3)
  assert.equal(pacingBandAt(pacing, 20).max_sec, 12)

  const documentary = parseSavedScenePlanPacing({
    mode: 'documentary',
    min_sec: 2,
    max_sec: 4,
    opening_duration_sec: 30,
    settled_min_sec: 8,
    settled_max_sec: 12,
  })
  assert.equal(documentary.mode, 'variable')
  assert.equal(pacingBandAt(documentary, 29.999).max_sec, 4)
  assert.equal(pacingBandAt(documentary, 30).max_sec, 12)
})

test('Scene Review reloads saved plan pacing when the episode changes', () => {
  assert.match(sceneReview, /plan\.value = r\.scene_plan/)
  assert.match(
    sceneReview,
    /watch\(\[slug, episodeId\], \(\) => \{[\s\S]*?void loadReview\(\)[\s\S]*?\}, \{ immediate: true, flush: 'sync' \}\)/,
  )
  assert.doesNotMatch(
    sceneReview,
    /\/continuity\/\$\{ep\}/,
    'a next-plan draft must not reclassify timings saved by an existing plan',
  )
})
