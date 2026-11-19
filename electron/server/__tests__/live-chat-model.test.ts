/**
 * A saved chat model is resolved against the LIVE catalogue (1.4.413).
 *
 * Two failures this covers:
 *   1. A product the catalogue republished under another identifier is still the
 *      product the preset chose — the saved id resolves, and the caller is told
 *      which id it was saved as. Before this, exact-string equality failed the
 *      step the moment the catalogue renamed a product it had not retired.
 *   2. An id the catalogue does not publish at all resolves to `null`, so the
 *      caller refuses BY NAME instead of running into the step hours later.
 *      Nothing is ever substituted: a different product would change the writing
 *      the owner chose (AGENTS.md, "Everything Follows the Selected Model").
 *
 * No real Gateway: the in-process mock GenStudio service serves the catalogue.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

let cleanup: (() => Promise<void>) | undefined
let service: MockGenStudioService
let findLiveChatModel: typeof import('../services/live-chat-model.js').findLiveChatModel
let clearGenStudioCatalogCache: () => void

function chatRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    display_name: id,
    available: true,
    qualification_only: false,
    context_window_tokens: 128_000,
    max_output_tokens: 4_096,
    controls: [],
    activation_blockers: [],
    ...extra,
  }
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  service = await startMockGenStudioService()
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  ;({ clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js'))
  ;({ findLiveChatModel } = await import('../services/live-chat-model.js'))
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
})

after(async () => {
  await new Promise<void>(resolve => service.server.close(() => resolve()))
  await cleanup?.()
})

describe('a saved chat model follows the live catalogue', () => {
  test('an id the catalogue publishes resolves to itself', async () => {
    service.chatModels = [chatRow('pool::story-studio-llm')]
    clearGenStudioCatalogCache()
    const live = await findLiveChatModel('genstudio-chat:pool::story-studio-llm')
    assert.equal(live?.id, 'pool::story-studio-llm')
    assert.equal(live?.saved_as, null)
  })

  test('an id republished under a legacy id resolves to the live product and says which id was saved', async () => {
    service.chatModels = [chatRow('magpie::xiaomi/mimo-v2.6-flash', {
      customer_handle: 'mimo-flash',
      public_model_id: 'genstudio-chat-mimo-v1',
      legacy_ids: ['deepseek-v4-flash-genstudio-5'],
    })]
    clearGenStudioCatalogCache()
    const live = await findLiveChatModel('deepseek-v4-flash-genstudio-5')
    assert.equal(live?.id, 'magpie::xiaomi/mimo-v2.6-flash')
    assert.equal(live?.saved_as, 'deepseek-v4-flash-genstudio-5')
  })

  test('an id the catalogue does not publish resolves to null — never to another product', async () => {
    service.chatModels = [chatRow('magpie::xiaomi/mimo-v2.6-flash', {
      legacy_ids: ['some-other-old-id'],
    })]
    clearGenStudioCatalogCache()
    assert.equal(await findLiveChatModel('deepseek-v4-flash-genstudio-5'), null)
  })

  test('a model-free timeline run is never judged', async () => {
    // Two real recovery plans (EP0001, EP0083) carry this value in their Scene
    // Plan node; refusing it would park them forever.
    service.chatModels = [chatRow('pool::story-studio-llm')]
    clearGenStudioCatalogCache()
    assert.equal(await findLiveChatModel('deterministic-timeline'), undefined)
  })

  test('a product published but not available is treated as gone', async () => {
    service.chatModels = [chatRow('pool::story-studio-llm', { available: false })]
    clearGenStudioCatalogCache()
    assert.equal(await findLiveChatModel('pool::story-studio-llm'), null)
  })
})
