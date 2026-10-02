/**
 * Chapter expansion heals a dead saved model instead of hard-failing, in the
 * ONE case `expansion-selected-model.test.ts` does not cover: the request
 * and the outline snapshot name the SAME retired id.
 *
 * THE GAP THIS GUARDS
 * --------------------
 * `setupChunkedJobContext` (generators/episode.ts) only announces a model
 * substitution when the request's model and the outline snapshot's model
 * DIFFER. A headless caller that re-supplies the outline's own (now dead)
 * model — Pipeline's "repair chapters" step re-reading a stale preset, or a
 * resumed expansion that never named a different model — makes both sides
 * of that comparison equal, so the divergence check stays silent and the
 * dead id used to reach GenStudio's product-resolution guard unexamined,
 * hard-failing the whole batch with:
 *
 *   The selected GenStudio language product "..." is not available. Choose
 *   a published product before retrying.
 *
 * even though a perfectly usable product was published and reachable.
 *
 * The fix lives at the one place a submission is actually about to happen
 * (`withModelFallback` in lib/chunked-narration.ts): GenStudio's own refusal
 * is caught, the live default is resolved, the swap is logged, and the same
 * batch is retried once. When there is truly nothing to fall back to (empty
 * catalogue), the original refusal must still surface unchanged.
 *
 * Zero paid calls: every request in here goes to an in-process mock HTTP
 * server, never a real provider.
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

describe('expand-chapters heals a dead model the request and the outline snapshot both name', () => {
  let service: MockGenStudioService

  before(async () => { service = await startMockGenStudioService() })
  after(async () => { await service.close() })
  beforeEach(() => { service.reset() })

  test('falls back to the live default, says so, writes the chapter, and self-repairs the sidecar', async () => {
    await pointGenStudioAt(service.baseUrl, MOCK_GENSTUDIO_FULL_KEY)
    await seedSidecar()
    service.queueScenario('chat', {
      outputText: '## Chapter 01: Topic 1\n\nThe quick brown fox jumps over the lazy dog. Lorem ipsum dolor.\n',
    })

    const { generateExpandChapters } = await import('../generators/episode.js')
    // Request and snapshot name the SAME dead id — the divergence check in
    // setupChunkedJobContext has nothing to compare, unlike
    // expansion-selected-model.test.ts's scenario.
    const job = fakeExpandJob({ model: DEAD_MODEL })
    await generateExpandChapters(job)

    const log = job.output_lines.join('\n')
    assert.ok(log.includes(DEAD_MODEL) || log.includes('genstudio-chat-b7abf15650287980589c-v1'),
      `log must name the dead model: ${log}`)
    assert.ok(log.includes('mock-chat-v1'), `log must name the live fallback: ${log}`)
    assert.doesNotMatch(log, /isn't available right now.*Pick another writing model/,
      'the dead-model refusal must not be the final outcome')

    // The chapter actually got written, using the healed model's output.
    const { chapterFilePath } = await import('../lib/narration-assembly.js')
    const chapterText = await fs.readFile(chapterFilePath(scriptDir, EPISODE_ID, 1), 'utf-8')
    assert.match(chapterText, /quick brown fox/)

    // Self-repair: the sidecar now names the live model, not the dead one —
    // a later run reads this back and never needs to heal again.
    const sidecar = JSON.parse(await fs.readFile(sidecarFile, 'utf-8'))
    assert.equal(sidecar.generation_params.model, 'mock-chat-v1')
  })

  test('a single provider submission serves the retry — the refused attempt was never billed', async () => {
    await pointGenStudioAt(service.baseUrl, MOCK_GENSTUDIO_FULL_KEY)
    await seedSidecar()
    service.queueScenario('chat', {
      outputText: '## Chapter 01: Topic 1\n\nBody text for the healed run.\n',
    })

    const { generateExpandChapters } = await import('../generators/episode.js')
    const job = fakeExpandJob({ model: DEAD_MODEL })
    await generateExpandChapters(job)

    // The refused attempt against the dead id never reached the network at
    // all (prepareChatSubmission's guard fires before any submission) — only
    // the healed retry actually submits.
    assert.equal(service.providerSubmissionCount('chat'), 1)
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
        `the original GenStudio refusal must reach the job log unchanged: ${log}`,
      )
      assert.doesNotMatch(log, /Falling back to the currently available/,
        'there is nothing usable to heal to — no fallback claim may appear')
    } finally {
      await empty.close()
    }
  })
})
