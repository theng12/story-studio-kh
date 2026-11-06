/**
 * The six Production Looks, exercised the whole way through.
 *
 * `content-packs/production-looks/` productises the six built-in visual styles
 * that never had a signed pack: Retro Paint Fantasy, Pixel Art Story, Anime Cel,
 * Studio Catalog Realism, Whiteboard Doodle Explainer, and Hand-Drawn Cartoon
 * Explainer. A source tree that merely parses proves nothing — the question is
 * whether a customer who buys one gets that look in their images.
 *
 * So this builds the real sources into signed archives, installs them through
 * the real installer, and follows the style all the way to the string the image
 * generator actually sends. It also pins the contrast that motivated the work:
 * the legacy `builtin-*` route silently drops the negative prompt, and the
 * signed route keeps it.
 *
 * IMPORTANT — module-load ordering: STORY_STUDIO_DATA_DIR must be set (via
 * useTempDataDir) before project-manager is imported, so PROJECTS_ROOT points
 * at the temp dir.
 */

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { router as contentPacksRouter } from '../routes/content-packs.js'
import { useTempDataDir } from './_helpers.js'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const LOOKS = path.join(ROOT, 'content-packs', 'production-looks', 'style')
const KEY_ID = 'com.storystudio.key.production-looks-test'
const APP_VERSION = '1.0.0'

const SLUGS = [
  'anime-cel', 'hand-drawn-cartoon-explainer', 'pixel-art-story',
  'retro-paint-fantasy', 'studio-catalog-realism', 'whiteboard-doodle-explainer',
] as const

// The authored source of each look's current version. The unversioned
// directories are historical 1.0.0 snapshots; pixel-art-story and
// retro-paint-fantasy were neutralised in 1.0.2 and no longer build under the
// publisher's subject-word check.
const SOURCE_DIRS: Record<(typeof SLUGS)[number], string> = {
  'anime-cel': 'anime-cel-v1.0.1',
  'hand-drawn-cartoon-explainer': 'hand-drawn-cartoon-explainer-v1.0.1',
  'pixel-art-story': 'pixel-art-story-v1.0.2',
  'retro-paint-fantasy': 'retro-paint-fantasy-v1.0.2',
  'studio-catalog-realism': 'studio-catalog-realism-v1.0.1',
  'whiteboard-doodle-explainer': 'whiteboard-doodle-explainer-v1.0.1',
}

const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: 'com.storystudio',
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sourceStyle = async (slug: keyof typeof SOURCE_DIRS) =>
  JSON.parse(await fs.readFile(
    path.join(LOOKS, SOURCE_DIRS[slug], 'content', 'visual-style.json'),
    'utf8',
  ))

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let resolver: typeof import('../services/art-style-resolver.js')
let styleLoader: typeof import('../services/visual-style-loader.js')
let options: { paths: ReturnType<typeof getContentPackRuntimePaths>; policy: typeof policy; recoveryRoot: string; appVersion: string }
let app: express.Express

