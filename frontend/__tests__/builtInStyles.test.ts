import { existsSync, statSync } from 'node:fs'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { BUILT_IN_STYLES } from '../composables/useBuiltInStyles'

describe('built-in style gallery', () => {
  it('ships a unique generated raster preview for every style', () => {
    assert.equal(BUILT_IN_STYLES.length, 13)
    assert.equal(new Set(BUILT_IN_STYLES.map(style => style.id)).size, BUILT_IN_STYLES.length)

    for (const style of BUILT_IN_STYLES) {
      assert.ok(['Digital', 'Explainer', 'Illustration', 'Realistic'].includes(style.category), `${style.name} category`)
      assert.ok(style.tags.length >= 3, `${style.name} has searchable tags`)
      assert.equal(new Set(style.tags).size, style.tags.length, `${style.name} tags are unique`)
      assert.match(style.preview_image, /^\/builtin-style-previews\/.+\.webp$/, `${style.name} preview`)

      const previewPath = resolve(process.cwd(), 'public', style.preview_image.replace(/^\//, ''))
      assert.equal(existsSync(previewPath), true, `${style.name} preview exists`)
      assert.ok(statSync(previewPath).size > 20_000, `${style.name} preview is not an empty placeholder`)
    }
  })

  it('keeps the hand-drawn cartoon explainer distinct from polished stick figures', () => {
    const style = BUILT_IN_STYLES.find(item => item.id === 'builtin-hand-drawn-cartoon-explainer')
    assert.ok(style)
    assert.equal(style.category, 'Explainer')
    assert.match(style.data.style_bible, /slightly uneven thick black outlines/)
    assert.match(style.data.style_bible, /rounded plain colored torsos/)
    assert.match(style.data.negative_prompt, /glossy polished vector art/)
    assert.equal(style.preview_image, '/builtin-style-previews/hand-drawn-cartoon-explainer.webp')
  })
})
