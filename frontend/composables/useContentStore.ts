import { readonly, ref, type Ref } from 'vue'
import { useApi } from './useApi'

export type ContentStoreProductKind =
  | 'series_formula'
  | 'topic_pack'
  | 'visual_style'
  | 'thumbnail_recipe'
  | 'niche_bundle'

export interface ContentStoreRelease {
  releaseId: string
  packId: string
  version: string
  archiveSha256: string
  archiveBytes: number
  minStoryVersion: string
  changelog: string
  componentSummary: Record<string, unknown>
}

export interface ContentStoreBundleComponent {
  productId: string
  entitlementFamily: string
  title: string
  kind: ContentStoreProductKind
  componentCreditValue: number
  owned: boolean
}

export interface ContentStoreProduct {
  productId: string
  entitlementFamily: string
  kind: ContentStoreProductKind
  title: string
  summary: string
  description: string
  publisherId: string
  creditPrice: number
  free: boolean
  owned: boolean
  retired: boolean
  successorProductId: string | null
  currentRelease: ContentStoreRelease | null
  compatible: boolean
  compatibilityReason: string | null
  bundleComponents: ContentStoreBundleComponent[]
  ownedComponentCreditValue: number
}

export interface ContentStoreAccount {
  accountId: string
  contentAccountId: string
  availableCredits: number
  contentSpendableCredits: number
  owned: Array<{
    entitlementFamily: string
    productId: string
    title: string
    kind: ContentStoreProductKind
    grantedAt: string
    purchaseId: string | null
    currentRelease: ContentStoreRelease | null
  }>
}

export type ContentPurchaseStatus = 'quoted' | 'submitting' | 'uncertain' | 'refused' | 'completed'

export interface PublicContentPurchaseAttempt {
  quote_id: string
  account_id: string
  product_id: string
  release_id: string
  entitlement_family: string
  expires_at: string
  status: ContentPurchaseStatus
  base_credit_price: number
  discount_credits: number
  quoted_credits: number
  balance_before: number
  balance_after: number
  owned_components: string[]
  sufficient_credits: boolean
  insufficient_reason: 'insufficient_credits' | null
  shortfall_credits: number
  refusal?: {
    status: number
    code: string
    detail: string
    required_credits?: number
    available_credits?: number
    shortfall_credits?: number
  }
  uncertain_detail?: string
  ownership?: 'owned_not_installed'
  credits_charged?: number
  replayed?: boolean
  receipt_verification?: 'unverified_phase1'
}

