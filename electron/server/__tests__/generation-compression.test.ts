/**
 * "Smaller files" settings (services/generation-compression.ts) and the receive-side fallback.
 *
 * Resolution order is the contract: a project's own value beats the app default, a kind the project
 * does not mention follows the app default, and an unset default is the owner's table
 * (music, narration, scene images, image pool ON; thumbnails OFF). The fallback is the other half:
 * a node that ignored `output_format` still sends a PNG, and when the toggle is on Story shrinks it.
 *
 * Module-load ordering: STORY_STUDIO_DATA_DIR must be set before app-settings / project-manager load.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'

let temp: Awaited<ReturnType<typeof useTempDataDir>>
let svc: typeof import('../services/generation-compression.js')
let pm: typeof import('../services/project-manager.js')
let app: express.Express

before(async () => {
  temp = await useTempDataDir()
  svc = await import('../services/generation-compression.js')
  pm = await import('../services/project-manager.js')
  const appSettings = await import('../routes/app-settings.js')
  const projectSettings = await import('../routes/settings.js')
  app = express()
  app.use(express.json())
  app.use(appSettings.router)
  app.use(projectSettings.router)
})

after(async () => { await temp.cleanup() })

describe('resolution: project override > app default > built-in table', () => {
  test('built-in defaults are the owner\'s table', async () => {
    assert.deepEqual(await svc.getGlobalCompression(), {
      music: true, narration: true, scene_images: true, image_pool: true, thumbnails: false,
    })
  })

  test('the format asked for is fixed per kind, and a kind that is off asks for nothing', async () => {
    const project = await pm.createProject({ name: 'Formats' })
    assert.equal(await svc.resolveOutputFormat(project.slug, 'music'), 'm4a')
    assert.equal(await svc.resolveOutputFormat(project.slug, 'narration'), 'm4a')
    assert.equal(await svc.resolveOutputFormat(project.slug, 'scene_images'), 'jpeg')
    assert.equal(await svc.resolveOutputFormat(project.slug, 'image_pool'), 'jpeg')
    assert.equal(await svc.resolveOutputFormat(project.slug, 'thumbnails'), undefined, 'thumbnails are never asked for by default')
  })

  test('a project follows the app default until it states its own value', async () => {
    const project = await pm.createProject({ name: 'Inherit' })
    await svc.setGlobalCompression({ music: false })
    assert.equal(await svc.resolveCompression(project.slug, 'music'), false, 'follows the app default')
    await svc.setProjectCompressionOverride(project.slug, { music: true })
    assert.equal(await svc.resolveCompression(project.slug, 'music'), true, 'project override wins over a global OFF')
    await svc.setGlobalCompression({ music: true, scene_images: false })
    await svc.setProjectCompressionOverride(project.slug, { music: false })
    assert.equal(await svc.resolveCompression(project.slug, 'music'), false, 'project OFF wins over a global ON')
    assert.equal(await svc.resolveCompression(project.slug, 'scene_images'), false, 'untouched kinds still follow the default')
    // `null` hands the kind back to the app default.
    await svc.setProjectCompressionOverride(project.slug, { music: null })
    assert.equal(await svc.resolveCompression(project.slug, 'music'), true)
    assert.deepEqual(await svc.getProjectCompressionOverride(project.slug), {})
    await svc.setGlobalCompression({ music: true, scene_images: true })
  })

  test('no project (a machine-wide call) uses the app default', async () => {
    await svc.setGlobalCompression({ thumbnails: true })
    assert.equal(await svc.resolveOutputFormat(undefined, 'thumbnails'), 'jpeg')
    await svc.setGlobalCompression({ thumbnails: false })
  })

  test('garbage in a hand-edited file never leaks through', () => {
    assert.deepEqual(svc.sanitizeCompression({ music: 'yes', bogus: true, narration: false }), { narration: false })
    assert.deepEqual(svc.sanitizeCompression([true]), {})
    assert.deepEqual(svc.sanitizeCompression(null), {})
  })
})

describe('routes', () => {
  test('app default: GET shows it, PUT changes only what was sent, unknown keys are a 400', async () => {
    const before = await request(app).get('/app-settings/generation-compression').expect(200)
    assert.equal(before.body.settings.music, true)
    assert.equal(before.body.defaults.thumbnails, false)
    const after = await request(app).put('/app-settings/generation-compression').send({ narration: false }).expect(200)
    assert.equal(after.body.settings.narration, false)
    assert.equal(after.body.settings.music, true, 'a partial PUT leaves the rest alone')
    const priorError = console.error
    try {
      console.error = () => undefined // the route logs each refusal it humanises
      await request(app).put('/app-settings/generation-compression').send({ video: true }).expect(400)
      await request(app).put('/app-settings/generation-compression').send({ music: 'yes' }).expect(400)
      await request(app).put('/app-settings/generation-compression').send([true]).expect(400)
    } finally {
      console.error = priorError
    }
    await request(app).put('/app-settings/generation-compression').send({ narration: true }).expect(200)
  })

  test('project override: effective = default + override, null clears, unknown project is a 404', async () => {
    const project = await pm.createProject({ name: 'Routes' })
    const url = `/projects/${project.slug}/settings/generation-compression`
    const first = await request(app).get(url).expect(200)
    assert.deepEqual(first.body.override, {})
    assert.equal(first.body.effective.music, true)
    const set = await request(app).put(url).send({ music: false, thumbnails: true }).expect(200)
    assert.deepEqual(set.body.override, { music: false, thumbnails: true })
    assert.equal(set.body.effective.music, false)
    assert.equal(set.body.effective.thumbnails, true)
    assert.equal(set.body.effective.scene_images, true)
    const cleared = await request(app).put(url).send({ music: null }).expect(200)
    assert.deepEqual(cleared.body.override, { thumbnails: true })
    // It is part of the project's own config.json, so it travels with the project.
    const config = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'config.json'), 'utf8'))
    assert.deepEqual(config.generation_compression, { thumbnails: true })
    await request(app).put(url).send({ nonsense: true }).expect(400)
    await request(app).get('/projects/does-not-exist/settings/generation-compression').expect(404)
    await request(app).put('/projects/does-not-exist/settings/generation-compression').send({ music: true }).expect(404)
  })
})

describe('receive side: a node that ignored output_format still gives us a PNG', () => {
  const noise = async (alpha = false) => {
    const raw = Buffer.alloc(320 * 180 * 4)
    for (let i = 0; i < raw.length; i += 4) {
      const x = (i / 4) % 320, y = Math.floor(i / 4 / 320)
      raw[i] = (x * 5 + y * 3) & 255; raw[i + 1] = (x * y) & 255; raw[i + 2] = (x ^ y) & 255
      raw[i + 3] = alpha ? (x < 160 ? 0 : 255) : 255
    }
    return sharp(raw, { raw: { width: 320, height: 180, channels: 4 } }).png().toBuffer()
  }
  const dataUrl = (bytes: Buffer, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`
  const magic = async (file: string) => (await fs.readFile(file)).subarray(0, 4).toString('hex')

  test('toggle ON: the PNG becomes a JPEG under the SAME name, same size, much smaller', async () => {
    const { saveGenStudioImage } = await import('../lib/genstudio-artifacts.js')
    const png = await noise()
    const out = path.join(temp.dir, 'fallback', 'scene_v1.png')
    await saveGenStudioImage(dataUrl(png), out, undefined, { compress: true })
    assert.equal((await magic(out)).startsWith('ffd8ff'), true, 'JPEG bytes')
    const meta = await sharp(out).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 320, 180])
    assert.ok((await fs.stat(out)).size < png.length)
    assert.deepEqual((await fs.readdir(path.dirname(out))), ['scene_v1.png'], 'no scratch files left behind')
  })

  test('toggle OFF: the PNG is stored untouched', async () => {
    const { saveGenStudioImage } = await import('../lib/genstudio-artifacts.js')
    const png = await noise()
    const out = path.join(temp.dir, 'fallback', 'off_v1.png')
    await saveGenStudioImage(dataUrl(png), out)
    assert.deepEqual(await fs.readFile(out), png)
  })

  test('a JPEG that already arrived compressed is stored as received (no second generation)', async () => {
    const { saveGenStudioImage } = await import('../lib/genstudio-artifacts.js')
    const jpeg = await sharp(await noise()).jpeg({ quality: 90 }).toBuffer()
    const out = path.join(temp.dir, 'fallback', 'already_v1.png')
    await saveGenStudioImage(dataUrl(jpeg, 'image/jpeg'), out, undefined, { compress: true })
    assert.deepEqual(await fs.readFile(out), jpeg)
  })

  test('real transparency is never flattened to black: the PNG stays', async () => {
    const { saveGenStudioImage } = await import('../lib/genstudio-artifacts.js')
    const png = await noise(true)
    const out = path.join(temp.dir, 'fallback', 'alpha_v1.png')
    await saveGenStudioImage(dataUrl(png), out, undefined, { compress: true })
    assert.deepEqual(await fs.readFile(out), png)
  })

  test('a PNG that JPEG cannot beat is kept as the verified original', async () => {
    const { saveGenStudioImage } = await import('../lib/genstudio-artifacts.js')
    const flat = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toBuffer()
    const out = path.join(temp.dir, 'fallback', 'flat_v1.png')
    await saveGenStudioImage(dataUrl(flat), out, undefined, { compress: true })
    const stored = await fs.readFile(out)
    assert.ok(stored.length <= flat.length, 'never larger than what arrived')
  })
})
