import {
  GenStudioContentStoreApiError,
  GenStudioContentStoreTransportError,
  getGenStudioContentAccount,
  listGenStudioContentProducts,
  purchaseGenStudioContentProduct,
  quoteGenStudioContentProduct,
  resolveStoryStudioVersion,
  type GenStudioContentAccount,
  type GenStudioContentProduct,
} from '../lib/genstudio-content-store.js'
import { getApiKey } from './app-secrets-store.js'
import {
  claimPurchaseAttempt,
  readContentStoreCommerceState,
  recordCompletedPurchase,
  recordPurchaseRefusal,
  recordPurchaseUncertain,
  recoverInterruptedContentPurchases,
  restoreQuotedAfterPurchaseScopeRefusal,
  restoreQuotedAfterPurchaseNotSent,
  saveQuotedAttempt,
} from '../content-store/commerce-state.js'
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
  replayed?: boolean
  receipt_verification?: 'unverified_phase1'
}

export type PublicContentAccount = Omit<GenStudioContentAccount, 'raw' | 'owned'> & {
  owned: Array<Omit<GenStudioContentAccount['owned'][number], 'raw' | 'currentRelease'> & {
    currentRelease: PublicContentRelease | null
  }>
}

export type PublicContentRelease = Omit<GenStudioContentProduct['currentRelease'] & {}, 'raw' | 'componentSummary'> & {
  componentSummary: Record<string, unknown>
}

export type PublicContentProduct = Omit<GenStudioContentProduct, 'raw' | 'currentRelease' | 'bundleComponents'> & {
  currentRelease: PublicContentRelease | null
  bundleComponents: Array<Omit<GenStudioContentProduct['bundleComponents'][number], 'raw'>>
}

export interface ContentStoreOverview {
  phase: 'commerce_core'
  account: PublicContentAccount
  products: PublicContentProduct[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: {
    purchase: true
    receipt_verification: false
    download: false
    install_after_purchase: false
    restore: false
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

function publicAttempt(attempt: CachedContentQuote): PublicContentPurchaseAttempt {
  const completed = attempt.completed_purchase
  return {
    quote_id: attempt.quote_id,
    account_id: attempt.account_id,
    product_id: attempt.product_id,
    release_id: attempt.release_id,
    entitlement_family: attempt.entitlement_family,
    expires_at: attempt.expires_at,
    status: attempt.status,
    base_credit_price: attempt.base_credit_price,
    discount_credits: attempt.discount_credits,
    quoted_credits: attempt.quoted_credits,
    balance_before: completed?.balance_before ?? attempt.balance_before,
    balance_after: completed?.balance_after ?? attempt.balance_after,
    owned_components: [...attempt.owned_components],
    sufficient_credits: attempt.sufficient_credits,
    insufficient_reason: attempt.insufficient_reason,
    shortfall_credits: attempt.shortfall_credits,
    ...(attempt.last_refusal ? { refusal: { ...attempt.last_refusal } } : {}),
    ...(attempt.uncertain_detail ? { uncertain_detail: attempt.uncertain_detail } : {}),
    ...(completed ? {
      ownership: 'owned_not_installed' as const,
      credits_charged: completed.credits_charged,
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
  }
}

function publicAccount(account: GenStudioContentAccount): PublicContentAccount {
  return {
    accountId: account.accountId,
    contentAccountId: account.contentAccountId,
    availableCredits: account.availableCredits,
    contentSpendableCredits: account.contentSpendableCredits,
    owned: account.owned.map(owned => ({
      entitlementFamily: owned.entitlementFamily,
      productId: owned.productId,
      title: owned.title,
      kind: owned.kind,
      grantedAt: owned.grantedAt,
      purchaseId: owned.purchaseId,
      currentRelease: owned.currentRelease ? publicRelease(owned.currentRelease) : null,
    })),
  }
}

async function activeKey(): Promise<string> {
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) {
    throw new ContentStoreLocalError(
      400,
      'CONTENT_STORE_KEY_REQUIRED',
      'Save a GenStudio API key with content:read access before opening the Content Store.',
    )
  }
  return apiKey
}

async function localAttempts(accountId: string): Promise<PublicContentPurchaseAttempt[]> {
  const state = await readContentStoreCommerceState()
  return Object.values(state.attempts)
    .filter(attempt => attempt.account_id === accountId)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .map(publicAttempt)
}

export async function loadContentStoreOverview(): Promise<ContentStoreOverview> {
  const apiKey = await activeKey()
  await recoverInterruptedContentPurchases()
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
  const catalog = await listGenStudioContentProducts(apiKey, await resolveStoryStudioVersion())
  return {
    phase: 'commerce_core',
    account: publicAccount(account),
    products: catalog.products.map(publicProduct),
    attempts: await localAttempts(account.accountId),
    capabilities: {
      purchase: true,
      receipt_verification: false,
      download: false,
      install_after_purchase: false,
      restore: false,
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
  return publicAttempt(await saveQuotedAttempt(quote))
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
