/**
 * Story's local-first footage library (1.4.402).
 *
 * The rules pinned here are the owner contract:
 *  - a clip already in the configured root resolves with ZERO Gateway calls;
 *  - a miss downloads ONCE, the received bytes must hash to the clip id, and
 *    the provenance sidecar is written beside them;
 *  - once local, the clip resolves with the Gateway unreachable;
 *  - a file whose bytes no longer match its name moves to Story's Trash and is
 *    fetched again — never silently used, never deleted;
 *  - an unreachable Gateway error names the clip and says it is unreachable;
 *  - a configured root is used exactly, and a new one is created 0700.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

interface FixtureClip {
  bytes: Buffer
  contentType: string
  row: Record<string, unknown>
}

class FootageGatewayFixture {
  private server = http.createServer((req, res) => this.handle(req, res))
  baseUrl = ''
  clips = new Map<string, FixtureClip>()
  searchResults: Record<string, unknown>[] = []
  requests: Array<{ path: string; method: string; authorization: string }> = []

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
    const closed = once(this.server, 'close')
    this.server.close()
    this.server.closeAllConnections()
    await closed
  }

  downloadRequests(): number {
    return this.requests.filter(request => request.path.endsWith('/file')).length
  }

  private json(res: ServerResponse, body: unknown, status = 200): void {
    const payload = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) })
    res.end(payload)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    this.requests.push({
      path: url.pathname,
      method: String(req.method || 'GET').toUpperCase(),
      authorization: String(req.headers.authorization || ''),
    })
    if (url.pathname === '/v1/footage/library') {
      this.json(res, { clips: [...this.clips.values()].map(clip => clip.row) })
      return
    }
    if (url.pathname === '/v1/footage/search') {
      this.json(res, {
        results: this.searchResults,
        library: [...this.clips.values()].map(clip => clip.row),
        sources: [{ id: 'wikimedia', ok: true }],
      })
      return
    }
    const file = /^\/v1\/footage\/library\/([0-9a-f]{64})\/file$/.exec(url.pathname)
    if (file) {
      const clip = this.clips.get(file[1]!)
      if (!clip) {
        this.json(res, { detail: 'No such clip in the library.' }, 404)
        return
      }
      res.writeHead(200, { 'Content-Type': clip.contentType, 'Content-Length': String(clip.bytes.length) })
      res.end(clip.bytes)
      return
    }
    this.json(res, { detail: 'not found' }, 404)
  }
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const LOCAL = Buffer.from('local footage bytes already on this Mac')
const LOCAL_SHA = sha(LOCAL)
const REMOTE = Buffer.from('footage bytes fetched from the Gateway once')
const REMOTE_SHA = sha(REMOTE)
const CORRUPT_SHA = sha(Buffer.from('the bytes the Gateway will send for the corrupt case'))
const CORRUPT = Buffer.from('the bytes the Gateway will send for the corrupt case')
const CUSTOM = Buffer.from('footage kept on an external drive chosen by the owner')
const CUSTOM_SHA = sha(CUSTOM)
const DEAD_GATEWAY = 'http://127.0.0.1:9'

let temp: Awaited<ReturnType<typeof useTempDataDir>>
let server: FootageGatewayFixture
let settings: typeof import('../services/app-settings.js')
let library: typeof import('../services/footage-library.js')
let client: typeof import('../lib/footage-client.js')

before(async () => {
  temp = await useTempDataDir()
  settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  library = await import('../services/footage-library.js')
  client = await import('../lib/footage-client.js')
  server = await new FootageGatewayFixture().start()
  await settings.setGenStudioUrl(server.baseUrl)
  await secrets.setApiKey('genstudio', 'test-key')
})

after(async () => {
  await server.close()
  await temp.cleanup()
})

describe('the local footage library', () => {
  test('a clip already in the configured root resolves with zero Gateway calls', async () => {
    const root = await settings.getFootageRoot()
    assert.equal(root, path.join(temp.dir, 'footage'), 'the default root sits beside the app data')
    await fs.mkdir(root, { recursive: true })
    const local = path.join(root, `${LOCAL_SHA}.mp4`)
    await fs.writeFile(local, LOCAL)
    await fs.writeFile(path.join(root, `${LOCAL_SHA}.json`), '{"licence":"cc0"}\n')

    server.requests = []
    const resolved = await library.resolveFootage(LOCAL_SHA)
    assert.equal(resolved, local, 'the sidecar beside the clip is never claimed as the clip')
    assert.equal(server.requests.length, 0, 'a local hit never asks the Gateway')
  })

  test('a miss downloads once, verifies the hash and writes the provenance sidecar', async () => {
    const row = {
      sha256: REMOTE_SHA, title: 'Harbour sunrise', source: 'wikimedia', source_id: 'wm-17',
      licence: 'cc0', provenance: 'Wikimedia stock', tags: ['sea', 'sunrise'],
      filesize_bytes: REMOTE.length, ai_generated: false,
    }
    server.clips.set(REMOTE_SHA, { bytes: REMOTE, contentType: 'video/mp4', row })
    server.requests = []

    const file = await library.fetchFootage(REMOTE_SHA, row)
    const root = await settings.getFootageRoot()
    assert.equal(file, path.join(root, `${REMOTE_SHA}.mp4`))
    assert.deepEqual(await fs.readFile(file), REMOTE)
    assert.equal(server.requests.length, 1, 'the miss makes exactly one Gateway request')
    assert.equal(server.downloadRequests(), 1, 'the clip is downloaded exactly once')

    const sidecar = JSON.parse(await fs.readFile(path.join(root, `${REMOTE_SHA}.json`), 'utf8'))
    assert.equal(sidecar.sha256, REMOTE_SHA)
    assert.equal(sidecar.bytes, REMOTE.length)
    assert.equal(sidecar.mime, 'video/mp4')
    assert.equal(sidecar.title, 'Harbour sunrise')
    assert.equal(sidecar.source, 'wikimedia')
    assert.equal(sidecar.licence, 'cc0')
    assert.equal(sidecar.origin, 'Wikimedia stock')
    assert.deepEqual(sidecar.tags, ['sea', 'sunrise'])
    assert.equal(sidecar.ai_generated, false)
    assert.match(sidecar.fetched_at, /^\d{4}-\d{2}-\d{2}T/)

    const headers = server.requests.every(request => request.authorization === 'Bearer test-key')
    assert.equal(headers, true, 'every call carries the scoped Gateway key')
  })

  test('after the first fetch the clip resolves with the Gateway unreachable', async () => {
    await settings.setGenStudioUrl(DEAD_GATEWAY)
    try {
      server.requests = []
      const resolved = await library.resolveFootage(REMOTE_SHA)
      const root = await settings.getFootageRoot()
      assert.equal(resolved, path.join(root, `${REMOTE_SHA}.mp4`))
      assert.equal(server.requests.length, 0)
    } finally {
      await settings.setGenStudioUrl(server.baseUrl)
    }
  })

  test('a file whose bytes no longer match its name moves to Story’s Trash and is fetched again', async () => {
    const root = await settings.getFootageRoot()
    const corrupt = path.join(root, `${CORRUPT_SHA}.mp4`)
    await fs.writeFile(corrupt, Buffer.from('torn or replaced bytes'))
    await fs.writeFile(path.join(root, `${CORRUPT_SHA}.json`), '{"licence":"cc0"}\n')
    const row = { sha256: CORRUPT_SHA, title: 'Bad take', licence: 'cc0' }
    server.clips.set(CORRUPT_SHA, { bytes: CORRUPT, contentType: 'video/mp4', row })
    server.requests = []

    const file = await library.fetchFootage(CORRUPT_SHA, row)
    assert.deepEqual(await fs.readFile(file), CORRUPT)
    assert.equal(server.requests.length, 1, 'only the repair is fetched')

    const trash = path.join(root, '_trash', '_story-studio', 'footage')
    assert.deepEqual(await fs.readFile(path.join(trash, `${CORRUPT_SHA}.mp4`)), Buffer.from('torn or replaced bytes'))
    await fs.access(path.join(trash, `${CORRUPT_SHA}.json`))
    const sidecar = JSON.parse(await fs.readFile(path.join(root, `${CORRUPT_SHA}.json`), 'utf8'))
    assert.equal(sidecar.title, 'Bad take', 'the sidecar is rewritten for the repaired bytes')
    assert.equal(sidecar.bytes, CORRUPT.length)
    assert.equal(sidecar.licence, 'cc0')
    assert.equal(sidecar.source, null, 'an unpublished field stays null, never invented')
  })

  test('an unreachable Gateway error names the clip and says it is unreachable', async () => {
    const missing = sha(Buffer.from('a clip this Mac has never had'))
    await settings.setGenStudioUrl(DEAD_GATEWAY)
    try {
      await assert.rejects(
        () => library.fetchFootage(missing, { title: 'Harbour sunrise' }),
        (error: any) => /Harbour sunrise/.test(error.message) && /Gateway is unreachable/.test(error.message),
      )
    } finally {
      await settings.setGenStudioUrl(server.baseUrl)
    }
  })

  test('search relays the Gateway’s catalogue rows verbatim', async () => {
    const upstream = {
      source: 'wikimedia', source_id: 'wm-99', title: 'Storm over the bay', licence: 'cc0',
      filetype: 'webm', filesize: 1234, tags: ['storm'], ai_generated: false,
    }
    server.searchResults = [upstream]
    server.requests = []

    const answer = await client.searchFootage('storm', 'coast')
    assert.deepEqual(answer.results, [upstream])
    assert.equal(answer.library.length, 1)
    assert.equal(answer.sources[0]?.id, 'wikimedia')
    assert.ok(answer.library[0]?.sha256, 'library rows keep their identity')
    assert.match(server.requests[0]!.path, /^\/v1\/footage\/search$/)
  })

  test('the configured root is used exactly and a new one is created 0700', async () => {
    const custom = path.join(temp.dir, 'footage-on-the-ssd')
    await settings.setFootageRoot(custom)
    try {
      const row = { sha256: CUSTOM_SHA, title: 'Cliff edge', licence: 'by', provenance: 'Pexels stock' }
      server.clips.set(CUSTOM_SHA, { bytes: CUSTOM, contentType: 'video/quicktime', row })
      const file = await library.fetchFootage(CUSTOM_SHA, row)
      assert.equal(path.dirname(file), custom)
      assert.equal(path.extname(file), '.mov')
      assert.equal((await fs.stat(custom)).mode & 0o777, 0o700)

      const sidecar = JSON.parse(await fs.readFile(path.join(custom, `${CUSTOM_SHA}.json`), 'utf8'))
      assert.equal(sidecar.origin, 'Pexels stock')
      assert.equal(sidecar.ai_generated, undefined, 'an unpublished flag is absent, never guessed false')
    } finally {
      await settings.setFootageRoot('')
    }
  })

  test('an unavailable root is named plainly, never read as “no clips”', async () => {
    const blocked = path.join(temp.dir, 'a-file')
    await fs.writeFile(blocked, 'not a folder')
    const impossible = path.join(blocked, 'footage')
    await settings.setFootageRoot(impossible)
    try {
      await assert.rejects(
        () => library.resolveFootage(LOCAL_SHA),
        (error: any) => error.message.includes(impossible) && /is not available/.test(error.message),
      )
    } finally {
      await settings.setFootageRoot('')
    }
  })
})
