/**
 * Wiring for the Scene Plan / Scene Review images audit (2026-10). Runtime
 * behaviour is covered in scenePlanLoading / sceneReviewFinishMissing; these
 * pin the template guards that a mount cannot isolate cheaply.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const scenePlan = fs.readFileSync(path.resolve(process.cwd(), 'pages/projects/[slug]/scene-plan.vue'), 'utf-8')
const sceneReview = fs.readFileSync(path.resolve(process.cwd(), 'pages/projects/[slug]/scene-review.vue'), 'utf-8')

function buttonFor(source: string, label: RegExp): string {
  const match = label.exec(source)
  assert.ok(match, `button ${label} exists`)
  const start = source.lastIndexOf('<button', match!.index)
  return source.slice(start, match!.index)
}

test('Scene Plan bulk Cancel uses the queue cancel route, never the terminal-only delete', () => {
  assert.match(scenePlan, /post\(`\/projects\/\$\{slug\.value\}\/jobs\/\$\{jobId\}\/cancel`, \{\}\)/)
  assert.doesNotMatch(scenePlan, /del\(`\/projects\/\$\{slug\.value\}\/jobs\//)
  assert.match(scenePlan, /if \(finalStatus === 'cancelled'\)/)
})

test('every action that reloads the plan is disabled while edits are unsaved or a plan job runs', () => {
  for (const label of [/'✨ Prompt Only' \}\}/, /'🛡 Reword' \}\}/, /'🎬 Regen Motion' \}\}/]) {
    const button = buttonFor(scenePlan, label)
    assert.match(button, /\|\| dirty/, `${label} waits for Save`)
    assert.match(button, /planBusy/, `${label} waits for the running job`)
    assert.match(button, /Save your scene edits first/)
  }
  assert.equal((scenePlan.match(/!visualPendingCount \|\| planning \|\| planJobActive \|\| dirty"/g) || []).length, 2)
  assert.equal((scenePlan.match(/!motionPendingCount \|\| planning \|\| planJobActive \|\| dirty"/g) || []).length, 2)
})

test('the scene list stays visible during a job, with stage-specific progress', () => {
  assert.match(scenePlan, /<section v-if="plan \|\| planBusy"/)
  assert.match(scenePlan, /<template v-if="plan">/)
  assert.doesNotMatch(scenePlan, /LLM is planning/)
  assert.match(scenePlan, /Building the timeline from your subtitles/)
})

test('single-scene prompt jobs are tracked so a failure is shown at once', () => {
  assert.equal((scenePlan.match(/pollUntilPlanLanded\(ep, \{ previousGeneratedAt, trackJobId: job\?\.job_id \|\| null \}\)/g) || []).length, 2)
  assert.match(scenePlan, /showError\(customerSafeJobText\(j\.error/)
})

test('Rebuild Timeline is a danger confirmation naming the safe alternative', () => {
  assert.match(scenePlan, /title: 'Start every scene over\?'[\s\S]{0,600}Reconcile timings[\s\S]{0,200}danger: true/)
})

test('links carry the open episode', () => {
  assert.doesNotMatch(scenePlan, /:to="`\/projects\/\$\{slug\}\/(subtitles|video-assembly|character-sheet)`"/)
  assert.doesNotMatch(sceneReview, /:to="`\/projects\/\$\{slug\}\/scene-plan`"/)
  assert.match(sceneReview, /scene-plan\?episode_id=\$\{encodeURIComponent\(episodeId\.value\)\}/)
})

test('Scene Review bulk re-render is offered for every format, like Finish', () => {
  assert.doesNotMatch(sceneReview, /v-if="isContinuity/)
})

test('Scene Review clears the previous episode on switch and says it is loading', () => {
  assert.match(sceneReview, /watch\(\[slug, episodeId\][\s\S]*?scenes\.value = \[\][\s\S]*?stats\.value = null[\s\S]*?activeRenderJobFromReview\.value = null[\s\S]*?void loadReview\(\)/)
  assert.match(sceneReview, /Loading episode…/)
})

test('Scene Review guards bulk approval, oversized uploads, and stray polls', () => {
  assert.match(sceneReview, /title: 'Un-approve every scene\?'/)
  assert.match(sceneReview, /drawn from an older prompt/)
  assert.match(sceneReview, /file\.size > MAX_UPLOAD_IMAGE_BYTES/)
  assert.match(sceneReview, /if \(!renderPollActive\) await loadReview\(\)/)
  assert.doesNotMatch(sceneReview, /Greenlight panel|secure action id|Managed by provider/)
})
