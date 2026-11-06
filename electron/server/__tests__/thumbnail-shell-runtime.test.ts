import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { channelReferenceShellId, resolveThumbnailShell, stageThumbnailShellImage } from '../services/thumbnail-shell.js'
import { assembleThumbnailRenderPrompt, savedThumbnailReferenceGuidanceFor, thumbnailRenderAssemblyOverhead } from '../generators/images.js'
import { assertPromptWithinCap } from '../services/prompt-char-cap.js'

let cleanup: () => Promise<void>
let slug: string
let projectDir: string
const templateId = 'runtime-text-shell'
const layoutNote = 'Subject on the right third; leave the left third clear for the episode’s chosen words.'
const reference = { id: 'old-reference', filename: 'old-reference.png', reframing_prompt: 'A centered subject with empty space above.' }

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Shell runtime fixtures' })
  slug = project.slug
  projectDir = pm.getProjectDir(slug)!
  const templates = path.join(pm.projectsRoot(), '.thumbnail-templates')
  await fs.mkdir(templates, { recursive: true })
  await fs.writeFile(path.join(templates, `${templateId}.json`), JSON.stringify({
    id: templateId, name: 'Text Shell', description: 'Layout only', builtin: false,
    schemaVersion: 1, layoutNote,
  }))
  await fs.mkdir(path.join(projectDir, 'thumbnail-reference-assets'), { recursive: true })
  await fs.writeFile(path.join(projectDir, 'thumbnail-reference-assets', reference.filename), 'original fixture bytes')
})
after(async () => { await cleanup() })

test('library editor analysis uses the existing containment boundary without choosing a channel', async () => {
  const { router } = await import('../routes/vision.js')
  const pm = await import('../services/project-manager.js')
  const beforeConfig = JSON.stringify(await pm.getConfig(slug))
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  const response = await request(app)
    .post(`/api/thumbnail-templates/${templateId}/analyze`)
    .send({ source_path: '/outside-configured-library/shell.png', model_id: 'fixture-vision' })
    .expect(403)
  assert.match(response.body.detail, /outside this project/)
  assert.equal(JSON.stringify(await pm.getConfig(slug)), beforeConfig)
})

test('an old saved reference remains selected ahead of an old text-only template without rewriting data', async () => {
  const config = { thumbnail_template_id: templateId, thumbnail_reference_asset: reference }
  const beforeConfig = JSON.stringify(config)
  const shell = await resolveThumbnailShell(slug, {}, config)
  assert.equal(shell.id, channelReferenceShellId(slug))
  assert.equal(shell.imagePath, path.join(projectDir, 'thumbnail-reference-assets', reference.filename))
  assert.equal(JSON.stringify(config), beforeConfig)
  assert.equal(await fs.readFile(shell.imagePath!, 'utf8'), 'original fixture bytes')
})

test('a deliberate text-only Shell supersedes the channel reference and keeps its layout note', async () => {
  const shell = await resolveThumbnailShell(slug, { thumbnail_shell_id: templateId }, { thumbnail_reference_asset: reference })
  assert.equal(shell.id, templateId)
  assert.equal(shell.imagePath, null)
  assert.equal(shell.layoutNote, layoutNote)
  assert.equal(shell.template?.id, templateId)
  assert.match(savedThumbnailReferenceGuidanceFor(projectDir, shell.guidanceAsset), /Subject on the right third/)
})

test('a deliberate no-Shell choice does not revive legacy references', async () => {
  const shell = await resolveThumbnailShell(slug, { thumbnail_shell_id: '' }, { thumbnail_reference_asset: reference })
  assert.equal(shell.id, '')
  assert.equal(shell.imagePath, null)
  assert.equal(shell.layoutNote, '')
})

test('a legacy text-only recipe remains usable without a vision model or image', async () => {
  const shell = await resolveThumbnailShell(slug, {}, { thumbnail_template_id: templateId })
  assert.equal(shell.id, templateId)
  assert.equal(shell.imagePath, null)
  assert.equal(shell.layoutNote, layoutNote)
})

test('missing source channels and path-traversing legacy assets are refused', async () => {
  await assert.rejects(resolveThumbnailShell(slug, { thumbnail_shell_id: channelReferenceShellId('other-channel') }, {}), /source channel was not found/)
  await assert.rejects(resolveThumbnailShell(slug, {}, {
    thumbnail_reference_asset: { ...reference, filename: '../outside.png' },
  }), /unavailable/)
})

