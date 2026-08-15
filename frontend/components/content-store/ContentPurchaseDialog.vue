<template>
  <Modal
    :visible="visible"
    size="md"
    labelledby="content-purchase-title"
    dialog-class="content-purchase-dialog modal-flush"
    @close="requestClose"
  >
    <div v-if="attempt && product" class="purchase-shell">
      <header class="purchase-header">
        <div>
          <span>{{ product.free ? 'Permanent free entitlement' : 'Exact GenStudio quote' }}</span>
          <h2 id="content-purchase-title">{{ product.title }}</h2>
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

      <div class="purchase-body">
        <template v-if="attempt.status === 'completed'">
          <div class="outcome success" role="status">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4 4L19 7" /></svg>
            <div>
              <strong>Owned in GenStudio · not installed on this Mac</strong>
              <p>Permanent ownership is active for this GenStudio account.</p>
            </div>
          </div>
          <dl class="purchase-ledger">
            <div><dt>Credits charged</dt><dd>{{ formatCredits(attempt.credits_charged ?? 0) }}</dd></div>
            <div><dt>Balance after</dt><dd>{{ formatCredits(attempt.balance_after) }}</dd></div>
          </dl>
          <p class="receipt-state">Signed receipt cached · use Restore purchases on the Owned shelf to verify and install.</p>
          <p v-if="attempt.replayed" class="replay-state">GenStudio safely replayed the saved purchase attempt.</p>
        </template>

        <template v-else>
          <p class="ownership-statement">Permanent ownership for this GenStudio account</p>

          <dl class="quote-grid">
            <div><dt>Base price</dt><dd>{{ formatCredits(attempt.base_credit_price) }} credits</dd></div>
            <div><dt>Owned-content discount</dt><dd>−{{ formatCredits(attempt.discount_credits) }} credits</dd></div>
            <div class="quote-total"><dt>Maximum deduction</dt><dd>{{ formatCredits(attempt.quoted_credits) }} credits</dd></div>
            <div><dt>Content-spendable balance</dt><dd>{{ formatCredits(attempt.balance_before) }} credits</dd></div>
            <div><dt>After purchase</dt><dd>{{ formatCredits(attempt.balance_after) }} credits</dd></div>
            <div><dt>Quote expires</dt><dd>{{ formatExpiry(attempt.expires_at) }}</dd></div>
          </dl>

          <p class="ceiling-note">This is the maximum deduction. The final charge may be lower when GenStudio settles the purchase.</p>

          <div v-if="!attempt.sufficient_credits" class="outcome warning" role="status">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 17h.01M12 3l9 17H3z" /></svg>
            <div>
              <strong>{{ formatCredits(attempt.shortfall_credits) }} more credits are needed</strong>
              <p>This quote cannot be confirmed with the current content-spendable balance.</p>
              <NuxtLink to="/usage">View credits</NuxtLink>
            </div>
          </div>

          <div v-if="displayError" :class="['outcome', displayError.tone]" role="status">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 17h.01M12 3l9 17H3z" /></svg>
            <div>
              <strong>{{ displayError.title }}</strong>
              <p>{{ displayError.detail }}</p>
              <NuxtLink v-if="displayError.showCredits" to="/usage">View credits</NuxtLink>
            </div>
          </div>
        </template>
      </div>

      <footer class="purchase-actions">
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="requestClose">
          {{ attempt.status === 'completed' ? 'Done' : 'Cancel' }}
        </button>
        <button
          v-if="attempt.status === 'uncertain' || attempt.status === 'refused'"
          type="button"
          class="btn btn-primary"
          :disabled="busy"
          @click="$emit('retry', attempt.quote_id)"
        >{{ busy ? 'Retrying…' : 'Retry this purchase' }}</button>
        <button
          v-else-if="attempt.status !== 'completed'"
          type="button"
          class="btn btn-primary"
          :disabled="busy || !attempt.sufficient_credits || attempt.status === 'submitting'"
          @click="$emit('confirm', attempt.quote_id)"
        >{{ busy || attempt.status === 'submitting' ? 'Submitting…' : product.free ? 'Confirm permanent ownership' : `Confirm up to ${formatCredits(attempt.quoted_credits)} credits` }}</button>
      </footer>
    </div>
  </Modal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type {
  ContentStoreProduct,
  ContentStoreUiError,
  PublicContentPurchaseAttempt,
} from '~/composables/useContentStore'
import { contentStoreErrorPresentation } from '~/composables/useContentStore'

const props = defineProps<{
  visible: boolean
  attempt: PublicContentPurchaseAttempt | null
  product: ContentStoreProduct | null
  error: ContentStoreUiError | null
  busy?: boolean
}>()

const emit = defineEmits<{
  close: []
  confirm: [quoteId: string]
  retry: [quoteId: string]
}>()

const cancelButton = ref<HTMLButtonElement | null>(null)

