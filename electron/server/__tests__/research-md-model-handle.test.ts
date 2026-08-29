/**
 * `research.md` names the model, never the product handle.
 *
 * ── The defect ──
 *
 * `renderResearchMarkdown` wrote `r.source_model` straight into the header line
 * of every research document:
 *
 *     *Model knowledge · research ran on 2026-08-29 · gemini-3.1-flash-lite-discount*
 *
 * `source_model` is an internal GenStudio product handle. research.md exists so
 * a person can open the folder in Finder and read what was researched — its
 * whole justification is that no app is required to read it — and a reader who
 * gets an internal identifier there has been shown plumbing and told nothing.
 * Unlike the picker leaks this one fired on EVERY successful run, not only on a
 * failure, and it wrote the handle to a file that then sits on disk.
 *
 * ── What is pinned here ──
 *
 *   1. A run against a reachable catalogue writes the product's PUBLISHED name,
 *      and the handle appears nowhere in the file. Exercised end to end: the
 *      real generator, the real adapter, and an in-process GenStudio.
 *   2. A handle the live catalogue does not list resolves to nothing.
 *   3. An unreachable or unreadable catalogue also resolves to nothing.
 *   4. Nothing resolved means the model segment is OMITTED. "Better than
 *      nothing" is exactly the reasoning that put an identifier in front of a
 *      customer, so the renderer must never fall back to the handle.
 *
 * Zero paid calls: the only GenStudio here is an in-process mock.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import type { Job, ResearchOutput } from '../models/types.js'

/** The exact shape of identifier that was reaching customers' research.md. */
const DEAD_HANDLE = 'genstudio-chat:genstudio-chat-b7abf15650287980589c-v1'
/** The mock catalogue's one chat product, and the name it publishes. */
const LIVE_HANDLE = 'mock-chat-v1'
const LIVE_NAME = 'Mock Chat'

const EPISODE_ID = 'EP001'
const TITLE = 'Handle Leak Test'
const TOPIC = 'The salt roads of the Sahara'

let cleanup: () => Promise<void>
let app: any
let slug: string
let service: MockGenStudioService

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const mod = await import('../app.js')
  app = mod.app

  const proj = await request(app).post('/api/projects').send({
    name: TITLE, episode_prefix: 'EP', episode_digits: 3,
  })
  assert.equal(proj.status, 201)
  slug = proj.body.slug

  service = await startMockGenStudioService()
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal(
    (await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status,
    200,
  )
})

after(async () => {
  await service.close()
  await cleanup()
})

function fakeResearchJob(model: string): Job {
  return {
    job_id: `test-research-${Math.random().toString(36).slice(2)}`,
    project_slug: slug,
    type: 'research_run',
    episode_id: EPISODE_ID,
    title: TITLE,
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [] as string[],
    params: {
      episode_id: EPISODE_ID,
      title: TITLE,
      source_provider: 'genstudio',
      research_mode: 'model-knowledge',
      topic: TOPIC,
      model,
    },
  } as unknown as Job
}

/** A hand-written research envelope, the shape the adapter parses. */
const ENVELOPE = JSON.stringify({
  summary: 'Trans-Saharan trade moved salt south and gold north for centuries.',
  claims: [
    { text: 'Caravans carried salt south and gold north.', confidence: 'high', citation_indices: [] },
  ],
  citations: [],
})

describe('research.md never carries an internal product handle', () => {
  test('a real run against a reachable catalogue writes the PUBLISHED name', async () => {
    service.reset()
    service.queueScenario('chat', { outputText: ENVELOPE })

    const { runResearchJob } = await import('../generators/research.js')
    await runResearchJob(fakeResearchJob(LIVE_HANDLE))

    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { resolveResearchPaths } = await import('../lib/research-paths.js')
    const paths = await resolveEpisodePathsByCode(slug, EPISODE_ID)
    const { mdPath, jsonPath } = await resolveResearchPaths(paths.episode_dir, EPISODE_ID)
    const markdown = await fs.readFile(mdPath, 'utf-8')

    assert.match(markdown, new RegExp(LIVE_NAME), `the published name must appear: ${markdown.slice(0, 300)}`)
    assert.ok(
      !markdown.includes(LIVE_HANDLE),
      `the product handle must not appear anywhere in the document: ${markdown.slice(0, 300)}`,
    )
    assert.match(markdown, /Caravans carried salt south and gold north\./)

    // The JSON sidecar is a machine record and KEEPS the handle — that is what
    // identifies the run for support and for a later re-resolve. The rule is
    // about the document a person reads, not about throwing away provenance.
    const sidecar = JSON.parse(await fs.readFile(jsonPath, 'utf-8'))
    assert.equal(sidecar.source_model, LIVE_HANDLE)
  })

  test('a handle the live catalogue does not list resolves to nothing', async () => {
    const { researchModelLabel } = await import('../generators/research.js')
    const label = await researchModelLabel({ source_model: DEAD_HANDLE } as ResearchOutput)
    assert.equal(label, '', 'an unlisted handle has no published name, and must not become one')
  })

  test('an unreachable catalogue resolves to nothing rather than to the handle', async () => {
    const saved = service.baseUrl
    try {
      // Point at a port nothing is listening on. The catalogue read fails
      // outright; the answer is still not the handle.
      assert.equal(
        (await request(app).put('/api/app-settings/genstudio').send({ url: 'http://127.0.0.1:1' })).status,
        200,
      )
      const { researchModelLabel } = await import('../generators/research.js')
      const label = await researchModelLabel({ source_model: LIVE_HANDLE } as ResearchOutput)
      assert.equal(label, '', 'a catalogue we cannot read is not a licence to print the handle')
    } finally {
      assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: saved })).status, 200)
    }
  })

  test('with nothing resolved the model segment is omitted, not filled with the id', async () => {
    const { renderResearchMarkdown } = await import('../generators/research.js')
    const output = {
      schema_version: 1,
      source_provider: 'llm-only',
      source_model: DEAD_HANDLE,
      research_mode: 'model-knowledge',
      generated_at: '2026-08-29T00:00:00.000Z',
      topic: TOPIC,
      claims: [],
      citations: [],
    } as unknown as ResearchOutput

    const omitted = renderResearchMarkdown(output, '')
    assert.ok(!omitted.includes(DEAD_HANDLE), `the handle was written anyway: ${omitted.slice(0, 300)}`)
    assert.ok(!omitted.includes('b7abf15650287980589c'), 'no fragment of the handle may survive')
    // The document is otherwise intact — only the optional segment goes away.
    assert.match(omitted, new RegExp(`# Research — ${TOPIC}`))
    assert.match(omitted, /research ran on/)

    // And when a name IS available it is what appears, in that same slot.
    const named = renderResearchMarkdown(output, LIVE_NAME)
    assert.match(named, new RegExp(`research ran on [^\\n]*· ${LIVE_NAME}`))
    assert.ok(!named.includes(DEAD_HANDLE))
  })
})
