/**
 * The channel profile — handle, About text, and the channel's own art.
 *
 * What these tests are about:
 *   - the channel's NAME stays where it has always lived (project.json) and
 *     is never duplicated into the profile;
 *   - the profile's text and its art can be saved at the same time without
 *     one of them losing the other;
 *   - only real, fully decodable images are stored, and a file that merely
 *     shares a name is never mistaken for the same content;
 *   - a stored reference can never point outside the channel's own folder,
 *     and neither can a symlinked folder inside it;
 *   - replacing or removing art moves the REFERENCE and leaves the bytes on
 *     disk.
 *
 * UNSAFE FIXTURES LIVE ALONE. A case that plants a symlink or a hostile
 * reference gets its own Library, its own channel, and its own preserved
 * tree: the harness refuses to remove a tree that holds a symbolic link, so
 * such a root is never deleted and never touches the shared channel that the
 * ordinary cases share. Nothing in this file removes a tree.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'fs/promises'
import path from 'node:path'
import request from 'supertest'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: express.Express
let slug: string
let channelDir: string
let pm: typeof import('../services/project-manager.js')

const PROFILE_DIR = path.join('assets', 'profile')

async function pngBytes(width = 8, height = 8, red = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: red, g: 40, b: 90, alpha: 1 } },
  }).png().toBuffer()
}

async function readConfigOf(dir: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf-8'))
}

async function writeConfigTo(dir: string, config: any): Promise<void> {
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')
}

async function profileAssetsIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(dir, PROFILE_DIR))).sort()
  } catch {
    return []
  }
}

/** A binary response body, whichever way the client hands it back. */
function servedBytes(body: any): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body)
}

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  // Imported AFTER the temp data dir is claimed, so nothing in these modules
  // can resolve a path into the real Library.
  pm = await import('../services/project-manager.js')
  const { router } = await import('../routes/channel-profile.js')
  app = express()
  // The real server reads JSON bodies up to 10 MB; the route's own limit is
  // on the DECODED image size.
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', router)
  const project = await pm.createProject({ name: 'Test Channel' } as any)
  slug = project.slug
  channelDir = path.join(tempDir, 'projects', slug)
})

after(async () => {
  // The shared Library holds ordinary files only, so the harness may remove
  // it. The preserved roots of the unsafe cases are left exactly as they are.
  process.env.STORY_STUDIO_DATA_DIR = tempDir
  await cleanup()
})

/**
 * Run one case in a Library of its own.
 *
 * The root is PRESERVED, not cleaned up: the harness refuses to remove a tree
 * that holds a symbolic link, and the unsafe entry is worth keeping. Only the
 * environment pointer moves back to the shared Library afterwards, so the next
 * case never sees this one.
 */
async function inIsolatedLibrary<T>(
  name: string,
  body: (channel: { slug: string; dir: string; root: string }) => Promise<T>,
): Promise<T> {
  const temp = await useTempDataDir()
  try {
    const project = await pm.createProject({ name } as any)
    const dir = path.join(temp.dir, 'projects', project.slug)
    return await body({ slug: project.slug, dir, root: temp.dir })
  } finally {
    process.env.STORY_STUDIO_DATA_DIR = tempDir
  }
}

test('a channel with no profile reports its name and empty fields', async () => {
  const response = await request(app).get(`/api/projects/${slug}/channel-profile`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    name: 'Test Channel',
    handle: '',
    description: '',
    logo_url: null,
    banner_url: null,
  })
})

test('an unknown channel answers 404 with a detail', async () => {
  const response = await request(app).get('/api/projects/no-such-channel/channel-profile')
  assert.equal(response.status, 404)
  assert.equal(typeof response.body.detail, 'string')
})

test('the handle and the About text are saved, and the name is not duplicated into them', async () => {
  const response = await request(app)
    .put(`/api/projects/${slug}/channel-profile`)
    .send({ handle: '@NightAtlas', description: 'Sleep stories for grown-ups.' })
  assert.equal(response.status, 200)
  assert.equal(response.body.handle, 'NightAtlas')
  assert.equal(response.body.description, 'Sleep stories for grown-ups.')
  assert.equal(response.body.name, 'Test Channel')

  const config = await readConfigOf(channelDir)
  assert.equal(config.channel_profile.handle, 'NightAtlas')
  assert.equal(config.channel_profile.description, 'Sleep stories for grown-ups.')
  assert.equal(config.channel_profile.name, undefined)
})

