/**
 * A route must be registered when the module loads, never when a request runs.
 *
 * `routes/image-prompts-edit.ts` registered its PUT `/image-prompts/item`
 * route from INSIDE the body of its own POST `/regenerate` handler — the
 * `router.put(...)` statement sat at the end of the POST's `try` block, after
 * `res.json(...)`. Observed on the pristine code, not inferred:
 *
 *   - at module load the router carried ONE layer (the POST);
 *   - a PUT before any regenerate returned 404 with an EMPTY body — an
 *     unmatched-route 404, distinct from this route's own 404s which always
 *     carry a `detail`;
 *   - after one successful regenerate the PUT existed; after two, it was
 *     registered TWICE, stacking one duplicate layer per regenerate.
 *
 * The user-visible shape is "sometimes my prompt edit doesn't save", which
 * nobody can reproduce, because whether it works depends on whether a
 * regenerate happened first in that same server process.
 *
 * The PUT handler captured no state from the enclosing POST handler — it
 * re-declares `slug`, `episodeId`, `kind`, `number`, `title`, `prompt` and
 * `titleParam` from its own `req`, and everything else it touches is a
 * module-level import — so the fix was a move, not a refactor.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EPISODE_ID = 'EP001'
const TITLE = 'Route Registration Test'

let app: any
let slug: string
let service: MockGenStudioService
let routerModule: any
let cleanup: () => Promise<void>

/** The registration layers Express is actually serving, as "METHOD path". */
function layers(): string[] {
  return (routerModule.router.stack || [])
    .filter((l: any) => l.route)
    .map((l: any) => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`)
}

const ITEM_LAYER = 'PUT /projects/:slug/episodes/:episodeId/image-prompts/item'

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  routerModule = await import('../routes/image-prompts-edit.js')
  service = await startMockGenStudioService()

  const project = await request(app).post('/api/projects')
    .send({ name: TITLE, episode_prefix: 'EP', episode_digits: 3 })
  assert.equal(project.status, 201)
  slug = project.body.slug

  await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })
  await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })

  // A prompts file on disk, so the routes find their target and the test is
  // about registration rather than about missing artifacts.
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { toMdPath } = await import('../lib/episode-artifacts.js')
  const paths = await resolveEpisodePaths(slug, EPISODE_ID, TITLE)
  const md = toMdPath(paths.thumb_prompts_docx)
  await fs.mkdir(path.dirname(md), { recursive: true })
  await fs.writeFile(md,
    '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA painterly wide shot of a harbour at dawn, cinematic.\n\n'
    + '## Thumbnail 2: Second\n\nA quiet street scene with long shadows, cinematic.\n\n')
})

after(async () => {
  await service?.close?.()
  await cleanup?.()
})

const itemUrl = () => `/api/projects/${slug}/episodes/${EPISODE_ID}/image-prompts/item?title=${encodeURIComponent(TITLE)}`
const editBody = (title: string) => ({
  kind: 'thumbnail', number: 1, title,
  prompt: 'An edited painterly harbour scene at dawn with cinematic lighting.',
})

async function regenerate(n: number) {
  service.queueScenario('chat', {
    states: ['succeeded'],
    outputText: JSON.stringify({
      title: `Regen ${n}`,
      prompt: `A regenerated painterly harbour at dawn number ${n}, cinematic lighting and long shadows.`,
    }),
  })
  return request(app)
    .post(`/api/projects/${slug}/episodes/${EPISODE_ID}/image-prompts/regenerate`)
    .send({ kind: 'thumbnail', number: 1, title: TITLE })
}

describe('image-prompts-edit registers both routes at module load', () => {
  test('the PUT item route exists before any request has been served', () => {
    assert.ok(
      layers().includes(ITEM_LAYER),
      'saving a prompt edit must not depend on a regenerate having run first',
    )
  })

  test('saving an edit works with no prior regenerate', async () => {
    const res = await request(app).put(itemUrl()).send(editBody('Edited with no regenerate'))
    assert.equal(res.status, 200)
    assert.equal(res.body.title, 'Edited with no regenerate')
    // The old failure was an unmatched-route 404, which carries no `detail`.
    // This route's own 404s always do, so the distinction is the regression.
    assert.notEqual(res.status, 404)
  })

  test('regenerating never stacks another registration', async () => {
    const before = layers().filter(l => l === ITEM_LAYER).length
    assert.equal(before, 1, 'exactly one PUT layer to begin with')

    assert.equal((await regenerate(1)).status, 200)
    assert.equal((await regenerate(2)).status, 200)

    assert.equal(
      layers().filter(l => l === ITEM_LAYER).length,
      1,
      'two regenerates previously left three layers — one duplicate PUT each',
    )
  })

  test('the edit still saves after regenerates, and is handled once', async () => {
    const res = await request(app).put(itemUrl()).send(editBody('Edited after regenerates'))
    assert.equal(res.status, 200)
    assert.equal(res.body.title, 'Edited after regenerates')
  })
})

/**
 * The class guard.
 *
 * Deliberately an AST check, not a grep for indentation: the bug this pins
 * had `router.put(` sitting at COLUMN ZERO while nested inside a handler, so
 * every text heuristic reads it as top-level. The only reliable question is
 * whether a registration has an ancestor function that is itself an argument
 * to another registration — i.e. whether it runs per-request.
 */
describe('no route is registered from inside a request handler', () => {
  const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'options', 'head'])

  function isRegistration(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) return false
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee)) return false
    const target = callee.expression
    return ts.isIdentifier(target)
      && /^(router|app)$/.test(target.text)
      && METHODS.has(callee.name.text)
  }

  function offenders(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const found: string[] = []

    const visit = (node: ts.Node, insideHandler: boolean): void => {
      if (isRegistration(node) && insideHandler) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart())
        found.push(`${path.relative(SERVER_ROOT, file)}:${line + 1}`)
      }
      // A function passed AS AN ARGUMENT to a registration is a request
      // handler; anything registered within it runs per-request. A function
      // declaration that merely CONTAINS registrations (mountRoutes) is the
      // legitimate startup case and must not trip this.
      if (isRegistration(node)) {
        for (const arg of (node as ts.CallExpression).arguments) {
          const isFn = ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
          ts.forEachChild(arg, child => visit(child, insideHandler || isFn))
        }
        ts.forEachChild((node as ts.CallExpression).expression, child => visit(child, insideHandler))
        return
      }
      ts.forEachChild(node, child => visit(child, insideHandler))
    }

    visit(source, false)
    return found
  }

  test('every registration across routes/ and app.ts runs at import time', () => {
    const dir = path.join(SERVER_ROOT, 'routes')
    // `app.ts` mounts and registers directly too, so it is swept on the same
    // rule — the router files are not the only place this shape can appear.
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => path.join(dir, f))
      .concat(path.join(SERVER_ROOT, 'app.ts'))
    const hits = files.flatMap(offenders)

    assert.deepEqual(
      hits,
      [],
      'a route registered inside a handler exists only after that handler runs, '
      + 'and stacks a duplicate every time it runs again',
    )
  })
})
