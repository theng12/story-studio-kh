import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { writeMetadataPackage } from '../services/metadata-completion.js'

const CODE = 'EP0001'
const TITLE = 'The Lighthouse Ledger'

function packageDocument(title: string) {
  return {
    title,
    title_options: [title],
    description: `${title} description.`,
    tags: [title.toLowerCase().replaceAll(' ', '-')],
  }
}

test('the episode package lock serializes allocation and retains both real JSON/TXT pairs', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const dir = path.join(temporary.dir, 'metadata-lock')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${CODE}_Metadata.json`), JSON.stringify(packageDocument('Version one')))
  await fs.writeFile(path.join(dir, `${CODE}_Metadata.txt`), 'Version one sidecar\n')

  const realMkdir = fs.mkdir
  const realReaddir = fs.readdir
  let allocationReads = 0
  t.mock.method(fs, 'mkdir', (target: any, ...args: any[]) => {
    if (path.resolve(String(target)) === path.resolve(dir)) return Promise.resolve(undefined)
    return (realMkdir as any)(target, ...args)
  })
  t.mock.method(fs, 'readdir', (target: any, ...args: any[]) => {
    if (path.resolve(String(target)) === path.resolve(dir)) allocationReads += 1
    return (realReaddir as any)(target, ...args)
  })

  let firstEntered!: () => void
  let releaseFirst!: () => void
  const entered = new Promise<void>(resolve => { firstEntered = resolve })
  const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve })
  let secondBuilt = false

  const first = writeMetadataPackage({
    dir,
    code: CODE,
    mode: 'new',
    build: async () => {
      firstEntered()
      await holdFirst
      return packageDocument('First writer')
    },
  })
  await entered
  assert.equal(allocationReads, 1)

  const second = writeMetadataPackage({
    dir,
    code: CODE,
    mode: 'new',
    build: () => {
      secondBuilt = true
      return packageDocument('Second writer')
    },
  })
  // mkdir is controlled to an already-resolved promise, so two microtask
  // checkpoints are enough for an unlocked second writer to reach readdir.
  try {
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(allocationReads, 1, 'the second allocator must stay outside the episode lock')
    assert.equal(secondBuilt, false)
  } finally {
    releaseFirst()
    await Promise.allSettled([first, second])
  }
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map(result => result.version), [2, 3])

  const jsonTitles = await Promise.all(results.map(async result => (
    JSON.parse(await fs.readFile(path.join(dir, result.json), 'utf8')).title
  )))
  const text = await Promise.all(results.map(result => fs.readFile(path.join(dir, result.txt), 'utf8')))
  assert.deepEqual(jsonTitles, ['First writer', 'Second writer'])
  assert.match(text[0]!, /First writer/)
  assert.match(text[1]!, /Second writer/)
})

test('an orphan TXT reserves its version and allocation listing errors fail closed', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const dir = path.join(temporary.dir, 'metadata-fail-closed')
  await fs.mkdir(dir, { recursive: true })
  const v1 = JSON.stringify(packageDocument('Protected version one'))
  await fs.writeFile(path.join(dir, `${CODE}_Metadata.json`), v1)
  await fs.writeFile(path.join(dir, `${CODE}_Metadata_v4.txt`), 'Retained orphan sidecar\n')

  const reserved = await writeMetadataPackage({
    dir,
    code: CODE,
    mode: 'new',
    build: () => packageDocument('After orphan'),
  })
  assert.equal(reserved.version, 5)
  assert.equal(await fs.readFile(path.join(dir, `${CODE}_Metadata_v4.txt`), 'utf8'), 'Retained orphan sidecar\n')

  const realReaddir = fs.readdir
  const denied = Object.assign(new Error('metadata listing denied'), { code: 'EACCES' })
  t.mock.method(fs, 'readdir', (target: any, ...args: any[]) => {
    if (path.resolve(String(target)) === path.resolve(dir)) return Promise.reject(denied)
    return (realReaddir as any)(target, ...args)
  })
  await assert.rejects(writeMetadataPackage({
    dir,
    code: CODE,
    mode: 'new',
    build: () => packageDocument('Must not be written'),
  }), error => error === denied)
  assert.equal(await fs.readFile(path.join(dir, `${CODE}_Metadata.json`), 'utf8'), v1)
  await assert.rejects(fs.access(path.join(dir, `${CODE}_Metadata_v6.json`)), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(dir, `${CODE}_Metadata_v6.txt`)), { code: 'ENOENT' })
})

test('queued generation and real HTTP saves share allocation and preserve explicit-edit evidence', async t => {
  const temporary = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => {
    await mock.close()
    await temporary.cleanup()
  })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const projects = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')

  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  const project = await projects.createProject({
    name: 'Metadata allocation integration',
    episode_prefix: 'EP',
    episode_digits: 4,
  })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: TITLE,
    logline: '',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: '',
  }], 'metadata-allocation-integration')
  await ideas.acceptIdea(project.slug, idea!.id, false, { override_code: CODE })
  await projects.updateConfig(project.slug, { safety_checks: { chapter_marks: 'warn' } } as any)

  const paths = await resolveEpisodePaths(project.slug, CODE, TITLE)
  const narration = paths.narration_docx.replace(/\.docx$/i, '.md')
  const metadataDir = path.dirname(paths.metadata_json)
  await fs.mkdir(path.dirname(narration), { recursive: true })
  await fs.writeFile(narration, 'A keeper compares two ledgers while the tide turns.')
  await fs.mkdir(metadataDir, { recursive: true })
  await fs.writeFile(path.join(metadataDir, `${CODE}_Metadata.json`), JSON.stringify({
    ...packageDocument('Existing version one'),
    version: 1,
  }))
  await fs.writeFile(path.join(metadataDir, `${CODE}_Metadata.txt`), 'Existing version one\n')

  const app = express()
  app.use(express.json())
  app.use('/api', (await import('../routes/scripts.js')).router)
  const { generateMetadata } = await import('../generators/metadata.js')
  const generatedJob: any = {
    job_id: 'metadata-allocation-generator',
    project_slug: project.slug,
    type: 'metadata',
    episode_id: CODE,
    title: 'YouTube Finalizer',
    params: {
      episode_id: CODE,
      title: TITLE,
      model: 'mock-chat-v1',
      existing_package: packageDocument('Generated package marker'),
    },
    output_lines: [],
  }

  const generated = generateMetadata(generatedJob)
  const manuallySaved = request(app)
    .post(`/api/projects/${project.slug}/generate/metadata/save`)
    .send({
      episode_id: CODE,
      title: TITLE,
      metadata_title: 'Interactive save marker',
      title_options: ['Interactive save marker'],
      description: 'Interactive description marker.',
      tags: ['interactive-marker'],
      save_mode: 'new',
    })

  const [, response] = await Promise.all([generated, manuallySaved])
  assert.equal(response.status, 200, JSON.stringify(response.body))

  const packages = await Promise.all([2, 3].map(async version => ({
    version,
    value: JSON.parse(await fs.readFile(path.join(metadataDir, `${CODE}_Metadata_v${version}.json`), 'utf8')),
    text: await fs.readFile(path.join(metadataDir, `${CODE}_Metadata_v${version}.txt`), 'utf8'),
  })))
  assert.deepEqual(
    new Set(packages.map(saved => saved.value.title)),
    new Set(['Generated package marker', 'Interactive save marker']),
  )
  for (const saved of packages) assert.match(saved.text, new RegExp(saved.value.title))

  const generatedPackage = packages.find(saved => saved.value.title === 'Generated package marker')!
  const manifestPath = path.join(metadataDir, `${CODE}_Metadata.completion.json`)
  const manifestBeforeEdit = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.equal(manifestBeforeEdit.output_filename, `${CODE}_Metadata_v${generatedPackage.version}.json`)
  const finalizationBeforeEdit = generatedPackage.value.youtube_finalization

  const edited = await request(app)
    .post(`/api/projects/${project.slug}/generate/metadata/save`)
    .send({
      episode_id: CODE,
      title: TITLE,
      metadata_title: 'Edited generated marker',
      title_options: ['Edited generated marker'],
      description: 'Edited generated description.',
      tags: ['edited-generated'],
      save_mode: 'overwrite',
      version: generatedPackage.version,
    })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  assert.equal(edited.body.version, generatedPackage.version)
  assert.equal(edited.body.json, `${CODE}_Metadata_v${generatedPackage.version}.json`)

  const editedDocument = JSON.parse(await fs.readFile(
    path.join(metadataDir, edited.body.json), 'utf8',
  ))
  assert.deepEqual(editedDocument.youtube_finalization, finalizationBeforeEdit)
  assert.match(await fs.readFile(path.join(metadataDir, edited.body.txt), 'utf8'), /Edited generated marker/)
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')), manifestBeforeEdit)
})
