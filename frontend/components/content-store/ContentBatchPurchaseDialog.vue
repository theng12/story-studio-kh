<template>
  <Modal
    :visible="visible"
    size="md"
    labelledby="content-batch-purchase-title"
    dialog-class="content-batch-purchase-dialog modal-flush"
    @close="requestClose"
  >
    <div class="batch-shell">
      <header class="batch-header">
        <div>
          <span>{{ phaseLabel }}</span>
          <h2 id="content-batch-purchase-title">{{ heading }}</h2>
        </div>
        <button
          ref="cancelButton"
          type="button"
          class="dialog-close"
          :disabled="busy"
          aria-label="Close purchase dialog"
          @click="requestClose"
        >Close</button>
      </header>

      <div class="batch-body">
        <!-- Quoting ------------------------------------------------------ -->
        <template v-if="phase === 'quoting'">
          <p class="batch-progress" role="status" aria-live="polite">
            Asking GenStudio for an exact quote on each pack — {{ progress.done }} of {{ progress.total }}.
          </p>
          <p class="ceiling-note">Nothing is charged while quotes are gathered.</p>
        </template>

        <!-- Review: one total, one confirmation --------------------------- -->
        <template v-else-if="phase === 'review'">
          <p class="ownership-statement">Permanent ownership for this GenStudio account</p>

          <dl class="quote-grid">
            <div><dt>Base price</dt><dd>{{ formatCredits(totals.base) }} credits</dd></div>
            <div v-if="totals.componentDiscount !== null && totals.componentDiscount > 0"><dt>Owned-content discount</dt><dd>−{{ formatCredits(totals.componentDiscount) }} credits</dd></div>
            <div v-if="totals.operatorDiscount !== null && totals.operatorDiscount > 0"><dt>Operator discount</dt><dd>−{{ formatCredits(totals.operatorDiscount) }} credits</dd></div>
            <div class="quote-total"><dt>Maximum deduction for {{ quoted.length }} {{ quoted.length === 1 ? 'pack' : 'packs' }}</dt><dd>{{ formatCredits(totals.quoted) }} credits</dd></div>
            <div><dt>Content-spendable balance</dt><dd>{{ formatCredits(balanceBefore) }} credits</dd></div>
            <div><dt>After buying all</dt><dd>{{ formatCredits(balanceAfter) }} credits</dd></div>
            <div><dt>First quote expires</dt><dd>{{ formatExpiry(earliestExpiry) }}</dd></div>
          </dl>

          <p class="ceiling-note">
            This is the maximum deduction for the whole selection. Each pack is settled on its own, so the
            final charge may be lower when GenStudio settles them.
          </p>

          <!-- Why the dialog total may differ from the selection bar -->
          <p v-if="skipped.length" class="skip-note" role="status">
            {{ skipped.length }} of the {{ selectedCount }} selected
            {{ skipped.length === 1 ? 'pack is' : 'packs are' }} not being bought<template v-if="selectionTotal !== null">, so this total is lower than the
            {{ formatCredits(selectionTotal) }} credits the selection bar showed</template>.
          </p>

          <details class="batch-breakdown" open>
            <summary>{{ quoted.length }} {{ quoted.length === 1 ? 'pack' : 'packs' }} to buy</summary>
            <ul>
              <li v-for="item in quoted" :key="item.productId">
                <span class="item-title">{{ item.title }}</span>
                <span class="item-price">{{ item.free ? 'Free' : `${formatCredits(item.attempt!.quoted_credits)} credits` }}</span>
              </li>
            </ul>
          </details>

          <details v-if="skipped.length" class="batch-breakdown">
            <summary>{{ skipped.length }} skipped, nothing will be charged for {{ skipped.length === 1 ? 'it' : 'them' }}</summary>
            <ul>
              <li v-for="item in skipped" :key="item.productId">
                <span class="item-title">{{ item.title }}</span>
                <span class="item-reason">{{ item.reason }}</span>
              </li>
            </ul>
          </details>

          <!--
            Three different reasons this batch cannot be confirmed, and they must
            not be collapsed into one. "You need more credits" is a claim about
            his balance, and stating it when the real problem is that GenStudio
            published no price would be a lie about his money.
          -->
          <div v-if="spendBlocker" class="outcome warning" role="status">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 17h.01M12 3l9 17H3z" /></svg>
            <div v-if="spendBlocker === 'unpriced'">
              <strong>GenStudio did not publish a price for {{ unpricedCount }} of these {{ quoted.length }} packs</strong>
              <p>The total for this selection is unknown, so it cannot be bought as one batch. Refresh the Store, or clear the unpriced packs and buy the rest.</p>
            </div>
            <div v-else-if="spendBlocker === 'balance-unknown'">
              <strong>Your content-spendable balance is not known right now</strong>
              <p>This is not a statement that you are short of credits — GenStudio has not published the balance, so buying stays off until it does.</p>
              <NuxtLink to="/usage">View credits</NuxtLink>
            </div>
            <div v-else>
              <strong>{{ formatCredits(shortfall) }} more credits are needed to buy all {{ quoted.length }}</strong>
              <p>Clear some of the selection or top up, so nothing is bought halfway through.</p>
              <NuxtLink to="/usage">View credits</NuxtLink>
            </div>
          </div>
        </template>

        <!-- Settling ------------------------------------------------------ -->
        <template v-else-if="phase === 'settling'">
          <p class="batch-progress" role="status" aria-live="polite">
            Buying {{ progress.done }} of {{ progress.total }} — leave this open until it finishes.
          </p>
          <p class="ceiling-note">Each pack is charged on its own. A pack that fails does not stop the rest.</p>
        </template>

        <!-- Result -------------------------------------------------------- -->
        <template v-else>
          <div :class="['outcome', failed.length ? 'warning' : 'success']" role="status">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path :d="failed.length ? 'M12 8v5M12 17h.01M12 3l9 17H3z' : 'm5 12.5 4 4L19 7'" /></svg>
            <div>
              <strong>{{ resultHeadline }}</strong>
              <p>{{ totals.charged === null ? 'GenStudio did not state the total charged' : `${formatCredits(totals.charged)} credits charged in total` }} · install them from the Owned shelf.</p>
            </div>
          </div>

          <dl class="purchase-ledger">
            <div><dt>Packs now owned</dt><dd>{{ succeeded.length }}</dd></div>
            <div v-if="failed.length"><dt>Not bought</dt><dd>{{ failed.length }}</dd></div>
            <div><dt>Credits charged</dt><dd>{{ formatCredits(totals.charged) }}</dd></div>
            <div><dt>Balance after</dt><dd>{{ formatCredits(finalBalance) }}</dd></div>
          </dl>

          <details v-if="failed.length" class="batch-breakdown" open>
            <summary>{{ failed.length }} could not be bought</summary>
            <ul>
              <li v-for="item in failed" :key="item.productId">
                <span class="item-title">{{ item.title }}</span>
                <span class="item-reason">{{ item.reason }}</span>
              </li>
            </ul>
          </details>

          <details v-if="succeeded.length" class="batch-breakdown">
            <summary>{{ succeeded.length }} now permanently owned</summary>
            <ul>
              <li v-for="item in succeeded" :key="item.productId">
                <span class="item-title">{{ item.title }}</span>
                <span class="item-price">{{ formatCredits(item.charged) }} credits</span>
              </li>
            </ul>
          </details>
        </template>
      </div>

      <footer class="batch-actions">
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="requestClose">
          {{ phase === 'result' ? 'Done' : 'Cancel' }}
        </button>
        <button
          v-if="phase === 'review'"
          type="button"
          class="btn btn-primary"
          :disabled="busy || !!spendBlocker || !quoted.length"
          @click="$emit('confirm')"
        >{{ totals.quoted === null ? `Buy all ${quoted.length}` : `Buy all ${quoted.length} · up to ${formatCredits(totals.quoted)} credits` }}</button>
        <button
          v-else-if="phase === 'result' && failed.some(item => item.retryable)"
          type="button"
          class="btn btn-primary"
          :disabled="busy"
          @click="$emit('retry-failed')"
        >Retry the {{ failed.filter(item => item.retryable).length }} that failed</button>
      </footer>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Buying a whole selection behind ONE confirmation.
 *
 * The multi-select used to promise a batch and deliver a single: "See exact
 * quotes (18)" opened one quote for one pack, and confirming bought that one.
 * The remaining seventeen arrived as seventeen more dialogs. What he asked for
 * is "select all and then 1 click buy all", so the deliberate confirm step now
 * happens ONCE, against a combined total, with a per-item breakdown he can read
 * before he agrees to it.
 *
 * The money rules this has to keep:
 *
 * - ONE total, shown before confirming, as a ceiling. Never a running tally
 *   discovered afterwards.
 * - The total must AGREE WITH, or explain itself against, the selection bar.
 *   When packs are skipped the dialog says so and names the bar's figure, so
 *   two different numbers on one screen are never left unexplained.
 * - The whole batch is refused up front if it does not fit the balance, rather
 *   than being discovered halfway through. Nothing is bought in that case.
 * - Each pack SETTLES INDEPENDENTLY. One retired or already-owned pack must not
 *   roll back seventeen good purchases, so failures are reported per item with
 *   a reason instead of being collapsed into "the batch failed".
 */
