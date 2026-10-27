/**
 * Episode and channel cost metrics: paid Gateway charge, local compute cost, and waste percentage.
 *
 * Rule §6: A zero that means two things is a defect.
 * State 'measured' represents a proven measurement (including $0 / 0% when work was free).
 * State 'unmeasurable' represents absent or unrecorded data ("No data" / unknown).
 */

export interface CostMeasurementNumber {
  state: 'measured' | 'unmeasurable'
  value?: number
  reason?: string
}

export interface PaidCostMeasurement {
  state: 'measured' | 'unmeasurable'
  usd?: number
  credits?: number
  reason?: string
}

export interface LocalCostMeasurement {
  state: 'measured' | 'unmeasurable'
  mac_minutes?: number
  cost_usd?: number
  cost_khr?: number
  watts_estimate?: number
  reason?: string
}

export interface WasteCostMeasurement {
  state: 'measured' | 'unmeasurable'
  percent?: number // 0 to 100
  waste_cost_usd?: number
  total_cost_usd?: number
  waste_credits?: number
  total_credits?: number
  waste_mac_minutes?: number
  total_mac_minutes?: number
  waste_jobs_count?: number
  total_jobs_count?: number
  reason?: string
}

export interface EpisodeCostSummary {
  episode_code: string
  paid: PaidCostMeasurement
  local: LocalCostMeasurement
  waste: WasteCostMeasurement
  total_usd?: CostMeasurementNumber
}

export interface CostSettings {
  /** Electricity tariff in KHR per kWh. Default: 720 (EDC standard rate). */
  electricity_khr_per_kwh: number
  /** Exchange rate KHR per USD. Default: 4000 (so 720 KHR ≈ $0.18/kWh). */
  khr_per_usd: number
  /** Workload power draw estimates in Watts per Mac class. */
  mac_power_watts: Record<string, number>
}

export const DEFAULT_COST_SETTINGS: CostSettings = {
  electricity_khr_per_kwh: 720,
  khr_per_usd: 4000,
  mac_power_watts: {
    'mac-mini': 35,
    'mac-studio': 85,
    'macbook-pro': 50,
    'mac-pro': 150,
    'default': 45,
  },
}

export interface ProjectCostReport {
  project_slug: string
  settings: CostSettings
  channel_total: {
    paid: PaidCostMeasurement
    local: LocalCostMeasurement
    waste: WasteCostMeasurement
    total_usd?: CostMeasurementNumber
  }
  episodes: Record<string, EpisodeCostSummary>
}