describe('the six Production Looks reach the image generator as signed styles', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    resolver = await import('../services/art-style-resolver.js')
    styleLoader = await import('../services/visual-style-loader.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at the temp dir — env was set too late')

    const recoveryRoot = path.join(tmp.dir, 'recovery')
    await fs.mkdir(recoveryRoot, { recursive: true })
    options = { paths: getContentPackRuntimePaths(), policy, recoveryRoot, appVersion: APP_VERSION }

    app = express()
    app.locals.contentPackOptions = options
    app.use('/api', contentPacksRouter)

    // The publisher is JavaScript-only tooling; the runtime never imports it.
    // @ts-expect-error no type declarations for the publisher script
    const { buildContentPack } = await import('../../../scripts/content-packs/lib.mjs')
    const keyPath = path.join(tmp.dir, 'production-looks-test.private.pem')
    await fs.writeFile(keyPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }))

    for (const slug of SLUGS) {
      const archivePath = path.join(tmp.dir, `${slug}.sspack`)
      await buildContentPack({
        sourceDirectory: path.join(LOOKS, SOURCE_DIRS[slug]),
        privateKeyPath: keyPath,
        outputPath: archivePath,
        keyId: KEY_ID,
        minAppVersion: APP_VERSION,
      })
      const archiveBytes = await fs.readFile(archivePath)
      const installed = await installContentPack(
        { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) },
        options,
      )
      assert.equal(installed.pack_id, `com.storystudio.pack.style.${slug}`)
    }
  })

  after(async () => { await tmp.cleanup() })

  test('every one of the six is published by the catalog — none is silently dropped', async () => {
    const published = await styleLoader.listVisualStyles(options)
    const ids = published.map(style => style.id).sort()
    for (const slug of SLUGS) {
      assert.ok(ids.includes(`com.storystudio.style.${slug}`),
        `${slug} installed but never reached the catalog — an unsupported category or a missing `
        + 'preview asset makes a bought style vanish without an error')
    }
    // A style whose category the adapter refuses is dropped by a swallowed
    // throw, so assert the categories these six actually declare are carried.
    for (const slug of SLUGS) {
      const source = await sourceStyle(slug)
      const style = published.find(candidate => candidate.id === source.id)!
      assert.equal(style.category, source.category, `${slug} category must survive publication`)
      assert.equal(style.name, source.name)
      assert.equal(style.data.style_bible, source.style_bible)
      assert.equal(style.data.negative_prompt, source.negative_prompt)
      // Every preview the pack ships reaches the gallery, hero first (owner, 2026-10-24).
      assert.equal(style.preview_images.length, source.preview_assets.length, `${slug} publishes every preview`)
      assert.equal(style.preview_images[0], style.preview_image, `${slug}: the hero stays the card image`)
      assert.equal(new Set(style.preview_images).size, style.preview_images.length, `${slug}: previews are distinct`)
    }
  })

  test('a project set to a signed look generates with that look, negatives included', async () => {
    const source = await sourceStyle('anime-cel')
    const project = await pm.createProject({ name: 'Signed Anime Cel' })
    await pm.updateConfig(project.slug, { active_style_preset_id: source.id } as never)

    const art = (await resolver.resolveProjectArtStyle(project.slug, options)).style
    assert.ok(art, 'a signed style selection must resolve')
    assert.equal(art!.presetId, source.id)
    assert.equal(art!.name, source.name)
    // This string is what image-prompts.ts uses as the style tag.
    assert.equal(art!.description, source.style_bible.trim())
    assert.deepEqual(
      art!.negatives,
      source.negative_prompt.split(',').map((value: string) => value.trim()).filter(Boolean),
      'the signed route must carry the negative prompt into generation',
    )
    assert.ok(art!.negatives.includes('photorealism'))
  })

  test('the legacy builtin route keeps the look but throws the negatives away', async () => {
    // This is the state a project is in today, before these packs exist: the
    // The retired Settings picker copied the style_bible into a project-local
    // preset and copies nothing else. It is why productising these six is a
    // fix and not just a repackaging.
    const source = await sourceStyle('anime-cel')
    const project = await pm.createProject({ name: 'Legacy Anime Cel' })
    await pm.updateConfig(project.slug, {
      style_presets: [{
        id: 'builtin-anime-cel',
        name: source.name,
        description: source.style_bible,
        created_at: '2026-08-01T00:00:00Z',
      }],
      active_style_preset_id: 'builtin-anime-cel',
    } as never)

    const art = (await resolver.resolveProjectArtStyle(project.slug, options)).style
    assert.ok(art, 'the materialised preset still resolves — old projects do not break')
    assert.equal(art!.description, source.style_bible.trim())
    assert.deepEqual(art!.negatives, [], 'the legacy copy carries no negatives')
  })

  test('a style saved with no copy behind it falls back to the format default AND says so', async () => {
    // No `style_presets` entry, so nothing resolves. Generation still does not
    // fail; image-prompts.ts substitutes the format default. What changed on
    // 2026-10-28: the resolver now reports that substitution instead of
    // returning a bare null the caller could not tell from "no style chosen".
    const project = await pm.createProject({ name: 'Dangling Anime Cel' })
    await pm.updateConfig(project.slug, { active_style_preset_id: 'builtin-anime-cel' } as never)
    const resolution = await resolver.resolveProjectArtStyle(project.slug, options)
    assert.equal(resolution.style, null)
    assert.ok(resolution.fallback, 'a named style that could not be used is announced')
    assert.equal(resolution.fallback!.requestedId, 'builtin-anime-cel')
    assert.equal(resolution.fallback!.used, 'format_default')
    assert.equal(resolution.fallback!.reason, 'style_not_found')
    assert.match(resolution.fallback!.message, /builtin-anime-cel/)
    assert.match(resolution.fallback!.message, /format default style/i)
  })

  test('the preview a customer is shown comes from the signed Content Pack source', async () => {
    for (const slug of SLUGS) {
      const published = (await styleLoader.listVisualStyles(options))
        .find(style => style.id === `com.storystudio.style.${slug}`)!
      const response = await request(app).get(published.preview_image).expect(200)
      assert.equal(response.headers['content-type'], 'image/webp')
      assert.equal(
        sha256(response.body),
        sha256(await fs.readFile(path.join(LOOKS, SOURCE_DIRS[slug], 'assets', `${slug}.webp`))),
        `${slug} serves bytes that differ from its signed source asset`,
      )
    }
  })
})
