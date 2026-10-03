import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { featureGuides } from '../composables/useFeatureGuide'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('Video Assembly Step 1 needs merged audio; chapter audio alone points to Audio Assembly', () => {
  const page = read('../pages/projects/[slug]/video-assembly.vue')
  const valid = page.slice(page.indexOf('const step1Valid = computed'), page.indexOf('const canProceed'))
  assert.match(valid, /hasMergedAudio\.value/)
  assert.doesNotMatch(valid, /audio_sections/, 'chapter audio must not satisfy Step 1 (the render needs merged audio)')
  const block = page.slice(page.indexOf('data-testid="merged-audio-missing"'))
  assert.match(block.slice(0, 900), /Merge the chapter audio first — the video uses the merged narration\./)
  assert.match(block.slice(0, 1200), /\/audio-merge[\s\S]{0,200}Open Audio Assembly/)
})

test('Outline expansion sends the Scripts page voice text, not a field the form never had', () => {
  const panel = read('../components/OutlineReviewPanel.vue')
  assert.doesNotMatch(panel, /form\?\.custom_style_text/)
  assert.match(panel, /custom_style_text: props\.customStyleText/)
  const scripts = read('../pages/projects/[slug]/scripts.vue')
  assert.match(scripts, /<OutlineReviewPanel[\s\S]{0,700}:custom-style-text="customStyleText"/)
})

test('Research help never says research blocks or is required', () => {
  const research = featureGuides.research
  const text = JSON.stringify(research) + JSON.stringify(featureGuides.pipeline)
  assert.doesNotMatch(text, /Research blocks completion|channel requires it|research is required/i)
  assert.match(JSON.stringify(research.tips), /Research is optional\. It never blocks/)
  assert.match(JSON.stringify(featureGuides.pipeline.tips), /Research is always optional/)
  assert.doesNotMatch(read('../pages/projects/[slug]/research.vue'), /whether it needs research/)
})
