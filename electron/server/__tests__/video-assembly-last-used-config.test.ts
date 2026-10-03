/**
 * Video Assembly's remembered last-render settings must reach the page: the
 * safe config passes only known keys, and an unknown key is silently dropped
 * (found by rendering the page against a Dreamlands copy).
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
})
after(async () => { await cleanup() })

test('the safe project config carries video_assembly_last_used', async () => {
  const project = await pm.createProject({ name: 'LastUsedConfig' })
  const value = { channel: { episode_id: 'EP0002', saved_at: '2026-10-03T19:29:00.000Z', settings: { export: { quality: 'medium' } } }, episodes: {} }
  await pm.updateConfig(project.slug, { video_assembly_last_used: value } as any)
  assert.deepEqual((await pm.getSafeConfig(project.slug))?.video_assembly_last_used, value)
})