test('a preset selecting another channel uses that channel’s real Shell explicitly', async () => {
  const pm = await import('../services/project-manager.js')
  const sourceConfig = await pm.getConfig(slug)
  assert.ok(sourceConfig)
  await pm.updateConfig(slug, Object.assign(sourceConfig, { thumbnail_reference_asset: reference }))
  const receiving = await pm.createProject({ name: 'Receiving Shell channel' })
  const shell = await resolveThumbnailShell(receiving.slug, {
    thumbnail_shell_id: channelReferenceShellId(slug),
    thumbnail_reference_asset: { ...reference, filename: 'wrong-channel.png' },
  }, {})
  assert.equal(shell.id, channelReferenceShellId(slug))
  assert.equal(shell.sourceProjectSlug, slug)
  assert.match(shell.name, /Shell runtime fixtures/)
  assert.equal(shell.imagePath, path.join(projectDir, 'thumbnail-reference-assets', reference.filename))
  const staged = await stageThumbnailShellImage(pm.getProjectDir(receiving.slug)!, shell.imagePath!)
  assert.ok(staged.startsWith(path.join(pm.getProjectDir(receiving.slug)!, 'thumbnail-reference-assets') + path.sep))
  assert.equal(await fs.readFile(staged, 'utf8'), 'original fixture bytes')
})

test('the exact Shell guidance is measured even when no reference image can be sent', async () => {
  const shell = await resolveThumbnailShell(slug, { thumbnail_shell_id: templateId }, {})
  const referenceGuidance = savedThumbnailReferenceGuidanceFor(projectDir, shell.guidanceAsset)
  const body = 'This episode’s new subject in the chosen art style.'
  const assembly = { referenceGuidance, extraDetails: 'Keep the hook legible.', styleKeywords: ['flat ink'] }
  const final = assembleThumbnailRenderPrompt(body, assembly)
  assert.equal(final.length - body.length, thumbnailRenderAssemblyOverhead(assembly).characters)
  assertPromptWithinCap(final, final.length, { modelLabel: 'Fixture', what: 'Shell thumbnail' })
  assert.throws(() => assertPromptWithinCap(final, final.length - 1, { modelLabel: 'Fixture', what: 'Shell thumbnail' }))
  assert.match(final, /Shell layout only:/)
})

test('a missing legacy image still supplies its saved layout note for text-only rendering', async () => {
  const shell = await resolveThumbnailShell(slug, {}, {
    thumbnail_reference_asset: { ...reference, filename: 'missing.png' },
  })
  assert.equal(shell.layoutNote, reference.reframing_prompt)
  assert.match(savedThumbnailReferenceGuidanceFor(projectDir, shell.guidanceAsset), /A centered subject with empty space above/)
})

test('a channel reference directory cannot redirect outside its owning project', async () => {
  const pm = await import('../services/project-manager.js')
  const other = await pm.createProject({ name: 'Shell symlink fixture' })
  const otherDir = pm.getProjectDir(other.slug)!
  await fs.symlink(path.join(projectDir, 'thumbnail-reference-assets'), path.join(otherDir, 'thumbnail-reference-assets'))
  await assert.rejects(resolveThumbnailShell(other.slug, {}, { thumbnail_reference_asset: reference }), /outside its managed folder/)
  await assert.rejects(stageThumbnailShellImage(otherDir, path.join(projectDir, 'thumbnail-reference-assets', reference.filename)), /outside this project/)
})

test('library images stage immutably inside the project for original-request retry identity', async () => {
  const source = path.join(projectDir, 'source.png')
  await fs.writeFile(source, 'first image')
  const staged = await stageThumbnailShellImage(projectDir, source)
  assert.equal(await fs.readFile(staged, 'utf8'), 'first image')
  assert.equal(await stageThumbnailShellImage(projectDir, source), staged)
  await fs.writeFile(source, 'replacement image')
  const replacement = await stageThumbnailShellImage(projectDir, source)
  assert.notEqual(replacement, staged)
  assert.equal(await fs.readFile(staged, 'utf8'), 'first image')
  await fs.writeFile(staged, 'corrupt')
  await fs.writeFile(source, 'first image')
  await assert.rejects(stageThumbnailShellImage(projectDir, source), /integrity check/)
})
