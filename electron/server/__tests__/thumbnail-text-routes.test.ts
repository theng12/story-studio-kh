import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { fontManifestPath } from '../lib/thumbnail-fonts.js'
import { presetsFilePath, listBuiltinPresets } from '../lib/thumbnail-text-presets.js'
import type { ThumbnailTextStyle } from '../contracts/thumbnail-text.js'

let cleanup: () => Promise<void>
let app: express.Express
let slug: string
let thumbDir: string
let otherThumbDir: string
let style: ThumbnailTextStyle
let source: Buffer
const code = 'EP0001'
const endpoint = (action: string) => `/api/projects/${slug}/episodes/${code}/thumbnail-text/${action}`
const body = (extra: Record<string, unknown> = {}) => ({ source_filename: 'source.png', text: 'សួស្តី', style, ...extra })

before(async () => {
  const temp = await useTempDataDir()
  cleanup = async () => {
    delete process.env.STORY_STUDIO_DATA_DIR
    if (process.env.STORY_STUDIO_TEST_HARNESS_ROOT) return // the focused runner retains this fixture
    const trash = process.env.STORY_STUDIO_TRASH_ROOT || path.join(tmpdir(), 'story-studio-thumbnail-text-tests')
    await fs.mkdir(trash, { recursive: true })
    await fs.rename(temp.dir, path.join(trash, path.basename(temp.dir)))
  }
  const pm = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Thumbnail text routes' })
  slug = project.slug
  thumbDir = (await resolveEpisodePaths(slug, code, '')).thumb_dir
  otherThumbDir = (await resolveEpisodePaths(slug, 'EP0002', '')).thumb_dir
  await fs.mkdir(thumbDir, { recursive: true })
  await fs.mkdir(otherThumbDir, { recursive: true })
  source = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#404040' } }).png().toBuffer()
  await fs.writeFile(path.join(thumbDir, 'source.png'), source)
  await fs.writeFile(path.join(otherThumbDir, 'foreign.png'), source)
  style = structuredClone((await listBuiltinPresets())[0]!.style)
  style.outline.enabled = false
  style.shadow.enabled = false
  const { router } = await import('../routes/thumbnail-text.js')
  app = express().use(express.json()).use('/api', router)
})
after(async () => { await cleanup?.() })

test('font catalogue exactly matches the public fields in fonts.json', async () => {
  const manifest = JSON.parse(await fs.readFile(fontManifestPath(), 'utf8'))
  const response = await request(app).get('/api/thumbnail-text/fonts')
  assert.equal(response.status, 200)
  assert.ok(manifest.fonts.length > 0)
  assert.deepEqual(response.body, manifest.fonts.map(({ id, label, scripts, weights, role, license }: any) => ({
    id, label, scripts, weights, role, license, source: 'bundled',
  })))
})

test('builtin catalogue matches its resource and contains only reusable look fields', async () => {
  const resource = JSON.parse(await fs.readFile(presetsFilePath(), 'utf8'))
  const response = await request(app).get('/api/thumbnail-text/presets/builtin')
  assert.equal(response.status, 200)
  assert.ok(resource.presets.length > 0)
  assert.deepEqual(response.body, resource.presets.map((preset: any) => ({ ...preset, builtin: true })))
  const lookKeys = ['font_id', 'weight', 'size', 'max_lines', 'align', 'line_height', 'letter_spacing', 'uppercase', 'fill', 'opacity', 'outline', 'shadow', 'background', 'placement'].sort()
  for (const preset of resource.presets) {
    assert.deepEqual(Object.keys(preset).sort(), ['id', 'name', 'style'])
    assert.deepEqual(Object.keys(preset.style).sort(), lookKeys, preset.id)
    const visit = (value: any): void => {
      for (const [key, child] of Object.entries(value)) {
        assert.doesNotMatch(key, /^(text|headline|episode.*|source.*|.*filename|slug|script)$/i, `${preset.id}: ${key}`)
        if (child && typeof child === 'object') visit(child)
      }
    }
    visit(preset.style)
  }
})

test('preview and apply reject absolute paths, traversal and foreign episode files without path disclosure', async () => {
  const before = (await fs.readdir(thumbDir)).sort()
  for (const action of ['preview', 'apply']) {
    for (const filename of [path.join(otherThumbDir, 'foreign.png'), '../foreign.png', '../../foreign.png', 'foreign.png']) {
      const response = await request(app).post(endpoint(action)).send(body({ source_filename: filename }))
      assert.equal(response.status, 400, `${action}: ${filename}`)
      const serialized = JSON.stringify(response.body)
      assert.ok(!serialized.includes(otherThumbDir), serialized)
      assert.ok(!serialized.includes(thumbDir), serialized)
      assert.ok(!serialized.includes('../'), serialized)
      assert.ok(response.body.detail)
    }
  }
  assert.deepEqual((await fs.readdir(thumbDir)).sort(), before)
})

