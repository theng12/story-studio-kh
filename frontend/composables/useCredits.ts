/**
 * Credit/balance + usage polling composable.
 */

// Explicit Vue + composable imports so this module is usable from plain
// node:test (no Nuxt auto-import context). Nuxt's auto-imports remain
// additive inside .vue files.
import { ref, readonly } from 'vue'
import { useApi } from './useApi.js'

export const DEFAULT_CREDIT_POLL_MS = 30_000

export type ElevenLabsBalance = {
  tier: string
  character_count: number
  character_limit: number
  remaining: number
}

export type DeepseekBalance = { currency: string; total_balance: number }

const kieCredits = ref<number | string | null>(null)
const falBalance = ref<number | string | null>(null)
const elevenLabsBalance = ref<ElevenLabsBalance | null>(null)
const genaiproBalance = ref<number | null>(null)
const fishCredit = ref<number | null>(null)
const deepseekBalance = ref<DeepseekBalance | null>(null)
const openaiUsage = ref<number>(0)
const apiKeys = ref<Record<string, boolean>>({})
const isRefreshing = ref<boolean>(false)
const pollIntervalMs = ref<number>(DEFAULT_CREDIT_POLL_MS)
let creditInterval: ReturnType<typeof setInterval> | null = null
let currentSlug: string | null = null
const fetchesInFlight = new Map<string, Promise<void>>()

export function useCredits() {
  const { get } = useApi()

  async function fetchHealth(slug: string) {
    // Race guard: route transitions can call this mid-tick when slug
    // is briefly undefined or the literal string "undefined" (a
    // route.params.slug template-literal artifact). Either form would
    // hit /projects/undefined/health which is always 404. Skip
    // silently — the next valid tick will take over once the route
    // settles.
    if (!slug || slug === 'undefined') return
    const existing = fetchesInFlight.get(slug)
    if (existing) return existing

    const request = (async () => {
      isRefreshing.value = true
      try {
        const [healthData, usageData] = await Promise.all([
          get<{ credits: { kie: any; fal: any; elevenlabs: ElevenLabsBalance | null; genaipro: number | null; fishaudio: number | null; deepseek: DeepseekBalance | null }; api_keys: Record<string, boolean> }>(`/projects/${slug}/health`),
          get<{ total_cost: number }>('/usage'),
        ])
        // A slow response from the previous project must not overwrite the
        // balances after navigation. Direct one-off calls (no active poll)
        // still apply normally.
        if (currentSlug !== null && currentSlug !== slug) return
        kieCredits.value = healthData.credits.kie
        falBalance.value = healthData.credits.fal
        elevenLabsBalance.value = healthData.credits.elevenlabs
        genaiproBalance.value = healthData.credits.genaipro ?? null
        fishCredit.value = healthData.credits.fishaudio ?? null
        deepseekBalance.value = healthData.credits.deepseek ?? null
        apiKeys.value = healthData.api_keys
        openaiUsage.value = usageData.total_cost
      } catch {
        // Keep the last known balances on a transient provider failure.
      } finally {
        fetchesInFlight.delete(slug)
        isRefreshing.value = fetchesInFlight.size > 0
      }
    })()
    fetchesInFlight.set(slug, request)
    return request
  }

  function startPolling(slug: string, intervalMs = DEFAULT_CREDIT_POLL_MS) {
    stopPolling()
    currentSlug = slug
    pollIntervalMs.value = intervalMs
    void fetchHealth(slug)
    creditInterval = setInterval(() => {
      void fetchHealth(slug)
    }, intervalMs)
  }

  function stopPolling() {
    if (creditInterval) {
      clearInterval(creditInterval)
      creditInterval = null
    }
    currentSlug = null
  }

  // Manual refresh: reset the countdown so the user gets a fresh 5s
  // window after the forced fetch — otherwise the next auto-tick would
  // fire moments later and feel jittery.
  async function refreshNow() {
    if (!currentSlug) return
    await fetchHealth(currentSlug)
    if (creditInterval) {
      clearInterval(creditInterval)
      const slug = currentSlug
      creditInterval = setInterval(() => {
        void fetchHealth(slug)
      }, pollIntervalMs.value)
    }
  }

  return {
    kieCredits: readonly(kieCredits),
    falBalance: readonly(falBalance),
    elevenLabsBalance: readonly(elevenLabsBalance),
    genaiproBalance: readonly(genaiproBalance),
    fishCredit: readonly(fishCredit),
    deepseekBalance: readonly(deepseekBalance),
    openaiUsage: readonly(openaiUsage),
    apiKeys: readonly(apiKeys),
    isRefreshing: readonly(isRefreshing),
    pollIntervalMs: readonly(pollIntervalMs),
    fetchHealth,
    startPolling,
    stopPolling,
    refreshNow,
  }
}
