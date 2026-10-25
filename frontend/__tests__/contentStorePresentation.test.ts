import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ContentStoreProduct } from '../composables/useContentStore.js'
import {
  filterCatalogProducts,
  installedPackCount,
  orderShelfProducts,
  validateCatalogPresentationFixture,
  type CatalogPresentationFixture,
} from '../content-store/catalog-presentation.js'
import type { ContentStoreInstalledPack } from '../composables/useContentStore.js'

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
    presentation: { cover: null, hero: null, licenseLabel: null, licenseText: null, tags: [] },
    discount: null,
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

describe('Studio Library catalog presentation boundary', () => {
  test('uses explicit server order and never appends unplaced products', () => {
    const ordered = orderShelfProducts(products, {
      id: 'starter', title: 'Free Starter Kits', productIds: ['kit-b', 'kit-a'],
    })
    assert.deepEqual(ordered.map(product => product.productId), ['kit-b', 'kit-a'])
  })

  test('searches only published customer text and tags', () => {
    const result = filterCatalogProducts(products, 'documentary', {
      kind: 'all', compatibleOnly: false,
    })
    assert.deepEqual(result.map(product => product.productId), ['kit-a'])
  })

  test('does not search opaque product identifiers', () => {
    const result = filterCatalogProducts(products, 'kit-b', {
      kind: 'all', compatibleOnly: false,
    })
    assert.deepEqual(result, [])
  })

  test('applies kind and compatibility filters together', () => {
    const result = filterCatalogProducts([
      product('free-formula', { kind: 'series_formula', title: 'Formula', free: true }),
      product('paid-formula', { kind: 'series_formula', title: 'Paid Formula', free: false }),
      product('paid-kit', { kind: 'niche_bundle', title: 'Paid Kit', free: false, compatible: false }),
    ], '', { kind: 'series_formula', compatibleOnly: true })
    assert.deepEqual(result.map(product => product.productId), ['free-formula', 'paid-formula'])
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
      { kind: 'all', compatibleOnly: false },
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
      kind: 'all', compatibleOnly: false,
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

describe('the Installed tab count', () => {
  function installedVersion(
    packId: string,
    version: string,
    active: boolean,
  ): ContentStoreInstalledPack {
    return {
      packId, version, active, installState: 'installed_current', missingDependencies: [],
      productId: `cprod-${packId}`, title: packId, kind: 'visual_style', ownedByActiveAccount: true,
    }
  }

  /**
   * Retaining a superseded version is deliberate, so counting version records
   * made Installed climb past Owned -- "Installed 85 - Owned 82", which cannot
   * be true and which nobody can act on. Every tab beside it counts packs.
   */
  test('counts packs, not the retained versions of them', () => {
    const installed = [
      installedVersion('com.a', '1.0.0', false),
      installedVersion('com.a', '1.0.1', false),
      installedVersion('com.a', '1.0.2', true),
      installedVersion('com.b', '1.0.0', true),
      installedVersion('com.c', '2.0.0', true),
    ]
    assert.equal(installed.length, 5, 'the retained history is still five records')
    assert.equal(installedPackCount(installed), 3)
  })

  test('is zero when nothing is installed, and ignores a pack with no active version', () => {
    assert.equal(installedPackCount([]), 0)
    // Mid-install or mid-removal a pack can have retained bytes and no active
    // version. It is not installed, and the tab must not say it is.
    assert.equal(installedPackCount([installedVersion('com.a', '1.0.0', false)]), 0)
  })
})
