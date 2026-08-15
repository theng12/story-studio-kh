import { createHash } from 'node:crypto'

import { getGenStudioUrl } from '../services/app-settings.js'
export { resolveStoryStudioVersion } from './app-version.js'

const MAX_DEPTH = 32
const MAX_NODES = 4_096
const MAX_STRING_BYTES = 256 * 1024
const MAX_CANONICAL_BYTES = 1024 * 1024
const MAX_LOCAL_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_PUBLISHED_ARCHIVE_BYTES = 128 * 1024 * 1024
const QUOTE_TYPE = 'genstudio.content.quote.v1'
const RECEIPT_TYPE = 'genstudio.content.receipt.v1'
const RESTORE_TYPE = 'genstudio.content.restore.v1'
const DOWNLOAD_TYPE = 'genstudio.content.download.v1'
const CONTENT_STORE_CANONICALIZATION = 'json:sorted-keys,no-whitespace,utf-8'
const CONTENT_STORE_PAYLOAD_TYPES = new Set([
  DOWNLOAD_TYPE, QUOTE_TYPE, RECEIPT_TYPE, RESTORE_TYPE,
])
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PRODUCT_KINDS = new Set<GenStudioContentProductKind>([
  'series_formula', 'topic_pack', 'visual_style', 'thumbnail_recipe', 'niche_bundle',
])
const numberSources = new WeakMap<object, Map<string, string>>()

export type GenStudioContentProductKind =
  | 'series_formula'
  | 'topic_pack'
  | 'visual_style'
  | 'thumbnail_recipe'
  | 'niche_bundle'

export interface CanonicalJsonObject {
  value: Record<string, unknown>
  canonicalJson: string
  canonicalBytes: Uint8Array
}

export interface GenStudioContentRelease {
  releaseId: string
  packId: string
  version: string
  archiveSha256: string
  archiveBytes: number
  minStoryVersion: string
  changelog: string
  componentSummary: CanonicalJsonObject
  archiveAvailable: boolean
  raw: CanonicalJsonObject
}

export interface GenStudioOwnedContentRelease extends GenStudioContentRelease {
  state: 'published' | 'withdrawn' | 'recalled'
  publishedAt: string | null
  current: boolean
  recalledAt: string | null
  recallReason: string | null
}

export interface GenStudioOwnedContentReleases {
  entitlementFamily: string
  entitlementId: string
  productId: string
  title: string
  kind: GenStudioContentProductKind
  publisherId: string
  grantedAt: string
  retired: boolean
  currentReleaseId: string | null
  releases: GenStudioOwnedContentRelease[]
  raw: CanonicalJsonObject
}

export interface GenStudioContentBundleComponent {
  productId: string
  entitlementFamily: string
  title: string
  kind: GenStudioContentProductKind
  componentCreditValue: number
  owned: boolean
  raw: CanonicalJsonObject
}

export interface GenStudioShowcaseVideo {
  url: string
  title: string
  description: string
}

export interface GenStudioContentMedia {
  url: string
  alt: string
}

export interface GenStudioContentLicense {
  label: string
  text: string
}

export interface GenStudioContentDiscount {
  discountId: string
  version: number
  percent: number
  startsOn: string | null
  endsOn: string | null
  timezone: 'Asia/Phnom_Penh'
  listCreditPrice: number
  discountedCreditPrice: number
}

export interface GenStudioContentProduct {
  productId: string
  entitlementFamily: string
  kind: GenStudioContentProductKind
  title: string
  summary: string
  description: string
  publisherId: string
  creditPrice: number
  free: boolean
  owned: boolean
  retired: boolean
  successorProductId: string | null
  currentRelease: GenStudioContentRelease | null
  compatible: boolean
  compatibilityReason: string | null
  bundleComponents: GenStudioContentBundleComponent[]
  ownedComponentCreditValue: number
  showcaseVideos: GenStudioShowcaseVideo[]
  cover: GenStudioContentMedia | null
  hero: GenStudioContentMedia | null
  tags: string[]
  license: GenStudioContentLicense | null
  discount: GenStudioContentDiscount | null
  raw: CanonicalJsonObject
}

export interface GenStudioOwnedContent {
  entitlementFamily: string
  productId: string
  title: string
  kind: GenStudioContentProductKind
  grantedAt: string
  purchaseId: string | null
  currentRelease: GenStudioContentRelease | null
  showcaseVideos: GenStudioShowcaseVideo[]
  raw: CanonicalJsonObject
}

export interface GenStudioContentAccount {
  accountId: string
  contentAccountId: string
  availableCredits: number
  contentSpendableCredits: number
  owned: GenStudioOwnedContent[]
  raw: CanonicalJsonObject
}

export interface GenStudioContentCatalog {
  products: GenStudioContentProduct[]
  raw: CanonicalJsonObject
}

export interface GenStudioContentStoreShelf {
  shelfId: string
  title: string
  position: number
  productIds: string[]
}

export interface GenStudioContentStoreShelves {
  shelves: GenStudioContentStoreShelf[]
  fallbackProductIds: string[]
  raw: CanonicalJsonObject
}

export interface GenStudioContentQuote {
  signedQuote: CanonicalJsonObject
  quoteSignature: string
  quoteId: string
  keyId: string
  expiresAt: string
  accountId: string
  productId: string
  entitlementFamily: string
  releaseId: string
  baseCreditPrice: number
  discountCredits: number
  entitlementFamilies: string[]
  bundleClosure: GenStudioContentBundleClosureEntry[]
  operatorDiscount: GenStudioContentOperatorDiscount | null
  operatorDiscountCredits: number
  quotedCredits: number
  balanceBefore: number
  balanceAfter: number
  ownedComponents: string[]
  sufficientCredits: boolean
  insufficientReason: string | null
  shortfallCredits: number
  raw: CanonicalJsonObject
}

export interface GenStudioContentOperatorDiscount {
  discountId: string
  version: number
  percent: number
  startsOn: string | null
  endsOn: string | null
  timezone: 'Asia/Phnom_Penh'
}

export interface GenStudioContentBundleClosureEntry {
  position: number
  productId: string
  entitlementFamily: string
  releaseId: string
  version: string
  archiveSha256: string
}

export interface GenStudioContentReceipt {
  signedReceipt: CanonicalJsonObject
  receiptSignature: string
  keyId: string
  raw: CanonicalJsonObject
}

export interface GenStudioContentPurchase {
  purchaseId: string
  /** Immutable identity from the signed receipt; binds settlement to the saved quote. */
  quoteId: string
  accountId: string
  creditsCharged: number
  discountCredits: number
  baseCreditPrice: number
  componentDiscountCredits: number
  operatorDiscount: GenStudioContentOperatorDiscount | null
  operatorDiscountCredits: number
  balanceBefore: number
  balanceAfter: number
  entitlementIds: string[]
  entitlementFamilies: string[]
  grantedFamilies: string[]
  previouslyOwnedFamilies: string[]
  bundleClosure: GenStudioContentBundleClosureEntry[]
  product: CanonicalJsonObject
  release: CanonicalJsonObject
  ledgerEventKey: string | null
  receipt: GenStudioContentReceipt
  replayed: boolean
  raw: CanonicalJsonObject
}

export interface GenStudioContentSigningKey {
  keyId: string
  algorithm: 'ed25519'
  publicKeyBase64: string
  publicKeyBytes: Uint8Array
  current: boolean
}

export interface GenStudioContentPublicKey extends GenStudioContentSigningKey {
  keys: GenStudioContentSigningKey[]
  payloadTypes: string[]
  canonicalization: typeof CONTENT_STORE_CANONICALIZATION
  raw: CanonicalJsonObject
}

export interface GenStudioContentPurchaseReceipt extends GenStudioContentReceipt {
  purchaseId: string
  creditsCharged: number
  createdAt: string
}

