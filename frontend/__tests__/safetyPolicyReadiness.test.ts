import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const scenePlan = readFileSync(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url), 'utf8')
const sceneReview = readFileSync(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url), 'utf8')
const subtitles = readFileSync(new URL('../pages/projects/[slug]/subtitles.vue', import.meta.url), 'utf8')
const jobs = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')

describe('caption-gap readiness policy callers', () => {
  test('Scene Plan keeps measured gaps visible without calling Warn or Off a refusal', () => {
    assert.match(scenePlan, /caption_gap_mode\?: 'off' \| 'warn' \| 'block'/)
    assert.match(scenePlan, /captionGapBlocks \? 'Do not rebuild or re-plan yet\.' : 'Scene Plan can continue\.'/)
    assert.match(scenePlan, /status\.value\?\.timeline_integrity\?\.complete !== false/)
  })

  test('Scene Review uses projected completeness for controls and renders advisory gaps as warnings', () => {
    assert.match(sceneReview, /:tone="subtitleIntegrity\.complete \? 'warning' : 'error'"/)
    assert.match(sceneReview, /subtitleTimelineMissing\s*\? 'Scene rendering paused: subtitle timeline is incomplete'/)
    assert.match(sceneReview, /captionGapBlocks \? 'Scene rendering paused: subtitle coverage gap' : 'Subtitle coverage warning'/)
    assert.match(sceneReview, /subtitleIntegrity\.value\?\.complete === true && missingImagePromptsComplete\.value/)
  })

  test('Subtitles distinguishes measured gaps from policy-blocking readiness', () => {
    assert.match(subtitles, /const hasMeasuredCueGaps = computed/)
    assert.match(subtitles, /:tone="subtitleTimelineIntegrity\.complete \? 'warning' : 'error'"/)
    assert.match(subtitles, /subtitleTimelineIntegrity\.value\?\.complete === true/)
    assert.doesNotMatch(subtitles, /hasBlockingCueGaps/)
  })

  test('Jobs offers current gap repair only when caption gaps are configured to Block', () => {
    assert.match(jobs, /status\.timeline_integrity\?\.caption_gap_mode === 'block' && gaps\.length/)
  })
})
