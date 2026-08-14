/** GenStudio-authoritative credit polling. No local rate calculations. */
import { ref, readonly } from 'vue'
import { useApi } from './useApi.js'

export const DEFAULT_CREDIT_POLL_MS = 30_000

const genstudioCredits = ref<number | null>(null)
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
let creditInterval: ReturnType<typeof setInterval> | null = null
const pollingConsumers = new Set<symbol>()
let creditRequest: Promise<void> | null = null

export function useCredits() {
  const { get } = useApi()

  async function fetchHealth(): Promise<void> {
    if (creditRequest) return creditRequest
    creditRequest = (async () => {
      isRefreshing.value = true
      try {
        const keys = await get<{ providers: Array<{ providerId: string; hasKey: boolean }> }>('/app-settings/api-keys')
        genstudioConfigured.value = keys.providers.some(row => row.providerId === 'genstudio' && row.hasKey)
        if (!genstudioConfigured.value) {
          genstudioCredits.value = null
          genstudioTier.value = null
          genstudioActiveLanes.value = null
          genstudioLaneLimit.value = null
          usageError.value = 'GenStudio API key is not configured.'
          return
        }
        const usage = await get<{ overview: {
          credit_balance: number
          paid_active_jobs?: number
          paid_concurrency_limit?: number
          service_tier?: GenStudioServiceTierStanding
        } }>('/app-settings/genstudio/usage')
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
        genstudioCredits.value = null
        genstudioTier.value = null
        genstudioActiveLanes.value = null
        genstudioLaneLimit.value = null
        usageError.value = error?.data?.detail || error?.message || 'Authoritative GenStudio credit balance unavailable.'
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
      creditInterval = setInterval(() => { void fetchHealth() }, intervalMs)
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
    if (creditInterval) clearInterval(creditInterval)
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
