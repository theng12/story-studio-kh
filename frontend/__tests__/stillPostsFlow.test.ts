import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  flowForVisualSource,
  requiredFlowSteps,
  requiredStatusFields,
  visualSourceFromFormat,
} from '../composables/useProjectFlow'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/still-posts.vue', import.meta.url)),
  'utf8',
)

test('a Still Posts Formula selects the Still Posts flow, not the video one', () => {
  assert.equal(visualSourceFromFormat({ stillPostsChannel: true }), 'still-posts')
  // The flag wins even when the shell format would otherwise look like a narration channel.
  assert.equal(visualSourceFromFormat({ stillPostsChannel: true, visualSource: 'continuity-chain' }), 'still-posts')
  // And a channel without it is untouched.
  assert.equal(visualSourceFromFormat({ visualSource: 'continuity-chain' }), 'continuity-chain')
})

test('the flow is the one workspace, with no episode stages and nothing blocking an episode', () => {
  const steps = flowForVisualSource('still-posts')
  assert.equal(steps.length, 1)
  assert.equal(steps[0]!.key, 'still-posts')
  assert.equal(steps[0]!.path, '/still-posts')
  // There are no episodes on this channel, so no step may be judged by an episode status field.
  assert.deepEqual(requiredStatusFields('still-posts'), [])
  assert.deepEqual(requiredFlowSteps('still-posts').map(step => step.key), ['still-posts'])
})

test('the page keeps the owner rules visible: batches, characters, and a live model choice', () => {
  assert.match(page, /Write a batch/)
  assert.match(page, /Characters/)
  // A model is never assumed: the image picker starts on a "choose" option and is refused server-side.
  assert.match(page, /Choose a live Gateway model/)
  // The words are burned in by our renderer, and the page says so.
  assert.match(page, /never drawn by/)
  assert.doesNotMatch(page, /window\.confirm/)
})

test('the drawing choice is offered in plain words beside the export frames, defaulting to one drawing', () => {
  // Owner, 2026-10-27: keep one drawing per post, and offer a fresh drawing per size.
  assert.match(page, /One drawing, fitted to each size \(default\)/)
  assert.match(page, /A fresh drawing for each size \(up to 3× the drawings\)/)
  // The default is OFF, in the page state the preset applies into.
  assert.match(page, /fresh_drawing_per_size:\s*false/)
  // It is a reusable configuration choice, so the preset RESTORES it (AGENTS §5)…
  assert.match(page, /preset\.fresh_drawing_per_size\s*=\s*found\.data\.fresh_drawing_per_size/)
  // …and the batch/render requests carry it, so the stored record knows the mode.
  assert.match(page, /fresh_drawing_per_size:\s*preset\.fresh_drawing_per_size/)
  // The cost is quoted from the live model's published price, and it counts the drawings.
  assert.match(page, /describeImageBatchEstimate/)
  assert.match(page, /drawingsForBatch/)
})