test('the name is saved in project.json and stays authoritative there', async () => {
  const response = await request(app)
    .put(`/api/projects/${slug}/channel-profile`)
    .send({ name: '  Renamed Channel  ' })
  assert.equal(response.status, 200)
  assert.equal(response.body.name, 'Renamed Channel')

  const meta = JSON.parse(await fs.readFile(path.join(channelDir, 'project.json'), 'utf-8'))
  assert.equal(meta.name, 'Renamed Channel')
  const config = await readConfigOf(channelDir)
  assert.equal(config.channel_profile.name, undefined)
})

test('a handle with a space is refused, and the channel is NOT renamed by the failed save', async () => {
  const before = JSON.parse(await fs.readFile(path.join(channelDir, 'project.json'), 'utf-8')).name
  const response = await request(app)
    .put(`/api/projects/${slug}/channel-profile`)
    .send({ name: 'Should Not Stick', handle: 'two words' })
  assert.equal(response.status, 400)
  assert.equal(typeof response.body.detail, 'string')
  // Nothing was written, so the error must not claim the name went in.
  assert.ok(!/name was saved/i.test(response.body.detail))

  const after = JSON.parse(await fs.readFile(path.join(channelDir, 'project.json'), 'utf-8')).name
  assert.equal(after, before)
  const config = await readConfigOf(channelDir)
  assert.equal(config.channel_profile.handle, 'NightAtlas')
})

test('a handle-only failure never claims the name was saved', async () => {
  const response = await request(app)
    .put(`/api/projects/${slug}/channel-profile`)
    .send({ handle: 'two words' })
  assert.equal(response.status, 400)
  assert.ok(!/name was saved/i.test(response.body.detail))
})

test('a field the profile does not own is refused', async () => {
  const response = await request(app)
    .put(`/api/projects/${slug}/channel-profile`)
    .send({ logo_url: '/somewhere/else.png' })
  assert.equal(response.status, 400)
})

test('a file that is not an image is refused, and nothing is written', async () => {
  const notAnImage = Buffer.from('this is plain text, not a picture').toString('base64')
  const response = await request(app)
    .post(`/api/projects/${slug}/channel-profile/logo`)
    .send({ filename: 'notes.txt', data_base64: notAnImage })
  assert.equal(response.status, 400)
  assert.equal(typeof response.body.detail, 'string')

  const profile = await request(app).get(`/api/projects/${slug}/channel-profile`)
  assert.equal(profile.body.logo_url, null)
  assert.deepEqual(await profileAssetsIn(channelDir), [])
})

test('a truncated image is refused', async () => {
  const full = await pngBytes(16, 16)
  const truncated = full.subarray(0, Math.floor(full.length / 2)).toString('base64')
  const response = await request(app)
    .post(`/api/projects/${slug}/channel-profile/logo`)
    .send({ filename: 'cut.png', data_base64: truncated })
  assert.equal(response.status, 400)
  assert.deepEqual(await profileAssetsIn(channelDir), [])
})

test('an oversized upload is refused before it is decoded', async () => {
  const tooBig = 'A'.repeat(7_000_000)
  const response = await request(app)
    .post(`/api/projects/${slug}/channel-profile/logo`)
    .send({ filename: 'huge.png', data_base64: tooBig })
  assert.equal(response.status, 413)
  assert.deepEqual(await profileAssetsIn(channelDir), [])
})

test('a valid PNG is stored in the channel and served back', async () => {
  const bytes = await pngBytes(12, 12, 10)
  const response = await request(app)
    .post(`/api/projects/${slug}/channel-profile/logo`)
    .send({ filename: 'logo.png', data_base64: bytes.toString('base64') })
  assert.equal(response.status, 200)
  assert.equal(typeof response.body.logo_url, 'string')
  assert.match(response.body.logo_url, /^\/api\/projects\/[^/]+\/channel-profile\/asset\/logo\?v=.+$/)
  assert.equal(response.body.banner_url, null)

  const files = await profileAssetsIn(channelDir)
  assert.equal(files.length, 1)
  assert.match(files[0]!, /^logo-[0-9a-f]+\.png$/)

  // The reference is the app's portable token, never a path from this machine.
  const config = await readConfigOf(channelDir)
  assert.match(config.channel_profile.logo, /^\$\{CHANNEL\}\/assets\/profile\/logo-[0-9a-f]+\.png$/)

  const served = await request(app).get(response.body.logo_url).buffer(true)
  assert.equal(served.status, 200)
  assert.equal(served.headers['content-type'], 'image/png')
  assert.deepEqual(servedBytes(served.body), bytes)
})

