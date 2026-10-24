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

  test('carries every preview, hero first, and never drops a style for lacking a gallery', async () => {
    const hero = signedStyle.preview_image
    const scene = `/api/content-packs/com.storystudio.pack.archive/1.0.0/assets/${'b'.repeat(64)}`
    const gallery = { ...signedStyle, id: 'gallery', preview_images: [hero, scene, 'javascript:alert(1)'] }
    const legacy = { ...signedStyle, id: 'legacy' } // an older main process: no preview_images at all
    ;(globalThis as any).$fetch = async () => ({ visual_styles: [gallery, legacy] })
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()
    const byId = Object.fromEntries(catalog.styles.value.map(style => [style.id, style]))
    assert.deepEqual(byId.gallery!.preview_images, [hero, scene], 'unsafe URLs are dropped, order kept')
    assert.deepEqual(byId.legacy!.preview_images, [hero], 'a style without a gallery still shows its hero')
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

  test('shows a user style pack style, which has no preview image', async () => {
    const userStyle = { ...signedStyle, id: 'kh.art-styles.dreamlands', preview_image: '' }
    ;(globalThis as any).$fetch = async () => ({ visual_styles: [signedStyle, userStyle] })
    const catalog = useVisualStyleCatalog()
    await catalog.refresh()

    assert.deepEqual(catalog.styles.value.map(style => style.id), [signedStyle.id, userStyle.id])
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
