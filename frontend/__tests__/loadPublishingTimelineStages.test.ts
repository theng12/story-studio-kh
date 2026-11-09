import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPublishingTimelineStages } from '../utils/loadPublishingTimelineStages'
import type { PublishingOverviewChannel } from '../../electron/server/contracts/publishing-overview'

function channel(slug: string, stage = 'not_checked') {
  return { slug, timeline: { episodes: [{ episode_code: 'EP0001', artifacts_pending: stage === 'not_checked', stage, state: stage === 'not_checked' ? 'not_checked' : 'failed', detail: 'Original evidence' }] } } as PublishingOverviewChannel
}

test('cached artifact hydration is bounded, reads only episode lists and preserves known work and publication', async () => {
  const channels = [channel('a'), channel('b'), channel('c'), channel('render', 'render'), channel('public', 'public')]
  let running = 0, maximum = 0
  const paths: string[] = []
  await loadPublishingTimelineStages(channels, async path => {
    paths.push(path); maximum = Math.max(maximum, ++running)
    await new Promise(resolve => setTimeout(resolve, 0)); running--
    return [{ episode_code: 'EP0001', status: { script: true }, scene_images: { present: 2, total: 5 } }]
  }, () => true)
  assert.equal(maximum, 2)
  assert.deepEqual(paths.sort(), ['/projects/a/episodes', '/projects/b/episodes', '/projects/c/episodes'])
  assert.equal(channels[0]!.timeline!.episodes[0]!.stage, 'images')
  assert.match(channels[0]!.timeline!.episodes[0]!.detail, /2 of 5/)
  assert.equal(channels[3]!.timeline!.episodes[0]!.state, 'failed')
  assert.equal(channels[4]!.timeline!.episodes[0]!.stage, 'public')
})

test('hydration preserves upload verdicts and unreadable server evidence', async () => {
  const channels = ['active', 'failed', 'paused', 'waiting', 'not_checked'].map(state => {
    const c = channel(state)
    Object.assign(c.timeline!.episodes[0]!, { state, detail: `Upload ${state}`, artifacts_pending: state !== 'not_checked' })
    return c
  })
  const before = JSON.stringify(channels)
  let reads = 0
  await loadPublishingTimelineStages(channels, async () => {
    reads++
    return [{ episode_code: 'EP0001', status: { script: false } }]
  }, () => true)
  assert.equal(reads, 0)
  assert.equal(JSON.stringify(channels), before)
})

test('failed, missing, malformed and unreliable status never become an idea or completion', async () => {
  for (const response of [[], {}, [{ episode_code: 'EP0001', status: {} }], [{ episode_code: 'EP0001', status: { script: true }, episode_error: 'Cannot read EP0001' }], [{ episode_code: 'EP0001', status: { script: true, _unreliable: true } }]]) {
    const c = channel('a')
    await loadPublishingTimelineStages([c], async () => response, () => true)
    assert.equal(c.timeline!.episodes[0]!.stage, 'not_checked')
    assert.equal(c.timeline!.episodes[0]!.state, 'not_checked')
  }
  const c = channel('a')
  await loadPublishingTimelineStages([c], async () => { throw new Error('offline') }, () => true)
  assert.match(c.timeline!.episodes[0]!.detail, /could not be loaded/)
})

test('leaving the view or replacing overview drops late results and stops further channel reads', async () => {
  const channels = [channel('a'), channel('b'), channel('c')]
  let current = true, reads = 0
  await loadPublishingTimelineStages(channels, async () => {
    reads++; current = false
    return [{ episode_code: 'EP0001', status: { script: true } }]
  }, () => current)
  assert.equal(reads, 1)
  assert.ok(channels.every(c => c.timeline!.episodes[0]!.stage === 'not_checked'))
})
