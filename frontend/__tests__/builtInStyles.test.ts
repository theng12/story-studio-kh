import { existsSync, statSync } from 'node:fs'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { BUILT_IN_STYLES } from '../composables/useBuiltInStyles'

describe('built-in style gallery', () => {
  it('ships a unique generated raster preview for every style', () => {
    assert.equal(BUILT_IN_STYLES.length, 12)
    assert.equal(new Set(BUILT_IN_STYLES.map(style => style.id)).size, BUILT_IN_STYLES.length)

    for (const style of BUILT_IN_STYLES) {
      assert.match(style.preview_image, /^\/builtin-style-previews\/.+\.webp$/, `${style.name} preview`)

      const previewPath = resolve(process.cwd(), 'public', style.preview_image.replace(/^\//, ''))
      assert.equal(existsSync(previewPath), true, `${style.name} preview exists`)
      assert.ok(statSync(previewPath).size > 20_000, `${style.name} preview is not an empty placeholder`)
    }
  })
})
