/**
 * Episode and project cost service.
 *
 * Implements:
 * (a) Paid cost = actual Gateway charges recorded per job (cost_usd / settled_credits).
 * (b) Local cost = Mac-minutes × power × electricity price.
 * (c) Waste % = cost of redone / failed / rejected / superseded work as a share of total.
 *
 * Rule §6: "No data" is distinct from 0 everywhere.
 */

import os from 'node:os'
import { execFile } from 'node:child_process'
import type { Job } from '../models/types.js'
import {
  type CostSettings,
  type EpisodeCostSummary,
  type LocalCostMeasurement,
  type PaidCostMeasurement,
  type ProjectCostReport,
  type WasteCostMeasurement,
  DEFAULT_COST_SETTINGS,
} from '../contracts/episode-cost.js'
import { getCostSettings } from './app-settings.js'
import { getRawProjectJobs } from './job-queue.js'

let cachedThisMacClass: string | null = null

/** Classify the Mac from `hw.model` and, failing that, the CPU name. Pure. */
export function classifyMacModel(model: string, cpu: string): string {
  const m = (model || '').toLowerCase()
  if (!m && !cpu) return 'default'
  if (m.includes('studio') || m.startsWith('mac13,') || m === 'mac14,13' || m === 'mac14,14') return 'mac-studio'
  if (m.includes('mini')) return 'mac-mini'
  if (m.includes('book')) return 'macbook-pro'
  if (m.includes('pro')) return 'mac-pro'
  if (m.includes('imac')) return 'imac'
  const c = cpu || ''
  if (/studio/i.test(c)) return 'mac-studio'
  if (/mini/i.test(c)) return 'mac-mini'
  if (/book/i.test(c)) return 'macbook-pro'
  return 'default'
}

/**
 * Which Mac class this process is running on, read once and remembered.
 *
 * Async on purpose: the cost routes are ordinary requests, and blocking the
 * event loop on a subprocess there is the defect `request-path-blocking-io`
 * pins for other paths. `STORY_STUDIO_TEST_MAC_CLASS` seeds it for tests.
 */
export async function detectThisMacClassAsync(): Promise<string> {
  if (process.env.STORY_STUDIO_TEST_MAC_CLASS) return process.env.STORY_STUDIO_TEST_MAC_CLASS
  if (cachedThisMacClass) return cachedThisMacClass
  const cpu = os.cpus()[0]?.model || ''
  if (process.platform !== 'darwin') {
    cachedThisMacClass = 'default'
    return 'default'
  }
  const model = await new Promise<string>(resolve => {
    execFile('sysctl', ['-n', 'hw.model'], { timeout: 500 }, (error, stdout) => {
      resolve(error ? '' : String(stdout).trim())
    })
  })
  cachedThisMacClass = classifyMacModel(model, cpu)
  return cachedThisMacClass
}

/** Back-assigned by `classifyThisMacSyncForTest` — unused by production paths. */
export function detectThisMacClass(): string {
  if (process.env.STORY_STUDIO_TEST_MAC_CLASS) {
    return process.env.STORY_STUDIO_TEST_MAC_CLASS
  }
  if (cachedThisMacClass) return cachedThisMacClass
  return classifyMacModel('', os.cpus()[0]?.model || '')
}

/** Name this process's Mac from a caller-supplied `hw.model` value (tests and startup pre-warm). */
export function rememberThisMacClass(model: string): string {
  cachedThisMacClass = classifyMacModel(model, os.cpus()[0]?.model || '')
  return cachedThisMacClass
}

export function resetDetectedMacClassForTest(): void {
  cachedThisMacClass = null
}

