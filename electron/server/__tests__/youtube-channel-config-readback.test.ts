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
  assert.equal(Object.hasOwn(untouched, 'upload_pacing'), false)
  assert.equal(Object.hasOwn(untouched, 'caption_settings'), false)

  const playlists = { account_a: 'playlist_a', account_b: 'playlist_b' }
  const endScreen = { enabled: false, duration_seconds: 12, elements: [] }
  const uploadPacing = { tier: 'gentle', daily_limit: 3, timezone: 'Asia/Phnom_Penh', window: { start: '09:00', end: '17:00' } }
  const captionSettings = { enabled: false }
  await pm.updateConfig(project.slug, {
    youtube_default_playlist: playlists,
    youtube_end_screen: endScreen,
    upload_pacing: uploadPacing,
    caption_settings: captionSettings,
    google_api_key: 'test-secret-not-for-safe-config',
  } as any)
  const saved = await pm.getSafeConfig(project.slug)
  assert.deepEqual(saved.youtube_default_playlist, playlists)
  assert.deepEqual(saved.youtube_end_screen, endScreen)
  assert.deepEqual(saved.upload_pacing, uploadPacing)
  assert.deepEqual(saved.caption_settings, captionSettings)
  assert.equal(Object.hasOwn(saved, 'google_api_key'), false)
})
