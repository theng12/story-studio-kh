/** GenStudio-authoritative credit polling. No local rate calculations. */
import { ref, readonly } from 'vue'
import { useApi } from './useApi.js'
import { keepStandingAfterFailedRefresh } from '../utils/genstudio-freshness.js'
import { createVisibleInterval } from './useVisibleInterval.js'

export const DEFAULT_CREDIT_POLL_MS = 30_000

const genstudioCredits = ref<number | null>(null)
/**
 * When the balance on screen was actually loaded FROM GenStudio — not when this
 * app last asked. The server answers a failed refresh from its own last known
 * copy and reports that copy's age, so the two add up to one honest number.
 */
const genstudioCreditsLoadedAt = ref<number | null>(null)
/** True while the balance is only on screen because a refresh failed. */
const genstudioCreditsStale = ref(false)
export interface GenStudioServiceTier {
  code: string
  display_name: string
  threshold_cents: number
  paid_concurrency_limit: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  max_api_keys: number
}
export interface GenStudioServiceTierStanding {
  current: GenStudioServiceTier
  ladder: GenStudioServiceTier
  floor?: GenStudioServiceTier | null
  overridden: boolean
  lifetime_paid_cents: number
  next_tier: GenStudioServiceTier | null
  cents_to_next_tier: number | null
}
const genstudioTier = ref<GenStudioServiceTierStanding | null>(null)
const genstudioActiveLanes = ref<number | null>(null)
const genstudioLaneLimit = ref<number | null>(null)
const genstudioConfigured = ref(false)
const usageError = ref('')
const isRefreshing = ref(false)
const pollIntervalMs = ref(DEFAULT_CREDIT_POLL_MS)
// Paused while the window is hidden (each tick is two local calls and a Gateway read, ~5 800 a day
// for a strip nobody is looking at); refreshed the moment the window is shown again.
let creditInterval: ReturnType<typeof createVisibleInterval> | null = null
const pollingConsumers = new Set<symbol>()
let creditRequest: Promise<void> | null = null

function forgetStanding(): void {
  genstudioCredits.value = null
  genstudioCreditsLoadedAt.value = null
  genstudioCreditsStale.value = false
  genstudioTier.value = null
  genstudioActiveLanes.value = null
  genstudioLaneLimit.value = null
}

export function useCredits() {
  const { get } = useApi()

  async function fetchHealth(): Promise<void> {
    if (creditRequest) return creditRequest
    creditRequest = (async () => {
      isRefreshing.value = true
      try {
        const keys = await get<{ providers: Array<{ providerId: string; hasKey: boolean }> }>('/app-settings/api-keys', { cache: 'no-store' })
        genstudioConfigured.value = keys.providers.some(row => row.providerId === 'genstudio' && row.hasKey)
        if (!genstudioConfigured.value) {
          forgetStanding()
          usageError.value = 'Gateway API Key is not configured.'
          return
        }
        const usage = await get<{
          overview: {
            credit_balance: number
            paid_active_jobs?: number
            paid_concurrency_limit?: number
            service_tier?: GenStudioServiceTierStanding
          }
          overview_freshness?: { stale?: boolean; ageMs?: number }
        }>('/app-settings/genstudio/overview', { cache: 'no-store' })
        // The server retries before it answers, and falls back to its own last
        // known copy rather than failing. A 200 that is marked stale is still a
        // real balance — it is just not one refreshed during this call.
        const freshness = usage.overview_freshness
        genstudioCreditsStale.value = freshness?.stale === true
        genstudioCreditsLoadedAt.value = Date.now() - (Number.isFinite(freshness?.ageMs) ? freshness!.ageMs as number : 0)
        genstudioCredits.value = usage.overview.credit_balance
        genstudioTier.value = usage.overview.service_tier || null
        genstudioActiveLanes.value = Number.isInteger(usage.overview.paid_active_jobs)
          ? usage.overview.paid_active_jobs as number
          : null
        genstudioLaneLimit.value = Number.isInteger(usage.overview.paid_concurrency_limit)
          ? usage.overview.paid_concurrency_limit as number
          : null
        usageError.value = ''
      } catch (error: any) {
        usageError.value = error?.data?.detail || error?.message || 'Your GenStudio credit balance could not be read right now.'
        // A failed poll is not proof the account is unreachable, and saying so
        // next to a job that is generating normally is what made the header
        // cry wolf. Keep the last known standing and mark it stale; drop to
        // "Unavailable" only when the key lost its entitlement (definitive, and
        // the server never serves stale data across that) or the copy we hold
        // has aged past the point where showing it would be misleading.
        if (!keepStandingAfterFailedRefresh(genstudioCredits.value, genstudioCreditsLoadedAt.value, error?.data?.code)) {
          forgetStanding()
          return
        }
        genstudioCreditsStale.value = true
      } finally {
        isRefreshing.value = false
      }
    })()
    try {
      await creditRequest
    } finally {
      creditRequest = null
    }
  }

  function startPolling(intervalMs = DEFAULT_CREDIT_POLL_MS): () => void {
  // model-drift-allow: Internal polling-lease label, not a GenStudio catalog product ID.
  const consumer = Symbol('genstudio-account-standing')
    pollingConsumers.add(consumer)
    if (!creditInterval) {
      pollIntervalMs.value = intervalMs
      void fetchHealth()
      creditInterval = createVisibleInterval(() => { void fetchHealth() }, intervalMs)
      creditInterval.start()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      pollingConsumers.delete(consumer)
      if (pollingConsumers.size === 0) clearPollingInterval()
    }
  }

  function clearPollingInterval(): void {
    creditInterval?.stop()
    creditInterval = null
  }

  function stopPolling(): void {
    pollingConsumers.clear()
    clearPollingInterval()
  }

  async function refreshNow(): Promise<void> {
    await fetchHealth()
  }

  return {
    genstudioCredits: readonly(genstudioCredits),
    genstudioCreditsLoadedAt: readonly(genstudioCreditsLoadedAt),
    genstudioCreditsStale: readonly(genstudioCreditsStale),
    genstudioTier: readonly(genstudioTier),
    genstudioActiveLanes: readonly(genstudioActiveLanes),
    genstudioLaneLimit: readonly(genstudioLaneLimit),
    genstudioConfigured: readonly(genstudioConfigured),
    usageError: readonly(usageError),
    isRefreshing: readonly(isRefreshing),
    pollIntervalMs: readonly(pollIntervalMs),
    fetchHealth,
    startPolling,
    stopPolling,
    refreshNow,
  }
}
