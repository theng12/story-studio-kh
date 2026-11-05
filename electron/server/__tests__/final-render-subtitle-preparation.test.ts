import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'

import { prepareFinalRenderSubtitleAssets } from '../lib/final-render-subtitle-assets.js'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const previousResources = process.env.STORY_STUDIO_RESOURCES_DIR
after(async () => {
  if (previousResources === undefined) delete process.env.STORY_STUDIO_RESOURCES_DIR
  else process.env.STORY_STUDIO_RESOURCES_DIR = previousResources
  await temp.cleanup()
})

for (const [name, reason] of [
  ['missing-manifest', 'subtitles_font_unresolved'],
  ['corrupt-manifest', 'subtitles_font_integrity'],
  ['missing-font', 'subtitles_font_unresolved'],
  ['corrupt-font', 'subtitles_font_integrity'],
] as const) {
  test(`${name} returns a local reason instead of rejecting subtitle preparation`, async () => {
    const dir = path.join(temp.dir, name)
    const fonts = path.join(dir, 'fonts')
    await fs.mkdir(path.join(fonts, 'fixture'), { recursive: true })
    process.env.STORY_STUDIO_RESOURCES_DIR = dir
    const manifest = path.join(fonts, 'fonts.json')
    if (name === 'corrupt-manifest') await fs.writeFile(manifest, '{broken')
    if (name === 'missing-font' || name === 'corrupt-font') {
      await fs.writeFile(manifest, JSON.stringify({ fonts: [{
        id: 'fixture', family: 'Inter', file: 'fixture.ttf', sha256: '0'.repeat(64),
      }] }))
    }
    if (name === 'corrupt-font') {
      await fs.writeFile(path.join(fonts, 'fixture', 'fixture.ttf'), Buffer.alloc(4))
    }
    const srt = path.join(dir, 'source.srt')
    await fs.writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nHello\n')
    const result = await prepareFinalRenderSubtitleAssets({
      srt_path: srt,
      style: { font_family: 'Inter' },
      frame_w: 128,
      frame_h: 96,
      target_duration_sec: 2,
      dir,
    })
    assert.equal(result.ok, false)
    if (result.ok) assert.fail('broken font resources must stay local')
    assert.equal(result.reason, reason)
    assert.ok(result.detail.length > 0, 'local reason must explain the asset failure')
    await assert.rejects(fs.stat(path.join(dir, 'subtitles-burn.ass')), { code: 'ENOENT' })
  })
}
