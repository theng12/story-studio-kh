import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  BUILT_IN_STYLES,
  _resetVisualStyleCatalogForTests,
  useVisualStyleCatalog,
} from '../composables/useBuiltInStyles.js'

afterEach(() => {
  _resetVisualStyleCatalogForTests()
  delete (globalThis as any).$fetch
})

const signedStyle = {
  id: 'com.storystudio.pack.archive.style', name: 'Signed Archive', builtin: true,
  blurb: 'A signed catalog style.', category: 'Realistic', tags: ['signed', 'archive'],
  data: { style_bible: 'Signed archive look.', negative_prompt: 'No modern objects.' },
  preview_image: `/api/content-packs/com.storystudio.pack.archive/1.0.0/assets/${'a'.repeat(64)}`,
}

describe('reactive visual style catalog', () => {
  test('publishes API styles first and retains the complete legacy recovery catalog', async () => {
    ;(globalThis as any).$fetch = async () => ({ visual_styles: [signedStyle] })
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.equal(catalog.styles.value[0].id, signedStyle.id)
    assert.equal(catalog.styles.value.length, BUILT_IN_STYLES.length + 1)
    assert.equal(catalog.usingFallback.value, false)
    assert.ok(catalog.styles.value.some(style => style.id === 'builtin-ms-paint-fantasy'))
  })

  test('falls back to all 17 static styles when the API is unavailable', async () => {
    ;(globalThis as any).$fetch = async () => { throw new Error('offline') }
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.equal(catalog.styles.value.length, 17)
    assert.deepEqual(catalog.styles.value.map(style => style.id), BUILT_IN_STYLES.map(style => style.id))
    assert.equal(catalog.usingFallback.value, true)
    assert.match(catalog.error.value || '', /offline/i)
  })

  test('rejects filesystem-backed previews instead of exposing pack disk paths to the renderer', async () => {
    ;(globalThis as any).$fetch = async () => ({
      visual_styles: [{ ...signedStyle, preview_image: '/Users/customer/Library/content-packs/style.png' }],
    })
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.equal(catalog.styles.value.some(style => style.id === signedStyle.id), false)
    assert.equal(catalog.styles.value.length, 17)
    assert.equal(catalog.usingFallback.value, true)
  })
})
