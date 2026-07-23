/**
 * Smoke tests for API routes via supertest.
 * Hits real Express routes with isolated temp data, but does NOT make real
 * calls to OpenAI/Anthropic/kie/fal — those require real keys.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup

  // Ensure projects dir exists before app loads
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })

  // Prevent app.ts from binding a listening port during tests
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  // Import after env vars are set so module-level resolution picks them up
  const mod = await import('../app.js')
  app = mod.app
})

after(async () => { await cleanup() })

describe('Health & meta routes', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health')
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ok')
    assert.ok(res.body.version)
  })

  test('GET /api/ffmpeg/status returns shape', async () => {
    const res = await request(app).get('/api/ffmpeg/status')
    assert.equal(res.status, 200)
    assert.ok(typeof res.body.installed === 'boolean')
    assert.ok(['bundled', 'system', 'not-found'].includes(res.body.source))
  })

  test('direct sibling-Studio and Studio Hub control routes are retired', async () => {
    for (const path of [
      '/api/imagestudio/base-url',
      '/api/voicestudio/base-url',
      '/api/chatstudio/base-url',
      '/api/videostudio/base-url',
      '/api/studiohub/status',
    ]) {
      const res = await request(app).get(path)
      assert.equal(res.status, 410, path)
      assert.equal(res.body.code, 'GENSTUDIO_ONLY', path)
    }
  })
})

describe('Project routes', () => {
  let projectSlug: string

  test('POST /api/projects creates a project', async () => {
    const res = await request(app).post('/api/projects').send({
      name: 'Route Test Project',
      episode_prefix: 'RT',
      episode_digits: 3,
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.name, 'Route Test Project')
    assert.ok(res.body.slug)
    projectSlug = res.body.slug
  })

  test('GET /api/projects lists projects', async () => {
    const res = await request(app).get('/api/projects')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body))
    const slugs = res.body.map((p: any) => p.slug)
    assert.ok(slugs.includes(projectSlug))
  })

  test('GET /api/projects/:slug returns project meta', async () => {
    const res = await request(app).get(`/api/projects/${projectSlug}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.slug, projectSlug)
    assert.equal(res.body.episode_prefix, 'RT')
  })

  test('GET /api/projects/ghost returns 404', async () => {
    const res = await request(app).get('/api/projects/nonexistent-slug')
    assert.equal(res.status, 404)
  })

  test('PUT /api/projects/:slug updates metadata', async () => {
    const res = await request(app).put(`/api/projects/${projectSlug}`).send({
      name: 'Updated Name',
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.name, 'Updated Name')
  })

  test('GET /api/projects/templates lists available templates', async () => {
    const res = await request(app).get('/api/projects/templates')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body))
  })
})

describe('Project settings routes', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Settings Test' })
    slug = res.body.slug
  })

  test('GET /api/projects/:slug/settings/config returns safe config', async () => {
    const res = await request(app).get(`/api/projects/${slug}/settings/config`)
    assert.equal(res.status, 200)
    // Should not expose API keys
    const body = JSON.stringify(res.body)
    assert.ok(!body.includes('sk-'), 'should not leak API keys in safe config')
  })

  test('PUT /api/projects/:slug/settings/api-keys is retired by the GenStudio-only boundary', async () => {
    const res = await request(app).put(`/api/projects/${slug}/settings/api-keys`).send({
      openai_api_key: 'sk-test-not-real',
    })
    assert.equal(res.status, 410)
    assert.equal(res.body.code, 'GENSTUDIO_ONLY')
  })

  test('PUT /api/projects/:slug/settings/standards saves text', async () => {
    const res = await request(app).put(`/api/projects/${slug}/settings/standards`).send({
      content: 'Test production standards content',
    })
    assert.equal(res.status, 200)

    const get = await request(app).get(`/api/projects/${slug}/settings/standards`)
    assert.equal(get.status, 200)
    assert.equal(get.body.content, 'Test production standards content')
  })

  test('GET /api/projects/:slug/settings/subfolder-config returns structure', async () => {
    const res = await request(app).get(`/api/projects/${slug}/settings/subfolder-config`)
    assert.equal(res.status, 200)
    assert.ok(res.body.subfolder_names)
    assert.ok(Array.isArray(res.body.linkage))
  })
})

describe('Jobs routes', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Jobs Test' })
    slug = res.body.slug
  })

  test('GET /api/projects/:slug/jobs returns jobs list + stats', async () => {
    const res = await request(app).get(`/api/projects/${slug}/jobs`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.jobs))
    assert.ok(res.body.stats)
  })

  test('DELETE /api/projects/:slug/jobs/ghost returns 400', async () => {
    const res = await request(app).delete(`/api/projects/${slug}/jobs/ghost-job-id`)
    // Route returns 400 "Job not found or not cancellable" (vs 404)
    assert.equal(res.status, 400)
  })
})

describe('Ideas routes', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Ideas Test' })
    slug = res.body.slug
  })

  test('GET /api/projects/:slug/ideas returns ideas object initially', async () => {
    const res = await request(app).get(`/api/projects/${slug}/ideas`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.ideas), 'response wraps ideas in an object')
    assert.equal(res.body.ideas.length, 0)
    assert.ok(typeof res.body.next_episode_number === 'number')
  })

  test('GET /api/projects/:slug/episodes returns empty list initially', async () => {
    const res = await request(app).get(`/api/projects/${slug}/episodes`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body))
  })

  test('whole-episode Mark Done includes new Motion Review status fields', async () => {
    const project = await request(app).post('/api/projects').send({
      name: 'Motion Status Contract Project', episode_prefix: 'MS', episode_digits: 3,
    })
    const isolatedSlug = project.body.slug
    const created = await request(app).post(`/api/projects/${isolatedSlug}/ideas`).send({
      title: 'Motion Status Contract', suggested_chapters: 4,
    })
    assert.equal(created.status, 200)
    const accepted = await request(app)
      .post(`/api/projects/${isolatedSlug}/ideas/${created.body.id}/accept`).send({})
    assert.equal(accepted.status, 200)
    const code = accepted.body.episode_code
    const marked = await request(app)
      .patch(`/api/projects/${isolatedSlug}/episodes/${code}/mark-done`).send({ done: true })
    assert.equal(marked.status, 200)
    const episodes = await request(app).get(`/api/projects/${isolatedSlug}/episodes`)
    const episode = episodes.body.find((row: any) => row.episode_code === code)
    assert.ok(episode)
    assert.equal(episode.status.motion_review, true,
      'new EpisodeStatus fields must survive the /episodes public response')
  })

  // ── Paste-import tests ─────────────────────────────────────────────────
  // These pin the validation rules for the `/ideas/import-paste` route so
  // a future tightening of the shape (e.g. requiring suggested_length be
  // one of a fixed list) doesn't silently start rejecting rows the UI
  // accepted yesterday. Also confirms the dry_run contract — preview must
  // never write to ideas.json.

  test('GET /api/projects/:slug/ideas/paste-prompt returns the preset prompt as text', async () => {
    const res = await request(app).get(`/api/projects/${slug}/ideas/paste-prompt`)
    assert.equal(res.status, 200)
    assert.ok(res.headers['content-type']?.startsWith('text/plain'))
    assert.ok(res.text.includes('JSON array'), 'prompt mentions JSON array so the LLM knows the shape')
    assert.ok(res.text.includes('suggested_chapters'), 'prompt lists required keys')
  })

  test('POST /ideas/import-paste dry_run: splits valid vs rejected rows without writing', async () => {
    // One valid row + three that fail different validation rules so a single
    // POST exercises the decision tree: missing title, bad themes type,
    // missing mood. All four should come back in one response.
    const payload = {
      dry_run: true,
      json: JSON.stringify([
        { title: 'The Lantern Keeper', logline: 'A keeper tends one last flame.', themes: ['solitude', 'memory'], suggested_chapters: 10, suggested_length: '45 min', mood: 'quiet resolve' },
        { title: '', logline: 'Missing title', themes: ['x'], suggested_chapters: 8, suggested_length: '45 min', mood: 'tense' },
        { title: 'Bad themes', logline: 'themes is not an array', themes: 'solitude,memory', suggested_chapters: 8, suggested_length: '45 min', mood: 'calm' },
        { title: 'Missing mood', logline: 'mood field is blank', themes: ['a'], suggested_chapters: 8, suggested_length: '45 min', mood: '' },
      ]),
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 200)
    assert.equal(res.body.valid.length, 1)
    assert.equal(res.body.rejected.length, 3)
    assert.equal(res.body.imported, 0, 'dry_run must never write')

    // And confirm the underlying store is still empty — the dry_run contract
    // is the whole point of the preview pane, so belt + braces here.
    const after = await request(app).get(`/api/projects/${slug}/ideas`)
    assert.equal(after.body.ideas.length, 0)
  })

  test('POST /ideas/import-paste commits valid rows to ideas.json', async () => {
    const payload = {
      json: JSON.stringify([
        { title: 'Real Paste One', logline: 'A test idea from paste.', themes: ['test'], suggested_chapters: 8, suggested_length: '45 min', mood: 'calm' },
        { title: 'Real Paste Two', logline: 'Another test idea.', themes: ['test', 'paste'], suggested_chapters: 10, suggested_length: '60 min', mood: 'gentle' },
      ]),
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 200)
    assert.equal(res.body.imported, 2)
    assert.equal(res.body.valid.length, 2)
    assert.ok(res.body.valid[0].id, 'stored ideas get ids assigned server-side')
    assert.equal(res.body.valid[0].model_used, 'paste-import', 'model_used tag lets the UI distinguish paste from generator')
    assert.equal(res.body.valid[0].status, 'new', 'new status matches generator-created ideas — Accept flow is shared')

    // Follow-up fetch must reflect the write.
    const after = await request(app).get(`/api/projects/${slug}/ideas`)
    assert.equal(after.body.ideas.length, 2)
  })

  test('POST /ideas/import-paste rejects empty paste with 400', async () => {
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send({ json: '   ' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Empty paste/i)
  })

  test('POST /ideas/import-paste rejects malformed JSON with 400', async () => {
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send({ json: 'not json at all' })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Could not parse|No JSON array/)
  })

  test('POST /ideas/import-paste rejects all-rejected input with 400 (no ideas written)', async () => {
    // All rows fail — server must return 400 so the frontend shows an
    // error instead of success. Also: ideas.json must NOT have been
    // touched, even partially, when every row is bad.
    const before = (await request(app).get(`/api/projects/${slug}/ideas`)).body.ideas.length
    const payload = {
      json: JSON.stringify([
        { title: '', logline: 'no title', themes: ['x'], suggested_chapters: 8, suggested_length: '45 min', mood: 'calm' },
      ]),
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 400)
    assert.ok(res.body.rejected?.length === 1, 'rejected array surfaced so the UI can show reasons')
    const after = (await request(app).get(`/api/projects/${slug}/ideas`)).body.ideas.length
    assert.equal(after, before, 'no ideas should have been written on all-rejected input')
  })

  test('POST /ideas/import-paste tolerates ```json fences around the array', async () => {
    // LLMs often wrap output in markdown fences. parseIdeas strips them;
    // this asserts the tolerance flows all the way through to a successful
    // import (not just a successful parse).
    const payload = {
      json: '```json\n[\n  { "title": "Fenced Idea", "logline": "Wrapped in a code fence.", "themes": ["fence"], "suggested_chapters": 8, "suggested_length": "45 min", "mood": "dry" }\n]\n```',
    }
    const res = await request(app).post(`/api/projects/${slug}/ideas/import-paste`).send(payload)
    assert.equal(res.status, 200)
    assert.equal(res.body.imported, 1)
  })
})

describe('Error handling', () => {
  test('Jobs endpoint returns empty list (not 404) for non-existent project', async () => {
    // Design choice: /jobs returns empty list rather than 404
    // since it's a read-only endpoint safe to call optimistically.
    const res = await request(app).get('/api/projects/ghost-slug/jobs')
    assert.equal(res.status, 200)
    assert.equal(res.body.jobs.length, 0)
  })

  test('Image generation without kie key fails gracefully', async () => {
    // Create project, queue image job with no key configured
    const proj = await request(app).post('/api/projects').send({ name: 'NoKey Test' })
    const slug = proj.body.slug
    const res = await request(app).post(`/api/projects/${slug}/generate/images`).send({
      episode_id: 'FAKE001',
      model: 'grok-imagine',
      mode: 'thumbs',
    })
    // Route will accept the job (validation happens at generation time);
    // API key check now moved to provider layer. Either 201 (queued, will fail later)
    // or 400 (early validation). Both are acceptable — we just want no crash.
    assert.ok([201, 400, 409].includes(res.status), `unexpected status ${res.status}`)
  })
})

// ── Retired project-scoped provider/account endpoints ──────────────────────

describe('Account endpoints', () => {
  let slug: string

  before(async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Accounts Route Test' })
    slug = res.body.slug
  })

  const assertGenStudioOnly = (res: request.Response) => {
    assert.equal(res.status, 410)
    assert.equal(res.body.code, 'GENSTUDIO_ONLY')
    assert.match(res.body.detail, /GenStudio/i)
  }

  test('GET /settings/accounts is retired', async () => {
    assertGenStudioOnly(await request(app).get(`/api/projects/${slug}/settings/accounts`))
  })

  test('POST /settings/accounts/:providerId is retired before CRUD validation', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/settings/accounts/openai`)
      .send({ label: 'A', apiKey: 'sk-aaaabbbb1111' })
    assertGenStudioOnly(res)
    assert.ok(!JSON.stringify(res.body).includes('aaaabbbb'), 'retired route must not echo the submitted key')
  })

  test('retired account routes do not revive payload validation or CRUD behavior', async () => {
    assertGenStudioOnly(await request(app)
      .post(`/api/projects/${slug}/settings/accounts/openai`)
      .send({ label: '', apiKey: '' }))
  })

  test('unknown legacy account providers receive the same closed boundary', async () => {
    assertGenStudioOnly(await request(app)
      .post(`/api/projects/${slug}/settings/accounts/not-a-provider`)
      .send({ label: 'X', apiKey: 'y' }))
  })

  test('PATCH /settings/accounts/:providerId/:accountId is retired', async () => {
    assertGenStudioOnly(await request(app)
      .patch(`/api/projects/${slug}/settings/accounts/anthropic/default`)
      .send({ label: 'After' }))
  })

  test('DELETE /settings/accounts/:providerId/:accountId is retired', async () => {
    assertGenStudioOnly(await request(app)
      .delete(`/api/projects/${slug}/settings/accounts/anthropic/default`))
  })

  test('GET /settings/config remains credential-safe and does not restore retired accounts', async () => {
    const res = await request(app).get(`/api/projects/${slug}/settings/config`)
    assert.equal(res.status, 200)
    assert.ok(res.body.accounts, 'accounts field present')
    assert.equal('openai' in res.body.accounts, false)
    assert.doesNotMatch(JSON.stringify(res.body), /sk-[a-z0-9-]+/i, 'no raw keys in safe config')
  })
})
