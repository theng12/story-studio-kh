/**
 * Chapter expansion never swaps the owner's chosen writing model for another one.
 *
 * It used to: when the chosen model (named by both the request and the outline snapshot) was no
 * longer published, `withModelFallback` resolved "the live default" — the first usable economy
 * model — logged the swap and carried on. The gateway publishes every chat model as economy /
 * 0 credits, so that default could be a PAID provider the owner never picked (coordinator decision
 * 2026-10-03: Story never picks a writing model). Now the run stops with a plain sentence naming the
 * model, nothing is submitted, and the outline keeps the owner's choice.
 *
 * Zero paid calls: every request in here goes to an in-process mock HTTP server.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any

const EPISODE_ID = 'EP001'
const TITLE = 'Model Fallback Test'
const TOTAL_CHAPTERS = 1

/** Mirrors the id from the real GenStudio migration: a private `chat_models`
 *  row, never published, that Story Studio persisted before the product-first
 *  catalogue existed. */
const DEAD_MODEL = 'genstudio-chat:genstudio-chat-b7abf15650287980589c-v1'

let slug: string
let scriptDir: string
let sidecarFile: string

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup

  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const mod = await import('../app.js')
  app = mod.app

  const proj = await request(app).post('/api/projects').send({
    name: 'Model Fallback Test',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(proj.status, 201)
  slug = proj.body.slug

  const { resolveEpisodePaths } = await import('../services/utils.js')
  const paths = await resolveEpisodePaths(slug, EPISODE_ID, TITLE)
  scriptDir = paths.script_dir
  sidecarFile = path.join(scriptDir, `${EPISODE_ID}_chunked-progress.json`)
})

after(async () => { await cleanup() })

async function pointGenStudioAt(baseUrl: string, apiKey: string): Promise<void> {
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey })).status, 200)
}

/** A v3 sidecar whose generation_params record the SAME dead model the
 *  incoming job request will also carry — the case the divergence check in
 *  setupChunkedJobContext cannot detect. */
async function seedSidecar(): Promise<void> {
  const now = new Date().toISOString()
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(sidecarFile, JSON.stringify({
    schema_version: 3,
    episode_id: EPISODE_ID,
    mode: 'listicle',
    total_chapters: TOTAL_CHAPTERS,
    outline: [{ n: 1, title: 'Topic 1', hook_line: 'Hook 1' }],
    outline_completed_at: now,
    outline_approved_at: now,
    outline_edited_at: null,
    chapters_done: [],
    params_hash: 'fakehash00000000',
    last_updated: now,
    generation_params: {
      model: DEAD_MODEL,
      words_per_chapter: 200,
      total_words: 200,
      style: 'A',
    },
  }, null, 2))
}

function fakeExpandJob(params: Record<string, unknown>): any {
  return {
    job_id: `test-expand-${Math.random().toString(36).slice(2)}`,
    project_slug: slug,
    type: 'expand_chapters',
    episode_id: EPISODE_ID,
    title: TITLE,
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [] as string[],
    params: { episode_id: EPISODE_ID, title: TITLE, ...params },
  }
}

beforeEach(async () => {
  await fs.rm(sidecarFile, { force: true })
  const { chapterFilename } = await import('../lib/narration-assembly.js')
  await fs.rm(path.join(scriptDir, chapterFilename(EPISODE_ID, 1)), { force: true })
})

describe('expand-chapters stops on a chosen model that is gone, even when another model is live', () => {
  let service: MockGenStudioService

  before(async () => { service = await startMockGenStudioService() })
  after(async () => { await service.close() })
  beforeEach(() => { service.reset() })

  test('no other model is used, nothing is submitted, and the outline keeps the owner\'s choice', async () => {
    await pointGenStudioAt(service.baseUrl, MOCK_GENSTUDIO_FULL_KEY)
    await seedSidecar()
    service.queueScenario('chat', { outputText: '## Chapter 01: Topic 1\n\nShould never be written.\n' })

    const { generateExpandChapters } = await import('../generators/episode.js')
    const job = fakeExpandJob({ model: DEAD_MODEL })
    await assert.rejects(generateExpandChapters(job))

    const log = job.output_lines.join('\n')
    assert.match(log, /isn't available right now.*Pick another writing model/s, `plain stop expected: ${log}`)
    assert.doesNotMatch(log, /mock-chat-v1|Falling back/, 'the live catalogue model must never be used instead')
    assert.equal(service.providerSubmissionCount('chat'), 0)
    const sidecar = JSON.parse(await fs.readFile(sidecarFile, 'utf-8'))
    assert.notEqual(sidecar.generation_params.model, 'mock-chat-v1')
  })
})

describe('expand-chapters still refuses when nothing is left to fall back to', () => {
  /** Minimal reachable GenStudio stand-in whose chat catalogue is
   *  genuinely empty — resolveDefaultChatModel must fail loudly here, not
   *  invent a product id. */
  class EmptyCatalogServer {
    private server = http.createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('[]')
    })
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
  }

  test('the original refusal survives when the live catalogue has no usable product', async () => {
    const empty = await new EmptyCatalogServer().start()
    try {
      await pointGenStudioAt(empty.baseUrl, 'gsk_test_empty_catalog_not_real')
      await seedSidecar()

      const { generateExpandChapters } = await import('../generators/episode.js')
      const job = fakeExpandJob({ model: DEAD_MODEL })
      // The run overall still fails — a listicle batch failure is logged and
      // the batch continues (independent chapters), so the outer rejection is
      // the "not everything landed" completion check, not the raw refusal.
      // What matters here is that the raw refusal is the reason underneath,
      // recorded verbatim in the job log — never quietly resolved to a
      // fabricated product id, and never overwritten by a false healing claim.
      await assert.rejects(generateExpandChapters(job), /did not pass its completion check/)
      const log = job.output_lines.join('\n')
      assert.match(
        log,
        /isn't available right now.*Pick another writing model.*Nothing was sent or charged/s,
        `the original Gateway refusal must reach the job log unchanged: ${log}`,
      )
      assert.doesNotMatch(log, /Falling back to the currently available/,
        'there is nothing usable to heal to — no fallback claim may appear')
    } finally {
      await empty.close()
    }
  })
})
