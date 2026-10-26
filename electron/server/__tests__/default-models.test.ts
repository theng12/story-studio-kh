/**
 * Default models — the app-wide fallback per generation family (owner, 2026-10-27).
 *
 * The one precedence chain this pins, end to end:
 *
 *   the preset's saved model → the page's remembered last choice → the app-wide default
 *
 * and the four rules that make it safe:
 *
 *  - the setting is validated as a whole before it replaces the last good value (AGENTS §6: a
 *    corrupt file fails closed rather than reading as "no default" or as some other model);
 *  - a default is only ever READ. `resolveDefaultModel` returns the id and writes nothing, so it
 *    can never end up baked into a preset, a channel config or a remembered form (§1, §5);
 *  - a default that has left the catalogue is refused BY NAME and never swapped for another
 *    product (owner, 2026-10-03: Story Studio never picks a model);
 *  - a catalogue that cannot be read is an error, never a silent "no default".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import test, { after, before, describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** One stand-in Gateway publishing every family's catalogue, each row list set per test. */
class FamilyCatalogServer {
  private server = http.createServer((req, res) => this.handle(req, res))
  catalogs: Record<string, any[]> = {
    chat: [], image: [], video: [], tts: [], transcription: [], music: [],
  }
  baseUrl = ''

  async start(): Promise<this> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('did not bind a port')
    this.baseUrl = `http://127.0.0.1:${address.port}`
    return this
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    this.server.close()
    await once(this.server, 'close')
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const route: Record<string, string> = {
      '/v1/chat/models': 'chat',
      '/v1/image/models': 'image',
      '/v1/videos/models': 'video',
      '/v1/tts/models': 'tts',
      '/v1/transcription/models': 'transcription',
      '/v1/music/models': 'music',
    }
    const family = route[req.url || '']
    if (!family) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: 'not found' }))
      return
    }
    const body = Buffer.from(JSON.stringify({ models: this.catalogs[family] }))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
    res.end(body)
  }
}

/**
 * A row each family's parser actually accepts.
 *
 * Each catalogue has its own required fields (music demands every length and prompt cap, TTS demands
 * the three character counts, …), and a row missing one is DROPPED by the parser — which would make
 * a test pass for the wrong reason: "no default" instead of "the default was refused".
 */
const rowFor: Record<string, (id: string, extra?: Record<string, unknown>) => Record<string, unknown>> = {
  chat: (id, extra = {}) => ({
    id, display_name: id, available: true, qualification_only: false, ...extra,
  }),
  image: (id, extra = {}) => ({
    id, display_name: id, description: '', available: true, qualification_only: false, ...extra,
  }),
  video: (id, extra = {}) => ({
    id, display_name: id, description: '', available: true, modes: ['image-to-video'], ...extra,
  }),
  tts: (id, extra = {}) => ({
    id, display_name: id, provider_id: 'p', provider_name: 'P', description: '',
    credits_per_1000_characters: 0, minimum_credits: 0, maximum_input_characters: 5000,
    generation_enabled: true, ...extra,
  }),
  transcription: (id, extra = {}) => ({
    id, display_name: id, provider: 'p', language: '', available: true,
    available_workers: 1, qualification_only: false, ...extra,
  }),
  music: (id, extra = {}) => ({
    id, display_name: id, description: '', coming_soon: false, credits_per_request: 0,
    minimum_credits: 0, price_version: 'v1', max_prompt_characters: 1000,
    max_lyrics_characters: 1000, max_title_characters: 100, ...extra,
  }),
}

/** The one row builder a family's catalogue needs. */
function row(family: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return rowFor[family](id, extra)
}