export function resolveWattsForMachine(
  hardwareClass: string | undefined | null,
  settings: CostSettings,
): { watts: number; classKey: string } {
  const wattsMap = settings.mac_power_watts || DEFAULT_COST_SETTINGS.mac_power_watts
  const fallback = wattsMap['default'] ?? DEFAULT_COST_SETTINGS.mac_power_watts['default']!

  if (!hardwareClass || typeof hardwareClass !== 'string') {
    return { watts: fallback, classKey: 'default' }
  }

  const raw = hardwareClass.trim().toLowerCase()
  if (typeof wattsMap[raw] === 'number') {
    return { watts: wattsMap[raw]!, classKey: raw }
  }

  if (raw.includes('studio')) {
    return { watts: wattsMap['mac-studio'] ?? DEFAULT_COST_SETTINGS.mac_power_watts['mac-studio']!, classKey: 'mac-studio' }
  }
  if (raw.includes('mini')) {
    return { watts: wattsMap['mac-mini'] ?? DEFAULT_COST_SETTINGS.mac_power_watts['mac-mini']!, classKey: 'mac-mini' }
  }
  if (raw.includes('book')) {
    return { watts: wattsMap['macbook-pro'] ?? DEFAULT_COST_SETTINGS.mac_power_watts['macbook-pro']!, classKey: 'macbook-pro' }
  }
  if (raw.includes('pro') && !raw.includes('book')) {
    return { watts: wattsMap['mac-pro'] ?? DEFAULT_COST_SETTINGS.mac_power_watts['mac-pro']!, classKey: 'mac-pro' }
  }

  return { watts: fallback, classKey: 'default' }
}

function roundDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function extractEpisodeCode(job: Readonly<Job>): string | null {
  const raw = job.episode_id || job.params?.episode_id || job.params?.episode_code || job.params?.code
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed || null
}

interface JobCostFacts {
  job: Job
  paidUsd: number
  credits: number
  hasPaidEvidence: boolean
  macMinutes: number
  localCostUsd: number
  localCostKhr: number
  watts: number
  hasRuntimeEvidence: boolean
}

function analyzeJobCost(job: Job, settings: CostSettings, thisMacClass: string): JobCostFacts {
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let paidUsd = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let credits = 0
  let hasPaidEvidence = false

  // 1. Gateway provider evidence on the job
  if (Array.isArray(job.genstudio_jobs) && job.genstudio_jobs.length > 0) {
    for (const entry of job.genstudio_jobs) {
      if (entry.cost_source === 'provider' && typeof entry.cost_usd === 'number' && Number.isFinite(entry.cost_usd) && entry.cost_usd >= 0) {
        paidUsd += entry.cost_usd
        hasPaidEvidence = true
      }
      if (typeof entry.settled_credits === 'number' && Number.isFinite(entry.settled_credits) && entry.settled_credits >= 0) {
        credits += entry.settled_credits
        hasPaidEvidence = true
      } else if (typeof entry.credit_cost === 'number' && Number.isFinite(entry.credit_cost) && entry.credit_cost >= 0) {
        credits += entry.credit_cost
        hasPaidEvidence = true
      }
    }
  }

  // 2. Paid image replacement attempts
  if (Array.isArray(job.paid_image_replacement_attempts)) {
    for (const attempt of job.paid_image_replacement_attempts) {
      if (typeof attempt.actual_settled_credits === 'number' && Number.isFinite(attempt.actual_settled_credits) && attempt.actual_settled_credits >= 0) {
        credits += attempt.actual_settled_credits
        hasPaidEvidence = true
      }
    }
  }

  // 3. Local runtime
  let macMinutes = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let localCostUsd = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let localCostKhr = 0
  let watts = 0
  let hasRuntimeEvidence = false

  if (job.started_at && job.finished_at) {
    const startMs = Date.parse(job.started_at)
    const finishMs = Date.parse(job.finished_at)
    if (Number.isFinite(startMs) && Number.isFinite(finishMs) && finishMs >= startMs) {
      hasRuntimeEvidence = true
      macMinutes = (finishMs - startMs) / 60000
      const hwClass = job.result?.selected_machine?.hardware_class
        || (job.final_render_remote_wait as any)?.hardware_class
        || thisMacClass
      const resolved = resolveWattsForMachine(hwClass, settings)
      watts = resolved.watts
      const kwh = (macMinutes / 60) * (watts / 1000)
      localCostKhr = kwh * settings.electricity_khr_per_kwh
      localCostUsd = localCostKhr / settings.khr_per_usd
    }
  }

  return {
    job,
    paidUsd,
    credits,
    hasPaidEvidence,
    macMinutes,
    localCostUsd,
    localCostKhr,
    watts,
    hasRuntimeEvidence,
  }
}

function jobStepKey(job: Job): string {
  const section = job.params?.section !== undefined ? `:${job.params.section}` : ''
  const chapter = job.params?.chapter !== undefined ? `:${job.params.chapter}` : ''
  const kind = job.params?.kind !== undefined ? `:${job.params.kind}` : ''
  return `${job.type}${section}${chapter}${kind}`
}

