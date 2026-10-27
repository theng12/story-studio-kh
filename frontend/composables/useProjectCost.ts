/**
 * Shared, cached cost report for a channel.
 *
 * Implements:
 * (a) Paid cost = actual Gateway charges per job (USD / settled credits).
 * (b) Local cost = Mac-minutes × power × electricity price (default 720 KHR/kWh).
 * (c) Waste % = redone / failed / rejected / superseded work as a share of total.
 *
 * Rule §6: Missing data is strictly distinct from $0 / 0%.
 */

import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useApi } from './useApi.js'
import { formatMinutes } from '../utils/upload-format.js'
import type {
  CostMeasurementNumber,
  CostSettings,
  EpisodeCostSummary,
  LocalCostMeasurement,
  PaidCostMeasurement,
  ProjectCostReport,
  WasteCostMeasurement,
} from '@shared/contracts'

const reportsBySlug = new Map<string, Ref<ProjectCostReport | null>>()
const loadingBySlug = new Map<string, Ref<boolean>>()
const errorBySlug = new Map<string, Ref<string | null>>()

export function formatPaid(paid: PaidCostMeasurement | null | undefined, emptyLabel = '—'): string {
  if (!paid || paid.state === 'unmeasurable') return emptyLabel
  if (paid.usd !== undefined && paid.usd > 0 && paid.credits !== undefined && paid.credits > 0) {
    return `$${paid.usd.toFixed(2)} (${paid.credits} cr)`
  }
  if (paid.usd !== undefined && paid.usd > 0) {
    return `$${paid.usd.toFixed(2)}`
  }
  if (paid.credits !== undefined && paid.credits > 0) {
    return `${paid.credits} cr`
  }
  if (paid.usd === 0) return '$0.00'
  if (paid.credits === 0) return '0 cr'
  return '$0.00'
}

export function formatLocal(local: LocalCostMeasurement | null | undefined, emptyLabel = '—'): string {
  if (!local || local.state === 'unmeasurable') return emptyLabel
  const mins = formatMinutes(local.mac_minutes || 0)
  // A measured fraction of a cent must not read as $0.00 (AGENTS §6).
  const usd = typeof local.cost_usd !== 'number' ? '$0.00'
    : local.cost_usd > 0 && local.cost_usd < 0.005 ? '<$0.01' : `$${local.cost_usd.toFixed(2)}`
  return `${mins} · ${usd}`
}
export function formatWaste(waste: WasteCostMeasurement | null | undefined, emptyLabel = '—'): string {
  if (!waste || waste.state === 'unmeasurable') return emptyLabel
  return `${waste.percent ?? 0}%`
}

export function formatTotal(total: CostMeasurementNumber | null | undefined, emptyLabel = '—'): string {
  if (!total || total.state === 'unmeasurable') return emptyLabel
  return `$${(total.value ?? 0).toFixed(2)}`
}

export function useProjectCost(slugRef: Ref<string> | ComputedRef<string>) {
  const { get } = useApi()

  function getReportRef(): Ref<ProjectCostReport | null> {
    const slug = slugRef.value
    let r = reportsBySlug.get(slug)
    if (!r) {
      r = ref<ProjectCostReport | null>(null)
      reportsBySlug.set(slug, r)
    }
    return r
  }

  function getLoadingRef(): Ref<boolean> {
    const slug = slugRef.value
    let l = loadingBySlug.get(slug)
    if (!l) {
      l = ref<boolean>(false)
      loadingBySlug.set(slug, l)
    }
    return l
  }

  function getErrorRef(): Ref<string | null> {
    const slug = slugRef.value
    let e = errorBySlug.get(slug)
    if (!e) {
      e = ref<string | null>(null)
      errorBySlug.set(slug, e)
    }
    return e
  }

  const report = computed(() => getReportRef().value)
  const loading = computed(() => getLoadingRef().value)
  const error = computed(() => getErrorRef().value)

  async function load(force = false): Promise<void> {
    const slug = slugRef.value
    if (!slug) return
    const repRef = getReportRef()
    if (!force && repRef.value) return

    const loadRef = getLoadingRef()
    const errRef = getErrorRef()
    loadRef.value = true
    errRef.value = null

    try {
      const data = await get<ProjectCostReport>(`/projects/${slug}/cost`)
      repRef.value = data
    } catch (e: any) {
      errRef.value = e?.message || 'Failed to load project cost report'
    } finally {
      loadRef.value = false
    }
  }

  function costFor(episodeCode: string | null | undefined): EpisodeCostSummary | null {
    if (!episodeCode || !report.value?.episodes) return null
    return report.value.episodes[episodeCode] || report.value.episodes[episodeCode.toUpperCase()] || null
  }

  const channelTotal = computed(() => report.value?.channel_total ?? null)
  const settings = computed(() => report.value?.settings ?? null)

  return {
    report,
    loading,
    error,
    channelTotal,
    settings,
    costFor,
    load,
    refresh: () => load(true),
    formatPaid,
    formatLocal,
    formatWaste,
    formatTotal,
  }
}
