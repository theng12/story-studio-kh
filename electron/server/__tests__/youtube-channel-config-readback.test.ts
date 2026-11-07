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

test('YouTube channel choices survive safe config readback without creating defaults', async () => {
  const project = await pm.createProject({ name: 'YouTubeReadback' })
  const untouched = await pm.getSafeConfig(project.slug)
  assert.equal(Object.hasOwn(untouched, 'youtube_default_playlist'), false)
  assert.equal(Object.hasOwn(untouched, 'youtube_end_screen'), false)

  const playlists = { account_a: 'playlist_a', account_b: 'playlist_b' }
  const endScreen = { enabled: false, duration_seconds: 12, elements: [] }
  await pm.updateConfig(project.slug, {
    youtube_default_playlist: playlists,
    youtube_end_screen: endScreen,
    google_api_key: 'test-secret-not-for-safe-config',
  } as any)
  const saved = await pm.getSafeConfig(project.slug)
  assert.deepEqual(saved.youtube_default_playlist, playlists)
  assert.deepEqual(saved.youtube_end_screen, endScreen)
  assert.equal(Object.hasOwn(saved, 'google_api_key'), false)
})
