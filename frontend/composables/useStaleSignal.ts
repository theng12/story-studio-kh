/**
 * Tiny helper for "is this data stale?" indicators on background widgets.
 *
 * Pattern: a polling / background-refresh call increments a counter on
 * failure, resets it on success. The widget renders a dim "data may be
 * stale" badge once `failures >= threshold` so a single blip doesn't
 * scream, but a sustained outage is visible to the operator.
 *
 * Why this exists: silent catch blocks on background fetches let the UI
 * keep rendering empty/old data while the backend is broken. The audit
 * report (Session 11) called this out as the worst class of operator-UX
 * bug — "operator can't tell whether the system is working, broken, or
 * stale". The staleness counter gives a low-noise way to surface that
 * third state without toasting on every retry.
 *
 * Not for one-shot user-initiated calls — those should use `useToast`
 * via `humanizeError` because the operator was waiting for the result
 * and silence is misleading.
 */

import { ref, computed } from 'vue'

export function useStaleSignal(threshold = 3) {
  const failures = ref(0)
  const lastError = ref<string>('')
  const stale = computed(() => failures.value >= threshold)

  function markSuccess() {
    failures.value = 0
    lastError.value = ''
  }

  function markFailure(err: unknown) {
    failures.value++
    const e = err as { data?: { detail?: string }; message?: string } | undefined
    lastError.value = e?.data?.detail || e?.message || (typeof err === 'string' ? err : 'Unknown error')
  }

  return { failures, lastError, stale, markSuccess, markFailure }
}
