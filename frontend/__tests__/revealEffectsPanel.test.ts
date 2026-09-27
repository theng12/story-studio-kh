/**
 * Reveal effects on the Video Assembly page — the settings, the plan, and the reroll.
 *
 * The engine (1.4.229) and the assembly integration (1.4.232) are pinned elsewhere; what these
 * tests protect is the surface between them:
 *
 *   1. **Off by default.** A reveal changes how an episode looks, so it is never a silent default,
 *      and the plan is not even asked for while it is off.
 *   2. **The panel sends exactly what the engine reads.** A control the engine does not read, or a
 *      field the panel forgets, is a setting that does nothing — the shape of defect this repo has
 *      paid for more than once.
 *   3. **A reroll is a stored, per-scene choice, and it is a NEW choice** — the reroll number
 *      travels with it so the same preset picked twice is not mistaken for the stored one.
 *   4. **The animation preset carries the look and never the seed.** One seed per episode is the
 *      design's rule; a preset that restored a seed would make two episodes share a randomisation.
 *
 * The page is read as source rather than mounted: it is a 6,000-line component whose mount cost is
 * the whole pipeline, and every property here is about which fields travel where.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')
const io = readFileSync(new URL('../composables/useVideoAssemblyIo.ts', import.meta.url), 'utf8')

test('reveals are off by default and the plan is only asked for when they are on', () => {
  assert.match(page, /const sceneReveal = reactive\(\{\s*\n\s*enabled: false,/)
  // The loader returns early while the switch is off, so an untouched episode never calls the route.
  assert.match(page, /if \(!sceneReveal\.enabled\) \{ revealPlan\.value = null; return \}/)
})

test('the panel sends what the engine reads, and nothing else', () => {
  const start = page.indexOf('function revealPayload()')
  // Bounded to the function: the next top-level closing brace is its end.
  const payload = page.slice(start, page.indexOf('\n}', start) + 2)
  for (const field of ['enabled', 'pace', 'coherence', 'seed', 'cap_per_effect', 'no_immediate_repeat', 'pool']) {
    assert.match(payload, new RegExp(`${field}:`), `the reveal payload must carry ${field}`)
  }
  // The engine reads those seven and no eighth; the panel must not invent one. Every key the
  // function builds, spreads included, must be one of the seven.
  const declared = [...payload.matchAll(/([a-z_]+):\s/g)].map(match => match[1])
  assert.deepEqual([...new Set(declared)].sort(),
    ['cap_per_effect', 'coherence', 'enabled', 'no_immediate_repeat', 'pace', 'pool', 'seed'].sort())
})

test('the request carries the same settings the plan was built from', () => {
  // One function builds both, so the two cannot drift.
  assert.match(page, /scene_reveal: revealPayload\(\)/)
  assert.match(io, /scene_reveal: s\.sceneReveal/)
  assert.match(io, /enabled: s\.sceneReveal\.enabled === true/)
})

test('a reroll stores a per-scene choice with a reroll number, then re-reads the plan', () => {
  const reroll = page.slice(page.indexOf('async function rerollRevealScene'))
  assert.match(reroll, /video-editor\/reveals\/scene-choice/)
  assert.match(reroll, /scene_id: sceneId/)
  assert.match(reroll, /reroll: Date\.now\(\)/)
  assert.match(reroll, /await loadRevealPlan\(\)/)
  // A reroll never repeats the look the scene already had, when the pool offers an alternative.
  assert.match(reroll, /candidates\.filter\(id => id !== current\)/)
})

test('the animation preset carries the reveal look and never the seed', () => {
  const presets = page.slice(page.indexOf('const animationPresets = usePresets('))
  const snapshot = presets.slice(presets.indexOf('reveal: {'), presets.indexOf('}),', presets.indexOf('reveal: {')))
  assert.match(snapshot, /pace: sceneReveal\.pace/)
  assert.match(snapshot, /coherence: sceneReveal\.coherence/)
  assert.match(snapshot, /pool: \[\.\.\.sceneReveal\.pool\]/)
  assert.ok(!/seed:/.test(snapshot),
    'the seed is per episode: a preset that restored one would make two episodes share a randomisation')
})

test('the panel shows the render\'s own plan rather than a second opinion', () => {
  assert.match(page, /video-editor\/reveals\/plan/)
  // The plan route is the engine's resolver; the page renders what it returns.
  assert.match(page, /revealPlan\.value = r\.plan \|\| null/)
  assert.match(page, /entry\.hold\.reveal_seconds/)
  assert.match(page, /entry\.source === 'override'/)
})

test('the panel says what the saving is and that it renders locally', () => {
  assert.match(page, /One image carries a whole narration line/)
  assert.match(page, /Rendered locally: no model, no memory tier/)
  // And the family's own approximation is shown where a pack carries one.
  assert.match(page, /preset\.approximation/)
})
