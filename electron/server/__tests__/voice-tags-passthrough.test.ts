/**
 * Voice `tags` published by the Gateway survive the backend.
 *
 * Two independent copies of the mapping exist — `listVoicesSnapshot` (the
 * picker's catalogue) and `listGenStudioVoiceLibrary` (a library page) — so a
 * fix in one does not fix the other. Both are exercised here against a stubbed
 * Gateway, because a row whose tags are silently dropped is invisible in the
 * UI: it renders as a voice with nothing to filter on, which is exactly what a
 * voice with no tags looks like.
 *
 * The malformed cases pin that only non-empty strings are kept: a tag is a
 * label, so whitespace alone, numbers and objects never reach the row.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

// Claim this test's own data directory before lib/genstudio-client.ts imports
// services/app-settings.ts, which freezes its settings path at module load.
const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const {
  clearGenStudioCatalogCache,
  listVoicesSnapshot,
  listGenStudioVoiceLibrary,
} = await import('../lib/genstudio-client.js')

const originalFetch = globalThis.fetch

/** Answers whatever the client asks with `payload`. */
function stubGateway(payload: unknown): void {
  globalThis.fetch = (async () => Response.json(payload)) as typeof globalThis.fetch
}

test.after(async () => {
  globalThis.fetch = originalFetch
  clearGenStudioCatalogCache()
  await temp.cleanup()
})

test('tags survive the backend: kept, trimmed, and in order', async () => {
  clearGenStudioCatalogCache()
  stubGateway([{
    id: 'voice-a', display_name: 'Voice A',
    tags: ['  warm narration  ', 'sleep'],
  }])

  const rows = (await listVoicesSnapshot('tags-key-1')).value
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].tags, ['warm narration', 'sleep'])
})

test('a row with none publishes no tags at all', async () => {
  clearGenStudioCatalogCache()
  stubGateway([
    { id: 'voice-absent', display_name: 'Absent' },
    { id: 'voice-empty', display_name: 'Empty', tags: [] },
  ])

  const rows = (await listVoicesSnapshot('tags-key-2')).value
  const byId = Object.fromEntries(rows.map(row => [row.id, row]))
  // Absent means the field was never published; empty means the Gateway said
  // "no tags". The UI treats both as no tags, but neither may be invented.
  assert.equal(byId['voice-absent'].tags, undefined, 'an absent field must stay absent')
  assert.deepEqual(byId['voice-empty'].tags, [], 'an explicit empty list stays empty')
})

test('malformed tags never reach a row', async () => {
  clearGenStudioCatalogCache()
  stubGateway([
    { id: 'voice-mixed', display_name: 'Mixed', tags: ['ok', '', '   ', 42, null, { label: 'x' }] },
    { id: 'voice-string', display_name: 'String', tags: 'not-an-array' },
    { id: 'voice-null', display_name: 'Null', tags: null },
  ])

  const rows = (await listVoicesSnapshot('tags-key-3')).value
  const byId = Object.fromEntries(rows.map(row => [row.id, row]))
  assert.deepEqual(byId['voice-mixed'].tags, ['ok'], 'only non-empty strings survive')
  assert.equal(byId['voice-string'].tags, undefined, 'a non-array is not a tag list')
  assert.equal(byId['voice-null'].tags, undefined, 'null is not a tag list')
})

test('library rows carry tags, and carry nothing malformed', async () => {
  stubGateway({
    page: 1,
    has_more: false,
    voices: [
      { public_voice_id: 'lib-1', name: 'Lib One', tags: [' narration ', 'male'] },
      { public_voice_id: 'lib-2', name: 'Lib Two' },
      { public_voice_id: 'lib-3', name: 'Lib Three', tags: [7, 'kept', ' '] },
    ],
  })

  const page = await listGenStudioVoiceLibrary('tags-key-lib-real', 'elevenlabs')
  assert.equal(page.voices.length, 3)
  assert.deepEqual(page.voices[0].tags, ['narration', 'male'])
  assert.equal(page.voices[1].tags, undefined, 'a library row with no tags publishes none')
  assert.deepEqual(page.voices[2].tags, ['kept'])
})