export interface GenStudioContentRestoreEntitlement {
  entitlementId: string
  entitlementFamily: string
  productId: string
  title: string
  kind: GenStudioContentProductKind
  publisherId: string
  grantedAt: string
  purchaseId: string | null
  retired: boolean
  currentRelease: GenStudioContentRelease | null
  downloadAvailable: boolean
  recalledReleaseVersions: string[]
  showcaseVideos: GenStudioShowcaseVideo[]
  raw: CanonicalJsonObject
}

export interface GenStudioContentReceipts {
  accountId: string
  contentAccountId: string
  restoreReceipt: GenStudioContentReceipt
  purchaseReceipts: GenStudioContentPurchaseReceipt[]
  entitlements: GenStudioContentRestoreEntitlement[]
  raw: CanonicalJsonObject
}

export interface GenStudioContentDownloadGrant {
  grantId: string
  accountId: string
  productId: string
  entitlementFamily: string
  releaseId: string
  packId: string
  version: string
  archiveSha256: string
  archiveBytes: number
  downloadUrl: string
  expiresAt: string
  ttlSeconds: number
  signedGrant: CanonicalJsonObject
  grantSignature: string
  keyId: string
  raw: CanonicalJsonObject
}

export class GenStudioContentStoreApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly detail: string
  readonly refusal: Record<string, unknown>

  constructor(status: number, code: string | null, detail: string, refusal: Record<string, unknown>) {
    super(detail || `GenStudio Content Store returned HTTP ${status}`)
    this.name = 'GenStudioContentStoreApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.refusal = refusal
  }
}

export class GenStudioContentStoreTransportError extends Error {
  readonly outcome: 'not-sent' | 'uncertain'

  constructor(outcome: 'not-sent' | 'uncertain', detail: string, cause?: unknown) {
    super(detail, cause === undefined ? undefined : { cause })
    this.name = 'GenStudioContentStoreTransportError'
    this.outcome = outcome
  }
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} has an unsupported prototype`)
  return value as Record<string, unknown>
}

function parseJsonPreservingNumberSources(source: string): unknown {
  return JSON.parse(source, function (this: object, key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && typeof context?.source === 'string') {
      let fields = numberSources.get(this)
      if (!fields) {
        fields = new Map()
        numberSources.set(this, fields)
      }
      fields.set(key, context.source)
    }
    return value
  })
}

function canonicalJson(value: unknown, state: { nodes: number }, depth: number, numericSource?: string): string {
  state.nodes += 1
  if (state.nodes > MAX_NODES) throw new Error(`Content Store JSON exceeds ${MAX_NODES} nodes`)
  if (depth > MAX_DEPTH) throw new Error(`Content Store JSON exceeds depth ${MAX_DEPTH}`)
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) throw new Error('Content Store JSON string is too large')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Content Store JSON number must be finite')
    if (numericSource !== undefined) {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(numericSource)
        || !Object.is(Number(numericSource), value)) {
        throw new Error('Content Store JSON number source is invalid')
      }
      return numericSource
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const entries: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error('Content Store JSON arrays must not be sparse')
      entries.push(canonicalJson(value[index], state, depth + 1, numberSources.get(value)?.get(String(index))))
    }
    return `[${entries.join(',')}]`
  }
  const record = plainObject(value, 'Content Store JSON value')
  if (Object.getOwnPropertySymbols(record).length > 0) throw new Error('Content Store JSON contains non-JSON keys')
  const keys = Object.keys(record).sort()
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`Content Store JSON contains dangerous key: ${key}`)
  }
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], state, depth + 1, numberSources.get(record)?.get(key))}`).join(',')}}`
}

export function canonicalizeContentStoreObject(value: unknown): CanonicalJsonObject {
  plainObject(value, 'Content Store JSON root')
  const canonical = canonicalJson(value, { nodes: 0 }, 0)
  const bytes = Buffer.from(canonical, 'utf8')
  if (bytes.byteLength > MAX_CANONICAL_BYTES) throw new Error('Content Store canonical JSON payload exceeds 1 MiB')
  return {
    value: value as Record<string, unknown>,
    canonicalJson: canonical,
    canonicalBytes: new Uint8Array(bytes),
  }
}

export function canonicalizeContentStoreJson(source: string): CanonicalJsonObject {
  return canonicalizeContentStoreObject(parseJsonPreservingNumberSources(source))
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function nullableText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value === null) return null
  return text(record, key)
}

function bool(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function uint(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${key} must be a non-negative safe integer`)
  return value as number
}

function array(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`)
  return value
}

function textArray(record: Record<string, unknown>, key: string): string[] {
  return array(record, key).map((value, index) => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${key}[${index}] must be a non-empty string`)
    return value
  })
}

function optionalTextArray(record: Record<string, unknown>, key: string): string[] {
  return record[key] === undefined ? [] : textArray(record, key)
}

function boundedPlainText(value: unknown, field: string, min: number, max: number, allowNewlines = false): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const length = [...value].length
  if (length < min || length > max) throw new Error(`${field} must contain ${min}-${max} characters`)
  for (const character of value) {
    if (character === '<' || character === '>'
      || (/\p{Cc}/u.test(character) && (!allowNewlines || character !== '\n'))) {
      throw new Error(`${field} must be plain text`)
    }
  }
  return value
}

function canonicalMarketingUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || [...value].length > 2_048) throw new Error(`${field} must be an HTTPS URL no longer than 2048 characters`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || parsed.search || parsed.hash || !parsed.hostname.includes('.')) {
    throw new Error(`${field} must be a canonical HTTPS marketing URL`)
  }
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(parsed.pathname)
  } catch {
    throw new Error(`${field} must contain a valid URL path`)
  }
  if (decodedPath.includes('/v1/content/archives')) {
    throw new Error(`${field} must not reference gated content archives`)
  }
  return `https://${parsed.hostname.toLowerCase()}${parsed.pathname}`
}

function parseContentMedia(value: unknown, field: string): GenStudioContentMedia | null {
  if (value === null) return null
  const row = plainObject(value, field)
  return {
    url: canonicalMarketingUrl(row.url, `${field}.url`),
    alt: boundedPlainText(row.alt, `${field}.alt`, 1, 200),
  }
}

function nullableDate(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${key} must be a YYYY-MM-DD date or null`)
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    throw new Error(`${key} must be a calendar date`)
  }
  return value
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('tags must contain at most 12 entries')
  const seen = new Set<string>()
  return value.map((tag, index) => {
    const parsed = boundedPlainText(tag, `tags[${index}]`, 1, 40)
    const normalized = parsed.toLocaleLowerCase()
    if (seen.has(normalized)) throw new Error('tags must be case-insensitively unique')
    seen.add(normalized)
    return parsed
  })
}

function parseLicense(value: unknown): GenStudioContentLicense | null {
  if (value === null) return null
  const row = plainObject(value, 'license')
  return {
    label: boundedPlainText(row.label, 'license.label', 1, 120),
    text: boundedPlainText(row.text, 'license.text', 1, 8_000, true),
  }
}

function parseDiscount(value: unknown, free: boolean): GenStudioContentDiscount | null {
  if (value === null) return null
  if (free) throw new Error('discount must be null for a free product')
  const row = plainObject(value, 'discount')
  const percent = uint(row, 'percent')
  if (percent < 1 || percent > 99) throw new Error('discount.percent must be between 1 and 99')
  const version = uint(row, 'version')
  if (version < 1) throw new Error('discount.version must be at least 1')
  if (row.timezone !== 'Asia/Phnom_Penh') throw new Error('discount.timezone must be Asia/Phnom_Penh')
  return {
    discountId: text(row, 'discount_id'),
    version,
    percent,
    startsOn: nullableDate(row, 'starts_on'),
    endsOn: nullableDate(row, 'ends_on'),
    timezone: 'Asia/Phnom_Penh',
    listCreditPrice: uint(row, 'list_credit_price'),
    discountedCreditPrice: uint(row, 'discounted_credit_price'),
  }
}

function strictBase64(value: string, field: string, expectedBytes?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${field} must be valid base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`${field} must be canonical base64`)
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new Error(`${field} must encode exactly ${expectedBytes} bytes`)
  }
  return new Uint8Array(bytes)
}

function isoInstant(record: Record<string, unknown>, key: string): string {
  const value = text(record, key)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${key} must be a UTC ISO-8601 instant`)
  }
  return value
}

