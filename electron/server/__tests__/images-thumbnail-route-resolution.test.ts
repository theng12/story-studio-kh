/**
 * The thumbnail picker, the pin and the uploader must agree on ONE folder.
 *
 * The picker (`GET /projects/:slug/episodes/:code/thumbnails`) and the pin
 * (`POST .../thumbnails/pin`) resolved the episode BY TITLE, while the
 * uploader's resolver resolves it BY CODE. After a rename those are two
 * different folders: the picker listed files the upload never read, and the
 * pin pre-check refused files that were really there — the customer picked a
 * thumbnail from one list and the platform received another.
 *
 * These tests hold the route boundary to that: the picker, the pin and the
 * sidecar all name the same folder, and an episode whose folders cannot be
 * told apart is refused rather than guessed between.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

// Import the router under a throwaway data dir so any module-level cache is
// keyed against it, then drop it — the same pattern
// upload-metadata-overrides-pair.test.ts uses.
const boot = await useTempDataDir()
const { router } = await import('../routes/images.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const THUMB = 'EP0001_Thumb01_v1.png'
const EPISODE_TITLE = 'The Lighthouse at Dawn'

/**
 * A project with one accepted episode, and a folder for it ON DISK under a
 * name that may differ from the idea's title — a rename leaves the folder
 * under its old name.
 *
 * `uploadSidecar` says whether the folder carries `youtube_upload.json`, the
 * file that marks a folder as the episode's own for the by-code resolver. An
 * episode that has never been uploaded does not have one, and that is a
 * different case: only the read resolver's recovery can find it.
 */
async function seededEpisode(name: string, options: {
  folderTitle?: string
  uploadSidecar?: boolean
} = {}): Promise<{
  slug: string; episodeCode: string; title: string; episodeDir: string; thumbDir: string
}> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await pm.createProject({ name })
  const [idea] = await im.addIdeas(project.slug, [{
    title: EPISODE_TITLE, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const episodeCode = accepted.idea.episode_code!
  const title = accepted.idea.title
  const paths = await resolveEpisodePaths(project.slug, episodeCode, options.folderTitle || title)
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, THUMB), Buffer.from([0xff, 0xd8, 0xff]))
  if (options.uploadSidecar) {
    await fs.writeFile(path.join(paths.episode_dir, 'youtube_upload.json'), JSON.stringify({ channel_id: 'UC-test' }))
  }
  return {
    slug: project.slug, episodeCode, title,
    episodeDir: paths.episode_dir, thumbDir: paths.thumb_dir,
  }
}

function list(slug: string, episodeCode: string) {
  return request(app).get(`/api/projects/${slug}/episodes/${episodeCode}/thumbnails`)
}

function pin(slug: string, episodeCode: string, filename: string | null) {
  return request(app)
    .post(`/api/projects/${slug}/episodes/${episodeCode}/thumbnails/pin`)
    .send({ filename, platform: 'youtube' })
}

test('the picker lists the folder the uploader reads, after a rename', async () => {
  // The folder was renamed; the folder named after the CURRENT title is
  // still on disk but empty — accepting the idea created it and the rename
  // left it behind. The upload sidecar is what says which folder owns the
  // episode, and it moved with the rename.
  const { slug, episodeCode } = await seededEpisode('Picker Renamed Episode', {
    folderTitle: 'Old Title', uploadSidecar: true,
  })

  const res = await list(slug, episodeCode)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.files.map((f: any) => f.filename), [THUMB],
    'the picker shows the file in the folder that holds the episode')
  assert.equal(res.body.resolved, THUMB, 'and resolves to it')
})

test('a thumbnail in the renamed folder can be pinned, and the picker reports it pinned', async () => {
  const { slug, episodeCode, episodeDir } = await seededEpisode('Pin Renamed Episode', {
    folderTitle: 'Old Title', uploadSidecar: true,
  })

  const pinned = await pin(slug, episodeCode, THUMB)
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body))
  assert.equal(pinned.body.pinned, THUMB)

  // The pin landed in the folder that holds the episode.
  const sidecar = path.join(episodeDir, 'upload_metadata_overrides.json')
  assert.equal(existsSync(sidecar), true, 'the pin wrote the override sidecar')
  const raw = JSON.parse(await fs.readFile(sidecar, 'utf-8'))
  assert.equal(raw.youtube.selected_thumbnail, THUMB)

  const res = await list(slug, episodeCode)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.pinned, THUMB, 'the picker reports the pin')
  assert.equal(res.body.files[0].is_pinned, true)
})

test('an episode that was never uploaded is still found by the picker and the pin', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('Never Uploaded Episode', {
    folderTitle: 'Old Title', uploadSidecar: false,
  })
  // A rename MOVES the folder, so the one named after the current title is
  // not on disk. Only the read resolver's recovery can find this folder.
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)
  await fs.rm(canonical.episode_dir, { recursive: true, force: true })

  const res = await list(slug, episodeCode)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.files.map((f: any) => f.filename), [THUMB])

  const pinned = await pin(slug, episodeCode, THUMB)
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body))
  assert.equal(pinned.body.pinned, THUMB)
})

test('two folders for one episode code are refused by the picker and the pin, not guessed between', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('Ambiguous Episode')
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)
  const siblings = ['Another Title', 'Yet Another Title'].map(name =>
    path.join(path.dirname(canonical.episode_dir), `${episodeCode} - ${name}`))
  for (const dir of siblings) await fs.mkdir(dir, { recursive: true })
  await fs.rm(canonical.episode_dir, { recursive: true, force: true })

  const listed = await list(slug, episodeCode)
  assert.equal(listed.status, 409, JSON.stringify(listed.body))
  assert.equal(listed.body.code, 'EPISODE_FOLDER_AMBIGUOUS')
  assert.match(listed.body.detail, /more than one folder/i)

  const pinned = await pin(slug, episodeCode, THUMB)
  assert.equal(pinned.status, 409, JSON.stringify(pinned.body))
  assert.equal(pinned.body.code, 'EPISODE_FOLDER_AMBIGUOUS')

  for (const dir of siblings) {
    assert.equal(
      existsSync(path.join(dir, 'upload_metadata_overrides.json')),
      false,
      'nothing was written into any of the candidate folders',
    )
  }
})
