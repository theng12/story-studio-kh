import type {
  ContentStoreProduct,
  ContentStoreProductKind,
} from '../composables/useContentStore'

export type ContentStoreKindFilter = 'all' | ContentStoreProductKind

const productKindLabels: Record<ContentStoreProductKind, string> = {
  series_formula: 'Series Formula',
  topic_pack: 'Topic Pack',
  visual_style: 'Visual Style',
  thumbnail_recipe: 'Thumbnail Recipe',
  font_pack: 'Font Pack',
  niche_bundle: 'Channel Kit',
}

export function contentStoreKindLabel(kind: ContentStoreProductKind): string {
  return productKindLabels[kind]
}

export interface CatalogShelfPresentation {
  id: string
  title: string
  productIds: readonly string[]
}

export interface CatalogProductPresentation {
  productId: string
  cover: { src: string; alt: string } | null
  licenseLabel: string | null
  tags: readonly string[]
}

export interface CatalogPresentationFixture {
  shelves: readonly CatalogShelfPresentation[]
  products: Readonly<Record<string, CatalogProductPresentation>>
}

const MAX_SHELVES = 100

function invalidFixture(detail: string): never {
  throw new TypeError(`Invalid catalog presentation fixture: ${detail}`)
}

function requireNonBlank(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalidFixture(`${label} must not be blank`)
}

function validateCover(cover: CatalogProductPresentation['cover'], productId: string): void {
  if (cover === null) return
  if (!cover || typeof cover !== 'object') invalidFixture(`product ${productId} cover must be null or an object`)
  if (typeof cover.src !== 'string') invalidFixture(`product ${productId} cover src must be a string`)
  let parsed: URL
  try {
    parsed = new URL(cover.src)
  } catch {
    invalidFixture(`product ${productId} cover src must be a valid HTTPS URL`)
  }
  if (parsed!.protocol !== 'https:') invalidFixture(`product ${productId} cover src must use HTTPS`)
  requireNonBlank(cover.alt, `product ${productId} cover alt`)
}

function validateShelfProducts(
  products: Readonly<Record<string, CatalogProductPresentation>>,
  shelf: CatalogShelfPresentation,
): void {
  requireNonBlank(shelf.id, 'shelf id')
  requireNonBlank(shelf.title, `shelf ${shelf.id} title`)
  if (!Array.isArray(shelf.productIds)) invalidFixture(`shelf ${shelf.id} productIds must be an array`)

  const seenProductIds = new Set<string>()
  for (const productId of shelf.productIds) {
    requireNonBlank(productId, `shelf ${shelf.id} product id`)
    if (seenProductIds.has(productId)) invalidFixture(`duplicate product id ${productId} in shelf ${shelf.id}`)
    seenProductIds.add(productId)
    if (!Object.prototype.hasOwnProperty.call(products, productId)) {
      invalidFixture(`unknown product ${productId} referenced by shelf ${shelf.id}`)
    }
  }
}

/**
 * Validates local Story-normalized presentation data.
 *
 * This is deliberately not a GenStudio wire parser. The renderer may use this
 * for test fixtures and for DTOs already normalized by a trusted boundary.
 */
export function validateCatalogPresentationFixture(
  fixture: CatalogPresentationFixture,
): CatalogPresentationFixture {
  if (!fixture || typeof fixture !== 'object') invalidFixture('fixture must be an object')
  if (!Array.isArray(fixture.shelves)) invalidFixture('shelves must be an array')
  if (fixture.shelves.length > MAX_SHELVES) invalidFixture(`at most ${MAX_SHELVES} shelves are allowed`)
  if (!fixture.products || typeof fixture.products !== 'object' || Array.isArray(fixture.products)) {
    invalidFixture('products must be a record')
  }

  const productIds = Object.keys(fixture.products)
  for (const productId of productIds) {
    requireNonBlank(productId, 'product id')
    const presentation = fixture.products[productId]
    if (!presentation || typeof presentation !== 'object') {
      invalidFixture(`product ${productId} presentation must be an object`)
    }
    if (presentation.productId !== productId) {
      invalidFixture(`product ${productId} presentation productId must match its record key`)
    }
    validateCover(presentation.cover, productId)
    if (presentation.licenseLabel !== null) {
      requireNonBlank(presentation.licenseLabel, `product ${productId} licenseLabel`)
    }
    if (!Array.isArray(presentation.tags) || presentation.tags.some(tag =>
      typeof tag !== 'string' || !tag.trim(),
    )) {
      invalidFixture(`product ${productId} tags must be an array of strings`)
    }
  }

  const seenShelfIds = new Set<string>()
  for (const shelf of fixture.shelves) {
    if (!shelf || typeof shelf !== 'object') invalidFixture('shelf must be an object')
    if (seenShelfIds.has(shelf.id)) invalidFixture(`duplicate shelf id ${shelf.id}`)
    seenShelfIds.add(shelf.id)
    validateShelfProducts(fixture.products, shelf)
  }

  return fixture
}

function productLookup(products: readonly ContentStoreProduct[]): Map<string, ContentStoreProduct> {
  const lookup = new Map<string, ContentStoreProduct>()
  for (const product of products) {
    if (lookup.has(product.productId)) invalidFixture(`duplicate product id ${product.productId}`)
    lookup.set(product.productId, product)
  }
  return lookup
}

export function orderShelfProducts(
  products: readonly ContentStoreProduct[],
  shelf: CatalogShelfPresentation,
): ContentStoreProduct[] {
  const lookup = productLookup(products)
  const seenProductIds = new Set<string>()
  return shelf.productIds.map(productId => {
    if (seenProductIds.has(productId)) invalidFixture(`duplicate product id ${productId} in shelf ${shelf.id}`)
    seenProductIds.add(productId)
    const product = lookup.get(productId)
    if (!product) invalidFixture(`unknown product ${productId} referenced by shelf ${shelf.id}`)
    return product
  })
}

function customerSearchText(
  product: ContentStoreProduct,
  presentations?: CatalogPresentationFixture['products'],
): string[] {
  return [
    product.title,
    product.summary,
    product.description,
    contentStoreKindLabel(product.kind),
    ...(presentations?.[product.productId]?.tags || []),
  ]
}

export function filterCatalogProducts(
  products: readonly ContentStoreProduct[],
  query: string,
  options: { price: 'all' | 'free' | 'paid'; kind: ContentStoreKindFilter; compatibleOnly: boolean; tag?: string },
  presentations?: CatalogPresentationFixture['products'],
): ContentStoreProduct[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return products.filter(product => {
    if (options.price === 'free' && !product.free) return false
    if (options.price === 'paid' && product.free) return false
    if (options.kind !== 'all' && product.kind !== options.kind) return false
    if (options.compatibleOnly && !product.compatible) return false
    if (options.tag && !(presentations?.[product.productId]?.tags || []).includes(options.tag)) return false
    if (!normalizedQuery) return true
    return customerSearchText(product, presentations).some(text =>
      typeof text === 'string' && text.toLocaleLowerCase().includes(normalizedQuery),
    )
  })
}
