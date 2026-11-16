/**
 * Branded typography — the wiring into the real thumbnail job and the upload (2026-11-16).
 *
 * Binding conditions proved here:
 *   - its OWN default-off switch: absent/disabled writes nothing and changes no prompt;
 *   - the text-drawing directive is removed from the COPY the model receives, never from the
 *     stored prompt, and the prose around it stays;
 *   - the composited picture is a NEW file (`…_v1_branded.png`) beside an untouched model file, with
 *     a sidecar naming its source sha, accent, member and state;
 *   - the accent assignment is recorded only after the picture is on disk, and a channel with no
 *     accent gets an honest `not_branded` sidecar instead of a picture;
 *   - a changed source makes the branded picture stale, so the upload refuses it by name.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import { BRANDED_TYPOGRAPHY_DEFAULTS, type BrandedTypography } from '../contracts/branded-typography.js'

let pm: typeof import('../services/project-manager.js')
let utils: typeof import('../services/utils.js')
let branded: typeof import('../services/branded-typography.js')
let thumb: typeof import('../services/branded-thumbnail.js')
let upload: typeof import('../lib/upload-metadata.js')
let tmp: { dir: string; cleanup: () => Promise<void> } | undefined
let fixtureNumber = 0

before(async () => {
  pm = await import('../services/project-manager.js')
  utils = await import('../services/utils.js')
  branded = await import('../services/branded-typography.js')
  thumb = await import('../services/branded-thumbnail.js')
  upload = await import('../lib/upload-metadata.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

/** A real 16:9 model picture and a real transparent accent, at the sizes the renderer expects. */
async function artBytes(colour = { r: 30, g: 40, b: 60, alpha: 1 }): Promise<Buffer> {
  return sharp({ create: { width: 1280, height: 720, channels: 4, background: colour } }).png().toBuffer()
}
async function accentFile(dir: string): Promise<string> {
  const file = path.join(dir, 'badge.png')
  await sharp({ create: { width: 240, height: 96, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 0.9 } } })
    .png().toFile(file)
  return file
}

function settingsOn(over: Partial<BrandedTypography> = {}): BrandedTypography {
  return { ...BRANDED_TYPOGRAPHY_DEFAULTS, enabled: true, title: { ...BRANDED_TYPOGRAPHY_DEFAULTS.title }, ...over }
}

async function fixture(options: { withAccent?: boolean } = {}) {
  const project = await pm.createProject({ name: `Branded wiring ${++fixtureNumber}`, episode_prefix: 'BW' })
  const projectDir = pm.getProjectDir(project.slug)!
  const paths = await utils.resolveEpisodePaths(project.slug, 'BW0001', '')
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  const accents = []
  if (options.withAccent !== false) {
    const source = await accentFile(tmp!.dir)
    const added = await branded.addBrandedAccent(project.slug, source, 'Red badge')
    accents.push(added.accent)
  }
  const sourcePath = path.join(paths.thumb_dir, 'BW0001_Thumb01_v1.png')
  await fs.writeFile(sourcePath, await artBytes())
  const settings = settingsOn({ accents })
  await pm.updateConfig(project.slug, { branded_typography: settings })
  return { project, projectDir, paths, sourcePath, settings, accents }
}

// ── the prompt the model receives ──────────────────────────────────────────

const STORED_PROMPT = [
  'A warm cinematic portrait of a monk at dawn in Angkor Wat, soft rim light, shallow depth of field.',
  'Rendered as a 16:9 widescreen — this is a YouTube thumbnail (16:9).',
  'Render the exact title "Peace in Every Step" inside the image as large, highly legible display text using bold sweeping sans-serif letters, a treatment chosen to suit the concept, positioned at the strongest placement for the composition. This is the finished thumbnail; do not use placeholder or gibberish lettering.',
].join('\n\n')

test('ON removes the drawing directive from the model copy and keeps the prose', () => {
  const stripped = thumb.stripTitleTextDirective(STORED_PROMPT)
  assert.match(stripped, /A warm cinematic portrait of a monk at dawn in Angkor Wat/)
  assert.match(stripped, /Rendered as a 16:9 widescreen/)
  assert.doesNotMatch(stripped, /Render the exact title/)
  assert.doesNotMatch(stripped, /do not use placeholder or gibberish lettering/)
  assert.equal(thumb.stripTitleTextDirective('No directive here.'), 'No directive here.')
})