watch([() => props.visible, () => props.attempt?.status], async ([visible]) => {
  if (!visible) return
  await nextTick()
  await nextTick()
  cancelButton.value?.focus({ preventScroll: true })
})

function requestClose(): void {
  if (!props.busy) emit('close')
}

const displayError = computed(() => {
  const attempt = props.attempt
  const refusal = attempt?.refusal
  const code = refusal?.code || props.error?.code || ''
  const detail = refusal?.detail || props.error?.detail || attempt?.uncertain_detail || ''
  if (attempt?.status === 'uncertain' || code === 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN') {
    return {
      tone: 'warning', title: 'GenStudio’s answer is uncertain',
      detail: detail || 'No replacement was sent. Retry this exact purchase to reuse its saved attempt.',
      showCredits: false,
    }
  }
  if (code === 'signing_unavailable') {
    return {
      tone: 'neutral', title: 'The Content Store is not open yet',
      detail: 'GenStudio refused before any debit or ownership change because it cannot sign purchases right now.', showCredits: false,
    }
  }
  if (code === 'insufficient_credits') {
    return { tone: 'warning', title: 'More credits are needed', detail, showCredits: true }
  }
  if (props.error?.status === 401 || code === 'CONTENT_STORE_SCOPE_REQUIRED') {
    return { tone: 'warning', title: 'This key needs another Content Store scope', detail, showCredits: false }
  }
  if (code === 'quote_expired' || code === 'quote_rejected') {
    return { tone: 'warning', title: 'This quote can no longer be used', detail: `${detail} Close this quote and request a new exact quote.`, showCredits: false }
  }
  if (code === 'already_owned') {
    return {
      tone: 'neutral', title: 'Already owned in GenStudio',
      detail: `${detail} Close this quote, then refresh the Store to see current ownership.`,
      showCredits: false,
    }
  }
  if (code || (attempt?.status === 'refused' && detail)) {
    const presentation = contentStoreErrorPresentation({ status: refusal?.status || props.error?.status || null, code: code || 'CONTENT_STORE_UPSTREAM_REFUSED', detail: detail || 'GenStudio did not complete this purchase.' })
    return { tone: 'warning', title: presentation.title, detail: `${presentation.detail} ${presentation.recovery}`, showCredits: false }
  }
  return null
})

function formatCredits(value: number): string {
  return value.toLocaleString()
}

function formatExpiry(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<style scoped>
.purchase-shell { display: grid; min-width: 0; }
.purchase-header,
.purchase-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; }
.purchase-header { border-bottom: 1px solid var(--border); }
.purchase-header span { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; }
.purchase-header h2 { margin-top: 2px; overflow-wrap: anywhere; font-size: var(--font-2xl); line-height: 1.25; }
.dialog-close { min-width: 44px; min-height: 36px; border: 1px solid var(--border); border-radius: var(--radius-md); background: transparent; color: var(--text-secondary); cursor: pointer; }
.dialog-close:hover { background: var(--bg-hover); color: var(--text-primary); }
.dialog-close:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.purchase-body { display: grid; gap: 16px; padding: 20px; }
.ownership-statement { color: var(--text-primary); font-weight: 700; }
.quote-grid,
.purchase-ledger { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.quote-grid div,
.purchase-ledger div { padding: 11px 12px; border-radius: var(--radius-md); background: var(--bg-tertiary); }
.quote-grid dt,
.purchase-ledger dt { color: var(--text-muted); font-size: var(--font-xs); }
.quote-grid dd,
.purchase-ledger dd { color: var(--text-primary); font-size: var(--font-md); font-weight: 700; font-variant-numeric: tabular-nums; }
.quote-grid .quote-total { background: var(--accent-dim); }
.quote-grid .quote-total dd { color: var(--accent); }
.ceiling-note,
.receipt-state,
.replay-state { color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.55; }
.receipt-state { padding: 10px 12px; border-radius: var(--radius-md); background: var(--bg-tertiary); }
.outcome { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 11px; padding: 13px; border-radius: var(--radius-md); background: var(--bg-tertiary); }
.outcome svg { width: 22px; height: 22px; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.outcome strong { display: block; color: var(--text-primary); }
.outcome p { margin-top: 2px; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; }
.outcome a { display: inline-block; margin-top: 6px; font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
.outcome.success { background: color-mix(in srgb, var(--success) 9%, var(--bg-secondary)); color: var(--success); }
.outcome.warning { background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--warning); }
.outcome.neutral { color: var(--text-secondary); }
.purchase-actions { border-top: 1px solid var(--border); background: var(--bg-tertiary); }
@media (max-width: 520px) {
  .purchase-header { align-items: flex-start; }
  .quote-grid,
  .purchase-ledger { grid-template-columns: 1fr; }
  .purchase-actions { align-items: stretch; flex-direction: column-reverse; }
  .purchase-actions .btn { width: 100%; justify-content: center; }
}
</style>

<style>
.content-purchase-dialog { overflow: hidden; }
</style>
