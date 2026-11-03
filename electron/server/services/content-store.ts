import {
  GenStudioContentStoreApiError,
  GenStudioContentStoreLimitError,
  GenStudioContentStoreResponseError,
  canonicalizeContentStoreObject,
  getGenStudioContentAccount,
  getGenStudioContentReceipts,
  listGenStudioOwnedContentReleases,
  listGenStudioContentProducts,
  listGenStudioContentStoreShelves,
  parseContentStorePublicKey,
  resolveStoryStudioVersion,
  type GenStudioContentAccount,
  type GenStudioContentProduct,
  type GenStudioOwnedContentRelease,
} from '../lib/genstudio-content-store.js'
import { verifyContentStoreRestoreReceipt } from '../lib/genstudio-content-store-trust.js'
import { gatewayConnectionFailure } from '../lib/humanize-backend-error.js'
import { getApiKey } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'
import { logLine } from './logger.js'
import {
  readContentStoreCommerceState,
  readVerifiedContentStoreRestore,
  recoverInterruptedContentPurchases,
  resolveVerifiedContentStoreSigningKey,
} from '../content-store/commerce-state.js'
import {
  resolveContentStoreInstallSnapshot,
  reconcileContentStoreRecalledVersions,
  type ContentStoreInstallState,
  type ContentStoreLocalInstallState,
} from './content-store-install-state.js'
import { applyGatewayPackRemovals } from '../content-packs/removal.js'
import {
  type CachedContentQuote,
  type CachedContentRefusal,
  type ContentStoreCommerceState,
} from '../content-store/types.js'

/**
 * A journal entry from this Mac's retired shop, shown without money.
 *
 * Old rows still carry credit figures; they stay on disk and are never
 * rewritten, but no price or balance is published from them.
 */
