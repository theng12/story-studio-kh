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
  listImageModelsForceLive,
  listImageModelsSnapshot,
  listMusicModelsSnapshot,
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
  '/v1/music/models': [{
    id: 'music-v1', display_name: 'Music V1', description: 'Music', coming_soon: false,
    credits_per_request: 0, minimum_credits: 0, price_version: 'music-price-v1',
    standard_credits: null, sale_credits: null, sale_ends_at: null, sale_disclaimer: null,
    supports_instrumental: true, supports_vocals: true, requires_lyrics: false,
    max_prompt_characters: 2_000, max_prompt_without_lyrics_characters: null,
    min_prompt_characters: 1, max_lyrics_characters: 5_000, min_lyrics_characters: 1,
    max_title_characters: 256, outputs_per_request: 1,
  }],
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
  { kind: 'music', endpoint: '/v1/music/models', load: listMusicModelsSnapshot },
  { kind: 'video', endpoint: '/v1/videos/models', load: listVideoModelsSnapshot },
  { kind: 'transcription', endpoint: '/v1/transcription/models', load: listTranscriptionModelsSnapshot },
]

type FetchMode = 'ok' | 'offline' | 'forbidden'

void test('every Gateway catalogue follows one caching and staleness policy', async (suite) => {
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
        assert.equal(requests, 1, 'a read inside the freshness window must not hit the Gateway')
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

test('a force-live read ABORTS the read it supersedes instead of orphaning it', async () => {
  // The paid-decision path re-reads the image catalogue live, superseding any
  // ordinary read already in flight. That read used to be abandoned rather than
  // cancelled: it stayed in flight — one socket held for its full 30 s timeout,
  // three times over with retries — while a second request started beside it,
  // and a run of paid decisions piled those up.
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()

  const signals: AbortSignal[] = []
  let requests = 0
  globalThis.fetch = ((_input: any, init?: RequestInit) => {
    requests++
    const signal = init!.signal as AbortSignal
    signals.push(signal)
    if (requests === 1) {
      // Only the abort ends this one; it never answers on its own.
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      })
    }
    return Promise.resolve(Response.json([
      { id: 'image-v1', display_name: 'Image V1', available: true, qualification_only: false },
    ]))
  }) as typeof globalThis.fetch

  try {
    const ordinary = listImageModelsSnapshot('force-live-key')
    for (let waited = 0; requests < 1 && waited < 2_000; waited++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(requests, 1, 'the ordinary read never reached the Gateway')

    const forced = await listImageModelsForceLive('force-live-key')
    assert.equal(forced.freshness, 'live')
    assert.deepEqual(forced.value.map(model => model.id), ['image-v1'])
    assert.equal(signals[0]!.aborted, true, 'the superseded read was left in flight instead of aborted')
    assert.equal(requests, 2, 'an aborted read must not be retried')

    // The ordinary caller had joined the superseded read, so it must follow the
    // read that replaced it rather than be failed by the abort.
    const settled = await ordinary
    assert.equal(settled.stale, false)
    assert.deepEqual(settled.value.map(model => model.id), ['image-v1'])
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
})
