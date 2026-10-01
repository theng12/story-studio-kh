/**
 * The local LTX video model is retired (owner decision 2026-10-01).
 *
 * Story Studio must never request it: not from a saved id, not from a catalogue
 * row that still lists it. A saved id that names it falls through to the same
 * "not available" path as any id GenStudio does not publish, and a live cloud
 * model still resolves normally. No network: the catalogue is a local fetch stub.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetiredVideoModel, isRetiredVideoModelId } from '../contracts/retired-video-models.js'
import { listVideoModels } from '../lib/genstudio-client.js'
import { resolveSceneClipCatalogModel } from '../generators/scene-clip.js'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'

const PACKAGE_ID = 'ltx-2-3-22b-ram-12gb-mlx'
const REPO_ID = 'baa-ai/LTX-2.3-22B-RAM-12GB-MLX'
const variant = {
  operation: 'image-to-video', duration_seconds: 5, resolution: '720p',
  credits_per_video: 12, minimum_credits: 12, price_version: 'v1',
}
const row = (id: string, display_name: string) => ({
  id, display_name, available: true, modes: ['image-to-video'], aspect_ratios: ['16:9'], variants: [variant],
})

test('every spelling of the retired model is recognised, and nothing else is', () => {
  for (const id of [PACKAGE_ID, REPO_ID, 'local-ltx', 'genstudio-video:local-ltx', 'LTX-2.3']) {
    assert.equal(isRetiredVideoModelId(id), true, id)
  }
  for (const id of ['genstudio-video-veo-31-v1', 'mlx-community/gemma-3-12b-it-4bit', 'gemma-4-26b', 'multixtreme', 'fal-ai/ltx-video', 'genstudio-video-ltx-video-v1', '', undefined]) {
    assert.equal(isRetiredVideoModelId(id), false, String(id))
  }
  assert.equal(isRetiredVideoModel({ id: 'genstudio-video-abc-v1', display_name: 'LTX 2.3 (local)' }), true)
  assert.equal(isRetiredVideoModel({ id: 'genstudio-video-abc-v1', legacy_ids: [PACKAGE_ID] }), true)
  assert.equal(isRetiredVideoModel({ id: 'genstudio-video-veo-31-v1', display_name: 'Veo 3.1 Fast' }), false)
})

test('a saved retired id is not requested and resolves to nothing, even if the catalogue still lists it', () => {
  const catalog = [row('local-ltx', 'LTX 2.3'), row('genstudio-video-veo-31-v1', 'Veo 3.1 Fast')] as any
  for (const saved of [PACKAGE_ID, REPO_ID, 'local-ltx', 'genstudio-video:local-ltx']) {
    assert.equal(resolveSceneClipCatalogModel(saved, catalog), null, saved)
    assert.equal(resolveSceneClipCatalogModel(saved, []), null, `${saved} with no catalogue`)
  }
  assert.equal(resolveGenStudioModelId('video', 'genstudio-video:local-ltx'), null)
  assert.equal(resolveGenStudioModelId('video', REPO_ID), null)
})

test('a configured cloud video model is still used', () => {
  const catalog = [row('genstudio-video-veo-31-v1', 'Veo 3.1 Fast')] as any
  assert.equal(
    resolveSceneClipCatalogModel('genstudio-video:genstudio-video-veo-31-v1', catalog),
    'genstudio-video-veo-31-v1',
  )
  assert.equal(resolveGenStudioModelId('video', 'genstudio-video:genstudio-video-veo-31-v1'), 'genstudio-video-veo-31-v1')
})

test('the video catalogue drops a retired row and does not throw when nothing is left', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json([row('local-ltx', 'LTX 2.3'), row('genstudio-video-veo-31-v1', 'Veo 3.1 Fast')])
    const mixed = await listVideoModels('retired-video-mixed-key')
    assert.deepEqual(mixed.map(model => model.id), ['genstudio-video-veo-31-v1'])

    globalThis.fetch = async () => Response.json([row('local-ltx', 'LTX 2.3')])
    assert.deepEqual(await listVideoModels('retired-video-only-key'), [])

    globalThis.fetch = async () => Response.json([])
    assert.deepEqual(await listVideoModels('retired-video-empty-key'), [])
  } finally {
    globalThis.fetch = originalFetch
  }
})
