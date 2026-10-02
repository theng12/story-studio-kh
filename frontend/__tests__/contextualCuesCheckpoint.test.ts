import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/contextual-cues.vue', import.meta.url)),
  'utf8',
)

test('Contextual Cues exposes saved partial batches without presenting them as complete', () => {
  assert.match(page, /proposal_progress/)
  assert.match(page, /Saved partial proposal/)
  // This page has no Retry button: pressing Propose cues again is what continues.
  assert.doesNotMatch(page, /Retry resumes/)
  assert.match(page, /Press Propose cues with the same model and settings and it continues from where it stopped/)
  assert.match(page, /Video Assembly still treats this timeline as incomplete/)
  assert.match(page, /aria-label="Saved partial contextual cue preview"/)
  assert.match(page, /read-only until every batch finishes/)
})

test('a running proposal pauses edits, and says so on screen', () => {
  assert.match(page, /A proposal is running — edits are paused until it finishes\./)
  assert.match(page, /<fieldset class="cue-rows" :disabled="cueJobActive">/)
  assert.match(page, /:disabled="saving \|\| cueJobActive"/, 'Approve all is paused too')
  assert.match(page, /function startCueDrag[^}]*if \(cueJobActive\.value\) return/)
})

test('a refused save keeps its issues and marks the cues at fault', () => {
  assert.match(page, /Array\.isArray\(e\?\.data\?\.issues\)/)
  assert.match(page, /if \(issues\.length\) validation\.value = issues/)
  assert.match(page, /cueErrors\.get\(cue\.id\)/)
})

test('the preset auto-approve says it is unused while the project setting approves', () => {
  assert.match(page, /:disabled="config\.auto_approve_cues" @change="onAutoApproveEdited"/)
  assert.match(page, /Not used — the project setting above already approves each safe cue\./)
})

test('a failed on/off save puts the switch back, and errors are titled for what they are', () => {
  assert.match(page, /config\.value\.enabled = previousEnabled/)
  assert.match(page, /\/Scene Plan\/\.test\(loadError\)/)
  assert.doesNotMatch(page, /timelineProjectSlug\.value\}\/\$\{timelineEpisodeId/, 'no "slug/EP0012" in a message')
  assert.doesNotMatch(page, /Retry submission/)
})
