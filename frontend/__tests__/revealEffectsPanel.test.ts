/**
 * Reveal effects — the separate Sketch Draw step, and the Video Assembly readback it feeds.
 *
 * Owner correction (2026-11-06): Motion Review and Sketch Draw are their own step
 * OUTSIDE Video Assembly. The Video Assembly title/chapter popup must not offer
 * scene motion, Sketch Draw or reveal controls, and must not carry a staged reroll
 * plan. What this file now protects:
 *
 *   1. **The separate step owns the controls.** The pen, reveal style, line weight
 *      and closing hold live in Motion Review.
 *   2. **Reveals are off by default.** A reveal changes how an episode looks, so it
 *      is never a silent default.
 *   3. **Saved values are still read and written unchanged.** Video Assembly's draft
 *      and Timeline preset carry the episode's own `scene_reveal` / `scene_animation`
 *      values through Apply, without re-deciding them.
 *   4. **The render payload is unchanged.** The assembly still sends exactly the
 *      reveal fields the engine reads, so existing output does not change.
 *
 * The page is read as source rather than mounted: it is a large component whose mount
 * cost is the whole pipeline, and every property here is about which fields travel where.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')
const io = readFileSync(new URL('../composables/useVideoAssemblyIo.ts', import.meta.url), 'utf8')
const motionReview = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')

test('the separate Motion Review / Sketch Draw step owns the reveal controls', () => {
  assert.match(motionReview, /<option value="sketch_draw">Sketch Draw<\/option>/)
  assert.match(motionReview, /<SketchRevealPicker/)
  assert.match(motionReview, /Sketch Draw reveal style for this episode/)
  assert.match(motionReview, /Sketch Draw line weight for this episode/)
  assert.match(motionReview, /Sketch Draw closing hold for this episode/)
})

test('Video Assembly no longer offers scene motion, Sketch Draw or reveal controls', () => {
  const template = page.slice(0, page.indexOf('<script setup'))
  assert.doesNotMatch(template, /<AnimationPicker/)
  assert.doesNotMatch(template, /Sketch Draw reveal effects/)
  assert.doesNotMatch(template, /scene_reveal\./)
  assert.doesNotMatch(template, /Show Planned Arrivals|Refresh Plan|Reroll on Apply/)
})

test('no staged reveal reroll machinery survives in Video Assembly', () => {
  assert.doesNotMatch(page, /stagedRevealRerolls|stageRevealReroll|flushStagedRevealRerolls/)
  assert.doesNotMatch(page, /video-editor\/reveals\/plan|video-editor\/reveals\/scene-choice/)
})

test('reveals are off by default in the saved state', () => {
  assert.match(page, /const sceneReveal = reactive\(\{\s*\n\s*enabled: false,/)
})

test('the draft still reads, applies and writes the saved reveal and motion values', () => {
  assert.match(page, /scene_reveal: revealBundleSnapshot\(\)/)
  assert.match(page, /scene_animation: sceneAnimation/)
  assert.match(page, /scene_animation: value\.timeline\.scene_animation/)
  assert.match(page, /scene_reveal: value\.timeline\.scene_reveal/)
  assert.match(page, /applyRevealBundle\(\{ scene_reveal: value\.timeline\.scene_reveal \}\)/)
  assert.match(page, /Object\.assign\(sceneAnimation, value\.timeline\.scene_animation\)/)
})

test('the render payload carries the same reveal fields the engine reads', () => {
  assert.match(io, /scene_reveal: s\.sceneReveal/)
  assert.match(io, /scene_animation: \{ \.\.\.s\.sceneAnimation \}/)
  for (const field of ['enabled', 'pace', 'coherence', 'seed', 'cap_per_effect', 'no_immediate_repeat', 'pool']) {
    assert.match(io, new RegExp(`${field}:`), `the render payload must still carry ${field}`)
  }
})

test('the Timeline preset still carries the look and never the seed', () => {
  const presets = page.slice(page.indexOf('const timelinePresets = usePresets('))
  const snapshot = presets.slice(presets.indexOf('scene_reveal:'), presets.indexOf('}),', presets.indexOf('scene_reveal:')))
  assert.match(snapshot, /revealBundleSnapshot\(\)/)
  assert.ok(!/seed:/.test(snapshot),
    'the seed is per episode: a preset that restored one would make two episodes share a randomisation')
  assert.match(page, /applyRevealBundle\(data\)/)
})
