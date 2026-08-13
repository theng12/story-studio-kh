import assert from 'node:assert/strict'
import test from 'node:test'
import { selectLiveImageToVideoModel } from '../utils/genstudio-video-model-selection.ts'

const models = [
  {
    id: 'economy-without-price',
    available: true,
    cost_tier: 'economy' as const,
    modes: ['image-to-video'],
    variants: [],
  },
  {
    id: 'economy-usable',
    available: true,
    cost_tier: 'economy' as const,
    modes: ['image-to-video'],
    variants: [{ credits_per_video: 3 }],
  },
  {
    id: 'premium-usable',
    available: true,
    cost_tier: 'premium' as const,
    modes: ['image-to-video'],
    variants: [{ credits_per_video: 30 }],
  },
]

test('empty Motion selection skips an Economy row with no priced variant', () => {
  assert.equal(selectLiveImageToVideoModel('', models)?.id, 'economy-usable')
})

test('Motion preserves named-selection intent when that row cannot run', () => {
  assert.equal(selectLiveImageToVideoModel('economy-without-price', models), null)
  assert.equal(selectLiveImageToVideoModel('missing-saved-model', models), null)
  assert.equal(selectLiveImageToVideoModel('premium-usable', models)?.id, 'premium-usable')
})