import { computed, nextTick, ref, watch } from 'vue'

import type { BatchPhase, BatchQuoteItem } from '~/composables/useBatchPurchase'
import { sumPublished } from '~/composables/useBatchPurchase'

const props = defineProps<{
  visible: boolean
  phase: BatchPhase
  items: BatchQuoteItem[]
  progress: { done: number; total: number }
  /**
   * The content-spendable balance, as the account strip reports it, or `null`
   * when GenStudio has not published one. Nullable on purpose: an unknown
   * balance must not arrive here disguised as zero.
   */
  balance: number | null
  /**
   * What the selection bar said, so a different dialog total can explain
   * itself. `null` when the bar could not state one either.
   */
  selectionTotal: number | null
  selectedCount: number
  busy?: boolean
}>()

const emit = defineEmits<{ close: []; confirm: []; 'retry-failed': [] }>()

const cancelButton = ref<HTMLButtonElement | null>(null)

// Excludes packs already bought: after a retry they still carry their quote,
// and listing them again would count their price twice in the ceiling.
const quoted = computed(() => props.items.filter(item => item.attempt && !item.reason && item.outcome !== 'owned'))
const skipped = computed(() => props.items.filter(item => item.reason && !item.outcome))
const succeeded = computed(() => props.items.filter(item => item.outcome === 'owned'))
const failed = computed(() => props.items.filter(item => item.outcome === 'failed'))