test('the prompt\'s own hook is readable, and absent when it drew no words', () => {
  assert.equal(thumb.promptHookText(STORED_PROMPT), 'Peace in Every Step')
  assert.equal(thumb.promptHookText('A quiet landscape with no lettering at all.'), null)
})

// ── the switch ─────────────────────────────────────────────────────────────

test('the switch is OFF unless this channel turned it on', () => {
  assert.equal(branded.brandedFromConfig({}), null)
  assert.equal(branded.brandedFromConfig({ branded_typography: { enabled: false } }), null)
  assert.equal(branded.brandedFromConfig({ branded_typography: settingsOn() })?.enabled, true)
})

test('the last-N guard is clamped to what the pool can honour, with a plain reason', () => {
  assert.deepEqual(branded.clampNoRepeat(2, 5), { n: 2, reason: null })
  const clamped = branded.clampNoRepeat(5, 3)
  assert.equal(clamped.n, 2)
  assert.match(clamped.reason!, /pool has 3 accents/)
  assert.match(branded.clampNoRepeat(3, 1).reason!, /guard is off/)
})

// ── the composite ──────────────────────────────────────────────────────────

test('ON writes a NEW branded picture and sidecar; the model art is untouched', async () => {
  const f = await fixture()
  const before = await fs.readFile(f.sourcePath)
  const result = await thumb.brandThumbVariant({
    slug: f.project.slug, projectDir: f.projectDir, episodeCode: 'BW0001',
    sourcePath: f.sourcePath, caption: 'Peace in Every Step', memberId: null,
    settings: f.settings, template: null,
  })
  assert.equal(result.state, 'branded')
  assert.equal(result.filename, 'BW0001_Thumb01_v1_branded.png')
  assert.deepEqual(await fs.readFile(f.sourcePath), before, 'the model art is byte-identical')

  const files = (await fs.readdir(f.paths.thumb_dir)).sort()
  assert.ok(files.includes('BW0001_Thumb01_v1_branded.png'))
  const sidecar = JSON.parse(await fs.readFile(path.join(f.paths.thumb_dir, 'BW0001_Thumb01_v1_branded.json'), 'utf8'))
  assert.equal(sidecar.state, 'branded')
  assert.equal(sidecar.accent_id, f.accents[0]!.id)
  assert.equal(sidecar.source_filename, 'BW0001_Thumb01_v1.png')
  assert.match(sidecar.source_sha256, /^[0-9a-f]{64}$/)
  assert.equal(sidecar.style.title, 'Peace in Every Step')

  // The assignment is stored LAST, and says how it was chosen.
  const assignments = await branded.readBrandedAssignments(f.projectDir)
  assert.equal(assignments.BW0001?.accent_id, f.accents[0]!.id)
  assert.ok(['pooled', 'pinned'].includes(assignments.BW0001!.source))
})

test('no accent means an honest not_branded sidecar and no picture', async () => {
  const f = await fixture({ withAccent: false })
  const result = await thumb.brandThumbVariant({
    slug: f.project.slug, projectDir: f.projectDir, episodeCode: 'BW0001',
    sourcePath: f.sourcePath, caption: 'Peace in Every Step', memberId: null,
    settings: f.settings, template: null,
  })
  assert.equal(result.state, 'not_branded')
  assert.match(result.reason!, /no accepted accent/i)
  const files = await fs.readdir(f.paths.thumb_dir)
  assert.equal(files.some(name => name.endsWith('_branded.png')), false)
  const sidecar = JSON.parse(await fs.readFile(path.join(f.paths.thumb_dir, 'BW0001_Thumb01_v1_branded.json'), 'utf8'))
  assert.equal(sidecar.state, 'not_branded')
  assert.ok(sidecar.reason)
})