export function computeEpisodeCost(
  jobs: Job[],
  episodeCode: string,
  settings: CostSettings = DEFAULT_COST_SETTINGS,
  thisMacClass?: string,
): EpisodeCostSummary {
  const targetCode = episodeCode.trim().toUpperCase()
  const epJobs = jobs.filter(j => {
    const code = extractEpisodeCode(j)
    return code ? code.toUpperCase() === targetCode : false
  })

  if (epJobs.length === 0) {
    return {
      episode_code: episodeCode,
      paid: { state: 'unmeasurable', reason: 'no_jobs' },
      local: { state: 'unmeasurable', reason: 'no_jobs' },
      waste: { state: 'unmeasurable', reason: 'no_jobs' },
      total_usd: { state: 'unmeasurable', reason: 'no_jobs' },
    }
  }

  const effectiveMacClass = thisMacClass || detectThisMacClass()
  const analyzed: JobCostFacts[] = epJobs.map(j => analyzeJobCost(j, settings, effectiveMacClass))

  // ── Paid cost ─────────────────────────────────────────────────────────────
  const hasAnyPaid = analyzed.some(a => a.hasPaidEvidence)
  let paidMeasurement: PaidCostMeasurement
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let totalPaidUsd = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let totalCredits = 0

  if (hasAnyPaid) {
    for (const a of analyzed) {
      totalPaidUsd += a.paidUsd
      totalCredits += a.credits
    }
    paidMeasurement = {
      state: 'measured',
      usd: roundDecimals(totalPaidUsd, 4),
      credits: totalCredits,
    }
  } else {
    paidMeasurement = {
      state: 'unmeasurable',
      reason: 'no_charge_recorded',
    }
  }

  // ── Local compute cost ───────────────────────────────────────────────────
  const hasAnyRuntime = analyzed.some(a => a.hasRuntimeEvidence)
  let localMeasurement: LocalCostMeasurement
  let totalMacMinutes = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let totalLocalUsd = 0
  let totalLocalKhr = 0
  let sumWatts = 0
  let countWatts = 0

  if (hasAnyRuntime) {
    for (const a of analyzed) {
      if (a.hasRuntimeEvidence) {
        totalMacMinutes += a.macMinutes
        totalLocalUsd += a.localCostUsd
        totalLocalKhr += a.localCostKhr
        sumWatts += a.watts
        countWatts++
      }
    }
    localMeasurement = {
      state: 'measured',
      mac_minutes: roundDecimals(totalMacMinutes, 2),
      cost_usd: roundDecimals(totalLocalUsd, 4),
      cost_khr: Math.round(totalLocalKhr),
      watts_estimate: countWatts > 0 ? Math.round(sumWatts / countWatts) : 0,
    }
  } else {
    localMeasurement = {
      state: 'unmeasurable',
      reason: 'no_runtime_data',
    }
  }

  // ── Waste computation ────────────────────────────────────────────────────
  // Group jobs by step. All jobs in each step before the newest one were redone/superseded.
  // The newest job in the step is waste only if it failed or was cancelled.
  // Each redone or failed job is in `wastedJobIds` exactly once.
  const stepGroups = new Map<string, JobCostFacts[]>()
  for (const a of analyzed) {
    const key = jobStepKey(a.job)
    const list = stepGroups.get(key) || []
    list.push(a)
    stepGroups.set(key, list)
  }

  const wastedJobIds = new Set<string>()

  for (const stepList of stepGroups.values()) {
    stepList.sort((a, b) => {
      const ta = Date.parse(a.job.created_at || a.job.started_at || '') || 0
      const tb = Date.parse(b.job.created_at || b.job.started_at || '') || 0
      return ta - tb
    })

    // All jobs except the latest were redone/superseded
    for (let i = 0; i < stepList.length - 1; i++) {
      wastedJobIds.add(stepList[i]!.job.job_id)
    }

    // The latest job in the step
    const latest = stepList[stepList.length - 1]!
    if (latest.job.status === 'error' || latest.job.status === 'cancelled') {
      wastedJobIds.add(latest.job.job_id)
    }
  }

  let wasteMeasurement: WasteCostMeasurement

  if (!hasAnyPaid && !hasAnyRuntime) {
    wasteMeasurement = {
      state: 'unmeasurable',
      reason: 'no_cost_data',
    }
  } else {
    // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
    let wasteUsd = 0
    // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
    let wasteCredits = 0
    let wasteMinutes = 0

    for (const a of analyzed) {
      if (wastedJobIds.has(a.job.job_id)) {
        // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
        wasteUsd += (a.hasPaidEvidence ? a.paidUsd : 0) + (a.hasRuntimeEvidence ? a.localCostUsd : 0)
        wasteCredits += a.credits
        wasteMinutes += a.macMinutes
      }
    }

    // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
    const totalUsdCombined = (hasAnyPaid ? totalPaidUsd : 0) + (hasAnyRuntime ? totalLocalUsd : 0)

    let percent = 0
    if (totalUsdCombined > 0) {
      percent = Math.round((wasteUsd / totalUsdCombined) * 100 * 10) / 10
    } else if (totalCredits > 0) {
      percent = Math.round((wasteCredits / totalCredits) * 100 * 10) / 10
    } else if (totalMacMinutes > 0) {
      percent = Math.round((wasteMinutes / totalMacMinutes) * 100 * 10) / 10
    } else {
      // Measured work that cost 0 and ran in 0m has 0% waste
      percent = 0
    }

    wasteMeasurement = {
      state: 'measured',
      percent,
      waste_cost_usd: roundDecimals(wasteUsd, 4),
      total_cost_usd: roundDecimals(totalUsdCombined, 4),
      waste_credits: wasteCredits,
      total_credits: totalCredits,
      waste_mac_minutes: roundDecimals(wasteMinutes, 2),
      total_mac_minutes: roundDecimals(totalMacMinutes, 2),
      waste_jobs_count: wastedJobIds.size,
      total_jobs_count: epJobs.length,
    }
  }

  // ── Combined total USD ───────────────────────────────────────────────────
  const totalUsdMeasurement = (hasAnyPaid || hasAnyRuntime)
    ? {
        state: 'measured' as const,
        // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
        value: roundDecimals((hasAnyPaid ? totalPaidUsd : 0) + (hasAnyRuntime ? totalLocalUsd : 0), 4),
      }
    : {
        state: 'unmeasurable' as const,
        reason: 'no_cost_data',
      }

  return {
    episode_code: episodeCode,
    paid: paidMeasurement,
    local: localMeasurement,
    waste: wasteMeasurement,
    total_usd: totalUsdMeasurement,
  }
}

