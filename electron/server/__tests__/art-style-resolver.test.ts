/**
 * Tests for the Art-style resolver (services/art-style-resolver.ts).
 *
 * Coverage:
 *   - active preset wins → source 'preset', description, no ref image yet
 *   - preset preview image resolves to an absolute path when the file exists
 *   - null when the project has no active preset
 *   - active_style_preset_id pointing at a missing preset → falls through
 *
 * IMPORTANT — module-load ordering: STORY_STUDIO_DATA_DIR must be set (via
 * useTempDataDir) before project-manager import, so PROJECTS_ROOT points at
 * the temp dir.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let resolver: typeof import('../services/art-style-resolver.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

describe('art-style-resolver', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    resolver = await import('../services/art-style-resolver.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at temp dir — env was set too late')
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

  test('null when no active preset', async () => {
    const proj = await pm.createProject({ name: 'ArtNone' })
    assert.equal(await resolver.resolveProjectArtStyle(proj.slug), null)
  })

  test('active_style_preset_id pointing at a missing preset → falls through to null', async () => {
    const proj = await pm.createProject({ name: 'ArtMissing' })
    await pm.updateConfig(proj.slug, { active_style_preset_id: 'does-not-exist' } as any)
    assert.equal(await resolver.resolveProjectArtStyle(proj.slug), null)
  })

})