describe('default models — the app-wide fallback', () => {
  let temp: Awaited<ReturnType<typeof useTempDataDir>>
  let server: FamilyCatalogServer
  let settings: typeof import('../services/app-settings.js')
  let client: typeof import('../lib/genstudio-client.js')
  let resolveDefaultModel: typeof import('../services/genstudio-default-model.js')['resolveDefaultModel']
  let resolveChosenChatModel: typeof import('../services/genstudio-default-model.js')['resolveChosenChatModel']
  const KEY = 'gsk_test_key'

  before(async () => {
    temp = await useTempDataDir()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    settings = await import('../services/app-settings.js')
    client = await import('../lib/genstudio-client.js')
    ;({ resolveDefaultModel, resolveChosenChatModel } = await import('../services/genstudio-default-model.js'))
    server = await new FamilyCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
  })

  after(async () => {
    await server?.close()
    await temp?.cleanup()
  })

  /**
   * Set the rows one catalogue serves, and drop the process-local catalogue cache.
   *
   * The cache is deliberately hot for five minutes in production, so without this a test would read
   * the PREVIOUS test's rows and pass for the wrong reason.
   */
  function publish(catalogs: Partial<Record<string, any[]>>): void {
    for (const key of Object.keys(server.catalogs)) server.catalogs[key] = []
    Object.assign(server.catalogs, catalogs)
    client.clearGenStudioCatalogCache()
  }

  test('every family defaults to unset on a fresh install', async () => {
    const models = await settings.getDefaultModels()
    assert.deepEqual(models, {
      writing: null, image: null, video: null, audio: null, transcription: null, music: null,
    })
  })

  test('a whole value is validated before it replaces the last good one', async () => {
    const saved = await settings.setDefaultModels({ writing: 'chat-a' })
    assert.equal(saved.writing, 'chat-a')
    assert.equal(saved.image, null, 'an unset family is written as null, never left undefined')

    for (const invalid of [
      { writing: 'chat-a', bogus: 'chat-b' },       // an unknown family
      { writing: '   ' },                            // an empty id is not a choice
      { writing: 42 },                               // not an id
      'chat-a',                                      // not an object
      null,
    ]) {
      await assert.rejects(settings.setDefaultModels(invalid), /Default models requires only the families/,
        `refused: ${JSON.stringify(invalid)}`)
    }
    // A refused write leaves the last admitted value exactly as it was.
    assert.equal((await settings.getDefaultModels()).writing, 'chat-a')
  })

  test('corrupt storage fails closed to every family unset', async () => {
    await settings.setDefaultModels({ writing: 'chat-a', image: 'image-a' })
    await settings.setAppSetting(settings.DEFAULT_MODELS_KEY, { writing: 'chat-a', image: '' })
    assert.deepEqual(await settings.getDefaultModels(), {
      writing: null, image: null, video: null, audio: null, transcription: null, music: null,
    })
  })

  test('no default set resolves to null — the page then asks, it is never given a model', async () => {
    await settings.setDefaultModels({})
    publish({ chat: [row('chat', 'chat-a', { cost_tier: 'economy' })] })
    assert.equal(await resolveDefaultModel(KEY, 'writing'), null)
  })

  for (const [family, route] of [
    ['writing', 'chat'], ['image', 'image'], ['video', 'video'],
    ['audio', 'tts'], ['transcription', 'transcription'], ['music', 'music'],
  ] as const) {
    test(`a live ${family} default is used as chosen`, async () => {
      publish({ [route]: [row(route, 'live-one'), row(route, 'live-two')] })
      await settings.setDefaultModels({ [family]: 'live-two' })
      assert.equal(await resolveDefaultModel(KEY, family), 'live-two')
    })
  }

  test('a default that is gone from the catalogue is refused BY NAME — never swapped', async () => {
    publish({ chat: [row('chat', 'chat-other')] })
    await settings.setDefaultModels({ writing: 'chat-gone' })
    await assert.rejects(resolveDefaultModel(KEY, 'writing'), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /Your default writing model "chat-gone" is no longer available — choose another/)
      assert.match(err.message, /did not switch to a different model/)
      assert.doesNotMatch(err.message, /chat-other/)
      return true
    })
  })

  // Each flag is checked on the family whose catalogue actually publishes it: a chat row has no
  // `coming_soon`, and a music row has no `qualification_only`. Testing one family's flag against
  // another family's parser would pass because the field was IGNORED, not because it was refused.
  for (const [why, route, family, flags] of [
    ['unavailable', 'chat', 'writing', { available: false }],
    ['locked', 'chat', 'writing', { locked: true }],
    ['qualification-only', 'chat', 'writing', { qualification_only: true }],
    ['coming soon', 'music', 'music', { coming_soon: true }],
    ['not generation-enabled', 'tts', 'audio', { generation_enabled: false }],
  ] as const) {
    test(`a ${why} default is refused, not used`, async () => {
      publish({ [route]: [row(route, 'blocked-one', flags), row(route, 'other-one')] })
      await settings.setDefaultModels({ [family]: 'blocked-one' })
      await assert.rejects(resolveDefaultModel(KEY, family),
        new RegExp(`Your default ${family === 'audio' ? 'voice' : family} model "blocked-one" is no longer available`))
    })
  }

  test('an unreachable catalogue is an error, never a silent "no default"', async () => {
    await settings.setDefaultModels({ writing: 'chat-a' })
    await settings.setGenStudioUrl('http://127.0.0.1:1')
    try {
      await assert.rejects(resolveDefaultModel(KEY, 'writing'), /model list is unreachable/)
    } finally {
      await settings.setGenStudioUrl(server.baseUrl)
    }
  })

  test('resolving a default writes nothing — the setting is read-only', async () => {
    publish({ chat: [row('chat', 'chat-a')] })
    await settings.setDefaultModels({ writing: 'chat-a' })
    const before = JSON.stringify(await settings.getAllAppSettings())
    assert.equal(await resolveDefaultModel(KEY, 'writing'), 'chat-a')
    assert.equal(JSON.stringify(await settings.getAllAppSettings()), before)
  })
})

