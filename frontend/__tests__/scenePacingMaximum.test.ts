import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * v1.4.82 — Scene Review used to flag "Ns long" against a hardcoded 20 seconds,
 * so it accused scenes the episode's OWN pacing band considers perfectly fine
 * and stayed silent about ones that band considers too long. Scene Plan already
 * read the configured maximum; Scene Review now reads the same source.
 */
const sceneReview = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)
const scenePlan = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
  'utf8',
)

test('Scene Review flags over-long scenes against the configured pacing maximum, not a constant', () => {
  assert.doesNotMatch(sceneReview, /const OVERLONG_SEC/, 'the hardcoded over-long constant is gone')
  assert.match(
    sceneReview,
    /const pacingMaximumSec = computed\(\(\) => continuityPacing\.value\?\.max_sec \|\| 20\)/,
    'Scene Review derives the maximum from the episode continuity config',
  )
  assert.match(
    sceneReview,
    /if \(dur > pacingMaximumSec\.value\) reasons\.push/,
    'the health flag compares against the configured maximum',
  )
})

test('Scene Review and Scene Plan derive the pacing maximum identically', () => {
  const shared = /const pacingMaximumSec = computed\(\(\) => continuityPacing\.value\?\.max_sec \|\| 20\)/
  assert.match(scenePlan, shared, 'Scene Plan is the pattern being matched')
  assert.match(sceneReview, shared, 'Scene Review must not drift from it')
})

test('Scene Review re-reads the pacing band when the episode changes', () => {
  // Loading it only in onMounted left the flag judging episode B against
  // episode A's maximum.
  assert.match(
    sceneReview,
    /watch\(\[slug, episodeId\], \(\) => \{[\s\S]*?void loadContinuityFlag\(\)[\s\S]*?\}, \{ immediate: true, flush: 'sync' \}\)/,
    'the continuity read is wired to the project-and-episode watcher immediately',
  )
  assert.match(
    sceneReview,
    /continuityPacing\.value = r\?\.config\?\.pacing \|\| null/,
    'and it stores the episode pacing it fetched',
  )
})