function kind(record: Record<string, unknown>, key = 'kind'): GenStudioContentProductKind {
  const value = text(record, key) as GenStudioContentProductKind
  if (!PRODUCT_KINDS.has(value)) throw new Error(`${key} is not a published Content Store product kind`)
  return value
}

function sameJson(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false
  if (!right || typeof right !== 'object' || Array.isArray(right)) return false
  return canonicalizeContentStoreObject(left).canonicalJson === canonicalizeContentStoreObject(right).canonicalJson
}

function parseRelease(value: unknown, field: string): GenStudioContentRelease {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const archiveSha256 = text(row, 'archive_sha256')
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) throw new Error(`${field}.archive_sha256 must be 64 lowercase hexadecimal characters`)
  const componentSummary = canonicalizeContentStoreObject(row.component_summary)
  const archiveBytes = uint(row, 'archive_bytes')
  if (archiveBytes < 1 || archiveBytes > MAX_PUBLISHED_ARCHIVE_BYTES) {
    throw new Error(`${field}.archive_bytes must be between 1 and ${MAX_PUBLISHED_ARCHIVE_BYTES}`)
  }
  return {
    releaseId: text(row, 'release_id'),
    packId: text(row, 'pack_id'),
    version: text(row, 'version'),
    archiveSha256,
    archiveBytes,
    minStoryVersion: text(row, 'min_story_version'),
    changelog: typeof row.changelog === 'string' ? row.changelog : (() => { throw new Error(`${field}.changelog must be a string`) })(),
    componentSummary,
    archiveAvailable: row.archive_available === undefined ? false : bool(row, 'archive_available'),
    raw,
  }
}

function parseOptionalRelease(value: unknown, field: string): GenStudioContentRelease | null {
  return value === null ? null : parseRelease(value, field)
}

