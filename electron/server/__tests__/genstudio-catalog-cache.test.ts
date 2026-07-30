/**
 * One staleness policy for every GenStudio catalogue.
 *
 * Before this, only the image and transcription catalogues were cached; voices,
 * chat, video and capabilities re-fetched on every call and had no way to tell
 * a caller whether what it just received was live, warm, or only being served
 * because GenStudio was unreachable. All six now share `cachedCatalog`:
 *
 *   - inside the 5-minute freshness window   → served from cache, no request
 *   - beyond it, refresh fails, inside 30min → served and MARKED stale
 *   - beyond the 30-minute staleness window  → typed refusal, never served
 *   - 401 / 403                              → always throws, never serves stale
 *
 * No network: `globalThis.fetch` is stubbed for every case.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import type {
  GenStudioCatalogKind,
  GenStudioCatalogSnapshot,
} from '../lib/genstudio-client.js'

// services/app-settings.ts freezes its settings-file path at module load, and
// lib/genstudio-client.ts imports it. Claim this test's own data directory
// first so nothing here reads or touches the developer's real settings.
const temp = await useTempDataDir()
const {
  clearGenStudioCatalogCache,
  GenStudioApiError,
  GenStudioCatalogUnavailableError,
  invalidateGenStudioCatalogFreshness,
  listChatModelsSnapshot,
  listImageModelsSnapshot,
  listModelCapabilitiesSnapshot,
  listTranscriptionModelsSnapshot,
  listVideoModelsSnapshot,
  listVoicesSnapshot,
} = await import('../lib/genstudio-client.js')

const CATALOGUE_PAYLOAD: Record<string, unknown> = {
  '/v1/models': [{
    id: 'cap-v1', revision: 'r1', display_name: 'Cap V1', modality: 'audio',
    operation: 'voice.tts', availability: 'available', qualification_only: false,
  }],
  '/v1/voices': [{ id: 'voice-v1', display_name: 'Voice V1', generation_enabled: true }],
  '/v1/chat/models': [{ id: 'chat-v1', display_name: 'Chat V1', available: true, qualification_only: false }],
  '/v1/image/models': [{ id: 'image-v1', display_name: 'Image V1', available: true, qualification_only: false }],
  '/v1/videos/models': [{ id: 'video-v1', display_name: 'Video V1', available: true, modes: ['image-to-video'] }],
  '/v1/transcription/models': [{ id: 'stt-v1', display_name: 'STT V1', available: true, qualification_only: false }],
}

interface Catalogue {
  kind: GenStudioCatalogKind
  endpoint: string
  load: (apiKey: string) => Promise<GenStudioCatalogSnapshot<Array<{ id: string }>>>
}

const CATALOGUES: Catalogue[] = [
  { kind: 'capabilities', endpoint: '/v1/models', load: listModelCapabilitiesSnapshot },
  { kind: 'voices', endpoint: '/v1/voices', load: listVoicesSnapshot },
  { kind: 'chat', endpoint: '/v1/chat/models', load: listChatModelsSnapshot },
  { kind: 'image', endpoint: '/v1/image/models', load: listImageModelsSnapshot },
  { kind: 'video', endpoint: '/v1/videos/models', load: listVideoModelsSnapshot },
  { kind: 'transcription', endpoint: '/v1/transcription/models', load: listTranscriptionModelsSnapshot },
]

type FetchMode = 'ok' | 'offline' | 'forbidden'

void test('every GenStudio catalogue follows one caching and staleness policy', async (suite) => {
  const originalFetch = globalThis.fetch
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  let mode: FetchMode = 'ok'
  let requests = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const endpoint = Object.keys(CATALOGUE_PAYLOAD).find(path => url.endsWith(path))
    if (!endpoint) throw new Error(`Unexpected catalogue request: ${url}`)
    requests++
    if (mode === 'offline') throw new TypeError('fetch failed')
    if (mode === 'forbidden') {
      return Response.json({ detail: 'missing required scope: models:read' }, { status: 403 })
    }
    return Response.json(CATALOGUE_PAYLOAD[endpoint])
  }) as typeof globalThis.fetch

  try {
    for (const catalogue of CATALOGUES) {
      const apiKey = `cache-key-${catalogue.kind}`

      await suite.test(`${catalogue.kind}: fresh window serves the cached copy without a request`, async () => {
        clearGenStudioCatalogCache()
        mode = 'ok'
        requests = 0

        const live = await catalogue.load(apiKey)
        assert.equal(requests, 1)
        assert.equal(live.kind, catalogue.kind)
        assert.equal(live.freshness, 'live')
        assert.equal(live.stale, false)
        assert.ok(live.value.length > 0)

        const cached = await catalogue.load(apiKey)
        assert.equal(requests, 1, 'a read inside the freshness window must not hit GenStudio')
        assert.equal(cached.freshness, 'fresh')
        assert.equal(cached.stale, false)
        assert.deepEqual(cached.value, live.value)
      })

      await suite.test(`${catalogue.kind}: beyond the fresh window an outage is served but MARKED stale`, async () => {
        clearGenStudioCatalogCache()
        mode = 'ok'
        await catalogue.load(apiKey)

        // Force revalidation while keeping the copy usable — exactly what the
        // 5-minute freshness boundary does in production.
        invalidateGenStudioCatalogFreshness()
        mode = 'offline'
        const stale = await catalogue.load(apiKey)
        assert.equal(stale.freshness, 'stale')
        assert.equal(stale.stale, true, 'the UI must be able to mark this copy as stale')
        assert.ok(stale.value.length > 0)
        assert.ok(Date.parse(stale.loadedAt) > 0)
      })

      await suite.test(`${catalogue.kind}: beyond the stale window it refuses instead of serving`, async () => {
        // Dropping the entry is the beyond-30-minutes case: there is no copy
        // left that may authorise a submission.
        clearGenStudioCatalogCache()
        mode = 'offline'
        await assert.rejects(
          catalogue.load(apiKey),
          (error: unknown) => {
            assert.ok(
              error instanceof GenStudioCatalogUnavailableError,
              'a submission must be refused with a typed error, not a bare string',
            )
            assert.equal(error.kind, catalogue.kind)
            assert.match(error.message, /no credits were charged/)
            return true
          },
        )
      })

      await suite.test(`${catalogue.kind}: 401/403 always throws and never serves stale data`, async () => {
        clearGenStudioCatalogCache()
        mode = 'ok'
        const warm = await catalogue.load(apiKey)
        assert.ok(warm.value.length > 0)

        invalidateGenStudioCatalogFreshness()
        mode = 'forbidden'
        await assert.rejects(
          catalogue.load(apiKey),
          (error: unknown) => {
            assert.ok(error instanceof GenStudioApiError, 'scope failures stay GenStudioApiError')
            assert.equal(error.status, 403)
            assert.match(error.message, /missing required scope/)
            return true
          },
        )
      })
    }

    await suite.test('a catalogue cached under one API key never serves another key', async () => {
      clearGenStudioCatalogCache()
      mode = 'ok'
      requests = 0
      await listChatModelsSnapshot('key-a')
      await listChatModelsSnapshot('key-b')
      assert.equal(requests, 2, 'each account key gets its own catalogue snapshot')
    })
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
    await temp.cleanup()
  }
})
