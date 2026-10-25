import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { buildSidecar, sourceIdentity, writeSidecar } from '../services/thumbnail-text-variants.js'
import { listBuiltinPresets } from '../lib/thumbnail-text-presets.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let utils: typeof import('../services/utils.js')
let upload: typeof import('../lib/upload-metadata.js')
let overrides: typeof import('../services/upload-overrides.js')
let fixtureNumber = 0

before(async () => {
  const temp = await useTempDataDir()
  // Preserve fixtures rather than removing evidence at teardown.
  cleanup = async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    if (process.env.STORY_STUDIO_TEST_HARNESS_ROOT) return // the focused runner retains this fixture
    const trash = '/build/Developer/_trash/thumbnail-text-tests'
    await fs.mkdir(trash, { recursive: true })
    await fs.rename(temp.dir, path.join(trash, path.basename(temp.dir)))
  }
  pm = await import('../services/project-manager.js')
  utils = await import('../services/utils.js')
  upload = await import('../lib/upload-metadata.js')
  overrides = await import('../services/upload-overrides.js')
})
after(async () => { await cleanup?.() })

async function fixture() {
  const project = await pm.createProject({ name: `Thumbnail upload ${++fixtureNumber}` })
  const paths = await utils.resolveEpisodePaths(project.slug, 'EP0001', '')
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  const source = path.join(paths.thumb_dir, 'art.png')
  const filename = 'art_text-1.png'
  await fs.writeFile(source, 'original source')
  const identity = await sourceIdentity(source)
  await fs.writeFile(path.join(paths.thumb_dir, filename), 'applied variant')
  await writeSidecar(path.join(paths.thumb_dir, filename), buildSidecar({
    sourceFilename: 'art.png', sourceSha256: identity.sha256, sourceBytes: identity.bytes,
    text: 'Headline', style: (await listBuiltinPresets())[0]!.style,
    fontSha256: 'test-font', appVersion: 'test',
  }))
  return { input: { slug: project.slug, episode_code: 'EP0001', platform: 'youtube' as const }, paths, source, filename }
}

test('upload list includes fresh text variants, drops stale variants, and retains the source', async () => {
  const f = await fixture()
  assert.deepEqual((await upload.listUploadThumbnails(f.input)).map(row => row.filename).sort(), ['art.png', f.filename].sort())
  assert.equal(await upload.stalePinnedTextLayer(f.input), null)
  await fs.writeFile(f.source, 'changed source!')
  const remaining = await upload.listUploadThumbnails(f.input)
  assert.deepEqual(remaining.map(row => row.filename), ['art.png'])
  assert.equal(remaining[0]!.path, f.source)
})

test('a stale pinned text layer explains the change and how to repair it', async () => {
  const f = await fixture()
  await overrides.writeSelectedThumbnail(f.input.slug, f.input.episode_code, '', 'youtube', f.filename)
  assert.equal(await upload.stalePinnedTextLayer(f.input), null)
  assert.equal((await upload.listUploadThumbnails(f.input)).find(row => row.is_pinned)?.filename, f.filename)
  await fs.writeFile(f.source, 'changed source!')
  const message = await upload.stalePinnedTextLayer(f.input)
  assert.ok(message)
  assert.match(message, /artwork changed/i)
  assert.match(message, /art\.png/)
  assert.match(message, /re-apply/i)
  assert.match(message, /Nothing was uploaded/)
  assert.ok(!message.includes(f.paths.episode_dir), 'never expose filesystem paths')
  assert.equal((await upload.listUploadThumbnails(f.input)).some(row => row.is_pinned), false)
  await assert.rejects(() => upload.resolveUploadMetadata(f.input), /artwork changed.*re-apply/is)
})

test('an explicit stale text choice is refused even when it is not the pinned choice', async () => {
  const f = await fixture()
  await fs.writeFile(f.source, 'changed source!')
  await assert.rejects(
    () => upload.resolveUploadMetadata({ ...f.input, thumbnail_filename: f.filename }),
    /artwork changed.*re-apply/is,
  )
})

test('a missing or malformed text sidecar cannot enter the upload list', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.paths.thumb_dir, 'art_text-2.png'), 'orphan')
  await fs.writeFile(path.join(f.paths.thumb_dir, `${f.filename}.text-layer.json`), '{')
  assert.deepEqual((await upload.listUploadThumbnails(f.input)).map(row => row.filename), ['art.png'])
})