interface ContentStoreOverview {
  phase: 'commerce_core'
  account: ContentStoreAccount
  products: ContentStoreProduct[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: {
    purchase: true
    receipt_verification: false
    download: false
    install_after_purchase: false
    restore: false
  }
}

export interface ContentStoreUiError {
  status: number | null
  code: string
  detail: string
  requiredCredits?: number
  availableCredits?: number
  shortfallCredits?: number
}

function uiError(cause: any, fallback: string): ContentStoreUiError {
  const data = cause?.data || cause?.response?._data || {}
  return {
    status: Number.isInteger(cause?.status) ? cause.status
      : Number.isInteger(cause?.response?.status) ? cause.response.status
        : null,
    code: typeof data.code === 'string' ? data.code : 'CONTENT_STORE_UNAVAILABLE',
    detail: typeof data.detail === 'string' ? data.detail
      : typeof cause?.message === 'string' ? cause.message : fallback,
    ...(Number.isInteger(data.required_credits) ? { requiredCredits: data.required_credits } : {}),
    ...(Number.isInteger(data.available_credits) ? { availableCredits: data.available_credits } : {}),
    ...(Number.isInteger(data.shortfall_credits) ? { shortfallCredits: data.shortfall_credits } : {}),
  }
}

export function useContentStore(): {
  account: Readonly<Ref<ContentStoreAccount | null>>
  products: Readonly<Ref<ContentStoreProduct[]>>
  attempts: Readonly<Ref<PublicContentPurchaseAttempt[]>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<ContentStoreUiError | null>>
  refresh: () => Promise<void>
  requestQuote: (productId: string, releaseId?: string | null) => Promise<PublicContentPurchaseAttempt>
  confirmPurchase: (quoteId: string) => Promise<PublicContentPurchaseAttempt>
} {
  const { get, post } = useApi()
  const account = ref<ContentStoreAccount | null>(null)
  const products = ref<ContentStoreProduct[]>([])
  const attempts = ref<PublicContentPurchaseAttempt[]>([])
  const loading = ref(false)
  const error = ref<ContentStoreUiError | null>(null)

  function replaceAttempt(attempt: PublicContentPurchaseAttempt): void {
    const index = attempts.value.findIndex(row => row.quote_id === attempt.quote_id)
    if (index === -1) attempts.value = [attempt, ...attempts.value]
    else attempts.value.splice(index, 1, attempt)
  }

  function applyFailedAttempt(quoteId: string, cause: any): void {
    const data = cause?.data || cause?.response?._data || {}
    if (data.attempt && typeof data.attempt === 'object') {
      replaceAttempt(data.attempt as PublicContentPurchaseAttempt)
      return
    }
    const current = attempts.value.find(row => row.quote_id === quoteId)
    if (!current) return
    const status = data.status
    if (!['quoted', 'submitting', 'uncertain', 'refused', 'completed'].includes(status)) return
    replaceAttempt({
      ...current,
      status,
      ...(status === 'uncertain' ? { uncertain_detail: data.detail } : {}),
      ...(status === 'refused' && typeof data.code === 'string' ? {
        refusal: {
          status: Number(cause?.status || cause?.response?.status || 0),
          code: data.code,
          detail: data.detail || 'GenStudio declined this purchase.',
          ...(Number.isInteger(data.required_credits) ? { required_credits: data.required_credits } : {}),
          ...(Number.isInteger(data.available_credits) ? { available_credits: data.available_credits } : {}),
          ...(Number.isInteger(data.shortfall_credits) ? { shortfall_credits: data.shortfall_credits } : {}),
        },
      } : {}),
    })
  }

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const overview = await get<ContentStoreOverview>('/content-store', { cache: 'no-store' })
      account.value = overview.account
      products.value = overview.products
      attempts.value = overview.attempts
    } catch (cause: any) {
      account.value = null
      products.value = []
      attempts.value = []
      error.value = uiError(cause, 'The Content Store could not be loaded.')
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function requestQuote(productId: string, releaseId: string | null = null): Promise<PublicContentPurchaseAttempt> {
    error.value = null
    try {
      const attempt = await post<PublicContentPurchaseAttempt>('/content-store/quotes', {
        product_id: productId,
        release_id: releaseId,
      })
      replaceAttempt(attempt)
      return attempt
    } catch (cause: any) {
      error.value = uiError(cause, 'GenStudio could not create an exact quote.')
      throw cause
    }
  }

  async function confirmPurchase(quoteId: string): Promise<PublicContentPurchaseAttempt> {
    error.value = null
    try {
      const attempt = await post<PublicContentPurchaseAttempt>(
        `/content-store/quotes/${encodeURIComponent(quoteId)}/purchase`,
        {},
      )
      replaceAttempt(attempt)
      return attempt
    } catch (cause: any) {
      applyFailedAttempt(quoteId, cause)
      error.value = uiError(cause, 'GenStudio could not finish this purchase.')
      throw cause
    }
  }

  return {
    account: readonly(account) as unknown as Readonly<Ref<ContentStoreAccount | null>>,
    products: readonly(products) as unknown as Readonly<Ref<ContentStoreProduct[]>>,
    attempts: readonly(attempts) as unknown as Readonly<Ref<PublicContentPurchaseAttempt[]>>,
    loading: readonly(loading),
    error: readonly(error),
    refresh,
    requestQuote,
    confirmPurchase,
  }
}
