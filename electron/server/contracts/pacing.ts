/**
 * The one default for an episode whose continuity record has no pacing field.
 * It stays uniform; formulas and project settings do not replace it. Explicit
 * malformed saved pacing is rejected by parseScenePacing instead of falling
 * back here. This zero-dependency module is also imported by frontend runtime.
 */
export const DEFAULT_SCENE_PACING = { min_sec: 1, max_sec: 3 } as const

/** Historical repair band for plans saved before plan pacing snapshots existed.
 * This is never a planning default and must not initialize episode continuity. */
export const LEGACY_SNAPSHOTLESS_REPAIR_PACING = { min_sec: 3, max_sec: 12 } as const

export interface ScenePacingBand {
  min_sec: number
  max_sec: number
}

export interface ScenePacingPeriod extends ScenePacingBand {
  start_sec: number
  /** `null` is reserved for the final period and means "to episode end". */
  end_sec: number | null
}

export interface UniformScenePacing extends ScenePacingBand {
  /** Missing mode is the legacy uniform representation and remains valid. */
  mode?: 'uniform'
}

export interface VariableScenePacing extends ScenePacingBand {
  mode: 'variable'
  /** Ordered, contiguous periods beginning at zero and ending with `end_sec: null`. */
  periods: ScenePacingPeriod[]
  /** Retained only when normalizing the legacy explicit two-phase representation. */
  opening_duration_sec?: number
  settled_min_sec?: number
  settled_max_sec?: number
}

export type ScenePacing = UniformScenePacing | VariableScenePacing

export class ScenePacingValidationError extends Error {
  /** Bad input: running the job again stops here again, so no automatic retry (services/job-retry-policy.ts isNonRetryableError). */
  readonly retryable = false
  constructor(message: string) {
    super(message)
    this.name = 'ScenePacingValidationError'
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScenePacingValidationError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScenePacingValidationError(`${field} must be a finite number`)
  }
  return value
}

function band(value: Record<string, unknown>, field: string): ScenePacingBand {
  const min_sec = finiteNumber(value.min_sec, `${field}.min_sec`)
  const max_sec = finiteNumber(value.max_sec, `${field}.max_sec`)
  if (min_sec < 1 || min_sec > 60) {
    throw new ScenePacingValidationError(`${field}.min_sec must be between 1 and 60 seconds`)
  }
  if (max_sec < 1 || max_sec > 60) {
    throw new ScenePacingValidationError(`${field}.max_sec must be between 1 and 60 seconds`)
  }
  if (max_sec < min_sec) {
    throw new ScenePacingValidationError(`${field}.max_sec must be greater than or equal to ${field}.min_sec`)
  }
  return { min_sec, max_sec }
}

function periods(value: unknown): ScenePacingPeriod[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ScenePacingValidationError('pacing.periods must contain at least one period')
  }
  const normalized = value.map((item, index) => {
    const field = `pacing.periods[${index}]`
    const source = record(item, field)
    const start_sec = finiteNumber(source.start_sec, `${field}.start_sec`)
    if (start_sec < 0) throw new ScenePacingValidationError(`${field}.start_sec must be zero or greater`)
    const end_sec = source.end_sec === null ? null : finiteNumber(source.end_sec, `${field}.end_sec`)
    if (end_sec !== null && end_sec <= start_sec) {
      throw new ScenePacingValidationError(`${field}.end_sec must be greater than ${field}.start_sec`)
    }
    return { start_sec, end_sec, ...band(source, field) }
  })

  if (normalized[0]!.start_sec !== 0) {
    throw new ScenePacingValidationError('pacing.periods[0].start_sec must be 0')
  }
  for (let index = 0; index < normalized.length; index++) {
    const current = normalized[index]!
    if (index < normalized.length - 1 && current.end_sec === null) {
      throw new ScenePacingValidationError('only the final pacing period may use end_sec: null')
    }
    if (index > 0) {
      const previousEnd = normalized[index - 1]!.end_sec
      if (current.start_sec !== previousEnd) {
        throw new ScenePacingValidationError(
          `pacing.periods[${index}].start_sec must equal the previous period's end_sec (${previousEnd})`,
        )
      }
    }
  }
  if (normalized.at(-1)!.end_sec !== null) {
    throw new ScenePacingValidationError('final pacing period must use end_sec: null')
  }
  return normalized
}

/**
 * Validate persisted pacing and return the representation used by planners and
 * editors. Only a missing pacing field gets the current uniform default;
 * malformed explicitly saved state is an error.
 */
