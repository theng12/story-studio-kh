import { computed, readonly, ref, type Ref } from 'vue'
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
  hero: { src: string; alt: string } | null
  licenseLabel: string | null
  licenseText: string | null
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
  active: boolean
  installState: 'installed_current' | 'incomplete'
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
  productId: string
  title: string
  kind: ContentStoreProductKind | 'unknown'
  ownedByActiveAccount: boolean
}

export type ContentPurchaseStatus = 'quoted' | 'submitting' | 'uncertain' | 'refused' | 'completed'

export type ContentStoreDependencyState =
  | 'free' | 'owned' | 'included' | 'installed'
  | 'unavailable' | 'withdrawn' | 'recalled'

export interface ContentStoreDependency {
  position: number
  productId: string
  entitlementFamily: string
  releaseId: string
  version: string
  archiveSha256: string
  title: string
  kind: ContentStoreProductKind | 'unknown'
  states: ContentStoreDependencyState[]
}

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
  entitlement_families?: string[]
  bundle_closure?: Array<{
    position: number
    product_id: string
    entitlement_family: string
    release_id: string
    version: string
    archive_sha256: string
  }>
  dependencies?: ContentStoreDependency[]
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
  component_discount_credits?: number
  granted_families?: string[]
  previously_owned_families?: string[]
  replayed?: boolean
  receipt_verification?: 'unverified_phase1'
}

