/**
 * Intro skip has one meaning, in one place.
 *
 * DK0032 was blocked because the switch was half-retired: the planner still
 * honoured `config.skip_intro_scenes` and started scenes minutes in, while the
 * renderer had retired its own handling and the plan recorded nothing about the
 * hole that left. These pin the surviving contract:
 *
 *   - the PLANNER may skip the Introduction (an economy switch: no prompts, no
 *     images spent on it) and must RECORD that it opened `from-start` with
 *     nothing reserved;
 *   - the RENDER gate stays authoritative — a request-level `skip_intro_scenes`
 *     can never excuse the resulting head gap.
 *
 * Source-level, deliberately: both live inside long job functions that need a
 * project, a merged audio file and a model to run, and what is being pinned is
 * the contract between them rather than either one's output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const read = (rel: string) => fs.readFileSync(path.resolve(here, '..', rel), 'utf-8')

const planner = read('generators/scene-plan.ts')
const video = read('generators/video.ts')

test('the planner records the opening it produced', () => {
  assert.match(planner, /plan\.opening_mode = 'from-start'/)
  assert.match(planner, /plan\.opening_reserved_sec = 0/)
})

test('the planner never claims a branded opening it did not measure', () => {
  // Crediting the head to an opening clip the episode does not have would let
  // the render gate pass an episode with nothing to show over its first
  // minutes — the exact failure this whole change exists to prevent.
  assert.doesNotMatch(planner, /plan\.opening_mode = 'branded-opening'/)
  assert.doesNotMatch(planner, /plan\.opening_source = /)
})

test('intro skip survives as a planner-time switch', () => {
  assert.match(planner, /skip_intro_scenes/)
  assert.match(planner, /skip_until_sec: skipUntilSec/)
})

test('the render still refuses a head it has nothing to fill', () => {
  // The request-level flag is forced off, so only real opening assets (or a
  // plan that genuinely covers its own head) can satisfy the gate.
  assert.match(video, /req\.skip_intro_scenes = false/)
  assert.match(video, /Narration has \$\{gatedUncovered\.toFixed\(1\)\}s with NO planned scene/)
})

test('the retired comment describes the behaviour that survived', () => {
  assert.match(video, /Intro skip is a PLANNER-time economy switch, not a render-time one/)
  assert.doesNotMatch(video, /Legacy whole-Introduction skipping is retired/)
})
