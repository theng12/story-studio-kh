import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ContentStoreProduct } from '../composables/useContentStore.js'
import {
  filterCatalogProducts,
  orderShelfProducts,
  validateCatalogPresentationFixture,
  type CatalogPresentationFixture,
} from '../content-store/catalog-presentation.js'

function product(
  productId: string,
  overrides: Partial<ContentStoreProduct> = {},
): ContentStoreProduct {
  return {
    productId,
    entitlementFamily: `family-${productId}`,
    kind: 'niche_bundle',
    title: productId,
    summary: '',
    description: '',
    publisherId: 'publisher-story-studio',
    creditPrice: 0,
    free: true,
    owned: false,
    retired: false,
    successorProductId: null,
    currentRelease: null,
    compatible: true,
    compatibilityReason: null,
    bundleComponents: [],
    ownedComponentCreditValue: 0,
    showcaseVideos: [],
    ...overrides,
  }
}

const products: ContentStoreProduct[] = [
  product('kit-a', {
    title: 'Documentary Starter',
    summary: 'A documentary channel kit',
  }),
  product('kit-b', {
    title: 'History Starter',
    free: false,
    creditPrice: 120,
  }),
  product('kit-c', {
    title: 'Incompatible Kit',
    compatible: false,
    compatibilityReason: 'Requires a newer Story Studio release',
  }),
]

describe('Content Store catalog presentation boundary', () => {
  test('uses explicit server order and never appends unplaced products', () => {
    const ordered = orderShelfProducts(products, {
      id: 'starter', title: 'Free Starter Kits', productIds: ['kit-b', 'kit-a'],
    })
    assert.deepEqual(ordered.map(product => product.productId), ['kit-b', 'kit-a'])
  })

  test('searches only published customer text and tags', () => {
    const result = filterCatalogProducts(products, 'documentary', {
      price: 'all', kind: 'all', compatibleOnly: false,
    })
    assert.deepEqual(result.map(product => product.productId), ['kit-a'])
  })

  test('does not search opaque product identifiers', () => {
    const result = filterCatalogProducts(products, 'kit-b', {
      price: 'all', kind: 'all', compatibleOnly: false,
    })
    assert.deepEqual(result, [])
  })

  test('applies price, kind, and compatibility filters together', () => {
    const result = filterCatalogProducts([
      product('free-formula', { kind: 'series_formula', title: 'Formula', free: true }),
      product('paid-formula', { kind: 'series_formula', title: 'Paid Formula', free: false }),
      product('paid-kit', { kind: 'niche_bundle', title: 'Paid Kit', free: false, compatible: false }),
    ], '', { price: 'paid', kind: 'series_formula', compatibleOnly: true })
    assert.deepEqual(result.map(product => product.productId), ['paid-formula'])
  })

  test('rejects duplicate product references in one shelf', () => {
    assert.throws(
      () => orderShelfProducts(products, {
        id: 'starter', title: 'Starter', productIds: ['kit-a', 'kit-a'],
      }),
      /duplicate product id/i,
    )
  })

  test('rejects unknown product references instead of inventing a shelf', () => {
    assert.throws(
      () => orderShelfProducts(products, {
        id: 'starter', title: 'Starter', productIds: ['missing'],
      }),
      /unknown product/i,
    )
  })

  const validFixture: CatalogPresentationFixture = {
    shelves: [{ id: 'starter', title: 'Starter', productIds: ['kit-a'] }],
    products: {
      'kit-a': {
        productId: 'kit-a',
        cover: { src: 'https://cdn.example.test/kit-a.webp', alt: 'Documentary starter kit' },
        licenseLabel: null,
        tags: ['documentary'],
      },
    },
  }

  test('accepts a valid local presentation fixture unchanged', () => {
    assert.equal(validateCatalogPresentationFixture(validFixture), validFixture)
  })

  test('searches tags from an explicit normalized product presentation map', () => {
    const result = filterCatalogProducts(
      [product('kit-tags', { title: 'Starter' })],
      'documentary',
      { price: 'all', kind: 'all', compatibleOnly: false },
      {
        'kit-tags': {
          productId: 'kit-tags', cover: null, licenseLabel: null, tags: ['documentary'],
        },
      },
    )
    assert.deepEqual(result.map(product => product.productId), ['kit-tags'])
  })

  test('does not search a hidden product presentation property', () => {
    const productWithHiddenPresentation = Object.assign(product('kit-tags', { title: 'Starter' }), {
      presentation: { tags: ['documentary'] },
    })
    const result = filterCatalogProducts([productWithHiddenPresentation], 'documentary', {
      price: 'all', kind: 'all', compatibleOnly: false,
    })
    assert.deepEqual(result, [])
  })

  test('allows one published product on multiple shelves', () => {
    assert.doesNotThrow(() => validateCatalogPresentationFixture({
      ...validFixture,
      shelves: [
        { id: 'starter', title: 'Starter', productIds: ['kit-a'] },
        { id: 'featured', title: 'Featured', productIds: ['kit-a'] },
      ],
    }))
  })

  test('rejects duplicate shelf ids', () => {
    assert.throws(
      () => validateCatalogPresentationFixture({
        ...validFixture,
        shelves: [
          ...validFixture.shelves,
          { id: 'starter', title: 'Another Starter', productIds: [] },
        ],
      }),
      /duplicate shelf id/i,
    )
  })

  test('rejects unknown fixture product references', () => {
    assert.throws(
      () => validateCatalogPresentationFixture({
        ...validFixture,
        shelves: [{ id: 'starter', title: 'Starter', productIds: ['missing'] }],
      }),
      /unknown product/i,
    )
  })

  test('rejects non-HTTPS covers and blank cover alt text', () => {
    assert.throws(
      () => validateCatalogPresentationFixture({
        ...validFixture,
        products: {
          'kit-a': { ...validFixture.products['kit-a']!, cover: { src: 'http://cdn.example.test/kit-a.webp', alt: 'Kit' } },
        },
      }),
      /cover src must use HTTPS/i,
    )
    assert.throws(
      () => validateCatalogPresentationFixture({
        ...validFixture,
        products: {
          'kit-a': { ...validFixture.products['kit-a']!, cover: { src: 'https://cdn.example.test/kit-a.webp', alt: '   ' } },
        },
      }),
      /cover alt/i,
    )
  })

  test('rejects blank license labels and tag entries', () => {
    assert.throws(
      () => validateCatalogPresentationFixture({
        ...validFixture,
        products: {
          'kit-a': { ...validFixture.products['kit-a']!, licenseLabel: '   ' },
        },
      }),
      /licenseLabel/i,
    )
    assert.throws(
      () => validateCatalogPresentationFixture({
        ...validFixture,
        products: {
          'kit-a': { ...validFixture.products['kit-a']!, tags: [''] },
        },
      }),
      /tags/i,
    )
  })

  test('rejects more than 100 shelves', () => {
    assert.throws(
      () => validateCatalogPresentationFixture({
        ...validFixture,
        shelves: Array.from({ length: 101 }, (_, index) => ({
          id: `shelf-${index}`,
          title: `Shelf ${index}`,
          productIds: [],
        })),
      }),
      /100 shelves/i,
    )
  })
})
