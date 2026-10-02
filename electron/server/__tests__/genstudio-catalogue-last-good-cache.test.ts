/**
 * A process restart during a short GenStudio outage must keep a previously
 * published catalogue visible, without letting that disk copy authorise work.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

const temp = await useTempDataDir()
const settings = await import('../services/app-settings.js')
const client = await import('../lib/genstudio-client.js')

const CACHE_SETTING = 'genstudio_catalog_last_good_v1'

function transcription(id: string) {
  return [{
    id,
    display_name: `Transcription ${id}`,
    provider: 'local-test',
    language: 'en',
    available: true,
    available_workers: 1,
    qualification_only: false,
    credits_per_second: 0,
    minimum_credits: 0,
    price_version: 'test-price-v1',
  }]
}

void test('last-good catalogues survive a short outage only for the same display account and base URL', async () => {
  const originalFetch = globalThis.fetch
  let online = true
  let forbidden = false
  let revision = 'one'
  const seen: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push(url)
    if (forbidden) return Response.json({ detail: 'missing required scope: audio:transcribe' }, { status: 403 })
    if (!online) throw new TypeError('The Gateway is restarting')
    if (new URL(url).pathname === '/v1/transcription/models') return Response.json(transcription(revision))
    throw new Error(`Unexpected request ${url}`)
  }) as typeof globalThis.fetch

  try {
    await settings.setGenStudioUrl('http://127.0.0.1:43101')
    const live = await client.listTranscriptionModelsSnapshot('account-a', { displayFallback: true })
    assert.equal(live.freshness, 'live')
    assert.equal(live.value[0]?.id, 'one')

    await waitFor(async () => !!(await settings.getAppSetting(CACHE_SETTING)), {
      label: 'persisted display catalogue', timeoutMs: 1_000,
    })
    const persisted = await settings.getAppSetting(CACHE_SETTING)
    assert.equal(persisted?.schema_version, 1)
    const serialized = JSON.stringify(persisted)
    assert.doesNotMatch(serialized, /account-a|127\.0\.0\.1:43101/, 'the cache record must retain no raw account secret or base URL')

    client.clearGenStudioCatalogCache()
    online = false
    const stale = await client.listTranscriptionModelsSnapshot('account-a', { displayFallback: true })
    assert.equal(stale.freshness, 'stale')
    assert.equal(stale.stale, true)
    assert.equal(stale.value[0]?.id, 'one')
    assert.equal(stale.loadedAt, live.loadedAt)

    client.clearGenStudioCatalogCache()
    forbidden = true
    await assert.rejects(
      client.listTranscriptionModelsSnapshot('account-a', { displayFallback: true }),
      /missing required scope/i,
      'lost entitlement must never retain a display catalogue',
    )
    forbidden = false

    await assert.rejects(
      client.listTranscriptionModels('account-a'),
      /could not be refreshed/i,
      'execution lists must never recover from the display-only disk cache',
    )
    await assert.rejects(
      client.listTranscriptionModelsSnapshot('account-b', { displayFallback: true }),
      /could not be refreshed/i,
      'a different account must never see another account’s catalogue',
    )

    await settings.setGenStudioUrl('http://127.0.0.1:43102')
    await assert.rejects(
      client.listTranscriptionModelsSnapshot('account-a', { displayFallback: true }),
      /could not be refreshed/i,
      'a different Gateway base URL must never see another endpoint’s catalogue',
    )

    await settings.setGenStudioUrl('http://127.0.0.1:43101')
    online = true
    revision = 'two'
    client.clearGenStudioCatalogCache()
    const replacement = await client.listTranscriptionModelsSnapshot('account-a', { displayFallback: true })
    assert.equal(replacement.freshness, 'live')
    assert.equal(replacement.value[0]?.id, 'two')
    await waitFor(async () => JSON.stringify(await settings.getAppSetting(CACHE_SETTING)).includes('"two"'), {
      label: 'replacement display catalogue', timeoutMs: 1_000,
    })
    const replaced = await settings.getAppSetting(CACHE_SETTING)
    assert.match(JSON.stringify(replaced), /"two"/)
    assert.doesNotMatch(JSON.stringify(replaced), /"one"/)

    client.invalidateGenStudioCatalogFreshness()
    online = false
    const retryOutage = await client.listTranscriptionModelsSnapshot('account-a', { displayFallback: true })
    assert.equal(retryOutage.freshness, 'stale')
    assert.equal(retryOutage.value[0]?.id, 'two')
    assert.ok(seen.some(url => url.endsWith('/v1/transcription/models')))
  } finally {
    globalThis.fetch = originalFetch
    client.clearGenStudioCatalogCache()
    await fs.rm(path.join(temp.dir, 'app-settings.json'), { force: true }).catch(() => {})
    await temp.cleanup()
  }
})
