/** GenStudio-authoritative credit polling. No local rate calculations. */
import { ref, readonly } from 'vue'
import { useApi } from './useApi.js'

export const DEFAULT_CREDIT_POLL_MS = 30_000

const genstudioCredits = ref<number | null>(null)
const genstudioConfigured = ref(false)
const usageError = ref('')
const isRefreshing = ref(false)
const pollIntervalMs = ref(DEFAULT_CREDIT_POLL_MS)
let creditInterval: ReturnType<typeof setInterval> | null = null
let currentSlug: string | null = null
let creditRequest: Promise<void> | null = null

export function useCredits() {
  const { get } = useApi()

  async function fetchHealth(slug: string): Promise<void> {
    if (!slug || slug === 'undefined') return
    if (creditRequest) return creditRequest
    creditRequest = (async () => {
      isRefreshing.value = true
      try {
        const keys = await get<{ providers: Array<{ providerId: string; hasKey: boolean }> }>('/app-settings/api-keys')
        genstudioConfigured.value = keys.providers.some(row => row.providerId === 'genstudio' && row.hasKey)
        if (!genstudioConfigured.value) {
          genstudioCredits.value = null
          usageError.value = 'Scoped GenStudio key is not configured.'
          return
        }
        const usage = await get<{ overview: { credit_balance: number } }>('/app-settings/genstudio/usage')
        genstudioCredits.value = usage.overview.credit_balance
        usageError.value = ''
      } catch (error: any) {
        genstudioCredits.value = null
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

  function startPolling(slug: string, intervalMs = DEFAULT_CREDIT_POLL_MS): void {
    stopPolling()
    currentSlug = slug
    pollIntervalMs.value = intervalMs
    void fetchHealth(slug)
    creditInterval = setInterval(() => { void fetchHealth(slug) }, intervalMs)
  }

  function stopPolling(): void {
    if (creditInterval) clearInterval(creditInterval)
    creditInterval = null
    currentSlug = null
  }

  async function refreshNow(): Promise<void> {
    if (!currentSlug) return
    await fetchHealth(currentSlug)
  }

  return {
    genstudioCredits: readonly(genstudioCredits),
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
