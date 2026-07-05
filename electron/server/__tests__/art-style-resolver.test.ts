/**
 * Tests for the Art-style resolver (services/art-style-resolver.ts).
 *
 * Coverage:
 *   - active preset wins → source 'preset', description, no ref image yet
 *   - preset preview image resolves to an absolute path when the file exists
 *   - null when the project has no active preset and no brand
 *   - active_style_preset_id pointing at a missing preset → falls through
 *   - brand imagePrompts fallback → source 'brand', folded description+negatives
 *   - active preset wins over a brand when both are present
 *
 * IMPORTANT — module-load ordering: STORY_STUDIO_DATA_DIR must be set (via
 * useTempDataDir) before project-manager / brand-loader import, so
 * PROJECTS_ROOT points at the temp dir. Mirrors brand-loader.test.ts.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let resolver: typeof import('../services/art-style-resolver.js')
let brandLoader: typeof import('../services/brand-loader.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

describe('art-style-resolver', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    resolver = await import('../services/art-style-resolver.js')
    brandLoader = await import('../services/brand-loader.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'),
      'PROJECTS_ROOT must point at temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('active preset wins → source preset, description, empty ref (no preview file)', async () => {
    const proj = await pm.createProject({ name: 'ArtPreset' })
    await pm.updateConfig(proj.slug, {
      style_presets: [{
        id: 'wd',
        name: 'Whiteboard Doodle Explainer',
        description: 'Simple hand-drawn whiteboard-doodle illustration. Thick black marker outlines.',
        created_at: '2026-07-05T00:00:00Z',
      }],
      active_style_preset_id: 'wd',
    } as any)

    const art = await resolver.resolveProjectArtStyle(proj.slug)
    assert.ok(art, 'expected a resolved art style')
    assert.equal(art!.source, 'preset')
    assert.equal(art!.presetId, 'wd')
    assert.equal(art!.name, 'Whiteboard Doodle Explainer')
    assert.match(art!.description, /thick black marker outlines/i)
    assert.deepEqual(art!.negatives, [])
    assert.deepEqual(art!.referenceImagePaths, [], 'no preview file on disk yet')
  })

  test('preset preview image resolves to an absolute path when the file exists', async () => {
    const proj = await pm.createProject({ name: 'ArtPresetRef' })
    const projDir = pm.getProjectDir(proj.slug)!
    const previewsDir = path.join(projDir, 'style-previews')
    await fs.mkdir(previewsDir, { recursive: true })
    await fs.writeFile(path.join(previewsDir, 'wd.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    await pm.updateConfig(proj.slug, {
      style_presets: [{
        id: 'wd',
        name: 'WD',
        description: 'x',
        created_at: '2026-07-05T00:00:00Z',
        preview_filename: 'wd.png',
      }],
      active_style_preset_id: 'wd',
    } as any)

    const art = await resolver.resolveProjectArtStyle(proj.slug)
    assert.ok(art)
    assert.equal(art!.referenceImagePaths.length, 1)
    assert.equal(art!.referenceImagePaths[0], path.join(previewsDir, 'wd.png'))
  })

  test('null when no active preset and no brand', async () => {
    const proj = await pm.createProject({ name: 'ArtNone' })
    assert.equal(await resolver.resolveProjectArtStyle(proj.slug), null)
  })

  test('active_style_preset_id pointing at a missing preset → falls through to null', async () => {
    const proj = await pm.createProject({ name: 'ArtMissing' })
    await pm.updateConfig(proj.slug, { active_style_preset_id: 'does-not-exist' } as any)
    assert.equal(await resolver.resolveProjectArtStyle(proj.slug), null)
  })

  test('brand imagePrompts fallback → source brand, folded description + negatives', async () => {
    brandLoader._clearBrandCaches()
    const brandsDir = path.join(pm.PROJECTS_ROOT, '.brands')
    await fs.mkdir(brandsDir, { recursive: true })
    await fs.writeFile(path.join(brandsDir, 'demo.json'), JSON.stringify({
      id: 'demo',
      name: 'Demo Brand',
      schemaVersion: 1,
      channel: { name: 'Demo Channel' },
      imagePrompts: {
        style_sheet: 'cinematic moody sheet',
        style_keywords: ['cinematic', 'moody'],
        negative_prompts: ['blurry', 'lowres'],
      },
    }))

    const proj = await pm.createProject({ name: 'ArtBrand' })
    const metaPath = path.join(pm.getProjectDir(proj.slug)!, 'project.json')
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    meta.brand_id = 'demo'
    await fs.writeFile(metaPath, JSON.stringify(meta))

    const art = await resolver.resolveProjectArtStyle(proj.slug)
    assert.ok(art, 'expected a brand-derived art style')
    assert.equal(art!.source, 'brand')
    assert.match(art!.description, /cinematic moody sheet/)
    assert.match(art!.description, /cinematic, moody/)
    assert.deepEqual(art!.negatives, ['blurry', 'lowres'])
    assert.deepEqual(art!.referenceImagePaths, [])
  })

  test('active preset wins over a brand when both are present', async () => {
    brandLoader._clearBrandCaches()
    const brandsDir = path.join(pm.PROJECTS_ROOT, '.brands')
    await fs.mkdir(brandsDir, { recursive: true })
    await fs.writeFile(path.join(brandsDir, 'demo2.json'), JSON.stringify({
      id: 'demo2',
      name: 'Demo Brand 2',
      schemaVersion: 1,
      channel: { name: 'Demo Channel 2' },
      imagePrompts: { style_sheet: 'brand should lose' },
    }))

    const proj = await pm.createProject({ name: 'ArtBoth' })
    const metaPath = path.join(pm.getProjectDir(proj.slug)!, 'project.json')
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    meta.brand_id = 'demo2'
    await fs.writeFile(metaPath, JSON.stringify(meta))
    await pm.updateConfig(proj.slug, {
      style_presets: [{ id: 'p1', name: 'P1', description: 'preset desc wins', created_at: 'x' }],
      active_style_preset_id: 'p1',
    } as any)

    const art = await resolver.resolveProjectArtStyle(proj.slug)
    assert.ok(art)
    assert.equal(art!.source, 'preset')
    assert.match(art!.description, /preset desc wins/)
  })
})
