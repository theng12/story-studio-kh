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