test('replacing the art changes the URL and keeps the previous bytes on disk', async () => {
  const before = (await request(app).get(`/api/projects/${slug}/channel-profile`)).body.logo_url as string
  const bytes = await pngBytes(20, 20, 220)
  const response = await request(app)
    .post(`/api/projects/${slug}/channel-profile/logo`)
    .send({ filename: 'logo2.png', data_base64: bytes.toString('base64') })
  assert.equal(response.status, 200)
  const after = response.body.logo_url as string
  assert.notEqual(before, after)

  // Both files are still there: the reference moved, the bytes stayed.
  assert.equal((await profileAssetsIn(channelDir)).length, 2)

  const served = await request(app).get(after).buffer(true)
  assert.equal(served.status, 200)
  assert.deepEqual(servedBytes(served.body), bytes)
})

test('the banner is a separate piece of art from the logo', async () => {
  const bytes = await pngBytes(30, 12, 90)
  const response = await request(app)
    .post(`/api/projects/${slug}/channel-profile/banner`)
    .send({ filename: 'banner.png', data_base64: bytes.toString('base64') })
  assert.equal(response.status, 200)
  assert.match(response.body.banner_url, /\/channel-profile\/asset\/banner\?v=.+$/)
  assert.match(response.body.logo_url, /\/channel-profile\/asset\/logo\?v=.+$/)
  assert.ok((await profileAssetsIn(channelDir)).some(file => file.startsWith('banner-')))
})

test('a file that only shares the name is not mistaken for the same content', async () => {
  const bytes = await pngBytes(24, 24, 77)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const profileDir = path.join(channelDir, PROFILE_DIR)
  await fs.mkdir(profileDir, { recursive: true })
  // Same size as the image about to be uploaded, different bytes, same name.
  const impostor = path.join(profileDir, `logo-${digest.slice(0, 16)}.png`)
  const impostorBytes = Buffer.alloc(bytes.length, 7)
  await fs.writeFile(impostor, impostorBytes)

  const response = await request(app)
    .post(`/api/projects/${slug}/channel-profile/logo`)
    .send({ filename: 'logo3.png', data_base64: bytes.toString('base64') })
  assert.equal(response.status, 200)

  // The stored art is the uploaded image, and the other file is untouched.
  const served = await request(app).get(response.body.logo_url).buffer(true)
  assert.equal(served.status, 200)
  assert.deepEqual(servedBytes(served.body), bytes)
  assert.deepEqual(await fs.readFile(impostor), impostorBytes)
})

test('removing the art clears the reference and keeps the file', async () => {
  const before = await profileAssetsIn(channelDir)
  assert.ok(before.length > 0)
  const response = await request(app).delete(`/api/projects/${slug}/channel-profile/logo`)
  assert.equal(response.status, 200)
  assert.equal(response.body.logo_url, null)

  // The bytes are still on disk — the app does not delete the owner's files.
  assert.deepEqual(await profileAssetsIn(channelDir), before)
  const served = await request(app).get(`/api/projects/${slug}/channel-profile/asset/logo`)
  assert.equal(served.status, 404)
})

test('an unknown kind is refused', async () => {
  const get = await request(app).get(`/api/projects/${slug}/channel-profile/asset/cover`)
  assert.equal(get.status, 400)
  const post = await request(app).post(`/api/projects/${slug}/channel-profile/cover`).send({ data_base64: 'AA==' })
  assert.equal(post.status, 400)
  const remove = await request(app).delete(`/api/projects/${slug}/channel-profile/cover`)
  assert.equal(remove.status, 400)
})

test('a stored reference that points outside the channel is not served', async () => {
  await inIsolatedLibrary('Outside Reference', async (channel) => {
    const config = await readConfigOf(channel.dir)
    config.channel_profile = { logo: '${CHANNEL}/../../../../etc/passwd' }
    await writeConfigTo(channel.dir, config)

    const response = await request(app).get(`/api/projects/${channel.slug}/channel-profile/asset/logo`)
    assert.equal(response.status, 404)
    assert.equal(typeof response.body.detail, 'string')
  })
})

