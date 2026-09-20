import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function metadataFixture(): Promise<{
  slug: string
  episodeCode: string
  title: string
  metadataDir: string
}> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const projects = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await projects.createProject({ name: 'Task 12 metadata versions' })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Versioned Metadata', logline: '', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'task12-test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const episodeCode = accepted.idea.episode_code!
  const title = accepted.idea.title
  const paths = await resolveEpisodePaths(project.slug, episodeCode, title)
  const metadataDir = path.dirname(paths.metadata_json)
  await fs.mkdir(metadataDir, { recursive: true })
  return { slug: project.slug, episodeCode, title, metadataDir }
}

function document(title: string): string {
  return JSON.stringify({ title, description: `${title} description`, tags: [title.toLowerCase()] })
}

test('upload metadata resolves the highest valid saved version', async () => {
  const fixture = await metadataFixture()
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata.json'), document('Version one'))
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata_v2.json'), document('Version two'))
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')

  const resolved = await resolveUploadMetadata({
    slug: fixture.slug,
    episode_code: fixture.episodeCode,
    fallback_title: fixture.title,
    platform: 'youtube',
  })

  assert.equal(resolved.title, 'Version two')
  assert.equal(resolved.description, 'Version two description')
  assert.deepEqual(resolved.tags, ['version two'])
})

test('upload metadata skips a malformed newest version and returns the next valid one', async () => {
  const fixture = await metadataFixture()
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata.json'), document('Version one'))
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata_v2.json'), document('Version two'))
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata_v3.json'), '{ malformed latest metadata')
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')

  const resolved = await resolveUploadMetadata({
    slug: fixture.slug,
    episode_code: fixture.episodeCode,
    fallback_title: fixture.title,
    platform: 'youtube',
  })

  assert.equal(resolved.title, 'Version two')
  assert.equal(resolved.description, 'Version two description')
  assert.deepEqual(resolved.tags, ['version two'])
})

test('upload metadata skips a valid but empty newest object', async () => {
  const fixture = await metadataFixture()
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata_v2.json'), document('Version two'))
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata_v3.json'), '{}')
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')

  const resolved = await resolveUploadMetadata({
    slug: fixture.slug,
    episode_code: fixture.episodeCode,
    fallback_title: fixture.title,
    platform: 'youtube',
  })

  assert.equal(resolved.title, 'Version two')
  assert.equal(resolved.description, 'Version two description')
  assert.deepEqual(resolved.tags, ['version two'])
})

test('upload metadata propagates candidate filesystem errors instead of treating them as absence', async () => {
  const fixture = await metadataFixture()
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata_v2.json'), document('Version two'))
  await fs.mkdir(path.join(fixture.metadataDir, 'EP0001_Metadata_v3.json'))
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')

  await assert.rejects(resolveUploadMetadata({
    slug: fixture.slug,
    episode_code: fixture.episodeCode,
    fallback_title: fixture.title,
    platform: 'youtube',
  }), /EISDIR|illegal operation|directory/i)
})

test('upload metadata propagates a directory listing permission error', async t => {
  const fixture = await metadataFixture()
  await fs.writeFile(path.join(fixture.metadataDir, 'EP0001_Metadata.json'), document('Version one'))
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')
  const realReaddir = fs.readdir
  const denied = Object.assign(new Error('metadata listing denied'), { code: 'EACCES' })
  t.mock.method(fs, 'readdir', (target: any, ...args: any[]) => {
    if (String(target) === fixture.metadataDir) return Promise.reject(denied)
    return (realReaddir as any)(target, ...args)
  })

  await assert.rejects(resolveUploadMetadata({
    slug: fixture.slug,
    episode_code: fixture.episodeCode,
    fallback_title: fixture.title,
    platform: 'youtube',
  }), error => error === denied)
})