/**
 * Every total is a published figure or `null`. Never a fallback.
 *
 * A quote that arrives without `quoted_credits` does not cost nothing; its
 * price is UNKNOWN. Summing it as 0 would put a confident, too-low ceiling in
 * front of him and let him authorise a spend against a number GenStudio never
 * published -- the same class of defect as a screen stating a total it cannot
 * honour. So one missing figure makes the whole total unknown, and everything
 * downstream (the affordability test, the confirm button) treats unknown as
 * "cannot proceed" rather than as a small number.
 */
const totals = computed(() => ({
  base: sumPublished(quoted.value, item => item.attempt?.base_credit_price),
  componentDiscount: sumPublished(quoted.value, item => item.attempt?.discount_credits),
  operatorDiscount: sumPublished(quoted.value, item => item.attempt?.operator_discount_credits),
  quoted: sumPublished(quoted.value, item => item.attempt?.quoted_credits),
  charged: sumPublished(succeeded.value, item => item.charged),
}))

/** How many quotes carry no price, so the dialog can name the cause. */
const unpricedCount = computed(() => quoted.value.filter(item => typeof item.attempt?.quoted_credits !== 'number').length)

/**
 * The balance the ACCOUNT reports, not the sum of per-quote balances. Every
 * quote was issued against the same starting balance, so adding their
 * `balance_after` values together would subtract the same starting figure once
 * per pack and produce nonsense.
 *
 * `null` when GenStudio has not published it. An unknown balance is NOT a zero
 * balance: zero would tell him he cannot afford this, when the truth is that
 * the app does not know what he has.
 */
const balanceBefore = computed(() => props.balance)
const balanceAfter = computed(() => balanceBefore.value === null || totals.value.quoted === null
  ? null
  : balanceBefore.value - totals.value.quoted)
const finalBalance = computed(() => balanceBefore.value === null || totals.value.charged === null
  ? null
  : balanceBefore.value - totals.value.charged)

/**
 * Only ever true on two known numbers. Unknown is not affordable and not
 * unaffordable -- it is unanswered, and `affordable` being false is what
 * disables the confirm button while `spendBlocker` explains which it is.
 */
const affordable = computed(() => balanceBefore.value !== null
  && totals.value.quoted !== null
  && totals.value.quoted <= balanceBefore.value)
const shortfall = computed(() => balanceBefore.value === null || totals.value.quoted === null
  ? null
  : Math.max(0, totals.value.quoted - balanceBefore.value))

/** Why this batch cannot be confirmed, distinguishing "too dear" from "unknown". */
const spendBlocker = computed<'unpriced' | 'balance-unknown' | 'insufficient' | null>(() => {
  if (!quoted.value.length) return null
  if (totals.value.quoted === null) return 'unpriced'
  if (balanceBefore.value === null) return 'balance-unknown'
  return affordable.value ? null : 'insufficient'
})