test('preview returns a decodable PNG and a parseable report, without writing a variant', async () => {
  const before = (await fs.readdir(thumbDir)).sort()
  const response = await request(app).post(endpoint('preview')).send(body())
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.match(response.headers['content-type'], /^image\/png/)
  assert.equal(response.headers['cache-control'], 'no-store')
  const report = JSON.parse(response.headers['x-thumbnail-text-report'])
  assert.equal(report.glyphs_complete, true)
  assert.deepEqual(report.missing_characters, [])
  assert.equal(report.overflow, false)
  assert.ok(report.font_px > 0)
  assert.ok(report.lines > 0)
  assert.ok(Buffer.isBuffer(response.body))
  const meta = await sharp(response.body).metadata()
  assert.equal(meta.width, 1280)
  assert.equal(meta.height, 720)
  assert.equal(meta.format, 'png')
  assert.deepEqual((await fs.readdir(thumbDir)).sort(), before)
})

test('apply refuses overflow, missing glyphs, blank text and malformed image bytes without writing anything', async () => {
  await fs.writeFile(path.join(thumbDir, 'broken.png'), 'not an image')
  const cases = [
    { label: /fit/i, payload: body({ text: 'W'.repeat(100), style: { ...style, size: { mode: 'fit', min_px: 80, max_px: 90 }, max_lines: 1, placement: { anchor: 'center', x_pct: 50, y_pct: 50, width_pct: 10, height_pct: 5 } } }) },
    { label: /cannot draw/i, payload: body({ style: { ...style, font_id: 'anton', weight: 400 } }) },
    { label: /headline|nothing to draw/i, payload: body({ text: '   ' }) },
    { label: /image|unsupported/i, payload: body({ source_filename: 'broken.png' }) },
  ]
  for (const { label, payload } of cases) {
    const before = (await fs.readdir(thumbDir)).sort()
    const response = await request(app).post(endpoint('apply')).send({ ...payload, pin: true })
    assert.equal(response.status, 400)
    assert.match(response.body.detail, label)
    if (/cannot draw/.test(response.body.detail)) {
      assert.equal(response.body.report?.glyphs_complete, false)
      assert.ok(response.body.report?.missing_characters.length > 0)
    }
    if (/does not fit/.test(response.body.detail)) assert.equal(response.body.report?.overflow, true)
    assert.deepEqual((await fs.readdir(thumbDir)).sort(), before, 'refusal must write neither PNG nor sidecar')
    assert.deepEqual(await fs.readFile(path.join(thumbDir, 'source.png')), source)
    assert.equal((await fs.readdir(path.dirname(thumbDir))).includes('upload_metadata_overrides.json'), false)
  }
})

test('successful apply preserves source, writes usable PNG plus provenance, and retries add variants', async () => {
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256').update(source).digest('hex')
  const filenames: string[] = []
  for (let index = 0; index < 2; index++) {
    const response = await request(app).post(endpoint('apply')).send(body({ text: `Headline ${index}` }))
    assert.equal(response.status, 201, JSON.stringify(response.body))
    const filename = response.body.filename
    assert.ok(!filenames.includes(filename), 'retry must preserve the previous variant')
    filenames.push(filename)
    assert.match(filename, /_text-\d+\.png$/)
    const output = path.join(thumbDir, filename)
    const meta = await sharp(await fs.readFile(output)).metadata()
    assert.equal(meta.format, 'png')
    assert.equal(meta.width, 1280)
    const sidecar = JSON.parse(await fs.readFile(`${output}.text-layer.json`, 'utf8'))
    assert.equal(sidecar.schema, 1)
    assert.equal(sidecar.source_filename, 'source.png')
    assert.equal(sidecar.source_sha256, hash)
    assert.equal(sidecar.source_bytes, source.length)
    assert.equal(sidecar.text, `Headline ${index}`)
    assert.deepEqual(sidecar.style, style)
    assert.match(sidecar.font_sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isFinite(Date.parse(sidecar.rendered_at)))
    assert.ok(sidecar.app_version)
  }
  assert.deepEqual(await fs.readFile(path.join(thumbDir, 'source.png')), source)
  const listed = await request(app).get(endpoint('variants'))
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.map((row: any) => row.filename).sort(), filenames.sort())
  assert.ok(listed.body.every((row: any) => row.stale === false && row.stale_reason === null))
})
