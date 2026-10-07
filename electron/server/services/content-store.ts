import {
  GenStudioContentStoreApiError,
  GenStudioContentStoreTransportError,
  canonicalizeContentStoreObject,
  getGenStudioContentAccount,
  getGenStudioContentReceipts,
  listGenStudioOwnedContentReleases,
  listGenStudioContentProducts,
  listGenStudioContentStoreShelves,
  purchaseGenStudioContentProduct,
  parseContentStorePublicKey,
  quoteGenStudioContentProduct,
  resolveStoryStudioVersion,
  type GenStudioContentAccount,
  type GenStudioContentProduct,
  type GenStudioOwnedContentRelease,
} from '../lib/genstudio-content-store.js'
import { verifyContentStoreRestoreReceipt } from '../lib/genstudio-content-store-trust.js'
import { getApiKey } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'
import {
  claimPurchaseAttempt,
  readContentStoreCommerceState,
  readVerifiedContentStoreRestore,
  recordCompletedPurchase,
  recordPurchaseRefusal,
  recordPurchaseUncertain,
  recoverInterruptedContentPurchases,
  resolveVerifiedContentStoreSigningKey,
  restoreQuotedAfterPurchaseScopeRefusal,
  restoreQuotedAfterPurchaseNotSent,
  saveQuotedAttempt,
} from '../content-store/commerce-state.js'
import {
  resolveContentStoreInstallSnapshot,
  reconcileContentStoreRecalledVersions,
  type ContentStoreInstallState,
  type ContentStoreLocalInstallState,
} from './content-store-install-state.js'
import {
  CachedContentRefusalSchema,
  type CachedContentQuote,
  type CachedContentRefusal,
} from '../content-store/types.js'

export interface PublicContentPurchaseAttempt {
  quote_id: string
  account_id: string
  product_id: string
  release_id: string
  entitlement_family: string
  expires_at: string
  status: CachedContentQuote['status']
  base_credit_price: number
  discount_credits: number
  entitlement_families?: string[]
  bundle_closure?: Array<{
    position: number
    product_id: string
    entitlement_family: string
    release_id: string
    version: string
    archive_sha256: string
  }>
  dependencies?: PublicContentDependency[]
  operator_discount?: {
    discount_id: string
    version: number
    percent: number
    starts_on: string | null
    ends_on: string | null
    timezone: 'Asia/Phnom_Penh'
  } | null
  operator_discount_credits?: number
  quoted_credits: number
  balance_before: number
  balance_after: number
  owned_components: string[]
  sufficient_credits: boolean
  insufficient_reason: 'insufficient_credits' | null
  shortfall_credits: number
  refusal?: CachedContentRefusal
  uncertain_detail?: string
  ownership?: 'owned_not_installed'
  credits_charged?: number
  component_discount_credits?: number
  granted_families?: string[]
  previously_owned_families?: string[]
  replayed?: boolean
  receipt_verification?: 'unverified_phase1'
}

export type PublicContentAccount = Omit<GenStudioContentAccount, 'raw' | 'owned'> & {
  owned: Array<Omit<GenStudioContentAccount['owned'][number], 'raw' | 'currentRelease'> & {
    currentRelease: PublicContentRelease | null
    recalledReleaseVersions: string[]
    receiptVerification: 'verified' | 'unverified'
    downloadAvailable: boolean
    installState: ContentStoreInstallState
    installedVersion: string | null
    missingDependencies: Array<{ packId: string; version: string; reason: string }>
  }>
}

export interface PublicContentInstalledPack {
  packId: string
  version: string
  active: boolean
  installState: 'installed_current' | 'incomplete'
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
  productId: string
  title: string
  kind: GenStudioContentAccount['owned'][number]['kind'] | 'unknown'
  ownedByActiveAccount: boolean
}

export type PublicContentRelease = Omit<GenStudioContentProduct['currentRelease'] & {}, 'raw' | 'componentSummary'> & {
  componentSummary: Record<string, unknown>
}