function parseShowcaseVideos(value: unknown, field: string): GenStudioShowcaseVideo[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  if (value.length > 12) throw new Error(`${field} must contain at most 12 videos`)
  const isCanonicalPlainText = (text: string): boolean => text === text.trim().split(/\s+/u).join(' ')
    && ![...text].some(character => character === '<' || character === '>'
      || (character !== ' ' && /[\p{C}\p{Z}]/u.test(character)))
  return value.map((entry, index) => {
    const row = plainObject(entry, `${field}[${index}]`)
    if (Object.keys(row).sort().join(',') !== 'description,title,url') {
      throw new Error(`${field}[${index}] must contain exactly url, title, and description`)
    }
    const url = text(row, 'url')
    const title = text(row, 'title')
    const description = typeof row.description === 'string'
      ? row.description
      : (() => { throw new Error(`${field}[${index}].description must be a string`) })()
    if (!/^https:\/\/(?:www\.youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{11}$/.test(url)) {
      throw new Error(`${field}[${index}].url is not a canonical YouTube URL`)
    }
    if ([...title].length > 160 || !isCanonicalPlainText(title)) {
      throw new Error(`${field}[${index}].title must be 1-160 characters of plain text`)
    }
    if ([...description].length > 500 || !isCanonicalPlainText(description)) {
      throw new Error(`${field}[${index}].description must be at most 500 characters of plain text`)
    }
    return { url, title, description }
  })
}

function parseProduct(value: unknown): GenStudioContentProduct {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const creditPrice = uint(row, 'credit_price')
  const free = bool(row, 'free')
  if (free !== (creditPrice === 0)) throw new Error('free must match whether credit_price is zero')
  const cover = parseContentMedia(row.cover, 'cover')
  const hero = parseContentMedia(row.hero, 'hero')
  if (hero !== null && cover === null) throw new Error('hero must be null when cover is null')
  return {
    productId: text(row, 'product_id'),
    entitlementFamily: text(row, 'entitlement_family'),
    kind: kind(row),
    title: text(row, 'title'),
    summary: typeof row.summary === 'string' ? row.summary : (() => { throw new Error('summary must be a string') })(),
    description: typeof row.description === 'string' ? row.description : (() => { throw new Error('description must be a string') })(),
    publisherId: text(row, 'publisher_id'),
    creditPrice,
    free,
    owned: bool(row, 'owned'),
    retired: bool(row, 'retired'),
    successorProductId: nullableText(row, 'successor_product_id'),
    currentRelease: parseOptionalRelease(row.current_release, 'current_release'),
    compatible: bool(row, 'compatible'),
    compatibilityReason: nullableText(row, 'compatibility_reason'),
    bundleComponents: array(row, 'bundle_components').map(value => {
      const componentRaw = canonicalizeContentStoreObject(value)
      const component = componentRaw.value
      return {
        productId: text(component, 'product_id'),
        entitlementFamily: text(component, 'entitlement_family'),
        title: text(component, 'title'),
        kind: kind(component),
        componentCreditValue: uint(component, 'component_credit_value'),
        owned: bool(component, 'owned'),
        raw: componentRaw,
      }
    }),
    ownedComponentCreditValue: uint(row, 'owned_component_credit_value'),
    showcaseVideos: parseShowcaseVideos(row.showcase_videos, 'showcase_videos'),
    cover,
    hero,
    tags: parseTags(row.tags),
    license: parseLicense(row.license),
    discount: parseDiscount(row.discount, free),
    raw,
  }
}

export function parseContentStoreAccount(value: unknown): GenStudioContentAccount {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  return {
    accountId: text(row, 'account_id'),
    contentAccountId: text(row, 'content_account_id'),
    availableCredits: uint(row, 'available_credits'),
    contentSpendableCredits: uint(row, 'content_spendable_credits'),
    owned: array(row, 'owned').map(value => {
      const ownedRaw = canonicalizeContentStoreObject(value)
      const owned = ownedRaw.value
      return {
        entitlementFamily: text(owned, 'entitlement_family'),
        productId: text(owned, 'product_id'),
        title: text(owned, 'title'),
        kind: kind(owned),
        grantedAt: text(owned, 'granted_at'),
        purchaseId: nullableText(owned, 'purchase_id'),
        currentRelease: parseOptionalRelease(owned.current_release, 'owned.current_release'),
        showcaseVideos: parseShowcaseVideos(owned.showcase_videos, 'owned.showcase_videos'),
        raw: ownedRaw,
      }
    }),
    raw,
  }
}

export function parseContentStoreCatalog(value: unknown): GenStudioContentCatalog {
  const raw = canonicalizeContentStoreObject(value)
  const products = array(raw.value, 'products').map(parseProduct)
  const ids = new Set<string>()
  for (const product of products) {
    if (ids.has(product.productId)) throw new Error(`products contains duplicate product_id ${product.productId}`)
    ids.add(product.productId)
  }
  return { products, raw }
}

export function parseContentStoreShelves(
  value: unknown,
  visibleProductIds: readonly string[],
): GenStudioContentStoreShelves {
  const raw = canonicalizeContentStoreObject(value)
  const visible = new Set(visibleProductIds)
  if (visible.size !== visibleProductIds.length) throw new Error('Visible catalog product IDs must be unique')
  const seenShelfIds = new Set<string>()
  const placedProductIds = new Set<string>()
  const shelves = array(raw.value, 'shelves').map((entry, index) => {
    const row = plainObject(entry, `shelves[${index}]`)
    const shelfId = text(row, 'shelf_id')
    if (seenShelfIds.has(shelfId)) throw new Error(`shelves contains duplicate shelf_id ${shelfId}`)
    seenShelfIds.add(shelfId)
    const productIds = textArray(row, 'product_ids')
    for (const productId of productIds) {
      if (!visible.has(productId)) throw new Error(`shelves contains unknown product_id ${productId}`)
      if (placedProductIds.has(productId)) throw new Error(`shelves contains duplicate product_id ${productId}`)
      placedProductIds.add(productId)
    }
    return {
      shelfId,
      title: boundedPlainText(row.title, `shelves[${index}].title`, 1, 120),
      position: uint(row, 'position'),
      productIds,
    }
  })
  const fallbackProductIds = textArray(raw.value, 'fallback_product_ids')
  for (const productId of fallbackProductIds) {
    if (!visible.has(productId)) throw new Error(`fallback_product_ids contains unknown product_id ${productId}`)
    if (placedProductIds.has(productId)) throw new Error(`shelves contains duplicate product_id ${productId}`)
    placedProductIds.add(productId)
  }
  for (const productId of visibleProductIds) {
    if (!placedProductIds.has(productId)) throw new Error(`shelves is missing visible product_id ${productId}`)
  }
  return { shelves, fallbackProductIds, raw }
}

function parseOperatorDiscount(value: unknown, field: string): GenStudioContentOperatorDiscount | null {
  if (value === null) return null
  const row = plainObject(value, field)
  const version = uint(row, 'version')
  const percent = uint(row, 'percent')
  const startsOn = nullableText(row, 'starts_on')
  const endsOn = nullableText(row, 'ends_on')
  if (version < 1) throw new Error(`${field}.version must be at least 1`)
  if (percent < 1 || percent > 99) throw new Error(`${field}.percent must be between 1 and 99`)
  for (const [name, date] of [['starts_on', startsOn], ['ends_on', endsOn]] as const) {
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${field}.${name} must be YYYY-MM-DD or null`)
  }
  if (text(row, 'timezone') !== 'Asia/Phnom_Penh') throw new Error(`${field}.timezone must be Asia/Phnom_Penh`)
  return {
    discountId: text(row, 'discount_id'), version, percent, startsOn, endsOn, timezone: 'Asia/Phnom_Penh',
  }
}

function parseBundleClosure(value: unknown, field: string): GenStudioContentBundleClosureEntry[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  const families = new Set<string>()
  return value.map((entry, index) => {
    const row = plainObject(entry, `${field}[${index}]`)
    const position = uint(row, 'position')
    if (position !== index) throw new Error(`${field} positions must be pinned in order from zero`)
    const entitlementFamily = text(row, 'entitlement_family')
    if (families.has(entitlementFamily)) throw new Error(`${field} contains a duplicate entitlement_family`)
    families.add(entitlementFamily)
    const archiveSha256 = text(row, 'archive_sha256')
    if (!/^[0-9a-f]{64}$/.test(archiveSha256)) throw new Error(`${field}[${index}].archive_sha256 must be 64 lowercase hexadecimal characters`)
    return {
      position,
      productId: text(row, 'product_id'),
      entitlementFamily,
      releaseId: text(row, 'release_id'),
      version: text(row, 'version'),
      archiveSha256,
    }
  })
}

function parseEntitlementFamilies(value: unknown, field: string, entitlementFamily: string, closure: readonly GenStudioContentBundleClosureEntry[]): string[] {
  const families = textArray({ value }, 'value')
  const expected = [entitlementFamily, ...closure.map(component => component.entitlementFamily)]
  if (families.length === 0 || new Set(families).size !== families.length || JSON.stringify(families) !== JSON.stringify(expected)) {
    throw new Error(`${field} must contain the complete pinned family set in order`)
  }
  return families
}

function assertSignedQuoteCoherence(signed: Record<string, unknown>, envelope: Record<string, unknown>): void {
  const scalarFields = [
    'quote_id', 'account_id', 'product_id', 'entitlement_family', 'release_id', 'expires_at',
    'base_credit_price', 'discount_credits', 'operator_discount_credits', 'quoted_credits',
  ]
  for (const field of scalarFields) {
    if (signed[field] !== envelope[field]) throw new Error(`Signed quote ${field} does not match its envelope`)
  }
  const signedOwned = signed.owned_components
  const envelopeOwned = envelope.owned_components
  if (!Array.isArray(signedOwned) || !Array.isArray(envelopeOwned)
    || JSON.stringify(signedOwned) !== JSON.stringify(envelopeOwned)) {
    throw new Error('Signed quote owned_components does not match its envelope')
  }
  for (const field of ['entitlement_families', 'bundle_closure', 'operator_discount']) {
    if (!sameJson({ value: signed[field] }, { value: envelope[field] })) throw new Error(`Signed quote ${field} does not match its envelope`)
  }
}

export function parseContentStoreQuote(value: unknown): GenStudioContentQuote {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const signedQuote = canonicalizeContentStoreObject(row.quote)
  if (signedQuote.value.typ !== QUOTE_TYPE) throw new Error(`Signed quote typ must be ${QUOTE_TYPE}`)
  const keyId = text(row, 'key_id')
  if (signedQuote.value.key_id !== keyId) throw new Error('Signed quote key_id does not match its envelope')
  assertSignedQuoteCoherence(signedQuote.value, row)
  const bundleClosure = parseBundleClosure(row.bundle_closure, 'bundle_closure')
  const entitlementFamily = text(row, 'entitlement_family')
  const entitlementFamilies = parseEntitlementFamilies(row.entitlement_families, 'entitlement_families', entitlementFamily, bundleClosure)
  const ownedComponents = textArray(row, 'owned_components')
  if (new Set(ownedComponents).size !== ownedComponents.length) {
    throw new Error('owned_components must be unique')
  }
  const operatorDiscount = parseOperatorDiscount(row.operator_discount, 'operator_discount')
  const operatorDiscountCredits = uint(row, 'operator_discount_credits')
  if ((operatorDiscount === null) !== (operatorDiscountCredits === 0)) {
    throw new Error('operator_discount and operator_discount_credits must agree')
  }

  const sufficientCredits = bool(row, 'sufficient_credits')
  const insufficientReason = nullableText(row, 'insufficient_reason')
  if (sufficientCredits && insufficientReason !== null) throw new Error('A sufficient quote cannot have an insufficient_reason')
  if (!sufficientCredits && insufficientReason !== 'insufficient_credits') throw new Error('An insufficient quote must name insufficient_credits')
  return {
    signedQuote,
    quoteSignature: text(row, 'quote_signature'),
    quoteId: text(row, 'quote_id'),
    keyId,
    expiresAt: text(row, 'expires_at'),
    accountId: text(row, 'account_id'),
    productId: text(row, 'product_id'),
    entitlementFamily,
    releaseId: text(row, 'release_id'),
    baseCreditPrice: uint(row, 'base_credit_price'),
    discountCredits: uint(row, 'discount_credits'),
    entitlementFamilies,
    bundleClosure,
    operatorDiscount,
    operatorDiscountCredits,
    quotedCredits: uint(row, 'quoted_credits'),
    balanceBefore: uint(row, 'balance_before'),
    balanceAfter: uint(row, 'balance_after'),
    ownedComponents,
    sufficientCredits,
    insufficientReason,
    shortfallCredits: uint(row, 'shortfall_credits'),
    raw,
  }
}

export function parseContentStorePurchase(value: unknown): GenStudioContentPurchase {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const receiptRaw = canonicalizeContentStoreObject(row.receipt)
  const receiptEnvelope = receiptRaw.value
  const signedReceipt = canonicalizeContentStoreObject(receiptEnvelope.receipt)
  if (signedReceipt.value.typ !== RECEIPT_TYPE) throw new Error(`Signed receipt typ must be ${RECEIPT_TYPE}`)
  const receiptKeyId = text(receiptEnvelope, 'key_id')
  if (signedReceipt.value.key_id !== receiptKeyId) throw new Error('Signed receipt key_id does not match its envelope')
  const quoteId = text(signedReceipt.value, 'quote_id')

  const product = canonicalizeContentStoreObject(row.product)
  const release = canonicalizeContentStoreObject(row.release)
  const coherence: Array<[string, unknown, unknown]> = [
    ['purchase_id', signedReceipt.value.purchase_id, row.purchase_id],
    ['account_id', signedReceipt.value.account_id, row.account_id],
    ['credits_charged', signedReceipt.value.credits_charged, row.credits_charged],
  ]
  for (const [field, signedValue, envelopeValue] of coherence) {
    if (signedValue !== envelopeValue) throw new Error(`Signed receipt ${field} does not match its purchase envelope`)
  }
  if (JSON.stringify(signedReceipt.value.entitlement_families) !== JSON.stringify(row.entitlement_families)) {
    throw new Error('Signed receipt entitlement_families does not match its purchase envelope')
  }
  if (!sameJson(signedReceipt.value.product, row.product)) throw new Error('Signed receipt product does not match its purchase envelope')
  if (!sameJson(signedReceipt.value.release, row.release)) throw new Error('Signed receipt release does not match its purchase envelope')

  const entitlementFamily = text(plainObject(row.product, 'product'), 'entitlement_family')
  const bundleClosure = parseBundleClosure(row.bundle_closure, 'bundle_closure')
  const entitlementFamilies = parseEntitlementFamilies(row.entitlement_families, 'entitlement_families', entitlementFamily, bundleClosure)
  const grantedFamilies = textArray(row, 'granted_families')
  const previouslyOwnedFamilies = textArray(row, 'previously_owned_families')
  if (new Set(grantedFamilies).size !== grantedFamilies.length
    || grantedFamilies.some(family => !entitlementFamilies.includes(family))) {
    throw new Error('granted_families must be a unique subset of entitlement_families')
  }
  if (new Set(previouslyOwnedFamilies).size !== previouslyOwnedFamilies.length
    || previouslyOwnedFamilies.some(family => !entitlementFamilies.includes(family))
    || JSON.stringify(previouslyOwnedFamilies) !== JSON.stringify([...previouslyOwnedFamilies].sort())) {
    throw new Error('previously_owned_families must be a sorted unique subset of entitlement_families')
  }
  const grantedSet = new Set(grantedFamilies)
  const previouslyOwnedSet = new Set(previouslyOwnedFamilies)
  if (grantedFamilies.some(family => previouslyOwnedSet.has(family))) {
    throw new Error('granted_families and previously_owned_families must be disjoint')
  }
  if (grantedSet.size + previouslyOwnedSet.size !== entitlementFamilies.length
    || entitlementFamilies.some(family => !grantedSet.has(family) && !previouslyOwnedSet.has(family))) {
    throw new Error('granted_families and previously_owned_families must completely partition entitlement_families')
  }
  const entitlementIds = textArray(row, 'entitlement_ids')
  if (new Set(entitlementIds).size !== entitlementIds.length || entitlementIds.length !== grantedFamilies.length) {
    throw new Error('entitlement_ids must be unique and correspond one-for-one with granted_families')
  }
  const operatorDiscount = parseOperatorDiscount(row.operator_discount, 'operator_discount')
  const operatorDiscountCredits = uint(row, 'operator_discount_credits')
  if ((operatorDiscount === null) !== (operatorDiscountCredits === 0)) {
    throw new Error('operator_discount and operator_discount_credits must agree')
  }
  const componentDiscountCredits = uint(row, 'component_discount_credits')
  if (componentDiscountCredits !== uint(row, 'discount_credits')) {
    throw new Error('component_discount_credits must match discount_credits')
  }
  for (const field of [
    'base_credit_price', 'component_discount_credits', 'operator_discount', 'operator_discount_credits',
    'granted_families', 'previously_owned_families', 'bundle_closure',
  ]) {
    if (!sameJson({ value: signedReceipt.value[field] }, { value: row[field] })) {
      throw new Error(`Signed receipt ${field} does not match its purchase envelope`)
    }
  }

  return {
    purchaseId: text(row, 'purchase_id'),
    quoteId,
    accountId: text(row, 'account_id'),
    creditsCharged: uint(row, 'credits_charged'),
    discountCredits: uint(row, 'discount_credits'),
    baseCreditPrice: uint(row, 'base_credit_price'),
    componentDiscountCredits,
    operatorDiscount,
    operatorDiscountCredits,
    balanceBefore: uint(row, 'balance_before'),
    balanceAfter: uint(row, 'balance_after'),
    entitlementIds,
    entitlementFamilies,
    grantedFamilies,
    previouslyOwnedFamilies,
    bundleClosure,
    product,
    release,
    ledgerEventKey: nullableText(row, 'ledger_event_key'),
    receipt: {
      signedReceipt,
      receiptSignature: text(receiptEnvelope, 'receipt_signature'),
      keyId: receiptKeyId,
      raw: receiptRaw,
    },
    replayed: bool(row, 'replayed'),
    raw,
  }
}

function parseSignedReceiptEnvelope(
  value: unknown,
  expectedType: typeof RECEIPT_TYPE | typeof RESTORE_TYPE,
  field: string,
): GenStudioContentReceipt {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const signedReceipt = canonicalizeContentStoreObject(row.receipt)
  if (signedReceipt.value.typ !== expectedType) throw new Error(`${field} typ must be ${expectedType}`)
  const keyId = text(row, 'key_id')
  if (signedReceipt.value.key_id !== keyId) throw new Error(`${field} key_id does not match its envelope`)
  const receiptSignature = text(row, 'receipt_signature')
  strictBase64(receiptSignature, `${field}.receipt_signature`, 64)
  return { signedReceipt, receiptSignature, keyId, raw }
}

export function parseContentStorePublicKey(value: unknown): GenStudioContentPublicKey {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const algorithm = text(row, 'algorithm')
  if (algorithm !== 'ed25519') throw new Error('Content Store public-key algorithm must be ed25519')
  const canonicalization = text(row, 'canonicalization')
  if (canonicalization !== CONTENT_STORE_CANONICALIZATION) {
    throw new Error(`Content Store public-key canonicalization must be ${CONTENT_STORE_CANONICALIZATION}`)
  }
  const payloadTypes = textArray(row, 'payload_types')
  if (new Set(payloadTypes).size !== payloadTypes.length
    || payloadTypes.length !== CONTENT_STORE_PAYLOAD_TYPES.size
    || [...CONTENT_STORE_PAYLOAD_TYPES].some(type => !payloadTypes.includes(type))) {
    throw new Error('Content Store public-key payload_types must exactly match the published signed payload types')
  }
  const publicKeyBase64 = text(row, 'public_key_base64')
  const keyId = text(row, 'key_id')
  const parseKey = (value: unknown, field: string): GenStudioContentSigningKey => {
    const key = plainObject(value, field)
    const keyAlgorithm = text(key, 'algorithm')
    if (keyAlgorithm !== 'ed25519') throw new Error(`${field}.algorithm must be ed25519`)
    const keyBase64 = text(key, 'public_key_base64')
    return {
      keyId: text(key, 'key_id'),
      algorithm: keyAlgorithm,
      publicKeyBase64: keyBase64,
      publicKeyBytes: strictBase64(keyBase64, `${field}.public_key_base64`, 32),
      current: bool(key, 'current'),
    }
  }
  const keys: GenStudioContentSigningKey[] = row.keys === undefined
    ? [{
        keyId,
        algorithm,
        publicKeyBase64,
        publicKeyBytes: strictBase64(publicKeyBase64, 'public_key_base64', 32),
        current: true,
      }]
    : (() => {
        if (!Array.isArray(row.keys) || row.keys.length === 0) throw new Error('Content Store public-key keys must be a non-empty array')
        const parsed = row.keys.map((key, index) => parseKey(key, `keys[${index}]`))
        if (new Set(parsed.map(key => key.keyId)).size !== parsed.length) throw new Error('Content Store public-key keys contains a duplicate key_id')
        if (parsed.filter(key => key.current).length !== 1 || !parsed[0]?.current) {
          throw new Error('Content Store public-key keys must contain exactly one current key, first')
        }
        const current = parsed[0]
        if (current.keyId !== keyId || current.algorithm !== algorithm || current.publicKeyBase64 !== publicKeyBase64) {
          throw new Error('Content Store public-key top-level fields must match the current key')
        }
        return parsed
      })()
  return {
    keyId,
    algorithm,
    publicKeyBase64,
    publicKeyBytes: strictBase64(publicKeyBase64, 'public_key_base64', 32),
    current: true,
    keys,
    payloadTypes,
    canonicalization,
    raw,
  }
}

function assertRestoreCoherence(result: GenStudioContentReceipts): void {
  if (result.accountId !== result.contentAccountId) throw new Error('Content Store restore account ids do not match')
  const signed = result.restoreReceipt.signedReceipt.value
  if (signed.account_id !== result.accountId || signed.content_account_id !== result.contentAccountId) {
    throw new Error('Signed restore account ids do not match the response envelope')
  }
  const signedFamilies = signed.entitlement_families
  const envelopeFamilies = result.entitlements.map(item => item.entitlementFamily)
  if (!Array.isArray(signedFamilies) || JSON.stringify(signedFamilies) !== JSON.stringify(envelopeFamilies)) {
    throw new Error('Signed restore entitlement_families do not match the response envelope')
  }
  const signedEntitlements = signed.entitlements
  const envelopeEntitlements = result.entitlements.map(item => ({
    entitlement_family: item.entitlementFamily,
    product_id: item.productId,
    title: item.title,
    kind: item.kind,
    granted_at: item.grantedAt,
    purchase_id: item.purchaseId,
  }))
  if (!Array.isArray(signedEntitlements) || !sameJson({ rows: signedEntitlements }, { rows: envelopeEntitlements })) {
    throw new Error('Signed restore entitlements do not match the response envelope')
  }
  const signedReleases = signed.releases
  const envelopeReleases = result.entitlements.flatMap(item => item.currentRelease ? [{
    entitlement_family: item.entitlementFamily,
    release_id: item.currentRelease.releaseId,
    pack_id: item.currentRelease.packId,
    version: item.currentRelease.version,
    archive_sha256: item.currentRelease.archiveSha256,
    archive_bytes: item.currentRelease.archiveBytes,
    min_story_version: item.currentRelease.minStoryVersion,
  }] : [])
  if (!Array.isArray(signedReleases) || !sameJson({ rows: signedReleases }, { rows: envelopeReleases })) {
    throw new Error('Signed restore releases do not match the response envelope')
  }
  const expiry = plainObject(signed.expiry_policy, 'restore receipt expiry_policy')
  if (expiry.ownership !== 'permanent' || expiry.receipt_expires_at !== null) {
    throw new Error('Signed restore expiry_policy must state permanent ownership without receipt expiry')
  }
  isoInstant(expiry, 'refresh_recommended_after')
  isoInstant(signed, 'issued_at')
  text(signed, 'receipt_id')
}

export function parseContentStoreReceipts(value: unknown): GenStudioContentReceipts {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const accountId = text(row, 'account_id')
  const contentAccountId = text(row, 'content_account_id')
  const result: GenStudioContentReceipts = {
    accountId,
    contentAccountId,
    restoreReceipt: parseSignedReceiptEnvelope(row.restore_receipt, RESTORE_TYPE, 'restore_receipt'),
    purchaseReceipts: array(row, 'purchase_receipts').map((value, index) => {
      const receipt = parseSignedReceiptEnvelope(value, RECEIPT_TYPE, `purchase_receipts[${index}]`)
      const envelope = receipt.raw.value
      const signed = receipt.signedReceipt.value
      const purchaseId = text(envelope, 'purchase_id')
      const creditsCharged = uint(envelope, 'credits_charged')
      if (signed.purchase_id !== purchaseId) throw new Error(`purchase_receipts[${index}] purchase_id does not match its signed receipt`)
      if (signed.account_id !== accountId) throw new Error(`purchase_receipts[${index}] account_id does not match the restore account`)
      if (signed.credits_charged !== creditsCharged) throw new Error(`purchase_receipts[${index}] credits_charged does not match its signed receipt`)
      return { ...receipt, purchaseId, creditsCharged, createdAt: isoInstant(envelope, 'created_at') }
    }),
    entitlements: array(row, 'entitlements').map((value, index) => {
      const entitlementRaw = canonicalizeContentStoreObject(value)
      const entitlement = entitlementRaw.value
      const currentRelease = parseOptionalRelease(entitlement.current_release, `entitlements[${index}].current_release`)
      const downloadAvailable = bool(entitlement, 'download_available')
      if (downloadAvailable !== Boolean(currentRelease?.archiveAvailable)) {
        throw new Error(`entitlements[${index}] download_available must match current release archive availability`)
      }
      return {
        entitlementId: text(entitlement, 'entitlement_id'),
        entitlementFamily: text(entitlement, 'entitlement_family'),
        productId: text(entitlement, 'product_id'),
        title: text(entitlement, 'title'),
        kind: kind(entitlement),
        publisherId: text(entitlement, 'publisher_id'),
        grantedAt: isoInstant(entitlement, 'granted_at'),
        purchaseId: nullableText(entitlement, 'purchase_id'),
        retired: bool(entitlement, 'retired'),
        currentRelease,
        downloadAvailable,
        recalledReleaseVersions: optionalTextArray(entitlement, 'recalled_release_versions'),
        showcaseVideos: parseShowcaseVideos(entitlement.showcase_videos, `entitlements[${index}].showcase_videos`),
        raw: entitlementRaw,
      }
    }),
    raw,
  }
  assertRestoreCoherence(result)
  return result
}

export function parseOwnedContentReleases(value: unknown): GenStudioOwnedContentReleases {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const currentReleaseId = nullableText(row, 'current_release_id')
  const releases = array(row, 'releases').map((value, index): GenStudioOwnedContentRelease => {
    const release = parseRelease(value, `releases[${index}]`)
    const source = release.raw.value
    const state = text(source, 'state')
    if (state !== 'published' && state !== 'withdrawn' && state !== 'recalled') {
      throw new Error(`releases[${index}].state must be published, withdrawn, or recalled`)
    }
    const publishedAt = source.published_at === null ? null : isoInstant(source, 'published_at')
    const current = bool(source, 'current')
    const recalledAt = source.recalled_at === undefined || source.recalled_at === null
      ? null
      : isoInstant(source, 'recalled_at')
    const recallReason = source.recall_reason === undefined || source.recall_reason === null
      ? null
      : text(source, 'recall_reason')
    if (state === 'recalled') {
      if (current) throw new Error(`releases[${index}] recalled release cannot be current`)
      if (!recalledAt || !recallReason) {
        throw new Error(`releases[${index}] recalled release requires recalled_at and recall_reason`)
      }
    } else if (recalledAt !== null || recallReason !== null) {
      throw new Error(`releases[${index}] non-recalled release must not carry recall metadata`)
    }
    return { ...release, state, publishedAt, current, recalledAt, recallReason }
  })
  if (new Set(releases.map(release => release.releaseId)).size !== releases.length) {
    throw new Error('Owned release history contains a duplicate release_id')
  }
  if (new Set(releases.map(release => release.version)).size !== releases.length) {
    throw new Error('Owned release history contains a duplicate version')
  }
  const current = releases.filter(release => release.current)
  if ((currentReleaseId === null && current.length !== 0)
    || (currentReleaseId !== null && (current.length !== 1 || current[0]?.releaseId !== currentReleaseId))) {
    throw new Error('Owned release history current release does not match current_release_id')
  }
  return {
    entitlementFamily: text(row, 'entitlement_family'),
    entitlementId: text(row, 'entitlement_id'),
    productId: text(row, 'product_id'),
    title: text(row, 'title'),
    kind: kind(row),
    publisherId: text(row, 'publisher_id'),
    grantedAt: isoInstant(row, 'granted_at'),
    retired: bool(row, 'retired'),
    currentReleaseId,
    releases,
    raw,
  }
}

export function parseContentStoreDownloadGrant(value: unknown): GenStudioContentDownloadGrant {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const signedGrant = canonicalizeContentStoreObject(row.grant)
  if (signedGrant.value.typ !== DOWNLOAD_TYPE) throw new Error(`Signed download grant typ must be ${DOWNLOAD_TYPE}`)
  const keyId = text(row, 'key_id')
  if (signedGrant.value.key_id !== keyId) throw new Error('Signed download grant key_id does not match its envelope')
  const scalarFields = [
    'grant_id', 'account_id', 'product_id', 'entitlement_family', 'release_id', 'pack_id', 'version',
    'archive_sha256', 'archive_bytes', 'expires_at',
  ]
  for (const field of scalarFields) {
    if (signedGrant.value[field] !== row[field]) throw new Error(`Signed download grant ${field} does not match its envelope`)
  }
  const archiveSha256 = text(row, 'archive_sha256')
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) throw new Error('archive_sha256 must be 64 lowercase hexadecimal characters')
  const archiveBytes = uint(row, 'archive_bytes')
  if (archiveBytes < 1 || archiveBytes > MAX_PUBLISHED_ARCHIVE_BYTES) {
    throw new Error(`archive_bytes must be between 1 and ${MAX_PUBLISHED_ARCHIVE_BYTES}`)
  }
  const ttlSeconds = uint(row, 'ttl_seconds')
  if (ttlSeconds !== 900) throw new Error('ttl_seconds must match the published 900-second grant lifetime')
  isoInstant(signedGrant.value, 'issued_at')
  const expiresAt = isoInstant(row, 'expires_at')
  const grantSignature = text(row, 'grant_signature')
  strictBase64(grantSignature, 'grant_signature', 64)
  return {
    grantId: text(row, 'grant_id'),
    accountId: text(row, 'account_id'),
    productId: text(row, 'product_id'),
    entitlementFamily: text(row, 'entitlement_family'),
    releaseId: text(row, 'release_id'),
    packId: text(row, 'pack_id'),
    version: text(row, 'version'),
    archiveSha256,
    archiveBytes,
    downloadUrl: text(row, 'download_url'),
    expiresAt,
    ttlSeconds,
    signedGrant,
    grantSignature,
    keyId,
    raw,
  }
}

interface RequestOptions<T> {
  method: 'GET' | 'POST'
  path: string
  apiKey: string
  timeoutMs: number
  body?: string
  idempotencyKey?: string
  purchase?: boolean
  parse: (value: unknown) => T
}

function errorBody(textBody: string): Record<string, unknown> {
  if (Buffer.byteLength(textBody, 'utf8') > MAX_CANONICAL_BYTES) throw new Error('GenStudio Content Store error response exceeds 1 MiB')
  try {
    const parsed = parseJsonPreservingNumberSources(textBody)
    return canonicalizeContentStoreObject(parsed).value
  } catch {
    return { raw_response: textBody }
  }
}

class ContentStoreResponseTooLargeError extends Error {
  constructor() {
    super('GenStudio Content Store response exceeds 1 MiB')
  }
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_CANONICAL_BYTES) {
        await reader.cancel().catch(() => {})
        throw new ContentStoreResponseTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

async function requestOnce<T>(options: RequestOptions<T>): Promise<T> {
  const baseUrl = (await getGenStudioUrl()).replace(/\/+$/, '')
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${options.apiKey}`,
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey
  let pending: Promise<Response>
  try {
    pending = globalThis.fetch(`${baseUrl}${options.path}`, {
      method: options.method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    throw new GenStudioContentStoreTransportError('not-sent', 'The Content Store request was not sent.', error)
  }
  let response: Response
  try {
    response = await pending
  } catch (error) {
    throw new GenStudioContentStoreTransportError(
      options.purchase ? 'uncertain' : 'not-sent',
      options.purchase
        ? 'The Content Store purchase outcome is uncertain; retry only with the same saved idempotency key.'
        : 'The Content Store request did not receive a response.',
      error,
    )
  }
  let responseText: string
  try {
    responseText = await readBoundedResponseBody(response)
  } catch (error) {
    if (options.purchase && response.ok) {
      throw new GenStudioContentStoreTransportError(
        'uncertain',
        'The Content Store purchase response was interrupted; retry only with the same saved idempotency key.',
        error,
      )
    }
    if (!response.ok) {
      if (error instanceof ContentStoreResponseTooLargeError) throw error
      throw new GenStudioContentStoreApiError(
        response.status,
        null,
        `GenStudio Content Store returned HTTP ${response.status}, but its refusal body could not be read.`,
        {},
      )
    }
    throw error
  }
  if (!response.ok) {
    const refusal = errorBody(responseText)
    const code = typeof refusal.code === 'string' ? refusal.code : null
    const detail = typeof refusal.detail === 'string'
      ? refusal.detail
      : responseText || `GenStudio Content Store returned HTTP ${response.status}`
    throw new GenStudioContentStoreApiError(response.status, code, detail, refusal)
  }
  let parsed: unknown
  try {
    parsed = parseJsonPreservingNumberSources(responseText)
  } catch (error) {
    if (options.purchase) {
      throw new GenStudioContentStoreTransportError(
        'uncertain',
        'The Content Store purchase returned an unreadable response; retry only with the same saved idempotency key.',
        error,
      )
    }
    throw new Error('GenStudio Content Store returned invalid JSON', { cause: error })
  }
  try {
    return options.parse(parsed)
  } catch (error) {
    if (options.purchase) {
      throw new GenStudioContentStoreTransportError(
        'uncertain',
        'The Content Store purchase response did not match the published contract; retry only with the same saved idempotency key.',
        error,
      )
    }
    throw error
  }
}

function assertApiKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new TypeError('GenStudio API key is required')
}

export async function getGenStudioContentAccount(apiKey: string): Promise<GenStudioContentAccount> {
  assertApiKey(apiKey)
  return requestOnce({
    method: 'GET', path: '/v1/content/account', apiKey, timeoutMs: 8_000,
    parse: parseContentStoreAccount,
  })
}

export async function getGenStudioContentPublicKey(apiKey: string): Promise<GenStudioContentPublicKey> {
  assertApiKey(apiKey)
  return requestOnce({
    method: 'GET', path: '/v1/content/public-key', apiKey, timeoutMs: 8_000,
    parse: parseContentStorePublicKey,
  })
}

export async function getGenStudioContentReceipts(apiKey: string): Promise<GenStudioContentReceipts> {
  assertApiKey(apiKey)
  return requestOnce({
    method: 'GET', path: '/v1/content/receipts', apiKey, timeoutMs: 12_000,
    parse: parseContentStoreReceipts,
  })
}

export async function listGenStudioOwnedContentReleases(
  apiKey: string,
  entitlementFamily: string,
): Promise<GenStudioOwnedContentReleases> {
  assertApiKey(apiKey)
  if (typeof entitlementFamily !== 'string' || entitlementFamily.length === 0) {
    throw new TypeError('entitlement family is required')
  }
  return requestOnce({
    method: 'GET',
    path: `/v1/content/entitlements/${encodeURIComponent(entitlementFamily)}/releases`,
    apiKey,
    timeoutMs: 12_000,
    parse: parseOwnedContentReleases,
  })
}

export async function listGenStudioContentProducts(
  apiKey: string,
  storyVersion: string,
): Promise<GenStudioContentCatalog> {
  assertApiKey(apiKey)
  if (typeof storyVersion !== 'string' || storyVersion.length === 0) throw new TypeError('Story Studio version is required')
  return requestOnce({
    method: 'GET', path: `/v1/content/products?story_version=${encodeURIComponent(storyVersion)}`,
    apiKey, timeoutMs: 8_000, parse: parseContentStoreCatalog,
  })
}

export async function listGenStudioContentStoreShelves(
  apiKey: string,
  storyVersion: string,
  visibleProductIds: readonly string[],
): Promise<GenStudioContentStoreShelves> {
  assertApiKey(apiKey)
  if (typeof storyVersion !== 'string' || storyVersion.length === 0) throw new TypeError('Story Studio version is required')
  return requestOnce({
    method: 'GET', path: `/v1/content/shelves?story_version=${encodeURIComponent(storyVersion)}`,
    apiKey, timeoutMs: 8_000,
    parse: value => parseContentStoreShelves(value, visibleProductIds),
  })
}

export async function quoteGenStudioContentProduct(
  apiKey: string,
  request: { product_id: string; release_id: string | null },
): Promise<GenStudioContentQuote> {
  assertApiKey(apiKey)
  if (typeof request.product_id !== 'string' || request.product_id.length === 0) throw new TypeError('product_id is required')
  if (request.release_id !== null && (typeof request.release_id !== 'string' || request.release_id.length === 0)) {
    throw new TypeError('release_id must be a non-empty string or null')
  }
  return requestOnce({
    method: 'POST', path: '/v1/content/quotes', apiKey, timeoutMs: 8_000,
    body: JSON.stringify({ product_id: request.product_id, release_id: request.release_id }),
    parse: parseContentStoreQuote,
  })
}

export async function purchaseGenStudioContentProduct(
  apiKey: string,
  request: { quoteCanonicalJson: string; quoteSignature: string; idempotencyKey: string },
): Promise<GenStudioContentPurchase> {
  assertApiKey(apiKey)
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 8 || request.idempotencyKey.length > 128) {
    throw new TypeError('Content Store purchase idempotency key must contain 8 to 128 characters')
  }
  if (typeof request.quoteSignature !== 'string' || request.quoteSignature.length === 0) throw new TypeError('quote signature is required')
  let canonicalQuote: CanonicalJsonObject
  try { canonicalQuote = canonicalizeContentStoreJson(request.quoteCanonicalJson) } catch (error) {
    throw new TypeError('Saved Content Store quote JSON is invalid', { cause: error })
  }
  if (canonicalQuote.canonicalJson !== request.quoteCanonicalJson) {
    throw new TypeError('Saved Content Store quote JSON is not canonical')
  }
  return requestOnce({
    method: 'POST', path: '/v1/content/purchases', apiKey, timeoutMs: 30_000,
    idempotencyKey: request.idempotencyKey,
    body: `{"quote":${request.quoteCanonicalJson},"quote_signature":${JSON.stringify(request.quoteSignature)}}`,
    purchase: true,
    parse: parseContentStorePurchase,
  })
}

export async function issueGenStudioContentDownload(
  apiKey: string,
  target: { releaseId: string } | { entitlementFamily: string; version: string },
): Promise<GenStudioContentDownloadGrant> {
  assertApiKey(apiKey)
  let body: { release_id: string } | { entitlement_family: string; version: string }
  if ('releaseId' in target) {
    if (typeof target.releaseId !== 'string' || target.releaseId.length === 0) throw new TypeError('release_id is required')
    body = { release_id: target.releaseId }
  } else {
    if (typeof target.entitlementFamily !== 'string' || target.entitlementFamily.length === 0) {
      throw new TypeError('entitlement_family is required')
    }
    if (typeof target.version !== 'string' || target.version.length === 0) throw new TypeError('version is required')
    body = { entitlement_family: target.entitlementFamily, version: target.version }
  }
  return requestOnce({
    method: 'POST', path: '/v1/content/downloads', apiKey, timeoutMs: 12_000,
    body: JSON.stringify(body),
    parse: parseContentStoreDownloadGrant,
  })
}

export async function downloadGenStudioContentArchive(
  downloadUrl: string,
  expected: { archiveSha256: string; archiveBytes: number },
): Promise<Uint8Array> {
  if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) throw new TypeError('Content Store download URL is required')
  let parsedDownloadUrl: URL
  try { parsedDownloadUrl = new URL(downloadUrl) } catch (error) {
    throw new TypeError('Content Store download URL must be an absolute HTTP(S) URL', { cause: error })
  }
  if (!['http:', 'https:'].includes(parsedDownloadUrl.protocol)) {
    throw new TypeError('Content Store download URL must use HTTP or HTTPS')
  }
  if (parsedDownloadUrl.username || parsedDownloadUrl.password) {
    throw new TypeError('Content Store download URL must not contain embedded credentials')
  }
  if (!/^[0-9a-f]{64}$/.test(expected.archiveSha256)) throw new TypeError('Expected archive SHA-256 must be 64 lowercase hexadecimal characters')
  if (!Number.isSafeInteger(expected.archiveBytes) || expected.archiveBytes < 1 || expected.archiveBytes > MAX_LOCAL_ARCHIVE_BYTES) {
    throw new TypeError(`Expected archive size must be between 1 and ${MAX_LOCAL_ARCHIVE_BYTES} bytes`)
  }

  let pending: Promise<Response>
  try {
    pending = globalThis.fetch(downloadUrl, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    })
  } catch (error) {
    throw new GenStudioContentStoreTransportError('not-sent', 'The Content Store archive request was not sent.', error)
  }
  let response: Response
  try {
    response = await pending
  } catch (error) {
    throw new GenStudioContentStoreTransportError('not-sent', 'The Content Store archive request did not receive a response.', error)
  }
  if (!response.ok) {
    let responseText = ''
    try { responseText = await readBoundedResponseBody(response) } catch { /* keep refusal bounded */ }
    const refusal = errorBody(responseText)
    const code = typeof refusal.code === 'string' ? refusal.code : null
    const detail = typeof refusal.detail === 'string'
      ? refusal.detail
      : responseText || `GenStudio Content Store archive returned HTTP ${response.status}`
    throw new GenStudioContentStoreApiError(response.status, code, detail, refusal)
  }

  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expected.archiveBytes) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Content Store archive size does not match the expected ${expected.archiveBytes} bytes`)
    }
  }
  if (!response.body) throw new Error('Content Store archive response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > expected.archiveBytes || length > MAX_LOCAL_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(`Content Store archive exceeds its expected ${expected.archiveBytes} byte size or ${MAX_LOCAL_ARCHIVE_BYTES} byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (length !== expected.archiveBytes) {
    throw new Error(`Content Store archive size ${length} does not match expected ${expected.archiveBytes} bytes`)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== expected.archiveSha256) {
    throw new Error(`Content Store archive SHA-256 does not match expected digest ${expected.archiveSha256}`)
  }
  return bytes
}
