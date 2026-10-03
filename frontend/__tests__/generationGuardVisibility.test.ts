import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const actionBar = source('../components/TopActionBar.vue')
const images = source('../components/ImageGeneratorPanel.vue')
const audio = source('../components/AudioChapterSelector.vue')
const pipeline = source('../pages/projects/[slug]/pipeline.vue')
const scenePlan = source('../pages/projects/[slug]/scene-plan.vue')

test('TopActionBar makes generation status persistent and describes the CTA', () => {
  assert.match(actionBar, /generate-status-/)
  assert.match(actionBar, /aria-describedby/)
  assert.match(actionBar, /generateStatusSentence/)
})

test('image and audio controls expose recovery reasons in readable text', () => {
  assert.match(images, /A render is already in progress for this episode/)
  assert.match(audio, /inlineGenerateDisabledReason/)
  assert.match(audio, /cs-inline-reason/)
})

test('pipeline and scene plan pass blocking reasons beside their primary actions', () => {
  assert.match(pipeline, /pipelineGenerateStatus/)
  assert.match(pipeline, /blockingIssues\.value\[0\]/)
  assert.match(scenePlan, /headerPrimaryStatus/)
  assert.match(scenePlan, /planDisabledReason/)
})