export interface PublicContentProductPresentation {
  cover: { src: string; alt: string } | null
  hero: { src: string; alt: string } | null
  licenseLabel: string | null
  licenseText: string | null
  tags: string[]
}

export type PublicContentDependencyState =
  | 'free' | 'owned' | 'included' | 'installed'
  | 'unavailable' | 'withdrawn' | 'recalled'

export interface PublicContentDependency {
  position: number
  productId: string
  entitlementFamily: string
  releaseId: string
  version: string
  archiveSha256: string
  title: string
  kind: GenStudioContentProduct['kind'] | 'unknown'
  states: PublicContentDependencyState[]
}

export interface PublicContentProductDiscount {
  id: string
  version: number
  percent: number
  startsOn: string | null
  endsOn: string | null
  timezone: 'Asia/Phnom_Penh'
  listCreditPrice: number
  discountedCreditPrice: number
}

export interface PublicContentStoreShelf {
  id: string
  title: string
  productIds: string[]
}

export type PublicContentProduct = Omit<GenStudioContentProduct,
  'raw' | 'currentRelease' | 'bundleComponents' | 'cover' | 'hero' | 'tags' | 'license' | 'discount'
> & {
  currentRelease: PublicContentRelease | null
  bundleComponents: Array<Omit<GenStudioContentProduct['bundleComponents'][number], 'raw'>>
  presentation: PublicContentProductPresentation
  discount: PublicContentProductDiscount | null
}

export interface ContentStoreOverview {
  phase: 'delivery_ready'
  origin: string
  account: PublicContentAccount
  installed: PublicContentInstalledPack[]
  products: PublicContentProduct[]
  shelves: PublicContentStoreShelf[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: {
    purchase: true
    receipt_verification: true
    download: true
    install_after_purchase: true
    restore: true
  }
}


export class ContentStoreLocalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly attempt?: PublicContentPurchaseAttempt,
  ) {
    super(detail)
    this.name = 'ContentStoreLocalError'
  }
}

export class ContentStoreUpstreamRefusal extends Error {
  constructor(
    readonly status: number,
    readonly refusal: CachedContentRefusal,
    readonly attempt: PublicContentPurchaseAttempt,
  ) {
    super(refusal.detail)
    this.name = 'ContentStoreUpstreamRefusal'
  }
}

const activePurchaseClaims = new Map<string, Promise<PublicContentPurchaseAttempt>>()
async function currentGenStudioOrigin(): Promise<string> {
  return new URL(await getGenStudioUrl()).origin
}

