/**
 * Buying a whole selection behind ONE confirmation.
 *
 * The multi-select used to promise a batch and deliver a single: "See exact
 * quotes (18)" opened one quote for one pack, confirming bought that one, and
 * the remaining seventeen arrived as seventeen more dialogs. "i'm only buying 1
 * at a time though. i'm trying to save time. someone with money just wanna
 * click select all and then 1 click buy all."
 *
 * So the loop stays and the CONFIRMATION collapses: quote everything, show one
 * combined ceiling, and settle each quote in turn once he agrees.
 *
 * WHY A LOOP RATHER THAN A BATCH ENDPOINT. Every quote is independently signed
 * and carries its own idempotency key, minted at quote time and persisted in
 * the commerce journal beside it. Settling them one at a time is therefore
 * already safe to retry per item -- GenStudio replays a repeated key instead of
 * charging twice. A batch endpoint would have to reinvent precisely that, plus
 * its own partial-failure semantics, to arrive where N signed quotes already
 * are. This lives in the client because that is where the smaller change is.
 *
 * PARTIAL FAILURE IS THE POINT, NOT AN EDGE CASE. Items settle independently.
 * If the twelfth pack is retired or was bought on another Mac a minute ago, the
 * other seventeen are still bought and the twelfth is reported with a reason.
 * Rolling seventeen good purchases back because one went stale is the worse
 * outcome. Nothing here ever reports a partial result as a complete one.
 */
import { computed, ref } from 'vue'
import type {
  ContentStoreProduct,
  ContentStoreUiError,
  PublicContentPurchaseAttempt,
} from '~/composables/useContentStore'

export type BatchPhase = 'idle' | 'quoting' | 'review' | 'settling' | 'result'

export interface BatchQuoteItem {
  productId: string
  title: string
  free: boolean
  /** Present once quoted; null while pending or when the pack is skipped. */
  attempt: PublicContentPurchaseAttempt | null
  /** Why this pack will not be bought, in his words rather than the API's. */
  reason?: string
  charged?: number
  outcome?: 'owned' | 'failed'
  retryable?: boolean
}

export interface BatchPurchaseDeps {
  quote: (productId: string, releaseId: string | null) => Promise<PublicContentPurchaseAttempt>
  confirm: (quoteId: string) => Promise<PublicContentPurchaseAttempt>
  /** The catalog as it stands NOW, re-read per pack so a stale selection cannot charge. */
  lookup: (productId: string) => ContentStoreProduct | undefined
  /** The store's last error, for turning a rejection into something readable. */
  lastError: () => ContentStoreUiError | null
}

/**
 * Why a selected pack is not going to be bought.
 *
 * Re-checked immediately before each quote AND relied on again by the server,
 * which refuses an already-owned product outright. Selecting eighteen packs and
 * buying them is not instantaneous, and "already owned" is the case he will hit
 * most: he owns 65 already, so select-all routinely includes some of them.
 */
export function batchSkipReason(product: ContentStoreProduct | undefined): string | null {
  if (!product) return 'No longer in the catalog'
  if (product.owned) return 'Already owned'
  if (product.retired) return 'Retired by GenStudio'
  if (!product.compatible) return product.compatibilityReason || 'Not compatible with this Story Studio'
  if (!product.currentRelease) return 'No published release'
  return null
}

/**
 * Add up a figure GenStudio published, or admit the total is not known.
 *
 * A missing figure must never become zero. Treating one absent
 * `quoted_credits` in an eighteen-pack batch as 0 does not make the batch
 * cheaper -- it makes the dialog state a confident total that is too low, and
 * he would confirm a spend against a number the server never published. That
 * is the exact defect this whole job existed to remove, so an incomplete set
 * yields `null`: UNKNOWN, not smaller. Callers must render that as unknown and
 * refuse to spend against it.
 *
 * `Number.isFinite` rather than a null check on purpose -- NaN and Infinity
 * would each poison a running sum into a number nobody can act on.
 */
export function sumPublished<T>(rows: readonly T[], read: (row: T) => number | undefined): number | null {
  let total = 0
  for (const row of rows) {
    const value = read(row)
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    total += value
  }
  return total
}