interface ContentStoreOverview {
  phase: 'delivery_ready'
  origin: string
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

export type ContentStoreCatalogFreshness = 'fresh' | 'cached' | 'unavailable'

/** Identity attached to a historical proof; it is never current-account state. */
export interface ContentStoreCachedProof {
  accountId: string
  origin: string
  verifiedAt: string
}

export interface ContentStoreErrorPresentation {
  title: string
  detail: string
  recovery: string
}

/** Maps the backend's public, exact error codes to recovery copy without inventing facts. */
export function contentStoreErrorPresentation(error: ContentStoreUiError): ContentStoreErrorPresentation {
  const failure = (title: string, recovery: string): ContentStoreErrorPresentation => ({ title, detail: error.detail, recovery })
  switch (error.code) {
    case 'CONTENT_STORE_KEY_REQUIRED':
    case 'CONTENT_STORE_SCOPE_REQUIRED':
    case 'CONTENT_STORE_SIGNING_KEY_MISSING': return failure('Content Store access is needed', 'Open Settings and test the Content Store scope, then refresh.')
    case 'CONTENT_PRODUCT_NOT_AVAILABLE': return failure('This product is not available', 'Refresh the Store to see currently published products.')
    case 'CONTENT_PRODUCT_ALREADY_OWNED': return failure('Already owned in GenStudio', 'Restore purchases to verify ownership on this Mac.')
    case 'CONTENT_PRODUCT_RETIRED': return failure('This product is retired', 'Choose a currently published product instead.')
    case 'CONTENT_PRODUCT_INCOMPATIBLE':
    case 'incompatible_story_version': return failure('A newer Story Studio version is needed', 'Update Story Studio before requesting this release.')
    case 'CONTENT_RELEASE_NOT_AVAILABLE': return failure('This release is not available', 'Refresh the Store and choose a published release.')
    case 'CONTENT_STORE_QUOTE_NOT_FOUND': return failure('This quote is no longer available', 'Close it and request a new exact quote.')
    case 'CONTENT_PURCHASE_NOT_SENT': return failure('This purchase was not sent', 'Request or retry the saved exact quote when GenStudio is available.')
    case 'insufficient_credits': return failure('More credits are needed', 'Add credits, then request a new exact quote.')
    case 'quote_expired':
    case 'quote_rejected': return failure('This quote can no longer be used', 'Close it and request a new exact quote.')
    case 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN': return failure('GenStudio’s answer is uncertain', 'Retry this exact purchase; Story Studio will reuse its saved attempt.')
    case 'signing_unavailable': return failure('The Content Store is not open yet', 'Try again after GenStudio can sign Content Store evidence.')
    case 'CONTENT_STORE_ACCOUNT_MISMATCH':
    case 'CONTENT_PURCHASE_ACCOUNT_MISMATCH':
    case 'CONTENT_PACK_OWNED_RELEASE_MISMATCH':
    case 'CONTENT_PACK_NOT_OWNED':
    case 'not_entitled': return failure('Ownership could not be confirmed', 'Restore purchases to verify the active GenStudio account.')
    case 'download_grant_expired': return failure('The download authorization expired', 'Request the owned release again to receive a new authorization.')
    case 'archive_limit_exceeded':
    case 'CONTENT_PACK_TOO_LARGE_FOR_THIS_APP': return failure('This archive is too large to install safely', 'Choose another published release or contact the publisher.')
    case 'CONTENT_PACK_REQUIRES_NEWER_APP': return failure('A newer Story Studio version is needed', 'Update Story Studio before installing this release.')
    case 'CONTENT_PACK_ARCHIVE_UNAVAILABLE': return failure('This archive is not available', 'Refresh the owned release and try again later.')
    case 'CONTENT_PACK_SIGNATURE_INVALID':
    case 'CONTENT_PACK_ARCHIVE_HASH_MISMATCH':
    case 'CONTENT_PACK_SCHEMA_INVALID':
    case 'CONTENT_PACK_ASSET_INVALID': return failure('This Content Pack could not be verified', 'Do not retry this archive; refresh for a safe published release.')
    case 'CONTENT_PACK_DEPENDENCY_CYCLE':
    case 'CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH':
    case 'CONTENT_PACK_DEPENDENCY_NOT_OWNED':
    case 'CONTENT_PACK_NESTED_CLOSURE_UNSUPPORTED': return failure('This Content Pack cannot be installed', 'Refresh the owned release and its required dependencies before trying again.')
    case 'CONTENT_PACK_RECEIPT_MISSING':
    case 'CONTENT_PACK_REMOTE_IDENTITY_MISMATCH': return failure('This Content Pack could not be verified', 'Restore purchases, then refresh the owned release before trying again.')
    case 'release_recalled': return failure('A Content Pack release was recalled', 'Ownership remains permanent. Install the newest safe owned release when available.')
    case 'CONTENT_PACK_DISK_UNAVAILABLE':
    case 'CONTENT_PACK_STAGING_FAILED':
    case 'CONTENT_PACK_ACTIVATION_FAILED': return failure('This Mac could not prepare the install', 'Check available disk space, then install the owned release again.')
    case 'CONTENT_STORE_REQUEST_INVALID':
    case 'CONTENT_STORE_REQUEST_TOO_LARGE': return failure('This Content Store request is invalid', 'Refresh the Store and try the action again.')
    case 'CONTENT_STORE_UPSTREAM_REFUSED': return failure('GenStudio could not complete this request', 'Refresh the Store before trying again.')
    default: return failure('The Content Store is unavailable', 'Refresh the Store before trying again.')
  }
}

let sessionOverview: { accountId: string; origin: string; verifiedAt: string } | null = null
const sharedAccount = ref<ContentStoreAccount | null>(null)
const sharedProducts = ref<ContentStoreProduct[]>([])
const sharedInstalled = ref<ContentStoreInstalledPack[]>([])
const sharedShelves = ref<ContentStoreShelf[]>([])
const sharedAttempts = ref<PublicContentPurchaseAttempt[]>([])
const sharedCatalogFreshness = ref<ContentStoreCatalogFreshness>('unavailable')
const sharedLastVerifiedAt = ref<string | null>(null)
const sharedLastVerifiedProof = ref<ContentStoreCachedProof | null>(null)
const sharedCachedProof = computed<ContentStoreCachedProof | null>(() =>
  sharedCatalogFreshness.value === 'cached' ? sharedLastVerifiedProof.value : null)
let sharedOverviewGeneration = 0

export function _clearContentStoreSessionCacheForTests(): void {
  sessionOverview = null
  sharedAccount.value = null
  sharedProducts.value = []
  sharedInstalled.value = []
  sharedShelves.value = []
  sharedAttempts.value = []
  sharedCatalogFreshness.value = 'unavailable'
  sharedLastVerifiedAt.value = null
  sharedLastVerifiedProof.value = null
  sharedOverviewGeneration = 0
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
  catalogFreshness: Readonly<Ref<ContentStoreCatalogFreshness>>
  lastVerifiedAt: Readonly<Ref<string | null>>
  cachedProof: Readonly<Ref<ContentStoreCachedProof | null>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<ContentStoreUiError | null>>
  refresh: () => Promise<void>
  requestQuote: (productId: string, releaseId?: string | null) => Promise<PublicContentPurchaseAttempt>
  confirmPurchase: (quoteId: string) => Promise<PublicContentPurchaseAttempt>
  restoreOwnership: () => Promise<void>
  installRelease: (releaseId: string) => Promise<{ pack_id: string; version: string; activated: boolean }>
} {
  const { get, post } = useApi()
  const loading = ref(false)
  const error = ref<ContentStoreUiError | null>(null)

  function beginOverviewRequest(): number { sharedOverviewGeneration += 1; return sharedOverviewGeneration }
  function applyOverview(overview: ContentStoreOverview, generation: number): void {
    if (generation !== sharedOverviewGeneration) return
    const verifiedAt = new Date().toISOString()
    const origin = overview.origin
    if (!origin) {
      sessionOverview = null
      sharedLastVerifiedProof.value = null
      return
    }
    // Vue batches these synchronous assignments, so every mounted consumer
    // observes one verified account/origin snapshot rather than mixed facts.
    sharedAccount.value = overview.account
    sharedProducts.value = overview.products
    sharedInstalled.value = overview.installed ?? []
    sharedShelves.value = overview.shelves
    sharedAttempts.value = overview.attempts
    sharedCatalogFreshness.value = 'fresh'
    sharedLastVerifiedAt.value = verifiedAt
    if (sessionOverview && (sessionOverview.accountId !== overview.account.accountId || sessionOverview.origin !== origin)) sessionOverview = null
    sessionOverview = { accountId: overview.account.accountId, origin, verifiedAt }
    sharedLastVerifiedProof.value = { accountId: overview.account.accountId, origin, verifiedAt }
  }

  function replaceAttempt(attempt: PublicContentPurchaseAttempt): void {
    const index = sharedAttempts.value.findIndex(row => row.quote_id === attempt.quote_id)
    if (index === -1) sharedAttempts.value = [attempt, ...sharedAttempts.value]
    else sharedAttempts.value.splice(index, 1, attempt)
  }

  function applyFailedAttempt(quoteId: string, cause: any): void {
    const data = cause?.data || cause?.response?._data || {}
    if (data.attempt && typeof data.attempt === 'object') {
      const current = sharedAttempts.value.find(row => row.quote_id === quoteId)
      replaceAttempt({ ...current, ...data.attempt } as PublicContentPurchaseAttempt)
      return
    }
    const current = sharedAttempts.value.find(row => row.quote_id === quoteId)
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
      if (generation === sharedOverviewGeneration) {
        const hasVerifiedOverview = sharedLastVerifiedAt.value !== null
        if (!hasVerifiedOverview) {
          sharedAccount.value = null
          sharedProducts.value = []
          sharedInstalled.value = []
          sharedShelves.value = []
          sharedAttempts.value = []
        }
        sharedCatalogFreshness.value = hasVerifiedOverview ? 'cached' : 'unavailable'
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
    const generation = beginOverviewRequest()
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
          if (generation === sharedOverviewGeneration) {
            applyOverview(overview, generation)
            if (!overview.attempts.some(row => row.quote_id === attempt.quote_id)) sharedAttempts.value = [attempt, ...overview.attempts]
          }
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
    account: readonly(sharedAccount) as unknown as Readonly<Ref<ContentStoreAccount | null>>,
    products: readonly(sharedProducts) as unknown as Readonly<Ref<ContentStoreProduct[]>>,
    installed: readonly(sharedInstalled) as unknown as Readonly<Ref<ContentStoreInstalledPack[]>>,
    shelves: readonly(sharedShelves) as unknown as Readonly<Ref<ContentStoreShelf[]>>,
    attempts: readonly(sharedAttempts) as unknown as Readonly<Ref<PublicContentPurchaseAttempt[]>>,
    catalogFreshness: readonly(sharedCatalogFreshness),
    lastVerifiedAt: readonly(sharedLastVerifiedAt),
    cachedProof: readonly(sharedCachedProof),
    loading: readonly(loading),
    error: readonly(error),
    refresh,
    requestQuote,
    confirmPurchase,
    restoreOwnership,
    installRelease,
  }
}