async function cachedVerifiedFamilies(accountId: string): Promise<Set<string>> {
  const cached = await readVerifiedContentStoreRestore({ accountId, origin: await currentGenStudioOrigin() })
  if (!cached) return new Set()
  try {
    const trustedKey = await resolveVerifiedContentStoreSigningKey({
      accountId, origin: cached.genstudio_origin, keyId: cached.key_id,
    })
    const publicKey = parseContentStorePublicKey({
      key_id: cached.key_id,
      algorithm: 'ed25519',
      public_key_base64: trustedKey,
      payload_types: [
        'genstudio.content.download.v1', 'genstudio.content.quote.v1',
        'genstudio.content.receipt.v1', 'genstudio.content.restore.v1',
      ],
      canonicalization: 'json:sorted-keys,no-whitespace,utf-8',
    })
    const payloadValue = JSON.parse(cached.receipt_canonical_json) as Record<string, unknown>
    const signedReceipt = canonicalizeContentStoreObject(payloadValue)
    verifyContentStoreRestoreReceipt(publicKey, {
      signedReceipt,
      receiptSignature: cached.receipt_signature,
      keyId: cached.key_id,
      raw: canonicalizeContentStoreObject({
        receipt: payloadValue,
        receipt_signature: cached.receipt_signature,
        key_id: cached.key_id,
      }),
    }, accountId)
    const families = signedReceipt.value.entitlement_families
    return new Set(Array.isArray(families) ? families.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

function publicAttempt(
  attempt: CachedContentQuote,
  dependencies?: PublicContentDependency[],
): PublicContentPurchaseAttempt {
  const completed = attempt.completed_purchase
  const finalOperatorDiscount = completed?.operator_discount !== undefined
    ? completed.operator_discount
    : attempt.operator_discount
  const finalOperatorDiscountCredits = completed?.operator_discount !== undefined
    ? completed.operator_discount_credits
    : attempt.operator_discount_credits
  return {
    quote_id: attempt.quote_id,
    account_id: attempt.account_id,
    product_id: attempt.product_id,
    release_id: attempt.release_id,
    entitlement_family: attempt.entitlement_family,
    expires_at: attempt.expires_at,
    status: attempt.status,
    base_credit_price: completed?.base_credit_price ?? attempt.base_credit_price,
    discount_credits: completed?.discount_credits ?? attempt.discount_credits,
    quoted_credits: attempt.quoted_credits,
    balance_before: completed?.balance_before ?? attempt.balance_before,
    balance_after: completed?.balance_after ?? attempt.balance_after,
    owned_components: [...attempt.owned_components],
    sufficient_credits: attempt.sufficient_credits,
    insufficient_reason: attempt.insufficient_reason,
    shortfall_credits: attempt.shortfall_credits,
    ...(attempt.entitlement_families ? {
      entitlement_families: [...(completed?.entitlement_families ?? attempt.entitlement_families)],
    } : {}),
    ...((completed?.bundle_closure ?? attempt.bundle_closure) ? {
      bundle_closure: structuredClone(completed?.bundle_closure ?? attempt.bundle_closure) as NonNullable<PublicContentPurchaseAttempt['bundle_closure']>,
    } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(finalOperatorDiscount !== undefined ? {
      operator_discount: structuredClone(finalOperatorDiscount) as PublicContentPurchaseAttempt['operator_discount'],
      operator_discount_credits: finalOperatorDiscountCredits,
    } : {}),
    ...(attempt.last_refusal ? { refusal: { ...attempt.last_refusal } } : {}),
    ...(attempt.uncertain_detail ? { uncertain_detail: attempt.uncertain_detail } : {}),
    ...(completed ? {
      ownership: 'owned_not_installed' as const,
      credits_charged: completed.credits_charged,
      ...(completed.component_discount_credits !== undefined ? {
        component_discount_credits: completed.component_discount_credits,
      } : {}),
      ...(completed.granted_families ? { granted_families: [...completed.granted_families] } : {}),
      ...(completed.previously_owned_families ? { previously_owned_families: [...completed.previously_owned_families] } : {}),
      replayed: completed.replayed,
      receipt_verification: completed.receipt.verification,
    } : {}),
  }
}

function publicRelease(
  release: NonNullable<GenStudioContentProduct['currentRelease']>,
): PublicContentRelease {
  return {
    releaseId: release.releaseId,
    packId: release.packId,
    version: release.version,
    archiveSha256: release.archiveSha256,
    archiveBytes: release.archiveBytes,
    archiveAvailable: release.archiveAvailable,
    minStoryVersion: release.minStoryVersion,
    changelog: release.changelog,
    componentSummary: release.componentSummary.value,
  }
}

function publicProduct(product: GenStudioContentProduct): PublicContentProduct {
  return {
    productId: product.productId,
    entitlementFamily: product.entitlementFamily,
    kind: product.kind,
    title: product.title,
    summary: product.summary,
    description: product.description,
    publisherId: product.publisherId,
    creditPrice: product.creditPrice,
    free: product.free,
    owned: product.owned,
    retired: product.retired,
    successorProductId: product.successorProductId,
    currentRelease: product.currentRelease ? publicRelease(product.currentRelease) : null,
    compatible: product.compatible,
    compatibilityReason: product.compatibilityReason,
    bundleComponents: product.bundleComponents.map(component => ({
      productId: component.productId,
      entitlementFamily: component.entitlementFamily,
      title: component.title,
      kind: component.kind,
      componentCreditValue: component.componentCreditValue,
      owned: component.owned,
    })),
    ownedComponentCreditValue: product.ownedComponentCreditValue,
    showcaseVideos: product.showcaseVideos,
    presentation: {
      cover: product.cover ? { src: product.cover.url, alt: product.cover.alt } : null,
      hero: product.hero ? { src: product.hero.url, alt: product.hero.alt } : null,
      licenseLabel: product.license?.label ?? null,
      licenseText: product.license?.text ?? null,
      tags: [...product.tags],
    },
    discount: product.discount ? {
      id: product.discount.discountId,
      version: product.discount.version,
      percent: product.discount.percent,
      startsOn: product.discount.startsOn,
      endsOn: product.discount.endsOn,
      timezone: product.discount.timezone,
      listCreditPrice: product.discount.listCreditPrice,
      discountedCreditPrice: product.discount.discountedCreditPrice,
    } : null,
  }
}

async function publicAccount(
  account: GenStudioContentAccount,
  verifiedFamilies: ReadonlySet<string>,
  installStates: ReadonlyArray<ContentStoreLocalInstallState>,
  recalledVersionsByFamily: ReadonlyMap<string, string[]>,
  compatibleByProduct: ReadonlyMap<string, boolean>,
): Promise<PublicContentAccount> {
  return {
    accountId: account.accountId,
    contentAccountId: account.contentAccountId,
    availableCredits: account.availableCredits,
    contentSpendableCredits: account.contentSpendableCredits,
    owned: account.owned.map((owned, index) => ({
      entitlementFamily: owned.entitlementFamily,
      productId: owned.productId,
      title: owned.title,
      kind: owned.kind,
      grantedAt: owned.grantedAt,
      purchaseId: owned.purchaseId,
      currentRelease: owned.currentRelease ? publicRelease(owned.currentRelease) : null,
      showcaseVideos: owned.showcaseVideos,
      recalledReleaseVersions: [...(recalledVersionsByFamily.get(owned.entitlementFamily) ?? [])],
      receiptVerification: verifiedFamilies.has(owned.entitlementFamily) ? 'verified' as const : 'unverified' as const,
      downloadAvailable: owned.currentRelease?.archiveAvailable === true,
      ...((compatibleByProduct.get(owned.productId) === false
        || (owned.currentRelease && recalledVersionsByFamily.get(owned.entitlementFamily)?.includes(owned.currentRelease.version)))
        ? { installState: 'unavailable' as const, installedVersion: null, missingDependencies: [] }
        : installStates[index]!),
    })),
  }
}

async function activeKey(): Promise<string> {
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) {
    throw new ContentStoreLocalError(
      400,
      'CONTENT_STORE_KEY_REQUIRED',
      'Save your Gateway API Key in Settings → This Mac before opening the Content Store.',
    )
  }
  return apiKey
}

/**
 * How many owned-release-history requests may be in flight at once.
 *
 * Enriching the purchase journal asks GenStudio for one release history per
 * owned entitlement family, and it used to ask for all of them simultaneously:
 * an outer `Promise.all` over every local attempt, each running an inner
 * `Promise.all` over its bundle's closure. For an account owning sixty-five
 * packs across eleven bundles that is far more concurrent requests than
 * GenStudio's connection pool has connections, so the surplus sat waiting for
 * one -- long enough for this client's own request timeouts to fire and turn a
 * healthy store into "the Content Store is unavailable".
 *
 * Six is chosen to stay comfortably inside a small server pool while still
 * being six times faster than a serial walk. It is a ceiling, not a target:
 * the memoised `releaseHistory` map still collapses duplicate families first,
 * so most of these slots go unused on a typical account.
 */
const OWNED_RELEASE_HISTORY_CONCURRENCY = 6

interface PublicDependencyContext {
  apiKey: string
  catalog: GenStudioContentProduct[]
  installed: PublicContentInstalledPack[]
  releaseHistory: Map<string, Promise<PublicOwnedReleaseEvidence>>
  /** Shared gate, so nested fan-outs cannot multiply past the ceiling above. */
  gate: RequestGate
}

interface PublicOwnedReleaseEvidence {
  releases: GenStudioOwnedContentRelease[]
  unavailable: boolean
}

/**
 * A counting semaphore over promises. Held on the context rather than per
 * call site, because the concurrency that mattered was the PRODUCT of two
 * nested fan-outs -- bounding either one alone would still have let the other
 * multiply it back past the ceiling.
 */
interface RequestGate {
  run: <T>(work: () => Promise<T>) => Promise<T>
}

function requestGate(limit: number): RequestGate {
  let active = 0
  const waiting: Array<() => void> = []
  const release = (): void => {
    active -= 1
    waiting.shift()?.()
  }
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
      active += 1
      try {
        return await work()
      } finally {
        release()
      }
    },
  }
}

function dependencyContext(
  apiKey: string,
  catalog: GenStudioContentProduct[],
  installed: PublicContentInstalledPack[],
): PublicDependencyContext {
  return {
    apiKey,
    catalog,
    installed,
    releaseHistory: new Map(),
    gate: requestGate(OWNED_RELEASE_HISTORY_CONCURRENCY),
  }
}

function ownedReleaseHistory(
  context: PublicDependencyContext,
  entitlementFamily: string,
): Promise<PublicOwnedReleaseEvidence> {
  let pending = context.releaseHistory.get(entitlementFamily)
  if (!pending) {
    pending = context.gate
      .run(() => listGenStudioOwnedContentReleases(context.apiKey, entitlementFamily))
      .then(history => ({ releases: history.releases, unavailable: false }))
      .catch(error => {
        if (error instanceof GenStudioContentStoreApiError && (error.status === 403 || error.status === 404)) {
          return { releases: [], unavailable: true }
        }
        throw error
      })
    context.releaseHistory.set(entitlementFamily, pending)
  }
  return pending
}

async function publicDependencies(
  attempt: CachedContentQuote,
  context: PublicDependencyContext,
): Promise<PublicContentDependency[] | undefined> {
  const closure = attempt.completed_purchase?.bundle_closure ?? attempt.bundle_closure
  if (!closure) return undefined
  const completedOwnedFamilies = attempt.completed_purchase
    ? [...(attempt.completed_purchase.granted_families ?? []), ...(attempt.completed_purchase.previously_owned_families ?? [])]
    : []
  const ownedFamilies = new Set(completedOwnedFamilies.length > 0 ? completedOwnedFamilies : attempt.owned_components)
  const histories = new Map<string, PublicOwnedReleaseEvidence>()
  await Promise.all([...ownedFamilies].map(async family => {
    histories.set(family, await ownedReleaseHistory(context, family))
  }))
  const root = context.catalog.find(product => product.productId === attempt.product_id)
  return closure.map(component => {
    const product = context.catalog.find(candidate => candidate.productId === component.product_id)
    const catalogComponent = root?.bundleComponents.find(candidate => candidate.productId === component.product_id)
    const evidence = histories.get(component.entitlement_family)
    const history = evidence?.releases.find(release => (
      release.releaseId === component.release_id
      && release.version === component.version
      && release.archiveSha256 === component.archive_sha256
    ))
    const withdrawn = history?.state === 'withdrawn'
    const recalled = history?.state === 'recalled'
    const unavailable = evidence?.unavailable === true || withdrawn || recalled
    const states: PublicContentDependencyState[] = []
    if (product?.free) states.push('free')
    if (ownedFamilies.has(component.entitlement_family)) states.push('owned')
    states.push('included')
    if (context.installed.some(installed => installed.productId === component.product_id && installed.version === component.version)) {
      states.push('installed')
    }
    if (unavailable) states.push('unavailable')
    if (withdrawn) states.push('withdrawn')
    if (recalled) states.push('recalled')
    return {
      position: component.position,
      productId: component.product_id,
      entitlementFamily: component.entitlement_family,
      releaseId: component.release_id,
      version: component.version,
      archiveSha256: component.archive_sha256,
      title: catalogComponent?.title ?? product?.title ?? component.product_id,
      kind: product?.kind ?? catalogComponent?.kind ?? 'unknown',
      states,
    }
  })
}

async function localAttempts(
  accountId: string,
  context: PublicDependencyContext,
): Promise<PublicContentPurchaseAttempt[]> {
  const state = await readContentStoreCommerceState()
  const attempts = Object.values(state.attempts)
    .filter(attempt => attempt.account_id === accountId)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  const enrichedProducts = new Set<string>()
  return Promise.all(attempts.map(async attempt => {
    if (enrichedProducts.has(attempt.product_id)) return publicAttempt(attempt)
    enrichedProducts.add(attempt.product_id)
    return publicAttempt(attempt, await publicDependencies(attempt, context))
  }))
}

export async function loadContentStoreOverview(): Promise<ContentStoreOverview> {
  const apiKey = await activeKey()
  await recoverInterruptedContentPurchases()
  const storyVersion = await resolveStoryStudioVersion()
  // Account, catalog and receipts depend only on the key, so they are asked
  // for together; shelves need the catalog's product ids and follow it. The
  // four used to run one after another — the live overview took 4.7 s warm and
  // 13 s cold (2026-09-12), most of it waiting on GenStudio in series.
  const accountRequest = getGenStudioContentAccount(apiKey).catch((error: unknown) => {
    if (error instanceof GenStudioContentStoreApiError && error.status === 401) {
      throw new ContentStoreLocalError(
        401,
        'CONTENT_STORE_SCOPE_REQUIRED',
        'The active GenStudio key was not accepted for required content:read access.',
      )
    }
    throw error
  })
  const catalogRequest = listGenStudioContentProducts(apiKey, storyVersion)
  const shelvesRequest = catalogRequest.then(catalog =>
    listGenStudioContentStoreShelves(apiKey, storyVersion, catalog.products.map(product => product.productId)))
  const receiptsRequest = getGenStudioContentReceipts(apiKey)
  // Settle every request so a rejection cannot leave a sibling dangling as an
  // unhandled rejection; the account's refusal keeps precedence, as before.
  const settled = await Promise.allSettled([accountRequest, catalogRequest, receiptsRequest, shelvesRequest])
  for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason
  const account: GenStudioContentAccount = (settled[0] as PromiseFulfilledResult<GenStudioContentAccount>).value
  const catalog = (settled[1] as PromiseFulfilledResult<Awaited<typeof catalogRequest>>).value
  const receipts = (settled[2] as PromiseFulfilledResult<Awaited<typeof receiptsRequest>>).value
  const shelfResponse = (settled[3] as PromiseFulfilledResult<Awaited<typeof shelvesRequest>>).value
  if (receipts.accountId !== account.accountId || receipts.contentAccountId !== account.contentAccountId) {
    throw new ContentStoreLocalError(
      409,
      'CONTENT_STORE_ACCOUNT_MISMATCH',
      'GenStudio returned Content Store recall state for a different account.',
    )
  }
  const recalledVersionsByFamily = new Map(receipts.entitlements.map(entitlement => [
    entitlement.entitlementFamily,
    entitlement.recalledReleaseVersions,
  ]))
  await reconcileContentStoreRecalledVersions({
    accountId: account.accountId,
    origin: await currentGenStudioOrigin(),
    recalledVersionsByFamily,
  })
  const [verifiedFamilies, installSnapshot] = await Promise.all([
    cachedVerifiedFamilies(account.accountId),
    resolveContentStoreInstallSnapshot(account.owned.map(owned => owned.currentRelease)),
  ])
  const catalogByProduct = new Map(catalog.products.map(product => [product.productId, product]))
  const verifiedOwnedProductIds = new Set(account.owned
    .filter(owned => verifiedFamilies.has(owned.entitlementFamily))
    .map(owned => owned.productId))
  const installed: PublicContentInstalledPack[] = installSnapshot.installed.map(local => {
    const product = catalogByProduct.get(local.productId)
    return {
      ...local,
      title: product?.title ?? local.packId,
      kind: product?.kind ?? 'unknown',
      ownedByActiveAccount: verifiedOwnedProductIds.has(local.productId),
    }
  })
  const dependencies = dependencyContext(apiKey, catalog.products, installed)
  return {
    phase: 'delivery_ready',
    origin: await currentGenStudioOrigin(),
    account: await publicAccount(account, verifiedFamilies, installSnapshot.owned, recalledVersionsByFamily,
      new Map(catalog.products.map(product => [product.productId, product.compatible]))),
    installed,
    products: catalog.products.map(publicProduct),
    shelves: [
      ...shelfResponse.shelves.map(shelf => ({ id: shelf.shelfId, title: shelf.title, productIds: [...shelf.productIds] })),
      ...(shelfResponse.fallbackProductIds.length > 0
        ? [{ id: 'fallback', title: 'More Content', productIds: [...shelfResponse.fallbackProductIds] }]
        : []),
    ],
    attempts: await localAttempts(account.accountId, dependencies),
    capabilities: {
      purchase: true,
      receipt_verification: true,
      download: true,
      install_after_purchase: true,
      restore: true,
    },
  }
}

function requirePurchasableProduct(
  products: GenStudioContentProduct[],
  input: { product_id: string; release_id: string | null },
): GenStudioContentProduct {
  const product = products.find(entry => entry.productId === input.product_id)
  if (!product) throw new ContentStoreLocalError(404, 'CONTENT_PRODUCT_NOT_AVAILABLE', 'This Content Store product is not available.')
  if (product.owned) throw new ContentStoreLocalError(409, 'CONTENT_PRODUCT_ALREADY_OWNED', 'This Content Store product is already owned by the active account.')
  if (product.retired) throw new ContentStoreLocalError(409, 'CONTENT_PRODUCT_RETIRED', 'This Content Store product is retired and cannot be newly purchased.')
  if (!product.compatible) throw new ContentStoreLocalError(409, 'CONTENT_PRODUCT_INCOMPATIBLE', product.compatibilityReason || 'This product is not compatible with this Story Studio version.')
  if (!product.currentRelease) throw new ContentStoreLocalError(404, 'CONTENT_RELEASE_NOT_AVAILABLE', 'This product has no published release.')
  if (input.release_id !== null && input.release_id !== product.currentRelease.releaseId) {
    throw new ContentStoreLocalError(404, 'CONTENT_RELEASE_NOT_AVAILABLE', 'The requested Content Store release is not available.')
  }
  return product
}

export async function createContentStoreQuote(input: {
  product_id: string
  release_id: string | null
}): Promise<PublicContentPurchaseAttempt> {
  const apiKey = await activeKey()
  const catalog = await listGenStudioContentProducts(apiKey, await resolveStoryStudioVersion())
  requirePurchasableProduct(catalog.products, input)
  const quote = await quoteGenStudioContentProduct(apiKey, input)
  const saved = await saveQuotedAttempt(quote)
  const installSnapshot = await resolveContentStoreInstallSnapshot(catalog.products.map(product => product.currentRelease))
  const catalogByProduct = new Map(catalog.products.map(product => [product.productId, product]))
  const installed: PublicContentInstalledPack[] = installSnapshot.installed.map(local => ({
    ...local,
    title: catalogByProduct.get(local.productId)?.title ?? local.packId,
    kind: catalogByProduct.get(local.productId)?.kind ?? 'unknown',
    ownedByActiveAccount: false,
  }))
  const dependencies = await publicDependencies(saved, dependencyContext(apiKey, catalog.products, installed))
  return publicAttempt(saved, dependencies)
}

function refusalFrom(error: GenStudioContentStoreApiError): CachedContentRefusal | null {
  const parsed = CachedContentRefusalSchema.safeParse({ status: error.status, ...error.refusal })
  return parsed.success ? parsed.data : null
}

async function purchaseLeader(
  quoteId: string,
  apiKey: string,
  accountId: string,
): Promise<PublicContentPurchaseAttempt> {
  const claim = await claimPurchaseAttempt(quoteId, accountId)
  if (claim.outcome !== 'claimed') return publicAttempt(claim.attempt)
  const submitting = claim.attempt
  try {
    const purchase = await purchaseGenStudioContentProduct(apiKey, {
      quoteCanonicalJson: submitting.quote_canonical_json,
      quoteSignature: submitting.quote_signature,
      idempotencyKey: submitting.idempotency_key,
    })
    return publicAttempt(await recordCompletedPurchase(quoteId, purchase))
  } catch (error) {
    if (error instanceof GenStudioContentStoreApiError) {
      const refusal = refusalFrom(error)
      if (refusal) {
        const attempt = publicAttempt(await recordPurchaseRefusal(quoteId, refusal))
        throw new ContentStoreUpstreamRefusal(error.status, refusal, attempt)
      }
      if (error.status === 401) {
        await restoreQuotedAfterPurchaseScopeRefusal(quoteId)
        throw error
      }
      const detail = 'GenStudio returned a purchase response Story Studio could not safely classify. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.'
      await recordPurchaseUncertain(quoteId, detail)
      throw new ContentStoreLocalError(502, 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN', detail)
    }
    if (error instanceof GenStudioContentStoreTransportError && error.outcome === 'uncertain') {
      const detail = 'Story Studio did not receive GenStudio\'s answer. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.'
      await recordPurchaseUncertain(quoteId, detail)
      throw new ContentStoreLocalError(502, 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN', detail)
    }
    if (error instanceof GenStudioContentStoreTransportError && error.outcome === 'not-sent') {
      await restoreQuotedAfterPurchaseNotSent(quoteId)
      throw new ContentStoreLocalError(502, 'CONTENT_PURCHASE_NOT_SENT', 'Story Studio could not send the purchase request. No credits were debited.')
    }
    const detail = 'Story Studio could not prove the Content Store purchase outcome. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.'
    await recordPurchaseUncertain(quoteId, detail)
    throw new ContentStoreLocalError(502, 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN', detail)
  }
}

export async function confirmContentStorePurchase(quoteId: string): Promise<PublicContentPurchaseAttempt> {
  const state = await readContentStoreCommerceState()
  const saved = state.attempts[quoteId]
  if (!saved) throw new ContentStoreLocalError(404, 'CONTENT_STORE_QUOTE_NOT_FOUND', 'The saved Content Store quote was not found.')

  const apiKey = await activeKey()
  let account: GenStudioContentAccount
  try {
    account = await getGenStudioContentAccount(apiKey)
  } catch (error) {
    if (error instanceof GenStudioContentStoreApiError && error.status === 401) {
      throw new ContentStoreLocalError(
        401,
        'CONTENT_STORE_SCOPE_REQUIRED',
        'The active GenStudio key was not accepted for required content:read access.',
      )
    }
    throw error
  }
  if (account.accountId !== saved.account_id) {
    throw new ContentStoreLocalError(
      409,
      'CONTENT_PURCHASE_ACCOUNT_MISMATCH',
      'This quote belongs to a different GenStudio account. Switch back to that account before purchasing.',
      publicAttempt(saved),
    )
  }

  if (saved.status === 'completed') return publicAttempt(saved)
  if (saved.status === 'submitting') return publicAttempt(saved)
  const follower = activePurchaseClaims.get(quoteId)
  if (follower) return follower
  const claim = purchaseLeader(quoteId, apiKey, account.accountId)
  activePurchaseClaims.set(quoteId, claim)
  try {
    return await claim
  } finally {
    if (activePurchaseClaims.get(quoteId) === claim) activePurchaseClaims.delete(quoteId)
  }
}
