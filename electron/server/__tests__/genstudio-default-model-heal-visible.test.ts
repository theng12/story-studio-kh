/**
 * A silent heal is the defect; the heal itself is correct.
 *
 * `ResolvedDefaultChatModel.healed` is documented as something callers
 * "should surface to the operator instead of healing silently" — and every
 * caller holding a saved preference dropped it on the floor. A run against a
 * substituted model was indistinguishable from a run against the model the
 * project had actually saved, which is precisely what a GenStudio catalogue
 * dedupe produces at scale.
 *
 * Two things are pinned here:
 *   1. `describeHealedDefaultChatModel` says the right thing about a REAL
 *      resolution — the flag is produced by the live resolver against a
 *      catalogue stand-in, never by a hand-built result object.
 *   2. No call site holding a saved preference goes back to discarding it.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import test, { afterEach, before, describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal /v1/chat/models stand-in, controllable per test. */
class ChatCatalogServer {
  private server = http.createServer((req, res) => this.handle(req, res))
  catalog: Array<{ id: string, available?: boolean, qualification_only?: boolean }> = []
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
        display_name: m.id,
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

describe('describeHealedDefaultChatModel — the substitution is said out loud', () => {
  let temp: Awaited<ReturnType<typeof useTempDataDir>>
  let server: ChatCatalogServer
  let resolveDefaultChatModel: typeof import('../services/genstudio-default-model.js')['resolveDefaultChatModel']
  let describeHealedDefaultChatModel: typeof import('../services/genstudio-default-model.js')['describeHealedDefaultChatModel']
  let settings: typeof import('../services/app-settings.js')

  before(async () => {
    temp = await useTempDataDir()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    settings = await import('../services/app-settings.js')
    ;({ resolveDefaultChatModel, describeHealedDefaultChatModel } = await import('../services/genstudio-default-model.js'))
  })

  afterEach(async () => {
    if (server) await server.close()
  })

  test('a saved product that GenStudio no longer publishes produces a sentence naming both models', async () => {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [{ id: 'genstudio-chat-live' }]

    const resolved = await resolveDefaultChatModel('gsk_test_key', 'deleted-by-dedupe')
    assert.equal(resolved.healed, true, 'precondition: this resolution really did heal')
    assert.equal(resolved.modelId, 'genstudio-chat-live')

    const notice = describeHealedDefaultChatModel(resolved)
    assert.ok(notice, 'a heal must produce something to show the operator')
    assert.match(notice!, /deleted-by-dedupe/, 'names what was saved')
    assert.match(notice!, /genstudio-chat-live/, 'names what actually ran')
    assert.match(notice!, /no longer available/)
    assert.match(notice!, /Choose a model explicitly/, 'tells the operator what to do')
  })

  test('a saved product that is still live says nothing', async () => {
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [{ id: 'genstudio-chat-live' }, { id: 'genstudio-chat-other' }]

    const resolved = await resolveDefaultChatModel('gsk_test_key', 'genstudio-chat-live')
    assert.equal(resolved.healed, false)
    assert.equal(describeHealedDefaultChatModel(resolved), null, 'no substitution, nothing to report')
  })

  test('no saved preference at all is not a substitution', async () => {
    // Nothing was overridden, so there is nothing to tell anyone about.
    server = await new ChatCatalogServer().start()
    await settings.setGenStudioUrl(server.baseUrl)
    server.catalog = [{ id: 'genstudio-chat-live' }]

    const resolved = await resolveDefaultChatModel('gsk_test_key')
    assert.equal(resolved.modelId, 'genstudio-chat-live')
    assert.equal(describeHealedDefaultChatModel(resolved), null)
  })
})

/**
 * The class guard.
 *
 * Fixing six call sites is worth little if the seventh reintroduces the
 * pattern next quarter. Any module that resolves a SAVED preference must also
 * route the result somewhere a human can see it.
 */
describe('no caller discards a heal', () => {
  /** Call sites that pass a saved preference and must therefore report. */
  const mustReport = [
    'generators/image-prompts.ts',
    'generators/metadata.ts',
    'routes/audio.ts',
    'routes/upload.ts',
    'routes/image-prompts-edit.ts',
    'services/audio-expression.ts',
  ]

  /**
   * Exempt, with reasons — not "unchecked".
   *  - chunked-narration.ts already announces its own mid-run heal, in its own
   *    words, on `job.output_lines` (that announcement is this fix's model).
   *  - pipeline.ts and research/genstudio.ts pass NO saved preference, so
   *    `healed` is structurally always false for them.
   */
  const exempt = new Set([
    'lib/chunked-narration.ts',
    'routes/pipeline.ts',
    'services/research/genstudio.ts',
    'services/genstudio-default-model.ts',
  ])

  for (const relPath of mustReport) {
    test(`${relPath} surfaces the heal instead of taking .modelId and walking away`, () => {
      const source = readFileSync(path.join(SERVER_ROOT, relPath), 'utf8')
      assert.match(
        source,
        /describeHealedDefaultChatModel/,
        `${relPath} resolves a saved model preference, so it must route the heal notice somewhere visible`,
      )
      assert.doesNotMatch(
        source,
        /\(await resolveDefaultChatModel\([^)]*\)\)\.modelId/,
        `${relPath} still throws the resolution away inline — the flag rides on the result object`,
      )
    })
  }

  test('the exempt list still matches reality', () => {
    // If a NEW module starts resolving a saved preference, it lands in neither
    // list and this fails — which is the point.
    const callers = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue
          walk(full)
        } else if (entry.name.endsWith('.ts')) {
          if (readFileSync(full, 'utf8').includes('resolveDefaultChatModel')) {
            callers.add(path.relative(SERVER_ROOT, full))
          }
        }
      }
    }
    walk(SERVER_ROOT)

    const unaccounted = [...callers].filter(f => !exempt.has(f) && !mustReport.includes(f))
    assert.deepEqual(
      unaccounted,
      [],
      'a new resolveDefaultChatModel caller appeared — decide whether it must report a heal, then add it to mustReport or exempt (with a reason)',
    )
  })
})