export function useBatchPurchase(deps: BatchPurchaseDeps) {
  const items = ref<BatchQuoteItem[]>([])
  const phase = ref<BatchPhase>('idle')
  const open = ref(false)
  const busy = ref(false)
  const progress = ref({ done: 0, total: 0 })

  /**
   * What is still to be bought. A pack that already succeeded keeps its quote
   * on the item, so excluding `owned` here is what stops a retry from listing
   * it again and counting its price a second time in the ceiling he confirms.
   */
  const quoted = computed(() => items.value.filter(item => item.attempt && !item.reason && item.outcome !== 'owned'))
  /** `null` means at least one quote carried no price, so no total can be stated. */
  const quotedTotal = computed(() => sumPublished(quoted.value, item => item.attempt?.quoted_credits))

  function patch(productId: string, change: Partial<BatchQuoteItem>): void {
    items.value = items.value.map(item => item.productId === productId ? { ...item, ...change } : item)
  }

  function readableError(fallback: string): string {
    return deps.lastError()?.detail || fallback
  }

  /**
   * Quote every selected pack. Sequential on purpose: quoting is cheap but it
   * is still one request per pack, and firing eighteen at once is the same
   * unbounded fan-out that made installing fall over.
   */
  async function quoteAll(productIds: string[]): Promise<void> {
    progress.value = { done: 0, total: productIds.length }
    for (const productId of productIds) {
      const product = deps.lookup(productId)
      const reason = batchSkipReason(product)
      if (reason) patch(productId, { reason, attempt: null, outcome: undefined })
      else {
        try {
          const attempt = await deps.quote(productId, product!.currentRelease?.releaseId ?? null)
          patch(productId, { attempt, reason: undefined, outcome: undefined })
        } catch {
          patch(productId, { reason: readableError('GenStudio would not quote this pack'), attempt: null })
        }
      }
      progress.value = { ...progress.value, done: progress.value.done + 1 }
    }
    phase.value = 'review'
  }

  /** Open the dialog and gather quotes. Charges nothing. */
  async function start(products: ContentStoreProduct[]): Promise<void> {
    if (busy.value || !products.length) return
    items.value = products.map(product => ({
      productId: product.productId, title: product.title, free: product.free, attempt: null,
    }))
    phase.value = 'quoting'
    open.value = true
    busy.value = true
    try { await quoteAll(products.map(product => product.productId)) } finally { busy.value = false }
  }

  /**
   * Settle every quoted pack, one at a time, recording each outcome on its own.
   * Returns the ids that became owned so the caller can drop them from the
   * selection -- a bought pack must not sit selected offering to be bought again.
   */
  async function confirmAll(): Promise<string[]> {
    const pending = items.value.filter(item => item.attempt && !item.reason && item.outcome !== 'owned')
    if (busy.value || !pending.length) return []
    busy.value = true
    phase.value = 'settling'
    progress.value = { done: 0, total: pending.length }
    const bought: string[] = []
    try {
      for (const item of pending) {
        try {
          const settled = await deps.confirm(item.attempt!.quote_id)
          patch(item.productId, {
            // Left undefined when GenStudio did not state what it charged, so
            // the receipt can say "not stated" rather than the free-of-charge
            // "0 credits" that a fallback would have invented.
            outcome: 'owned', charged: settled.credits_charged, reason: undefined, retryable: false,
          })
          bought.push(item.productId)
        } catch {
          // Never abort the rest. A pack that cannot be bought is one line in
          // the report, not the end of the batch.
          const error = deps.lastError()
          patch(item.productId, {
            outcome: 'failed',
            reason: readableError('GenStudio did not complete this purchase'),
            // A terminal refusal (recalled, retired) must not offer a retry
            // that can only fail the same way again.
            retryable: error?.terminal !== true,
          })
        }
        progress.value = { ...progress.value, done: progress.value.done + 1 }
      }
      phase.value = 'result'
    } finally { busy.value = false }
    return bought
  }

  /**
   * Re-quote and retry only what failed. The packs already bought keep their
   * outcome and are never re-submitted, so a retry cannot charge twice for one
   * that already succeeded.
   */
  async function retryFailed(): Promise<void> {
    const retryable = items.value.filter(item => item.outcome === 'failed' && item.retryable)
    if (busy.value || !retryable.length) return
    busy.value = true
    phase.value = 'quoting'
    try {
      for (const item of retryable) patch(item.productId, { outcome: undefined, reason: undefined, attempt: null })
      await quoteAll(retryable.map(item => item.productId))
    } finally { busy.value = false }
  }

  function close(): void {
    if (busy.value) return
    open.value = false
    phase.value = 'idle'
    items.value = []
    progress.value = { done: 0, total: 0 }
  }

  return { items, phase, open, busy, progress, quoted, quotedTotal, start, confirmAll, retryFailed, close }
}
