/**
 * 1.4.402 production fix (a-world-before-us EP0018): Scene Review must render with the model the
 * Scene Plan wrote prompts for, never a different app-wide default. The full route path needs a
 * live Gateway catalogue (it resolves the plan's real prompt ceiling), so the precedence itself is
 * pinned here through the same helper the batch uses.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSceneRenderFallbackModel } from '../routes/pipeline.js'

const QWEN = 'qwen-image-3'
const FLUX = 'flux2-klein'

test('Scene Review prefers the Scene Plan intended image model over the app default', () => {
  assert.equal(resolveSceneRenderFallbackModel('scene_review', QWEN, FLUX), QWEN,
    'prompts written for qwen must not be rendered by a stricter default')
})

test('Scene Review falls back to the app default only when the plan names no model', () => {
  assert.equal(resolveSceneRenderFallbackModel('scene_review', '', FLUX), FLUX)
})

test('other steps take the app default and never the plan\'s intended model', () => {
  assert.equal(resolveSceneRenderFallbackModel('thumb_images', QWEN, FLUX), FLUX)
  assert.equal(resolveSceneRenderFallbackModel('scene_plan', QWEN, FLUX), FLUX)
})

test('an empty answer stays model-less — the batch never invents a model', () => {
  assert.equal(resolveSceneRenderFallbackModel('scene_review', '', ''), '')
})