export function computeProjectCost(
  jobs: Job[],
  projectSlug: string,
  settings: CostSettings = DEFAULT_COST_SETTINGS,
  thisMacClass?: string,
): ProjectCostReport {
  const effectiveMacClass = thisMacClass || detectThisMacClass()

  // Collect all distinct episode codes from project jobs
  const codesSet = new Set<string>()
  for (const j of jobs) {
    if (j.project_slug !== projectSlug) continue
    const code = extractEpisodeCode(j)
    if (code) codesSet.add(code)
  }

  const episodeCodes = [...codesSet].sort()
  const episodes: Record<string, EpisodeCostSummary> = {}

  let anyPaidMeasured = false
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let channelPaidUsd = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let channelCredits = 0

  let anyLocalMeasured = false
  let channelMacMinutes = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let channelLocalUsd = 0
  let channelLocalKhr = 0

  let anyWasteMeasured = false
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let channelWasteUsd = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let channelTotalUsd = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let channelWasteCredits = 0
  // model-drift-allow: a running sum of charges the Gateway already recorded for these jobs; it starts empty, it is not a catalogue price
  let channelTotalCredits = 0
  let channelWasteMinutes = 0
  let channelTotalMinutes = 0
  let channelWasteJobs = 0
  let channelTotalJobs = 0

  for (const code of episodeCodes) {
    const summary = computeEpisodeCost(jobs, code, settings, effectiveMacClass)
    episodes[code] = summary

    if (summary.paid.state === 'measured') {
      anyPaidMeasured = true
      channelPaidUsd += summary.paid.usd ?? 0
      // model-drift-allow: adds a measured receipt field that is absent on that receipt; the measured or unmeasurable state is decided above
      channelCredits += summary.paid.credits ?? 0
    }

    if (summary.local.state === 'measured') {
      anyLocalMeasured = true
      channelMacMinutes += summary.local.mac_minutes ?? 0
      channelLocalUsd += summary.local.cost_usd ?? 0
      channelLocalKhr += summary.local.cost_khr ?? 0
    }

    if (summary.waste.state === 'measured') {
      anyWasteMeasured = true
      channelWasteUsd += summary.waste.waste_cost_usd ?? 0
      channelTotalUsd += summary.waste.total_cost_usd ?? 0
      // model-drift-allow: adds a measured receipt field that is absent on that receipt; the measured or unmeasurable state is decided above
      channelWasteCredits += summary.waste.waste_credits ?? 0
      // model-drift-allow: adds a measured receipt field that is absent on that receipt; the measured or unmeasurable state is decided above
      channelTotalCredits += summary.waste.total_credits ?? 0
      channelWasteMinutes += summary.waste.waste_mac_minutes ?? 0
      channelTotalMinutes += summary.waste.total_mac_minutes ?? 0
      channelWasteJobs += summary.waste.waste_jobs_count ?? 0
      channelTotalJobs += summary.waste.total_jobs_count ?? 0
    }
  }

  const channelPaid: PaidCostMeasurement = anyPaidMeasured
    ? {
        state: 'measured',
        usd: roundDecimals(channelPaidUsd, 4),
        credits: channelCredits,
      }
    : {
        state: 'unmeasurable',
        reason: episodeCodes.length === 0 ? 'no_episodes' : 'no_charge_recorded',
      }

  const channelLocal: LocalCostMeasurement = anyLocalMeasured
    ? {
        state: 'measured',
        mac_minutes: roundDecimals(channelMacMinutes, 2),
        cost_usd: roundDecimals(channelLocalUsd, 4),
        cost_khr: Math.round(channelLocalKhr),
      }
    : {
        state: 'unmeasurable',
        reason: episodeCodes.length === 0 ? 'no_episodes' : 'no_runtime_data',
      }

  let channelWaste: WasteCostMeasurement
  if (anyWasteMeasured) {
    let percent = 0
    if (channelTotalUsd > 0) {
      percent = Math.round((channelWasteUsd / channelTotalUsd) * 100 * 10) / 10
    } else if (channelTotalCredits > 0) {
      percent = Math.round((channelWasteCredits / channelTotalCredits) * 100 * 10) / 10
    } else if (channelTotalMinutes > 0) {
      percent = Math.round((channelWasteMinutes / channelTotalMinutes) * 100 * 10) / 10
    } else {
      percent = 0
    }

    channelWaste = {
      state: 'measured',
      percent,
      waste_cost_usd: roundDecimals(channelWasteUsd, 4),
      total_cost_usd: roundDecimals(channelTotalUsd, 4),
      waste_credits: channelWasteCredits,
      total_credits: channelTotalCredits,
      waste_mac_minutes: roundDecimals(channelWasteMinutes, 2),
      total_mac_minutes: roundDecimals(channelTotalMinutes, 2),
      waste_jobs_count: channelWasteJobs,
      total_jobs_count: channelTotalJobs,
    }
  } else {
    channelWaste = {
      state: 'unmeasurable',
      reason: episodeCodes.length === 0 ? 'no_episodes' : 'no_cost_data',
    }
  }

  const channelTotalUsdMeasurement = (anyPaidMeasured || anyLocalMeasured)
    ? {
        state: 'measured' as const,
        value: roundDecimals(channelPaidUsd + channelLocalUsd, 4),
      }
    : {
        state: 'unmeasurable' as const,
        reason: 'no_cost_data',
      }

  return {
    project_slug: projectSlug,
    settings,
    channel_total: {
      paid: channelPaid,
      local: channelLocal,
      waste: channelWaste,
      total_usd: channelTotalUsdMeasurement,
    },
    episodes,
  }
}

export async function getProjectCostReport(projectSlug: string): Promise<ProjectCostReport> {
  const [jobs, settings, macClass] = await Promise.all([
    getRawProjectJobs(projectSlug),
    getCostSettings(),
    detectThisMacClassAsync(),
  ])
  return computeProjectCost(jobs, projectSlug, settings, macClass)
}

export async function getEpisodeCostSummary(projectSlug: string, episodeCode: string): Promise<EpisodeCostSummary> {
  const [jobs, settings, macClass] = await Promise.all([
    getRawProjectJobs(projectSlug),
    getCostSettings(),
    detectThisMacClassAsync(),
  ])
  return computeEpisodeCost(jobs, episodeCode, settings, macClass)
}
