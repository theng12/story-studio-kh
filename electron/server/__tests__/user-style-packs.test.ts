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
  test('an imported pack is listed and its styles join the Style Library with no preview', async () => {
    const app = await appWithTempData()
    const installed = await request(app).post('/api/user-style-packs')
      .send(pack([style('dreamlands'), style('woodcut', { negative_prompt: 'photo, 3D render' })])).expect(200)
    assert.deepEqual(installed.body, { ok: true, pack_id: 'kh.art-styles', version: '1.0.0', styles: 2 })

    const listed = await request(app).get('/api/user-style-packs').expect(200)
    assert.deepEqual(listed.body.user_style_packs.map((p: any) => p.pack_id), ['kh.art-styles'])

    const library = await request(app).get('/api/visual-styles').expect(200)
    const dreamlands = library.body.visual_styles.find((s: any) => s.id === 'kh.art-styles.dreamlands')
    assert.deepEqual(dreamlands, {
      id: 'kh.art-styles.dreamlands', name: 'Style dreamlands', builtin: true, blurb: 'The dreamlands look.',
      category: 'Painterly', tags: ['painterly'],
      data: { style_bible: 'Soft dreamlands brushwork, no text.', negative_prompt: '' },
      preview_image: '',
    })
    assert.equal(library.body.visual_styles.find((s: any) => s.id === 'kh.art-styles.woodcut').data.negative_prompt, 'photo, 3D render')

    // Re-importing the same pack id replaces it rather than adding a second copy.
    await request(app).post('/api/user-style-packs').send(pack([style('dreamlands')], { version: '1.0.1' })).expect(200)
    const replaced = await request(app).get('/api/visual-styles').expect(200)
    assert.deepEqual(replaced.body.visual_styles.map((s: any) => s.id), ['kh.art-styles.dreamlands'])
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

  test('a damaged pack file is skipped and never hides the signed library', async () => {
    const app = await appWithTempData()
    await request(app).post('/api/user-style-packs').send(pack([style('dreamlands')])).expect(200)
    const dir = path.join(getContentPackRuntimePaths().root, 'user-style-packs')
    await fs.writeFile(path.join(dir, 'broken.pack.json'), '{ not json')
    const library = await request(app).get('/api/visual-styles').expect(200)
    assert.deepEqual(library.body.visual_styles.map((s: any) => s.id), ['kh.art-styles.dreamlands'])
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
    const resolved = await resolveProjectArtStyle(project.slug)
    assert.equal(resolved?.presetId, 'kh.art-styles.dreamlands')
    assert.equal(resolved?.description, 'Soft dreamlands brushwork, no text.')
    assert.deepEqual((await projectManager.getProject(project.slug))?.content_pack_items ?? {}, {})
  })
})
