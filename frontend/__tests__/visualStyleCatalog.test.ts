import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  _resetVisualStyleCatalogForTests,
  useVisualStyleCatalog,
} from '../composables/useVisualStyleCatalog.js'

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
  test('shows only server-published installed Content Pack styles', async () => {
    ;(globalThis as any).$fetch = async () => ({ visual_styles: [signedStyle] })
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.deepEqual(catalog.styles.value.map(style => style.id), [signedStyle.id])
  })

  test('accepts author-defined Content Pack categories', async () => {
    const naturalWorldStyle = { ...signedStyle, category: 'Natural world' }
    ;(globalThis as any).$fetch = async () => ({ visual_styles: [naturalWorldStyle] })
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.deepEqual(catalog.styles.value.map(style => style.category), ['Natural world'])
  })

  test('shows no unowned legacy styles when the API is unavailable', async () => {
    ;(globalThis as any).$fetch = async () => { throw new Error('offline') }
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.deepEqual(catalog.styles.value, [])
    assert.match(catalog.error.value || '', /offline/i)
  })

  test('rejects filesystem-backed previews instead of exposing pack disk paths to the renderer', async () => {
    ;(globalThis as any).$fetch = async () => ({
      visual_styles: [{ ...signedStyle, preview_image: '/Users/customer/Library/content-packs/style.png' }],
    })
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.deepEqual(catalog.styles.value, [])
  })
})