test('a symlink inside the profile folder is not served', async () => {
  await inIsolatedLibrary('Symlink In Profile', async (channel) => {
    const outside = path.join(channel.root, 'outside.png')
    await fs.writeFile(outside, await pngBytes(4, 4, 3))
    const profileDir = path.join(channel.dir, PROFILE_DIR)
    await fs.mkdir(profileDir, { recursive: true })
    await fs.symlink(outside, path.join(profileDir, 'link.png'))

    const config = await readConfigOf(channel.dir)
    config.channel_profile = { logo: '${CHANNEL}/assets/profile/link.png' }
    await writeConfigTo(channel.dir, config)

    const response = await request(app).get(`/api/projects/${channel.slug}/channel-profile/asset/logo`)
    assert.equal(response.status, 404)
  })
})

test('a profile folder that is a symlink is neither written through nor served', async () => {
  await inIsolatedLibrary('Symlinked Profile Folder', async (channel) => {
    const outsideDir = path.join(channel.root, 'outside-profile')
    await fs.mkdir(outsideDir, { recursive: true })
    // A fresh channel has no assets folder yet, so the link can be planted
    // without removing anything that is already there.
    await fs.mkdir(path.join(channel.dir, 'assets'), { recursive: true })
    await fs.symlink(outsideDir, path.join(channel.dir, PROFILE_DIR))

    const bytes = await pngBytes(9, 9, 5)
    const response = await request(app)
      .post(`/api/projects/${channel.slug}/channel-profile/logo`)
      .send({ filename: 'logo.png', data_base64: bytes.toString('base64') })
    assert.equal(response.status, 409)
    assert.deepEqual(await fs.readdir(outsideDir), [])

    // Nothing is served through it either.
    const config = await readConfigOf(channel.dir)
    config.channel_profile = { logo: '${CHANNEL}/assets/profile/anything.png' }
    await writeConfigTo(channel.dir, config)
    const served = await request(app).get(`/api/projects/${channel.slug}/channel-profile/asset/logo`)
    assert.equal(served.status, 404)
  })
})

test('a symlink at the content-addressed name is never reused', async () => {
  await inIsolatedLibrary('Symlink Candidate', async (channel) => {
    const bytes = await pngBytes(26, 26, 33)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const profileDir = path.join(channel.dir, PROFILE_DIR)
    await fs.mkdir(profileDir, { recursive: true })

    // A link whose target holds the very same bytes: reusing it would point
    // the profile at a file the read path refuses, and answer 200 with a
    // broken image.
    const target = path.join(channel.root, 'same-content.png')
    await fs.writeFile(target, bytes)
    await fs.symlink(target, path.join(profileDir, `logo-${digest.slice(0, 16)}.png`))

    const response = await request(app)
      .post(`/api/projects/${channel.slug}/channel-profile/logo`)
      .send({ filename: 'logo.png', data_base64: bytes.toString('base64') })
    assert.equal(response.status, 200)

    // The reference points at a real file the app wrote, not at the link.
    const config = await readConfigOf(channel.dir)
    assert.notEqual(
      config.channel_profile.logo,
      '${CHANNEL}/assets/profile/logo-' + digest.slice(0, 16) + '.png',
    )

    const served = await request(app).get(response.body.logo_url).buffer(true)
    assert.equal(served.status, 200)
    assert.deepEqual(servedBytes(served.body), bytes)
  })
})

test('a corrupt config file is reported honestly after the name was saved', async () => {
  await inIsolatedLibrary('Corrupt Config', async (channel) => {
    const configPath = path.join(channel.dir, 'config.json')
    await fs.writeFile(configPath, '{ this is not json', 'utf-8')

    const response = await request(app)
      .put(`/api/projects/${channel.slug}/channel-profile`)
      .send({ name: 'Half Saved', handle: 'NightAtlas2' })
    assert.equal(response.status, 409)
    // The name DID go in, so the error has to say so.
    assert.match(response.body.detail, /name was saved/i)

    const meta = JSON.parse(await fs.readFile(path.join(channel.dir, 'project.json'), 'utf-8'))
    assert.equal(meta.name, 'Half Saved')
  })
})

test('a text save and an art save at the same time do not lose each other', async () => {
  const bytes = await pngBytes(14, 14, 44)
  const [text, art] = await Promise.all([
    request(app).put(`/api/projects/${slug}/channel-profile`).send({ description: 'Both at once.' }),
    request(app).post(`/api/projects/${slug}/channel-profile/logo`).send({ data_base64: bytes.toString('base64') }),
  ])
  assert.equal(text.status, 200)
  assert.equal(art.status, 200)

  const final = await request(app).get(`/api/projects/${slug}/channel-profile`)
  assert.equal(final.body.description, 'Both at once.')
  assert.equal(typeof final.body.logo_url, 'string')
})