test('a re-rendered source makes the branded picture stale', async () => {
  const f = await fixture()
  await thumb.brandThumbVariant({
    slug: f.project.slug, projectDir: f.projectDir, episodeCode: 'BW0001',
    sourcePath: f.sourcePath, caption: 'Peace in Every Step', memberId: null,
    settings: f.settings, template: null,
  })
  const brandedPath = path.join(f.paths.thumb_dir, 'BW0001_Thumb01_v1_branded.png')
  assert.equal((await thumb.brandedStaleness(brandedPath, f.paths.thumb_dir)).stale, false)
  await fs.writeFile(f.sourcePath, await artBytes({ r: 200, g: 200, b: 30, alpha: 1 }))
  const stale = await thumb.brandedStaleness(brandedPath, f.paths.thumb_dir)
  assert.equal(stale.stale, true)
  assert.match(stale.reason!, /re-made after this branded picture/)
})

test('the title layout comes from the episode layout; the face comes from the setting', async () => {
  const template = {
    id: 't', name: 'T', description: '', builtin: true, schemaVersion: 1 as const,
    canvas: { width: 1920, height: 1080 },
    textZones: [{
      name: 'title', x: 'right' as const, y: 'top' as const, xOffset: 96, yOffset: 72,
      maxWidth: 900, fontFamily: 'Impact', fontSize: 120, fontWeight: 'black' as const,
      fill: '#FFD60A', lineHeight: 1.1, textAnchor: 'end' as const,
    }],
  }
  const style = thumb.titleStyleFor(template, settingsOn({ title: { source: 'approved-title', font_id: 'kantumruy-pro', weight: 700 } }))
  assert.equal(style.font_id, 'kantumruy-pro')
  assert.equal(style.weight, 700)
  assert.equal(style.placement.anchor, 'top-right')
  assert.equal(style.align, 'right')
  assert.equal(style.fill.color, '#FFD60A')
  // The box is a share of the canvas, converted from the template's own pixels.
  assert.ok(style.placement.width_pct > 40 && style.placement.width_pct < 50)
})

// ── the upload ─────────────────────────────────────────────────────────────

test('OFF never offers a branded file, and the model art is the upload', async () => {
  const f = await fixture()
  await thumb.brandThumbVariant({
    slug: f.project.slug, projectDir: f.projectDir, episodeCode: 'BW0001',
    sourcePath: f.sourcePath, caption: 'Peace in Every Step', memberId: null,
    settings: f.settings, template: null,
  })
  await pm.updateConfig(f.project.slug, { branded_typography: { ...f.settings, enabled: false } })
  const options = await upload.listUploadThumbnails({ slug: f.project.slug, episode_code: 'BW0001', platform: 'youtube' })
  assert.deepEqual(options.map(option => option.filename), ['BW0001_Thumb01_v1.png'])
})

test('ON offers only the fresh branded picture, and a stale one is refused by name', async () => {
  const f = await fixture()
  await thumb.brandThumbVariant({
    slug: f.project.slug, projectDir: f.projectDir, episodeCode: 'BW0001',
    sourcePath: f.sourcePath, caption: 'Peace in Every Step', memberId: null,
    settings: f.settings, template: null,
  })
  const options = await upload.listUploadThumbnails({ slug: f.project.slug, episode_code: 'BW0001', platform: 'youtube' })
  assert.deepEqual(options.map(option => option.filename), ['BW0001_Thumb01_v1_branded.png'])

  await fs.writeFile(f.sourcePath, await artBytes({ r: 10, g: 120, b: 200, alpha: 1 }))
  assert.deepEqual(
    (await upload.listUploadThumbnails({ slug: f.project.slug, episode_code: 'BW0001', platform: 'youtube' })).map(o => o.filename),
    [],
  )
  await assert.rejects(
    () => upload.resolveUploadMetadata({
      slug: f.project.slug, episode_code: 'BW0001',
      thumbnail_filename: 'BW0001_Thumb01_v1_branded.png',
    }),
    /re-made after this branded picture|no longer available/,
  )
})

test('ON refuses an unbranded model file on the upload path', async () => {
  const f = await fixture()
  await assert.rejects(
    () => upload.resolveUploadMetadata({
      slug: f.project.slug, episode_code: 'BW0001',
      thumbnail_filename: 'BW0001_Thumb01_v1.png',
    }),
    /must publish its branded thumbnail/,
  )
})
