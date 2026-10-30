import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  flowForVisualSource,
  requiredFlowSteps,
  requiredStatusFields,
  visualSourceFromFormat,
} from '../composables/useProjectFlow'
import {
  landingTab,
  nextStillPostTab,
  stillPostStepStates,
  stillPostTabRoute,
  type StillPostFlowFacts,
} from '../utils/still-posts-flow'
import { stillPostSource } from './_stillPostSource'

const page = stillPostSource()

const EMPTY: StillPostFlowFacts = {
  castCount: 0,
  postCount: 0,
  completePostCount: 0,
  needsReviewCount: 0,
  approvedCount: 0,
  publishedCount: 0,
  socialOn: false,
  writeJob: null,
  drawJob: null,
}

function states(facts: Partial<StillPostFlowFacts>) {
  return stillPostStepStates({ ...EMPTY, ...facts })
}

test('a Still Posts Formula selects the Still Posts flow, not the video one', () => {
  assert.equal(visualSourceFromFormat({ stillPostsChannel: true }), 'still-posts')
  // The flag wins even when the shell format would otherwise look like a narration channel.
  assert.equal(visualSourceFromFormat({ stillPostsChannel: true, visualSource: 'continuity-chain' }), 'still-posts')
  // And a channel without it is untouched.
  assert.equal(visualSourceFromFormat({ visualSource: 'continuity-chain' }), 'continuity-chain')
})

test('the flow is five steps on the one page, in the owner order, with no episode stages', () => {
  const steps = flowForVisualSource('still-posts')
  assert.deepEqual(steps.map(step => step.tab), ['look', 'write', 'draw', 'review', 'publish'])
  assert.deepEqual(steps.map(step => step.label), ['Channel look', 'Write', 'Draw', 'Review', 'Publish'])
  // Every step is the same page; the tab is what tells them apart (the Thumbnails pattern).
  assert.ok(steps.every(step => step.path === '/still-posts'))
  assert.equal(new Set(steps.map(step => step.key)).size, 5, 'each step has its own key')
  // There are no episodes on this channel, so no step may be judged by an episode status field.
  assert.deepEqual(requiredStatusFields('still-posts'), [])
  assert.deepEqual(requiredFlowSteps('still-posts').map(step => step.key), steps.map(step => step.key))
})

test('a step link keeps its tab, and an old link without one is resolved by the page', () => {
  assert.equal(stillPostTabRoute('kh-quotes', 'draw'), '/projects/kh-quotes/still-posts?tab=draw')
  assert.equal(nextStillPostTab('look'), 'write')
  assert.equal(nextStillPostTab('publish'), null)
  // The page reads the tab from the route, or lands on the step with the work when it is missing.
  assert.match(page, /isStillPostTab\(route\.query\.tab\)/)
  assert.match(page, /router\.replace\(\{ path: route\.path, query: \{ \.\.\.route\.query, tab: landing\.value \} \}\)/)
})

test('a new channel lands on Channel look, and a returning one lands where the work is', () => {
  assert.equal(landingTab(states({})), 'look')
  assert.equal(landingTab(states({ castCount: 2 })), 'write')
  assert.equal(landingTab(states({ castCount: 2, postCount: 6 })), 'draw')
  assert.equal(landingTab(states({ castCount: 2, postCount: 6, completePostCount: 6 })), 'review')
  assert.equal(landingTab(states({ castCount: 2, postCount: 6, completePostCount: 6, approvedCount: 6 })), 'publish')
})

test('every step says what is done, what is running, what failed and why, and what is next', () => {
  const idle = states({})
  assert.deepEqual(idle.map(entry => entry.state), ['not-started', 'not-started', 'not-started', 'not-started', 'not-started'])
  assert.match(idle[0]!.reason, /Choose at least one character/)

  const running = states({ castCount: 1, writeJob: { status: 'running' } })
  assert.equal(running[1]!.state, 'running')

  const failed = states({ castCount: 1, writeJob: { status: 'error', error: 'The writing model timed out.' } })
  assert.equal(failed[1]!.state, 'failed')
  assert.match(failed[1]!.reason, /The writing model timed out\./, 'a failure names its cause')
  assert.match(failed[1]!.reason, /Nothing was saved/, 'and says what state the batch is in')

  const partial = states({ castCount: 1, postCount: 6, completePostCount: 2 })
  assert.equal(partial[2]!.state, 'in-progress')
  assert.match(partial[2]!.reason, /2 of 6 drawn/)

  const drawn = states({ castCount: 1, postCount: 6, completePostCount: 6 })
  assert.equal(drawn[2]!.state, 'done')
  assert.match(drawn[2]!.reason, /All 6 posts drawn in every chosen frame/)
})

test('a failed draw keeps the drawings it finished, and says how many are still missing', () => {
  const failed = states({ castCount: 1, postCount: 6, completePostCount: 4, drawJob: { status: 'error', error: 'The image model refused the request.' } })
  assert.equal(failed[2]!.state, 'failed')
  assert.match(failed[2]!.reason, /2 posts still need drawing/)
  assert.match(failed[2]!.reason, /Finished drawings are kept/)
})

test('nothing is published unless it was approved, and posting that is off is said plainly', () => {
  const none = states({ castCount: 1, postCount: 6, completePostCount: 6 })
  assert.equal(none[4]!.state, 'not-started')
  const off = states({ castCount: 1, postCount: 6, completePostCount: 6, approvedCount: 6, socialOn: false })
  assert.equal(off[4]!.state, 'in-progress')
  assert.match(off[4]!.reason, /Nothing is sent: posting is off/)
})

test('the page keeps the owner rules visible: batches, characters, and a live model choice', () => {
  assert.match(page, /Write a batch|Describe a batch/)
  assert.match(page, /Characters/)
  // A model is never assumed: the shared image picker starts on its "pick one" label, nothing is
  // drawn until a model is really selected, and the server refuses a render without one.
  assert.match(page, /Pick an image model…/)
  assert.match(page, /const canDraw = computed\(\(\) => !!imageModelChoice\.value\)/)
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