const earliestExpiry = computed(() => quoted.value
  .map(item => item.attempt?.expires_at ?? '')
  .filter(Boolean)
  .sort()[0] ?? '')

const phaseLabel = computed(() => props.phase === 'result' ? 'GenStudio settled each pack' : 'Exact GenStudio quotes')
const heading = computed(() => {
  if (props.phase === 'quoting') return `Quoting ${props.progress.total} packs`
  if (props.phase === 'settling') return `Buying ${props.progress.total} packs`
  if (props.phase === 'result') return succeeded.value.length === props.items.length ? 'All packs are yours' : 'Finished, with some skipped'
  return `Buy ${quoted.value.length} ${quoted.value.length === 1 ? 'pack' : 'packs'}`
})
const resultHeadline = computed(() => failed.value.length
  ? `${succeeded.value.length} bought · ${failed.value.length} not bought`
  : `${succeeded.value.length} ${succeeded.value.length === 1 ? 'pack' : 'packs'} permanently owned`)

function requestClose(): void { if (!props.busy) emit('close') }
/**
 * Renders a published figure, or an em dash when there is none.
 *
 * The dash is the whole point: a credits field the server did not publish has
 * to LOOK unpublished. Printing 0 for it would be indistinguishable from a real
 * zero, which is precisely the substitution this screen must never make.
 */
function formatCredits(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—'
}
function formatExpiry(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
}

watch([() => props.visible, () => props.phase], async ([visible]) => {
  if (!visible) return
  await nextTick()
  cancelButton.value?.focus()
})
</script>

<style scoped>
.batch-shell { display: grid; gap: 0; }
.batch-header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding: 20px 22px 14px; border-bottom: 1px solid var(--border); }
.batch-header span { display: block; color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: .06em; }
.batch-header h2 { margin-top: 4px; font-size: var(--font-2xl); letter-spacing: -.02em; }
.dialog-close { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; text-decoration: underline; text-underline-offset: 3px; }
.batch-body { display: grid; gap: 14px; max-height: min(58vh, 560px); overflow-y: auto; padding: 18px 22px; }
.ownership-statement { color: var(--text-secondary); }
.batch-progress { font-size: var(--font-lg); font-variant-numeric: tabular-nums; }
.quote-grid, .purchase-ledger { display: grid; gap: 7px; }
.quote-grid > div, .purchase-ledger > div { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.quote-grid dt, .purchase-ledger dt { color: var(--text-secondary); }
.quote-grid dd, .purchase-ledger dd { font-variant-numeric: tabular-nums; }
.quote-total { padding-top: 7px; border-top: 1px solid var(--border); font-weight: 650; }
.quote-total dt, .quote-total dd { color: var(--text-primary); font-size: var(--font-lg); }
.ceiling-note, .skip-note { color: var(--text-muted); font-size: var(--font-sm); line-height: 1.5; }
.skip-note { padding: 9px 11px; border-radius: var(--radius-md); background: var(--bg-secondary); color: var(--text-secondary); }
.batch-breakdown { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary); }
.batch-breakdown summary { padding: 9px 11px; color: var(--text-secondary); cursor: pointer; font-size: var(--font-sm); font-weight: 650; }
.batch-breakdown ul { display: grid; gap: 2px; padding: 0 11px 10px; list-style: none; }
.batch-breakdown li { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 5px 0; border-top: 1px solid var(--border); font-size: var(--font-sm); }
.item-title { min-width: 0; overflow-wrap: anywhere; }
.item-price { flex: 0 0 auto; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.item-reason { flex: 0 0 auto; max-width: 55%; color: var(--text-muted); text-align: right; }
.outcome { display: flex; align-items: start; gap: 11px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); }
.outcome svg { flex: 0 0 auto; width: 21px; height: 21px; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.outcome.success { border-color: color-mix(in srgb, var(--success, #3fa66a) 40%, var(--border)); color: var(--success, #3fa66a); }
.outcome.warning { border-color: color-mix(in srgb, var(--warning) 40%, var(--border)); color: var(--warning); }
.outcome p { margin-top: 2px; color: var(--text-secondary); }
.outcome a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.batch-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 22px 18px; border-top: 1px solid var(--border); }
@media (max-width: 560px) {
  .batch-actions { flex-direction: column-reverse; }
  .batch-actions .btn { justify-content: center; min-height: 44px; }
  .item-reason { max-width: 100%; }
}
</style>
