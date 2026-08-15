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
  archiveAvailable: boolean
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

export interface ContentStoreShowcaseVideo {
  url: string
  title: string
  description: string
}

export interface ContentStoreProductPresentation {
  cover: { src: string; alt: string } | null
  licenseLabel: string | null
  tags: string[]
}

export interface ContentStoreProductDiscount {
  id: string
  version: number
  percent: number
  startsOn: string | null
  endsOn: string | null
  timezone: 'Asia/Phnom_Penh'
  listCreditPrice: number
  discountedCreditPrice: number
}

export interface ContentStoreShelf {
  id: string
  title: string
  productIds: string[]
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
  showcaseVideos: ContentStoreShowcaseVideo[]
  presentation: ContentStoreProductPresentation
  discount: ContentStoreProductDiscount | null
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
    showcaseVideos: ContentStoreShowcaseVideo[]
    recalledReleaseVersions: string[]
    receiptVerification: 'verified' | 'unverified'
    downloadAvailable: boolean
    installState: 'not_installed' | 'installed_current' | 'installed_other_version' | 'update_available' | 'incomplete' | 'unavailable'
    installedVersion: string | null
    missingDependencies: Array<{ packId: string; version: string; reason: string }>
  }>
}

export interface ContentStoreInstalledPack {
  packId: string
  version: string
  installState: 'installed_current' | 'incomplete'
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
  productId: string
  title: string
  kind: ContentStoreProductKind | 'unknown'
  ownedByActiveAccount: boolean
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
  phase: 'delivery_ready'
  account: ContentStoreAccount
  installed: ContentStoreInstalledPack[]
  products: ContentStoreProduct[]
  shelves: ContentStoreShelf[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: {
    purchase: true
    receipt_verification: true
    download: true
    install_after_purchase: true
    restore: true
  }
}

export interface ContentStoreUiError {
  status: number | null
  code: string
  detail: string
  requiredCredits?: number
  availableCredits?: number
  shortfallCredits?: number
  terminal?: boolean
  recallReason?: string | null
  recalledAt?: string | null
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
    ...(data.terminal === true ? { terminal: true } : {}),
    ...(typeof data.recall_reason === 'string' || data.recall_reason === null
      ? { recallReason: data.recall_reason as string | null } : {}),
    ...(typeof data.recalled_at === 'string' || data.recalled_at === null
      ? { recalledAt: data.recalled_at as string | null } : {}),
  }
}

export function useContentStore(): {
  account: Readonly<Ref<ContentStoreAccount | null>>
  products: Readonly<Ref<ContentStoreProduct[]>>
  installed: Readonly<Ref<ContentStoreInstalledPack[]>>
  shelves: Readonly<Ref<ContentStoreShelf[]>>
  attempts: Readonly<Ref<PublicContentPurchaseAttempt[]>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<ContentStoreUiError | null>>
  refresh: () => Promise<void>
  requestQuote: (productId: string, releaseId?: string | null) => Promise<PublicContentPurchaseAttempt>
  confirmPurchase: (quoteId: string) => Promise<PublicContentPurchaseAttempt>
  restoreOwnership: () => Promise<void>
  installRelease: (releaseId: string) => Promise<{ pack_id: string; version: string; activated: boolean }>
} {
  const { get, post } = useApi()
  const account = ref<ContentStoreAccount | null>(null)
  const products = ref<ContentStoreProduct[]>([])
  const installed = ref<ContentStoreInstalledPack[]>([])
  const shelves = ref<ContentStoreShelf[]>([])
  const attempts = ref<PublicContentPurchaseAttempt[]>([])
  const loading = ref(false)
  const error = ref<ContentStoreUiError | null>(null)

  let overviewGeneration = 0
  function beginOverviewRequest(): number { overviewGeneration += 1; return overviewGeneration }
  function applyOverview(overview: ContentStoreOverview, generation: number): void {
    if (generation !== overviewGeneration) return
    account.value = overview.account
    products.value = overview.products
    installed.value = overview.installed ?? []
    shelves.value = overview.shelves
    attempts.value = overview.attempts
  }

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
    const generation = beginOverviewRequest()
    loading.value = true
    error.value = null
    try {
      const overview = await get<ContentStoreOverview>('/content-store', { cache: 'no-store' })
      applyOverview(overview, generation)
    } catch (cause: any) {
      if (generation === overviewGeneration) {
        account.value = null
        products.value = []
        installed.value = []
        shelves.value = []
        attempts.value = []
        error.value = uiError(cause, 'The Content Store could not be loaded.')
      }
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
      if (attempt.status === 'completed') {
        try {
          const overview = await get<ContentStoreOverview>('/content-store', { cache: 'no-store' })
          account.value = overview.account
          products.value = overview.products
          installed.value = overview.installed ?? []
          attempts.value = overview.attempts.some(row => row.quote_id === attempt.quote_id)
            ? overview.attempts
            : [attempt, ...overview.attempts]
        } catch {
          // Ownership is already durable. A read-side refresh must not turn success into failure.
        }
      }
      return attempt
    } catch (cause: any) {
      applyFailedAttempt(quoteId, cause)
      error.value = uiError(cause, 'GenStudio could not finish this purchase.')
      throw cause
    }
  }

  async function restoreOwnership(): Promise<void> {
    const generation = beginOverviewRequest()
    loading.value = true
    error.value = null
    try {
      const overview = await post<ContentStoreOverview>('/content-store/restore', {})
      applyOverview(overview, generation)
    } catch (cause: any) {
      error.value = uiError(cause, 'GenStudio ownership could not be restored.')
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function installRelease(releaseId: string): Promise<{ pack_id: string; version: string; activated: boolean }> {
    const generation = beginOverviewRequest()
    error.value = null
    try {
      const response = await post<{
        install: { pack_id: string; version: string; activated: boolean }
        overview: ContentStoreOverview
      }>(`/content-store/releases/${encodeURIComponent(releaseId)}/install`, {})
      applyOverview(response.overview, generation)
      return response.install
    } catch (cause: any) {
      const installError = uiError(cause, 'This owned Content Pack could not be installed.')
      error.value = installError
      if (installError.code === 'release_recalled') {
        try {
          applyOverview(await get<ContentStoreOverview>('/content-store', { cache: 'no-store' }), generation)
        } catch {
          // Preserve the terminal recall. A failed read refresh is not permission to retry the recalled version.
        }
        error.value = installError
      }
      throw cause
    }
  }

  return {
    account: readonly(account) as unknown as Readonly<Ref<ContentStoreAccount | null>>,
    products: readonly(products) as unknown as Readonly<Ref<ContentStoreProduct[]>>,
    installed: readonly(installed) as unknown as Readonly<Ref<ContentStoreInstalledPack[]>>,
    shelves: readonly(shelves) as unknown as Readonly<Ref<ContentStoreShelf[]>>,
    attempts: readonly(attempts) as unknown as Readonly<Ref<PublicContentPurchaseAttempt[]>>,
    loading: readonly(loading),
    error: readonly(error),
    refresh,
    requestQuote,
    confirmPurchase,
    restoreOwnership,
    installRelease,
  }
}
