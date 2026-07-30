import { existsSync, statSync } from 'node:fs'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { BUILT_IN_STYLES } from '../composables/useBuiltInStyles'

describe('built-in style gallery', () => {
  it('ships a unique generated raster preview for every style', () => {
    assert.equal(BUILT_IN_STYLES.length, 16)
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

  it('ships waxy-outline cartoon separately from the muted mascot explainer', () => {
    const style = BUILT_IN_STYLES.find(item => item.id === 'builtin-waxy-outline-cartoon')
    assert.ok(style)
    assert.equal(style.category, 'Explainer')
    assert.match(style.data.style_bible, /waxy-outline 2D cartoon/i)
    assert.match(style.data.style_bible, /wobbly hand-drawn imperfections/i)
    assert.match(style.data.negative_prompt, /copied mascot characters/i)
    assert.equal(style.preview_image, '/builtin-style-previews/waxy-outline-cartoon.webp')
  })

  it('ships the editorial diagram look separately from mascot cartoons and sepia wash', () => {
    const style = BUILT_IN_STYLES.find(item => item.id === 'builtin-hand-drawn-editorial-diagram')
    assert.ok(style)
    assert.equal(style.category, 'Explainer')
    assert.match(style.data.style_bible, /fine dark ink outlines/)
    assert.match(style.data.style_bible, /balanced perimeter of supporting objects/)
    assert.match(style.data.negative_prompt, /mascot cartoon characters/)
    assert.match(style.data.negative_prompt, /dark moody sepia wash/)
    assert.equal(style.preview_image, '/builtin-style-previews/hand-drawn-editorial-diagram.webp')
  })

  it('ships the calm deep-time tableau separately from glossy cinematic realism', () => {
    const style = BUILT_IN_STYLES.find(item => item.id === 'builtin-paleo-documentary-tableau')
    assert.ok(style)
    assert.equal(style.category, 'Illustration')
    assert.match(style.data.style_bible, /natural-history documentary tableau/i)
    assert.match(style.data.style_bible, /softly hand-painted editorial finish/i)
    assert.match(style.data.negative_prompt, /glossy CGI plastic/i)
    assert.equal(style.preview_image, '/builtin-style-previews/paleo-documentary-tableau.webp')
  })
})