export interface PublicContentPurchaseAttempt {
  quote_id: string
  account_id: string
  product_id: string
  release_id: string
  entitlement_family: string
  expires_at: string
  status: CachedContentQuote['status']
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
  owned_components: string[]
  refusal?: CachedContentRefusal
  uncertain_detail?: string
  ownership?: 'owned_not_installed'
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

export interface PublicContentStoreShelf {
  id: string
  title: string
  productIds: string[]
}

export type PublicContentProduct = Omit<GenStudioContentProduct,
  'raw' | 'currentRelease' | 'bundleComponents' | 'cover' | 'hero' | 'tags' | 'license'
  | 'removeFromInstalls' | 'removeFromInstallsAt'
> & {
  currentRelease: PublicContentRelease | null
  bundleComponents: Array<Omit<GenStudioContentProduct['bundleComponents'][number], 'raw'>>
  presentation: PublicContentProductPresentation
}

export interface ContentStoreOverviewSections {
  /** This account's ownership and installed releases, as GenStudio publishes them. */
  account: ContentStoreSectionStatus
  /** The published product catalogue. */
  catalog: ContentStoreSectionStatus
  /** Shelf assignments (the Discover shelves). Needs the catalogue. */
  shelves: ContentStoreSectionStatus
  /** Recall receipts, which decide which installed versions stay usable. */
  receipts: ContentStoreSectionStatus
  /** This Mac's own purchase journal. Local, but it needs the account to scope it. */
  commerce: ContentStoreSectionStatus
  /** Applying the Gateway's "take this pack off installs" requests. */
  removals: ContentStoreSectionStatus
}

export type ContentStoreSectionStatus =
  | { status: 'available' }
  | { status: 'unavailable'; code: string; reason: string }

export interface ContentStoreOverview {
  /**
   * `delivery_ready` — every section answered. `partial` — at least one did
   * not, and the response says which one and why. A partial overview still
   * carries what this Mac knows on its own (installed packs, local journal).
   */
  phase: 'delivery_ready' | 'partial'
  origin: string
  /** Null only when the account section is unavailable — never "owns nothing". */
  account: PublicContentAccount | null
  installed: PublicContentInstalledPack[]
  products: PublicContentProduct[]
  shelves: PublicContentStoreShelf[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: {
    purchase: false
    receipt_verification: true
    download: true
    install_after_purchase: false
    restore: true
  }
  sections: ContentStoreOverviewSections
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

/**
 * An old refusal row still carries the credit figures it was saved with. The
 * code and the reason stay; the money does not travel with them.
 */
function refusalWithoutMoney(refusal: CachedContentRefusal): CachedContentRefusal {
  if (refusal.status !== 402) return { ...refusal }
  return { status: 402, code: 'insufficient_credits', detail: refusal.detail }
}

function publicAttempt(
  attempt: CachedContentQuote,
  dependencies?: PublicContentDependency[],
): PublicContentPurchaseAttempt {
  const completed = attempt.completed_purchase
  return {
    quote_id: attempt.quote_id,
    account_id: attempt.account_id,
    product_id: attempt.product_id,
    release_id: attempt.release_id,
    entitlement_family: attempt.entitlement_family,
    expires_at: attempt.expires_at,
    status: attempt.status,
    owned_components: [...attempt.owned_components],
    ...(attempt.entitlement_families ? {
      entitlement_families: [...(completed?.entitlement_families ?? attempt.entitlement_families)],
    } : {}),
    ...((completed?.bundle_closure ?? attempt.bundle_closure) ? {
      bundle_closure: structuredClone(completed?.bundle_closure ?? attempt.bundle_closure) as NonNullable<PublicContentPurchaseAttempt['bundle_closure']>,
    } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(attempt.last_refusal ? { refusal: refusalWithoutMoney(attempt.last_refusal) } : {}),
    ...(attempt.uncertain_detail ? { uncertain_detail: attempt.uncertain_detail } : {}),
    ...(completed ? {
      ownership: 'owned_not_installed' as const,
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

/**
 * Rewrite Gateway cover paths to Story's same-origin proxy route.
 *
 * The Discover shelf renders `presentation.cover.src` directly in an `<img>`.
 * A Gateway path like `/admin/api/content-library/covers/packId/version` would
 * be blocked by CSP (only `localhost` and `127.0.0.1` are in `img-src`). Story
 * proxies covers through `/api/content-store/covers/:packId/:version` which is
 * same-origin and bypasses auth for loopback requests.
 *
 * The Library tab already does this rewrite in `buildLibraryCards` using
 * `coverProxyPath`. This makes the Discover shelf consistent so both surfaces
 * load covers through the same route.
 */
export function rewriteCoverSrc(product: GenStudioContentProduct): string {
  const url = product.cover!.url
  const match = /^\/admin\/api\/content-library\/covers\/([^/]+)\/([^/]+)$/.exec(url)
  if (!match) return url
  const [, packId, version] = match
  return `/api/content-store/covers/${encodeURIComponent(packId!)}/${encodeURIComponent(version!)}`
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
      owned: component.owned,
    })),
    showcaseVideos: product.showcaseVideos,
    presentation: {
      cover: product.cover ? { src: rewriteCoverSrc(product), alt: product.cover.alt } : null,
      hero: product.hero ? { src: product.hero.url, alt: product.hero.alt } : null,
      licenseLabel: product.license?.label ?? null,
      licenseText: product.license?.text ?? null,
      tags: [...product.tags],
    },
  }
}

async function publicAccount(
  account: GenStudioContentAccount,
  verifiedFamilies: ReadonlySet<string>,
  installStates: ReadonlyArray<ContentStoreLocalInstallState>,
  recalledVersionsByFamily: ReadonlyMap<string, string[]>,
  compatibleByProduct: ReadonlyMap<string, boolean>,
  downloadableByFamily: ReadonlyMap<string, boolean>,
): Promise<PublicContentAccount> {
  return {
    accountId: account.accountId,
    contentAccountId: account.contentAccountId,
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
      // GenStudio's own `download_available` is the authority, not the archive's
      // existence: a RETIRED family publishes `false` while its bytes remain, and
      // deriving this from `archive_available` offered that family for install
      // again (2026-10-30). The archive test stays only as the answer when this
      // load had no signed receipts to read at all — that answer is already
      // marked `unverified`, the receipts section says why it is unavailable,
      // and an install attempt it wrongly offers is refused, loudly, before any
      // download grant is asked for (`CONTENT_PACK_DOWNLOAD_WITHDRAWN`).
      downloadAvailable: downloadableByFamily.get(owned.entitlementFamily)
        ?? owned.currentRelease?.archiveAvailable === true,
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
      'Save your Gateway API Key in Settings → This Mac before opening the Studio Library.',
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

/**
 * The journal is passed in, not read here: reading it is this Mac's own answer
 * and must be reported as a LOCAL failure, while enriching an attempt asks the
 * Gateway and must be reported as a Gateway failure. Reading it here made those
 * two indistinguishable to the caller.
 */
async function localAttempts(
  accountId: string,
  context: PublicDependencyContext,
  state: ContentStoreCommerceState,
): Promise<PublicContentPurchaseAttempt[]> {
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

const SECTION_AVAILABLE: ContentStoreSectionStatus = Object.freeze({ status: 'available' as const })

/**
 * What a section's failure means, in words the customer can act on — or null
 * when nothing here can explain it.
 *
 * Null is deliberate: an unexpected error in this file is a BUG and must stay a
 * loud, logged 500, not be laundered into "the Gateway did not answer". Every
 * shape a real machine can produce is classified below, so a null here is a
 * signal worth investigating rather than a catch-all.
 */
export function contentStoreSectionFailure(error: unknown): { code: string; reason: string } | null {
  // Local, exact refusals: no key saved, key refused for content:read, an
  // account mismatch the caller keeps loud, a broken local journal.
  if (error instanceof ContentStoreLocalError) {
    return { code: error.code, reason: error.message }
  }
  const offline = gatewayConnectionFailure(error)
  if (offline) return { code: 'GATEWAY_UNREACHABLE', reason: offline.detail }
  if (error instanceof GenStudioContentStoreResponseError) {
    // Answered, but not with a Content Store response: a Gateway that does not
    // serve these endpoints (a catch-all page), or a contract this build cannot
    // read. The validator detail names the field and endpoint; it is a
    // description of the response, never a local path.
    return {
      code: error.code,
      reason: `The Gateway answered, but not with a Studio Library response: ${error.message}`,
    }
  }
  if (error instanceof GenStudioContentStoreLimitError) {
    return { code: error.code, reason: error.message }
  }
  if (error instanceof GenStudioContentStoreApiError) {
    if (error.status === 401) {
      return {
        code: 'CONTENT_STORE_SCOPE_REQUIRED',
        reason: 'The saved Gateway API Key was not accepted for Studio Library access.',
      }
    }
    if (error.status === 404) {
      return { code: 'CONTENT_STORE_NOT_SERVED', reason: 'This Gateway does not serve the Studio Library.' }
    }
    return {
      code: 'CONTENT_STORE_GATEWAY_FAILED',
      reason: `The Gateway could not serve the Studio Library (HTTP ${error.status}${
        typeof error.code === 'string' && error.code ? `, ${error.code}` : ''}).`,
    }
  }
  // A local journal or pack-state file this Mac cannot read. The message can
  // carry the file path, so only the errno code is repeated to the renderer.
  const errno = (error as { code?: unknown })?.code
  if (typeof errno === 'string' && /^(?:EACCES|EPERM|ENOSPC|EISDIR|ENOTDIR|EIO|EBUSY|EMFILE)$/.test(errno)) {
    return {
      code: 'CONTENT_STORE_LOCAL_STATE_UNAVAILABLE',
      reason: `This Mac could not read its Studio Library records (${errno}).`,
    }
  }
  return null
}

function sectionFailure(error: unknown, section: string): { status: 'unavailable'; code: string; reason: string } {
  const described = contentStoreSectionFailure(error)
  if (!described) throw error
  return { status: 'unavailable', ...described }
}

/**
 * Load the Studio Library overview, answering with whatever this Mac can
 * honestly state.
 *
 * It used to be all-or-nothing: one rejection anywhere — a Gateway that does
 * not serve the content endpoints, a 200 that is not the published shape, a
 * local journal this Mac cannot read — threw, and the route answered the
 * generic `500 {"detail":"Failed to load the Content Store."}`. On 2026-10-28
 * the installed mini reported exactly that while its archive bank answered 216
 * archives normally, and the cause could not even be read out of the log.
 *
 * Now each part is asked for on its own and reported as
 * `available` or `unavailable` with a code and a reason. Local facts — the
 * packs installed on this Mac and this Mac's own purchase journal — are
 * answered even when the Gateway cannot be asked at all, and an unavailable
 * part is NEVER flattened into an empty one: `account: null` and
 * `sections.account.status === 'unavailable'` mean "could not ask", which is
 * not "you own nothing" (AGENTS.md 6).
 *
 * What stays loud, on purpose: a real local defect (an unreadable Content Pack
 * state, which is also what every install depends on) and an account mismatch
 * (409) — those are bugs, not a Gateway that does not offer the Store.
 */
export async function loadContentStoreOverview(): Promise<ContentStoreOverview> {
  const origin = await currentGenStudioOrigin()

  // ── the key ────────────────────────────────────────────────────────────
  // No key means every question about the account is unanswerable, but nothing
  // local is. It used to be a 400 with no body worth showing.
  let apiKey: string | null = null
  let keyFailure: { status: 'unavailable'; code: string; reason: string } | null = null
  try {
    apiKey = await activeKey()
  } catch (error) {
    keyFailure = sectionFailure(error, 'account')
    logLine('warn', 'Content Store overview: no usable Gateway key', { code: keyFailure.code })
  }

  // ── the four Gateway reads, together ───────────────────────────────────
  // Account, catalog and receipts depend only on the key; shelves need the
  // catalog's product ids and follow it. They used to run one after another —
  // 4.7 s warm and 13 s cold (2026-09-12).
  const accountRequest = apiKey === null
    ? Promise.reject(new ContentStoreLocalError(400, 'CONTENT_STORE_KEY_REQUIRED', keyFailure!.reason))
    : getGenStudioContentAccount(apiKey).catch((error: unknown) => {
      if (error instanceof GenStudioContentStoreApiError && error.status === 401) {
        throw new ContentStoreLocalError(
          401,
          'CONTENT_STORE_SCOPE_REQUIRED',
          'The active GenStudio key was not accepted for required content:read access.',
        )
      }
      throw error
    })
  const storyVersionRequest = resolveStoryStudioVersion()
  const catalogRequest = apiKey === null
    ? Promise.reject(new ContentStoreLocalError(400, 'CONTENT_STORE_KEY_REQUIRED', keyFailure!.reason))
    : storyVersionRequest.then(version => listGenStudioContentProducts(apiKey, version))
  const shelvesRequest = Promise.all([storyVersionRequest, catalogRequest]).then(([version, catalog]) =>
    listGenStudioContentStoreShelves(apiKey!, version, catalog.products.map(product => product.productId)))
  const receiptsRequest = apiKey === null
    ? Promise.reject(new ContentStoreLocalError(400, 'CONTENT_STORE_KEY_REQUIRED', keyFailure!.reason))
    : getGenStudioContentReceipts(apiKey)
  // Settle every request so a rejection cannot leave a sibling dangling as an
  // unhandled rejection, and so one refusal cannot hide the others' answers.
  const [accountOutcome, catalogOutcome, receiptsOutcome, shelvesOutcome] = await Promise.allSettled(
    [accountRequest, catalogRequest, receiptsRequest, shelvesRequest])

  const sections: ContentStoreOverviewSections = {
    account: SECTION_AVAILABLE, catalog: SECTION_AVAILABLE, shelves: SECTION_AVAILABLE,
    receipts: SECTION_AVAILABLE, commerce: SECTION_AVAILABLE, removals: SECTION_AVAILABLE,
  }
  const noteFailure = (section: keyof ContentStoreOverviewSections, error: unknown): void => {
    const failure = sectionFailure(error, section)
    sections[section] = failure
    logLine('warn', 'Content Store overview section unavailable', {
      section,
      code: failure.code,
      reason: failure.reason,
      raw: String((error as { message?: unknown })?.message ?? error ?? ''),
    })
  }
  if (accountOutcome.status === 'rejected') noteFailure('account', accountOutcome.reason)
  if (catalogOutcome.status === 'rejected') noteFailure('catalog', catalogOutcome.reason)
  if (shelvesOutcome.status === 'rejected') noteFailure('shelves', shelvesOutcome.reason)
  if (receiptsOutcome.status === 'rejected') noteFailure('receipts', receiptsOutcome.reason)

  const account = accountOutcome.status === 'fulfilled' ? accountOutcome.value : null
  const catalog = catalogOutcome.status === 'fulfilled' ? catalogOutcome.value : null
  const receipts = receiptsOutcome.status === 'fulfilled' ? receiptsOutcome.value : null
  const shelfResponse = shelvesOutcome.status === 'fulfilled' ? shelvesOutcome.value : null

  // An account/receipts disagreement is not "unavailable": it is a wrong
  // answer, and must stay loud rather than be softened into a notice.
  if (account && receipts
    && (receipts.accountId !== account.accountId || receipts.contentAccountId !== account.contentAccountId)) {
    throw new ContentStoreLocalError(
      409,
      'CONTENT_STORE_ACCOUNT_MISMATCH',
      'GenStudio returned Content Store recall state for a different account.',
    )
  }

  const recalledVersionsByFamily = new Map((receipts?.entitlements ?? []).map(entitlement => [
    entitlement.entitlementFamily,
    entitlement.recalledReleaseVersions,
  ]))
  // Whether GenStudio currently serves a download, exactly as the signed
  // receipts state it. The account endpoint does not publish this fact at all,
  // so without it a retired family whose bytes remain looked installable.
  const downloadableByFamily = new Map((receipts?.entitlements ?? []).map(entitlement => [
    entitlement.entitlementFamily,
    entitlement.downloadAvailable,
  ]))

  // ── local facts ────────────────────────────────────────────────────────
  // The Gateway's "take this pack off installs" requests land BEFORE the
  // install snapshot is read, so the list this page draws is the list after
  // the removal. A pack a channel still uses is kept, and the reason is
  // recorded and shown on it; a failure here is named, never silent.
  if (catalog && catalog.retiredPacks.length > 0) {
    await applyGatewayPackRemovals(catalog.retiredPacks).catch(error => {
      noteFailure('removals', error)
    })
  }
  // Recalls are written to pack state BEFORE the install snapshot is read, so
  // this one answer already reflects them instead of needing a second request.
  if (account && receipts) {
    // Marking recalls writes pack state; failing to do it must not cost the
    // customer the whole page, but it must be named.
    await reconcileContentStoreRecalledVersions({
      accountId: account.accountId,
      origin,
      recalledVersionsByFamily,
    }).catch(error => {
      // Folded into receipts: this IS the recall fact failing to land.
      noteFailure('receipts', error)
    })
  }
  // The install snapshot is read for this Mac alone; ownership only decorates
  // it. A local pack-state failure is a real defect (every install depends on
  // the same state), so it is NOT caught here.
  const [verifiedFamilies, installSnapshot] = await Promise.all([
    account ? cachedVerifiedFamilies(account.accountId).catch(() => new Set<string>()) : Promise.resolve(new Set<string>()),
    resolveContentStoreInstallSnapshot((account?.owned ?? []).map(owned => owned.currentRelease)),
  ])

  const products = catalog?.products ?? []
  const catalogByProduct = new Map(products.map(product => [product.productId, product]))
  const verifiedOwnedProductIds = new Set((account?.owned ?? [])
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
  const shelves: PublicContentStoreShelf[] = shelfResponse
    ? [
        ...shelfResponse.shelves.map(shelf => ({ id: shelf.shelfId, title: shelf.title, productIds: [...shelf.productIds] })),
        ...(shelfResponse.fallbackProductIds.length > 0
          ? [{ id: 'fallback', title: 'More Content', productIds: [...shelfResponse.fallbackProductIds] }]
          : []),
      ]
    : []

  // ── this Mac's own purchase journal ────────────────────────────────────
  // Reading it needs no Gateway, but scoping it to the account does. Every
  // failure of THIS read is local, whatever it says: the journal is this Mac's
  // own record, and the shop is retired, so an unreadable one is a notice, not
  // a reason to fail the whole page.
  let attempts: PublicContentPurchaseAttempt[] = []
  if (account && apiKey) {
    let journal: Awaited<ReturnType<typeof readContentStoreCommerceState>> | null = null
    try {
      await recoverInterruptedContentPurchases()
      journal = await readContentStoreCommerceState()
    } catch (error) {
      sections.commerce = {
        status: 'unavailable',
        code: 'CONTENT_STORE_LOCAL_STATE_UNAVAILABLE',
        reason: 'This Mac could not read its Studio Library purchase records.',
      }
      logLine('error', 'Content Store purchase journal unavailable', {
        raw: String((error as { message?: unknown })?.message ?? error ?? ''),
      })
    }
    if (journal) {
      try {
        attempts = await localAttempts(account.accountId, dependencyContext(apiKey, products, installed), journal)
      } catch (error) {
        noteFailure('commerce', error)
      }
    }
  } else if (sections.account.status === 'unavailable') {
    // Purchase attempts are scoped to the account, so an account that could not
    // be asked is also why this list is empty. It is the account's reason.
    sections.commerce = sections.account
  }

  const unavailable = Object.values(sections).some(section => section.status === 'unavailable')
  return {
    phase: unavailable ? 'partial' : 'delivery_ready',
    origin,
    account: account
      ? await publicAccount(account, verifiedFamilies, installSnapshot.owned, recalledVersionsByFamily,
        new Map(products.map(product => [product.productId, product.compatible])), downloadableByFamily)
      : null,
    installed,
    products: products.map(publicProduct),
    shelves,
    attempts,
    capabilities: {
      purchase: false,
      receipt_verification: true,
      download: true,
      install_after_purchase: false,
      restore: true,
    },
    sections,
  }
}
