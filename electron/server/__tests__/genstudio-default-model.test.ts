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
  locked?: boolean
  cost_tier?: 'economy' | 'balanced' | 'premium'
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
        ...(m.cost_tier ? { cost_tier: m.cost_tier } : {}),
        ...(m.locked === true ? { locked: true, lock_reason: 'requires_paid_account' } : {}),
      }))))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
      res.end(body)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ detail: 'not found' }))
  }
}

describe('resolveChosenChatModel — only the owner\'s choice ever runs', () => {
  let temp: Awaited<ReturnType<typeof useTempDataDir>>
  let server: ChatCatalogServer
  let resolveChosenChatModel: typeof import('../services/genstudio-default-model.js')['resolveChosenChatModel']
  let settings: typeof import('../services/app-settings.js')
  const WHERE = 'the Metadata page'

  before(async () => {
    temp = await useTempDataDir()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    settings = await import('../services/app-settings.js')
    ;({ resolveChosenChatModel } = await import('../services/genstudio-default-model.js'))
  })

  afterEach(async () => {
    if (server) await server.close()
  })

  async function catalog(models: ChatModelFixture[]) {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = models
  }

  test('a chosen live model runs as chosen', async () => {
    await catalog([{ id: 'chosen-v1' }, { id: 'other-v1', cost_tier: 'economy' }])
    assert.equal(await resolveChosenChatModel('gsk_test_key', 'chosen-v1', WHERE), 'chosen-v1')
  })

  test('nothing chosen stops with where to choose — no model is picked, even with an economy one live', async () => {
    await catalog([{ id: 'free-looking-v1', cost_tier: 'economy' }])
    for (const none of [undefined, null, '', '   ']) {
      await assert.rejects(resolveChosenChatModel('gsk_test_key', none, WHERE),
        /No writing model is chosen for this step\. Choose one on the Metadata page.*does not pick a writing model for you/)
    }
  })

  for (const [why, row] of [
    ['removed', null],
    ['unavailable', { id: 'chosen-v1', available: false }],
    ['qualification-only', { id: 'chosen-v1', qualification_only: true }],
    ['locked', { id: 'chosen-v1', locked: true }],
  ] as const) {
    test(`a chosen model that is ${why} stops, naming it — never swapped for another`, async () => {
      await catalog([...(row ? [row as ChatModelFixture] : []), { id: 'other-v1', cost_tier: 'economy' }])
      await assert.rejects(resolveChosenChatModel('gsk_test_key', 'chosen-v1', WHERE), (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /The writing model "chosen-v1" isn't available right now/)
        assert.match(err.message, /Pick another one on the Metadata page/)
        assert.match(err.message, /did not switch to a different model/)
        assert.doesNotMatch(err.message, /other-v1/)
        return true
      })
    })
  }

  test('catalog offline fails loudly instead of substituting a literal', async () => {
    await settings.setGenStudioUrl('http://127.0.0.1:1')
    await assert.rejects(resolveChosenChatModel('gsk_test_key', 'chosen-v1', WHERE), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /model list is unreachable/)
      assert.doesNotMatch(err.message, /deepseek-v4-flash|gpt-4o-mini|gpt-4o\b/)
      return true
    })
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
    'services/research/genstudio.ts',
    'services/genstudio-default-model.ts',
    // Chapter/outline expansion runs through lib/chunked-narration.ts's
    // withChosenModel (called from both this file and generators/episode.ts).
    'lib/chunked-narration.ts',
    'generators/episode.ts',
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
