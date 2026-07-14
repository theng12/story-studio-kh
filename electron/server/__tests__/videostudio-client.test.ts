import assert from 'node:assert/strict'
import test from 'node:test'
import { isUsableImageToVideoModel, normalizeVideoStudioCatalog } from '../lib/videostudio-client.js'

test('Video Studio inventory keeps ready image-to-video models only', () => {
  const rows = [
    { repo: 'cloud/i2v', label: 'Cloud I2V', capabilities: ['img2video'], is_cloud: true, key_set: true, paid_on: true },
    { repo: 'cloud/t2v', label: 'Cloud T2V', capabilities: ['txt2video'], is_cloud: true, key_set: true, paid_on: true },
    { repo: 'local/ready', label: 'Local Ready', capabilities: ['img2video'], is_cloud: false, cache: { state: 'complete' } },
    { repo: 'local/missing', label: 'Local Missing', capabilities: ['img2video'], is_cloud: false, cache: { state: 'absent' } },
  ]
  const models = normalizeVideoStudioCatalog(rows)
  assert.deepEqual(Object.keys(models), ['videostudio:cloud/i2v', 'videostudio:local/ready'])
  assert.equal(models['videostudio:cloud/i2v']?.provider, 'videostudio')
  assert.deepEqual(models['videostudio:local/ready']?.modes, ['frames'])
})

test('deprecated or unconfigured cloud models are not selectable', () => {
  assert.equal(isUsableImageToVideoModel({ capabilities: ['img2video'], is_cloud: true, key_set: false }), false)
  assert.equal(isUsableImageToVideoModel({ capabilities: ['img2video'], is_cloud: true, status: 'deprecated' }), false)
})
