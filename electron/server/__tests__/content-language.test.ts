/**
 * Content language: persistence and the shared audience directive.
 *
 * The contract under test:
 *   - `en` and `km` are the whole catalogue.
 *   - an unset value returns an EMPTY directive, so legacy prompts stay
 *     byte-identical (the prompt tests pin the bytes).
 *   - the project setting round-trips through create/update, including the
 *     explicit `null` clear sentinel.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let cl: typeof import('../lib/content-language.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  cl = await import('../lib/content-language.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

async function projectMeta(slug: string): Promise<any> {
  const dir = pm.getProjectDir(slug)
  assert.ok(dir, 'project folder exists')
  return JSON.parse(await fs.readFile(path.join(dir!, 'project.json'), 'utf-8'))
}

describe('the directive', () => {
  test('English is explicit and outranks the language of examples', () => {
    const directive = cl.languageDirective('en')
    assert.match(directive, /Write ALL audience-facing text in English\./)
    assert.match(directive, /takes precedence over the language of recipe examples/)
    assert.match(directive, /structure, voice, and section order only/)
  })

  test('Khmer names the script and keeps technical identifiers as-is', () => {
    const directive = cl.languageDirective('km')
    assert.match(directive, /Khmer \(Khmer script\)/)
    assert.match(directive, /Technical identifiers stay as-is\./)
  })

  test('unset and unknown values produce no directive at all', () => {
    for (const value of [undefined, null, '', 'fr', 42, {}, []]) {
      assert.equal(cl.languageDirective(value), '', `value ${JSON.stringify(value)} must stay legacy`)
      assert.equal(cl.normalizeContentLanguage(value), null)
    }
  })
})

describe('persistence', () => {
  test('create persists km and the project read returns it', async () => {
    const project = await pm.createProject({ name: 'Khmer Channel', content_language: 'km' })
    assert.equal(await cl.getContentLanguage(project.slug), 'km')
    assert.equal((await projectMeta(project.slug)).content_language, 'km')
  })

  test('a create without a language stays byte-for-byte absent', async () => {
    const project = await pm.createProject({ name: 'Legacy Channel' })
    const meta = await projectMeta(project.slug)
    assert.equal('content_language' in meta, false, 'absent must not become a guessed default')
    assert.equal(await cl.getContentLanguage(project.slug), null)
  })

  test('update round-trips en and clears with the null sentinel', async () => {
    const project = await pm.createProject({ name: 'Switch Channel', content_language: 'km' })
    await pm.updateProject(project.slug, { content_language: 'en' })
    assert.equal(await cl.getContentLanguage(project.slug), 'en')
    await pm.updateProject(project.slug, { content_language: null })
    assert.equal(await cl.getContentLanguage(project.slug), null)
  })

  test('the wire schemas accept only en/km and the explicit clear', async () => {
    const { CreateProjectSchema, UpdateProjectSchema } = await import('../contracts/index.js')
    assert.equal(CreateProjectSchema.parse({ name: 'x', content_language: 'km' }).content_language, 'km')
    assert.equal(CreateProjectSchema.parse({ name: 'x' }).content_language, undefined)
    assert.throws(() => CreateProjectSchema.parse({ name: 'x', content_language: 'fr' }))
    assert.equal(UpdateProjectSchema.parse({ content_language: null }).content_language, null)
    assert.throws(() => UpdateProjectSchema.parse({ content_language: 'fr' }))
  })
})
