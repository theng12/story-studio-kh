import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { updateProjectContentConfigSelections } from '../content-packs/project-pins.js'
import { router as nichesRouter } from '../routes/niches.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

const style = (slug: string, extra: Record<string, unknown> = {}) => ({
  kind: 'visual-style',
  schema_version: 1,
  id: `kh.art-styles.${slug}`,
  name: `Style ${slug}`,
  description: `The ${slug} look.`,
  category: 'Painterly',
  tags: ['painterly'],
  style_bible: `Soft ${slug} brushwork, no text.`,
  compatible_formula_ids: [],
  ...extra,
})

const pack = (styles: unknown[], extra: Record<string, unknown> = {}) => ({
  user_pack_format: 1,
  pack_id: 'kh.art-styles',
  name: 'KH Art Styles',
  version: '1.0.0',
  styles,
  ...extra,
})

async function appWithTempData() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.locals.contentPackOptions = {}
  app.use('/api', nichesRouter)
  return app
}

describe('user style packs', () => {
  test('an imported pack is managed by its own route and is no longer listed in the Style Library', async () => {
    const app = await appWithTempData()
    const installed = await request(app).post('/api/user-style-packs')
      .send(pack([style('dreamlands'), style('woodcut', { negative_prompt: 'photo, 3D render' })])).expect(200)
    assert.deepEqual(installed.body, { ok: true, pack_id: 'kh.art-styles', version: '1.0.0', styles: 2 })

    // Owner ruling 2026-10-29 — "no custom, no built in, all from packs": the
    // Style Library lists installed Content Packs only. The pack itself is still
    // installed, readable and managed here; it is simply not offered as a look.
    const listed = await request(app).get('/api/user-style-packs').expect(200)
    assert.deepEqual(listed.body.user_style_packs.map((p: any) => p.pack_id), ['kh.art-styles'])

    const library = await request(app).get('/api/visual-styles').expect(200)
    assert.deepEqual(library.body.visual_styles, [],
      'a user style pack style must not appear in the Library beside the packs')
    assert.equal(
      (await request(app).get('/api/user-style-packs').expect(200)).body.user_style_packs[0].styles[1].negative_prompt,
      'photo, 3D render',
      'the stored text still reads back exactly as written',
    )

    // Re-importing the same pack id replaces it rather than adding a second copy.
    await request(app).post('/api/user-style-packs').send(pack([style('dreamlands')], { version: '1.0.1' })).expect(200)
    const replaced = await request(app).get('/api/user-style-packs').expect(200)
    assert.deepEqual(replaced.body.user_style_packs.map((p: any) => [p.pack_id, p.version]), [['kh.art-styles', '1.0.1']])
  })

  test('a bad pack is refused with the reason and writes nothing', async () => {
    const app = await appWithTempData()
    const cases: Array<[unknown, RegExp]> = [
      [pack([style('a')], { pack_id: 'com.storystudio.pack.mine' }), /com\.storystudio namespace/],
      [pack([{ ...style('a'), id: 'other.pack.a' }]), /must start with kh\.art-styles\./],
      [pack([style('a'), style('a')]), /duplicate style id/],
      [pack([{ ...style('a'), preview_assets: ['assets/a.png'] }]), /Unrecognized key/],
      [pack([style('a', { style_bible: 'See www.example.com for the look.' })]), /URI references/],
      [pack([]), /styles/],
    ]
    for (const [body, reason] of cases) {
      const response = await request(app).post('/api/user-style-packs').send(body as object).expect(400)
      assert.match(response.body.detail, reason)
    }
    const dir = path.join(getContentPackRuntimePaths().root, 'user-style-packs')
    await assert.rejects(fs.readdir(dir), { code: 'ENOENT' })
  })

  test('a damaged pack file is skipped and never takes the library down', async () => {
    const app = await appWithTempData()
    await request(app).post('/api/user-style-packs').send(pack([style('dreamlands')])).expect(200)
    const dir = path.join(getContentPackRuntimePaths().root, 'user-style-packs')
    await fs.writeFile(path.join(dir, 'broken.pack.json'), '{ not json')
    const library = await request(app).get('/api/visual-styles').expect(200)
    assert.deepEqual(library.body.visual_styles, [],
      'the unreadable file neither throws nor surfaces a style it cannot describe')
    // The readable pack is still there to manage.
    assert.deepEqual((await request(app).get('/api/user-style-packs').expect(200)).body.user_style_packs
      .map((p: any) => p.pack_id), ['kh.art-styles'])
  })

  test('picking a user style copies its text into the project, which then renders with it', async () => {
    await appWithTempData()
    const projectManager = await import('../services/project-manager.js')
    const project = await projectManager.createProject({ name: 'User Style Pick' })
    // Exactly what Settings sends for a style whose id is not com.storystudio.
    await updateProjectContentConfigSelections(project.slug, {
      active_style_preset_id: 'kh.art-styles.dreamlands',
      style_presets: [{ id: 'kh.art-styles.dreamlands', name: 'Dreamlands', description: 'Soft dreamlands brushwork, no text.', created_at: new Date().toISOString() }],
    } as any, {})
    const { style: resolved, fallback } = await resolveProjectArtStyle(project.slug)
    assert.equal(resolved?.presetId, 'kh.art-styles.dreamlands')
    assert.equal(resolved?.description, 'Soft dreamlands brushwork, no text.')
    // The Store owns this look now, but its pack is not installed here, so the
    // channel's own saved prose runs — and the resolution says so.
    assert.equal(fallback?.reason, 'store_style_not_installed')
    assert.equal(fallback?.storeStyleId, 'com.storystudio.style.dreamlike-luminous-sleep-illustration')
    assert.equal(fallback?.used, 'saved_preset')
    assert.deepEqual((await projectManager.getProject(project.slug))?.content_pack_items ?? {}, {})
  })
})
