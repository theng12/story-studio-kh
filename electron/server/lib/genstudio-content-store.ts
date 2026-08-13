import { getGenStudioUrl } from '../services/app-settings.js'
export { resolveStoryStudioVersion } from './app-version.js'

const MAX_DEPTH = 32
const MAX_NODES = 4_096
const MAX_STRING_BYTES = 256 * 1024
const MAX_CANONICAL_BYTES = 1024 * 1024
const QUOTE_TYPE = 'genstudio.content.quote.v1'
const RECEIPT_TYPE = 'genstudio.content.receipt.v1'
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PRODUCT_KINDS = new Set<GenStudioContentProductKind>([
  'series_formula', 'topic_pack', 'visual_style', 'thumbnail_recipe', 'niche_bundle',
])
const numberSources = new WeakMap<object, Map<string, string>>()

type JsonPrimitive = null | boolean | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

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
  quotedCredits: number
  balanceBefore: number
  balanceAfter: number
  ownedComponents: string[]
  sufficientCredits: boolean
  insufficientReason: string | null
  shortfallCredits: number
  raw: CanonicalJsonObject
}

export interface GenStudioContentReceipt {
  signedReceipt: CanonicalJsonObject
  receiptSignature: string
  keyId: string
  raw: CanonicalJsonObject
}

export interface GenStudioContentPurchase {
  purchaseId: string
  accountId: string
  creditsCharged: number
  discountCredits: number
  balanceBefore: number
  balanceAfter: number
  entitlementIds: string[]
  entitlementFamilies: string[]
  product: CanonicalJsonObject
  release: CanonicalJsonObject
  ledgerEventKey: string | null
  receipt: GenStudioContentReceipt
  replayed: boolean
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
  return {
    releaseId: text(row, 'release_id'),
    packId: text(row, 'pack_id'),
    version: text(row, 'version'),
    archiveSha256,
    archiveBytes: uint(row, 'archive_bytes'),
    minStoryVersion: text(row, 'min_story_version'),
    changelog: typeof row.changelog === 'string' ? row.changelog : (() => { throw new Error(`${field}.changelog must be a string`) })(),
    componentSummary,
    raw,
  }
}

function parseOptionalRelease(value: unknown, field: string): GenStudioContentRelease | null {
  return value === null ? null : parseRelease(value, field)
}

function parseProduct(value: unknown): GenStudioContentProduct {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const creditPrice = uint(row, 'credit_price')
  const free = bool(row, 'free')
  if (free !== (creditPrice === 0)) throw new Error('free must match whether credit_price is zero')
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
        raw: ownedRaw,
      }
    }),
    raw,
  }
}

export function parseContentStoreCatalog(value: unknown): GenStudioContentCatalog {
  const raw = canonicalizeContentStoreObject(value)
  return { products: array(raw.value, 'products').map(parseProduct), raw }
}

function assertSignedQuoteCoherence(signed: Record<string, unknown>, envelope: Record<string, unknown>): void {
  const scalarFields = [
    'quote_id', 'account_id', 'product_id', 'entitlement_family', 'release_id', 'expires_at',
    'base_credit_price', 'discount_credits', 'quoted_credits',
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
}

export function parseContentStoreQuote(value: unknown): GenStudioContentQuote {
  const raw = canonicalizeContentStoreObject(value)
  const row = raw.value
  const signedQuote = canonicalizeContentStoreObject(row.quote)
  if (signedQuote.value.typ !== QUOTE_TYPE) throw new Error(`Signed quote typ must be ${QUOTE_TYPE}`)
  const keyId = text(row, 'key_id')
  if (signedQuote.value.key_id !== keyId) throw new Error('Signed quote key_id does not match its envelope')
  assertSignedQuoteCoherence(signedQuote.value, row)

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
    entitlementFamily: text(row, 'entitlement_family'),
    releaseId: text(row, 'release_id'),
    baseCreditPrice: uint(row, 'base_credit_price'),
    discountCredits: uint(row, 'discount_credits'),
    quotedCredits: uint(row, 'quoted_credits'),
    balanceBefore: uint(row, 'balance_before'),
    balanceAfter: uint(row, 'balance_after'),
    ownedComponents: textArray(row, 'owned_components'),
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

  return {
    purchaseId: text(row, 'purchase_id'),
    accountId: text(row, 'account_id'),
    creditsCharged: uint(row, 'credits_charged'),
    discountCredits: uint(row, 'discount_credits'),
    balanceBefore: uint(row, 'balance_before'),
    balanceAfter: uint(row, 'balance_after'),
    entitlementIds: textArray(row, 'entitlement_ids'),
    entitlementFamilies: textArray(row, 'entitlement_families'),
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
  let quoteValue: unknown
  try { quoteValue = parseJsonPreservingNumberSources(request.quoteCanonicalJson) } catch (error) {
    throw new TypeError('Saved Content Store quote JSON is invalid', { cause: error })
  }
  const canonicalQuote = canonicalizeContentStoreObject(quoteValue)
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