describe('resolveChosenChatModel — the default is the LAST link only', () => {
  let temp: Awaited<ReturnType<typeof useTempDataDir>>
  let server: FamilyCatalogServer
  let settings: typeof import('../services/app-settings.js')
  let client: typeof import('../lib/genstudio-client.js')
  let resolveChosenChatModel: typeof import('../services/genstudio-default-model.js')['resolveChosenChatModel']
  const KEY = 'gsk_test_key'
  const WHERE = 'the Metadata page'

  before(async () => {
    temp = await useTempDataDir()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    settings = await import('../services/app-settings.js')
    client = await import('../lib/genstudio-client.js')
    ;({ resolveChosenChatModel } = await import('../services/genstudio-default-model.js'))
    server = await new FamilyCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
  })

  after(async () => {
    await server?.close()
    await temp?.cleanup()
  })

  /** Set the chat rows served and drop the process-local catalogue cache (see the note above). */
  function publishChat(rows: any[]): void {
    server.catalogs.chat = rows
    client.clearGenStudioCatalogCache()
  }

  test('a preset\'s or page\'s own model wins over the app default', async () => {
    publishChat([row('chat', 'saved-choice'), row('chat', 'app-default')])
    await settings.setDefaultModels({ writing: 'app-default' })
    assert.equal(await resolveChosenChatModel(KEY, 'saved-choice', WHERE), 'saved-choice')
  })

  test('nothing chosen takes the app default when it is live', async () => {
    publishChat([row('chat', 'saved-choice'), row('chat', 'app-default')])
    await settings.setDefaultModels({ writing: 'app-default' })
    assert.equal(await resolveChosenChatModel(KEY, '', WHERE), 'app-default')
  })

  test('nothing chosen and no default keeps the plain "choose one" refusal', async () => {
    publishChat([row('chat', 'saved-choice'), row('chat', 'app-default')])
    await settings.setDefaultModels({})
    await assert.rejects(resolveChosenChatModel(KEY, '', WHERE),
      /No writing model is chosen for this step\. Choose one on the Metadata page.*does not pick a writing model for you/)
  })

  test('nothing chosen and a gone default says so plainly, leaving the field empty', async () => {
    await settings.setDefaultModels({ writing: 'app-default' })
    publishChat([row('chat', 'some-other')])
    await assert.rejects(resolveChosenChatModel(KEY, '', WHERE),
      /Your default writing model "app-default" is no longer available — choose another/)
  })

  test('an explicitly chosen model that is gone is still refused by ITS name, not the default\'s', async () => {
    publishChat([row('chat', 'app-default')])
    await settings.setDefaultModels({ writing: 'app-default' })
    await assert.rejects(resolveChosenChatModel(KEY, 'chosen-gone', WHERE),
      /The writing model "chosen-gone" isn't available right now/)
  })
})

describe('default models are never written into a preset or a channel', () => {
  const OWNED_SOURCE_FILES = [
    'services/genstudio-default-model.ts',
    'services/thumbnail-presets.ts',
    'generators/episode.ts',
    'generators/metadata.ts',
    'generators/scene-plan.ts',
    'generators/contextual-cues.ts',
    'routes/pipeline.ts',
    'routes/scene-plan.ts',
    'routes/scene-review.ts',
    'routes/images.ts',
    'routes/scripts.ts',
    'services/research/genstudio.ts',
  ]

  for (const relativePath of OWNED_SOURCE_FILES) {
    test(`${relativePath} only reads the default models setting`, async () => {
      const source = await fs.readFile(path.join(SERVER_ROOT, relativePath), 'utf8')
      // The ONLY writer is the settings route. A generator that called the setter would be baking
      // an app-level default into a preset, a channel config or a job's remembered state.
      assert.doesNotMatch(source, /setDefaultModels|DEFAULT_MODELS_KEY/, `${relativePath} writes the default models setting`)
    })
  }
})