export function parseScenePacing(value: unknown): ScenePacing {
  if (value === undefined) return { ...DEFAULT_SCENE_PACING }
  const source = record(value, 'pacing')

  if (source.mode === 'variable') {
    const normalizedPeriods = periods(source.periods)
    // The top-level band is a compatibility view for existing consumers. The
    // first period is authoritative, avoiding two contradictory opening bands.
    return {
      mode: 'variable',
      min_sec: normalizedPeriods[0]!.min_sec,
      max_sec: normalizedPeriods[0]!.max_sec,
      periods: normalizedPeriods,
    }
  }
  if (source.mode !== undefined && source.mode !== 'uniform') {
    throw new ScenePacingValidationError("pacing.mode must be 'uniform' or 'variable'")
  }
  if (source.periods !== undefined) {
    throw new ScenePacingValidationError("pacing.periods requires pacing.mode: 'variable'")
  }

  const openingFields = [
    source.opening_duration_sec,
    source.settled_min_sec,
    source.settled_max_sec,
  ]
  const hasAnyOpeningField = openingFields.some(item => item !== undefined)
  const hasEveryOpeningField = openingFields.every(item => item !== undefined)
  if (hasAnyOpeningField && !hasEveryOpeningField) {
    throw new ScenePacingValidationError(
      'legacy opening pacing must include opening_duration_sec, settled_min_sec, and settled_max_sec',
    )
  }

  const openingBand = band(source, 'pacing')
  if (!hasEveryOpeningField) {
    return source.mode === 'uniform' ? { mode: 'uniform', ...openingBand } : openingBand
  }

  const opening_duration_sec = finiteNumber(source.opening_duration_sec, 'pacing.opening_duration_sec')
  if (opening_duration_sec < 0) {
    throw new ScenePacingValidationError('pacing.opening_duration_sec must be zero or greater')
  }
  const settledBand = band({
    min_sec: source.settled_min_sec,
    max_sec: source.settled_max_sec,
  }, 'pacing.settled')
  const normalizedPeriods: ScenePacingPeriod[] = opening_duration_sec === 0
    ? [{ start_sec: 0, end_sec: null, ...settledBand }]
    : [
        { start_sec: 0, end_sec: opening_duration_sec, ...openingBand },
        { start_sec: opening_duration_sec, end_sec: null, ...settledBand },
      ]
  return {
    mode: 'variable',
    min_sec: normalizedPeriods[0]!.min_sec,
    max_sec: normalizedPeriods[0]!.max_sec,
    periods: normalizedPeriods,
    opening_duration_sec,
    settled_min_sec: settledBand.min_sec,
    settled_max_sec: settledBand.max_sec,
  }
}

/** Normalize the historical planner-only `live` / `documentary` labels when
 * reading a saved plan. Continuity records remain strict `uniform` / `variable`
 * inputs to parseScenePacing. This never rewrites the saved plan. */
export function parseSavedScenePlanPacing(value: unknown): ScenePacing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parseScenePacing(value)
  const saved = value as Record<string, unknown>
  if (saved.mode === 'live') {
    return parseScenePacing({ mode: 'uniform', min_sec: saved.min_sec, max_sec: saved.max_sec })
  }
  if (saved.mode === 'documentary') {
    const legacy = parseScenePacing({
      min_sec: saved.min_sec,
      max_sec: saved.max_sec,
      opening_duration_sec: saved.opening_duration_sec,
      settled_min_sec: saved.settled_min_sec,
      settled_max_sec: saved.settled_max_sec,
    })
    if (saved.periods !== undefined) {
      const normalizedPeriods = parseScenePacing({ mode: 'variable', periods: saved.periods })
      if (legacy.mode !== 'variable' || normalizedPeriods.mode !== 'variable') {
        throw new ScenePacingValidationError('saved Scene Plan documentary pacing is not variable')
      }
      const periodsMatch = normalizedPeriods.periods.length === legacy.periods.length
        && normalizedPeriods.periods.every((period, index) => {
          const expected = legacy.periods[index]
          return expected?.start_sec === period.start_sec
            && expected.end_sec === period.end_sec
            && expected.min_sec === period.min_sec
            && expected.max_sec === period.max_sec
        })
      if (!periodsMatch) {
        throw new ScenePacingValidationError('saved Scene Plan documentary pacing periods do not match its opening and settled bands')
      }
    }
    return legacy
  }
  return parseScenePacing(value)
}

/** Resolve the active inclusive band at a narration-timeline position. */
export function pacingBandAt(pacing: ScenePacing, timeSec: number): ScenePacingBand {
  if (pacing.mode !== 'variable') return { min_sec: pacing.min_sec, max_sec: pacing.max_sec }
  const period = [...pacing.periods].reverse().find(item => timeSec >= item.start_sec) ?? pacing.periods[0]!
  return { min_sec: period.min_sec, max_sec: period.max_sec }
}
