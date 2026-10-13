/** Scene Review: the safe "Check Again" leads, and the attention chips stop at 12 + "+N more". */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url), 'utf8')

test('Check Again stays visible while Replace Anyway is gated by the strict shared preference', () => {
  assert.match(page, /const manualRedoPreferenceEnabled = ref\(false\)/)
  assert.match(page, /get<ManualRedoSetting>\('\/app-settings\/manual-generation-redo', \{ cache: 'no-store' \}\)/)
  assert.match(page, /manualRedoPreferenceEnabled\.value = setting\?\.enabled === true/)
  assert.match(page, /catch[\s\S]*?manualRedoPreferenceEnabled\.value = false/)
  assert.match(page, /class="btn btn-sm btn-primary" :disabled="checkingUncertain \|\| replacingUncertain" @click="checkUncertainAgain"/)
  assert.match(page, /v-if="manualRedoPreferenceEnabled" class="btn btn-sm btn-warn" :disabled="replacingUncertain \|\| checkingUncertain" @click="replaceUncertainImages"/)
  assert.match(page, /if \(!manualRedoPreferenceEnabled\.value \|\| !source \|\| replacingUncertain\.value\) return/)
})

test('ordinary scene image actions remain independent from manual replacement exposure', () => {
  assert.match(page, /@generate="finishMissingImages"/)
  assert.match(page, /@click="generateOne\(scene\)"/)
  assert.match(page, /@click="retryFailedRender"/)
  assert.doesNotMatch(page, /manualRedoPreferenceEnabled[\s\S]{0,100}@generate="finishMissingImages"/)
})

test('replacement confirmation and replay identity reset on project, episode, or source changes', () => {
  assert.match(page, /type ManualFinishAction = \{ slug: string; episodeId: string; sourceJobId\?: string; id: string \}/)
  assert.match(page, /nextManualFinishActionId\(replaceAction, \{ slug: projectSlug, episodeId: ep, sourceJobId \}\)/)
  assert.match(page, /replaceConfirmationOpen\.value = true[\s\S]*?await ask\([\s\S]*?finally \{ replaceConfirmationOpen\.value = false \}/)
  assert.match(page, /function resetUncertainReplacementUi\(\)[\s\S]*?replaceAction\.value = null[\s\S]*?cancelConfirm\(\)/)
  assert.match(page, /watch\(\(\) => replaceableUncertainJob\.value\?\.job_id \|\| '',[\s\S]*?resetUncertainReplacementUi\(\)/)
  assert.match(page, /slug\.value !== projectSlug \|\| episodeId\.value !== ep \|\| replaceableUncertainJob\.value\?\.job_id !== sourceJobId/)
  assert.match(page, /action_id: actionId,[\s\S]*?source_job_id: sourceJobId/)
})

test('attention chips: first 12, then "+N more", reset on an episode change', () => {
  assert.match(page, /const PROBLEM_CHIP_LIMIT = 12/)
  assert.match(page, /v-for="p in shownProblemScenes"/)
  assert.match(page, /v-if="hiddenProblemCount > 0"[\s\S]*?@click="showAllProblems = true"[\s\S]*?>\+\{\{ hiddenProblemCount \}\} more</)
  assert.match(page, /watch\(episodeId, \(\) => \{ showAllProblems\.value = false \}\)/)
  assert.doesNotMatch(page, /v-for="p in problemScenes"/)
})
