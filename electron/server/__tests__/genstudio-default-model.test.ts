/**
 * Regression coverage for services/genstudio-default-model.ts and the
 * call sites it replaced.
 *
 * The audit found several places that fell back to a hardcoded external
 * product id (e.g. 'deepseek-v4-flash', 'gpt-4o-mini', 'gpt-4o') whenever
 * the caller didn't specify a model. `lib/ai-client.ts` only
 * length-validates a model string — it never checks catalog membership —
 * so a retired/renamed literal would have gone straight to submission.
 * These tests pin the replacement behavior: live-catalog-only resolution,
 * saved-selection preservation, visible healing, and loud failure when the
 * catalog can't be reached.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import test, { afterEach, before, describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type ChatModelFixture = {
  id: string
  display_name?: string
  available?: boolean
  qualification_only?: boolean
}

/** Minimal standalone GenStudio stand-in — only /v1/chat/models, fully
 *  controllable per test. Deliberately NOT the shared mock-genstudio-service
 *  fixture, whose /v1/chat/models catalog is fixed to one static model. */
class ChatCatalogServer {
  private server = http.createServer((req, res) => this.handle(req, res))
  catalog: ChatModelFixture[] = []
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
    if (req.url === '/v1/chat/models') {
      const body = Buffer.from(JSON.stringify(this.catalog.map(m => ({
        id: m.id,
        display_name: m.display_name ?? m.id,
        available: m.available !== false,
        qualification_only: m.qualification_only === true,
      }))))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
      res.end(body)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ detail: 'not found' }))
  }
}

describe('resolveDefaultChatModel — live-catalog default resolution', () => {
  let temp: Awaited<ReturnType<typeof useTempDataDir>>
  let server: ChatCatalogServer
  let resolveDefaultChatModel: typeof import('../services/genstudio-default-model.js')['resolveDefaultChatModel']
  let settings: typeof import('../services/app-settings.js')

  before(async () => {
    temp = await useTempDataDir()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    settings = await import('../services/app-settings.js')
    ;({ resolveDefaultChatModel } = await import('../services/genstudio-default-model.js'))
  })

  afterEach(async () => {
    if (server) await server.close()
  })

  test('a published live model is selectable', async () => {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [
      { id: 'genstudio-chat-current-v1', available: true, qualification_only: false },
      { id: 'genstudio-chat-qualification-only', available: true, qualification_only: true },
    ]
    const result = await resolveDefaultChatModel('gsk_test_key')
    assert.equal(result.modelId, 'genstudio-chat-current-v1')
    assert.equal(result.healed, false)
    assert.equal(result.requestedModelId, null)
  })

  test('an unavailable/retired model is not selectable', async () => {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [
      { id: 'genstudio-chat-retired', available: false, qualification_only: false },
      { id: 'genstudio-chat-qualification-only', available: true, qualification_only: true },
    ]
    // Only unusable products in the catalog: never invent a literal.
    await assert.rejects(
      resolveDefaultChatModel('gsk_test_key'),
      /No published GenStudio language model is currently available/,
    )
    // A saved selection pointing at the retired product must not be echoed
    // back — it should heal to a usable product instead, and there isn't
    // one here, so this still fails loudly.
    await assert.rejects(
      resolveDefaultChatModel('gsk_test_key', 'genstudio-chat-retired'),
      /No published GenStudio language model is currently available/,
    )
  })

  test('a still-valid saved selection is preserved', async () => {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [
      { id: 'genstudio-chat-a', available: true, qualification_only: false },
      { id: 'genstudio-chat-b', available: true, qualification_only: false },
    ]
    const result = await resolveDefaultChatModel('gsk_test_key', 'genstudio-chat-b')
    assert.equal(result.modelId, 'genstudio-chat-b')
    assert.equal(result.healed, false)
    assert.equal(result.requestedModelId, 'genstudio-chat-b')
  })

  test('a removed saved selection heals visibly instead of silently', async () => {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [
      { id: 'genstudio-chat-current-v1', available: true, qualification_only: false },
    ]
    const result = await resolveDefaultChatModel('gsk_test_key', 'genstudio-chat-retired-product')
    assert.equal(result.modelId, 'genstudio-chat-current-v1')
    assert.equal(result.healed, true, 'a vanished saved selection must be reported as healed, not hidden')
    assert.equal(result.requestedModelId, 'genstudio-chat-retired-product')
  })

  test('a saved selection that is now qualification-only is treated as unusable and heals', async () => {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [
      { id: 'genstudio-chat-current-v1', available: true, qualification_only: false },
      { id: 'genstudio-chat-gated', available: true, qualification_only: true },
    ]
    const result = await resolveDefaultChatModel('gsk_test_key', 'genstudio-chat-gated')
    assert.equal(result.modelId, 'genstudio-chat-current-v1')
    assert.equal(result.healed, true)
  })

  test('catalog-offline fails loudly instead of substituting a literal', async () => {
    // Point at a closed port — nothing is listening, so the fetch itself fails.
    await settings.setGenStudioUrl('http://127.0.0.1:1')
    await assert.rejects(
      resolveDefaultChatModel('gsk_test_key'),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /Could not resolve a default GenStudio language model/)
        assert.match(err.message, /live catalog is unreachable/)
        // Must never contain a plausible hardcoded fallback id.
        assert.doesNotMatch(err.message, /deepseek-v4-flash|gpt-4o-mini|gpt-4o\b/)
        return true
      },
    )
  })
})

describe('no owned source file expresses a hardcoded external product id as a generation default', () => {
  const OWNED_SOURCE_FILES = [
    'generators/image-prompts.ts',
    'generators/metadata.ts',
    'generators/scene-clip.ts',
    'routes/audio.ts',
    'routes/image-prompts-edit.ts',
    'routes/pipeline.ts',
    'routes/upload.ts',
    'services/audio-expression.ts',
    'services/research/genstudio.ts',
    'services/genstudio-default-model.ts',
  ]

  // Literals the audit named as removed hardcoded execution-authority
  // defaults. Matched as real code tokens, not prose mentioning them in a
  // comment (this file's own docstring above legitimately names them).
  const FORBIDDEN_DEFAULT_LITERALS = [/'deepseek-v4-flash'/, /"deepseek-v4-flash"/, /'gpt-4o-mini'/, /"gpt-4o-mini"/, /'gpt-4o'/, /"gpt-4o"/]

  function stripComments(source: string): string {
    return source
      .split('\n')
      .filter(line => {
        const trimmed = line.trim()
        return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**'))
      })
      .join('\n')
  }

  for (const relativePath of OWNED_SOURCE_FILES) {
    test(`${relativePath} has no hardcoded external product id default in executable code`, async () => {
      const source = await fs.readFile(path.join(SERVER_ROOT, relativePath), 'utf8')
      const code = stripComments(source)
      for (const pattern of FORBIDDEN_DEFAULT_LITERALS) {
        assert.doesNotMatch(code, pattern, `${relativePath} still contains ${pattern} in executable code`)
      }
    })
  }
})
