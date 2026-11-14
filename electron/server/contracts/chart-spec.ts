/**
 * Chart segment contract — the unified timeline's deterministic local charts.
 *
 * A chart segment is plain data: a kind, optional title, parallel labels and
 * values, and an optional pixel size. Strict validation lives here (backend
 * only, like `scene-effects-schema.ts` next door) so a malformed timeline
 * payload is refused with one typed error instead of reaching the rasteriser.
 *
 * Zero credit by design: nothing in this contract names a provider, a key or
 * a network call. `services/chart-render.ts` turns a validated spec into an
 * SVG string and hands it to the already-installed `sharp`.
 */

export const CHART_KINDS = ['bar', 'line', 'pie'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

/** Default canvas for a timeline chart segment. */
export const CHART_DEFAULT_WIDTH = 1280
export const CHART_DEFAULT_HEIGHT = 720

export const CHART_MIN_WIDTH = 320
export const CHART_MAX_WIDTH = 3840
export const CHART_MIN_HEIGHT = 200
export const CHART_MAX_HEIGHT = 2160

/** Bounded counts/lengths: a segment is one chart, not an unbounded feed. */
export const CHART_MAX_POINTS = 64
export const CHART_MAX_LABEL_CHARS = 160
export const CHART_MAX_TITLE_CHARS = 200

export interface ChartSpec {
  kind: ChartKind
  title?: string
  labels: string[]
  values: number[]
  /** Optional pixel size; defaults to 1280×720 when absent. */
  width?: number
  height?: number
}

/** A spec after validation: size always resolved to concrete pixels. */
export type ResolvedChartSpec = ChartSpec & { width: number; height: number }

/** Typed refusal for anything that is not a renderable chart segment. */
export class ChartSpecValidationError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'ChartSpecValidationError'
  }
}

function invalid(message: string): never {
  throw new ChartSpecValidationError(message)
}

function parseDimension(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw)) invalid(`${name} must be an integer pixel count`)
  if (raw < min || raw > max) invalid(`${name} must be between ${min} and ${max}, got ${raw}`)
  return raw
}

/**
 * Validate an untrusted chart segment. Labels are trimmed; empty labels,
 * non-finite values, length mismatches and out-of-range sizes are refused.
 * A pie of negatives or an all-zero pie cannot be drawn, so it is refused
 * here rather than rendered as noise.
 */
export function parseChartSpec(value: unknown): ResolvedChartSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('chart segment must be an object')
  const raw = value as Record<string, unknown>

  if (typeof raw.kind !== 'string' || !(CHART_KINDS as readonly string[]).includes(raw.kind)) {
    invalid(`kind must be one of ${CHART_KINDS.join(', ')}`)
  }
  const kind = raw.kind as ChartKind

  let title: string | undefined
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== 'string') invalid('title must be text')
    title = raw.title.trim()
    if (!title) invalid('title must not be empty')
    if (title.length > CHART_MAX_TITLE_CHARS) invalid(`title must be at most ${CHART_MAX_TITLE_CHARS} characters`)
  }

  if (!Array.isArray(raw.labels)) invalid('labels must be a list')
  if (raw.labels.length < 1) invalid('labels must not be empty')
  if (raw.labels.length > CHART_MAX_POINTS) invalid(`labels must hold at most ${CHART_MAX_POINTS} entries`)
  const labels = raw.labels.map((entry, index) => {
    if (typeof entry !== 'string') invalid(`labels[${index}] must be text`)
    const label = entry.trim()
    if (!label) invalid(`labels[${index}] must not be empty`)
    if (label.length > CHART_MAX_LABEL_CHARS) invalid(`labels[${index}] must be at most ${CHART_MAX_LABEL_CHARS} characters`)
    return label
  })

  if (!Array.isArray(raw.values)) invalid('values must be a list')
  if (raw.values.length !== labels.length) {
    invalid(`values must hold exactly ${labels.length} entries to match labels, got ${raw.values.length}`)
  }
  const values = raw.values.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) invalid(`values[${index}] must be a finite number`)
    return entry
  })

  if (kind === 'pie') {
    if (values.some(v => v < 0)) invalid('pie values must not be negative')
    if (values.reduce((sum, v) => sum + v, 0) <= 0) invalid('pie values must total more than zero')
  }

  return {
    kind,
    ...(title !== undefined ? { title } : {}),
    labels,
    values,
    width: parseDimension(raw.width, 'width', CHART_MIN_WIDTH, CHART_MAX_WIDTH, CHART_DEFAULT_WIDTH),
    height: parseDimension(raw.height, 'height', CHART_MIN_HEIGHT, CHART_MAX_HEIGHT, CHART_DEFAULT_HEIGHT),
  }
}

function formatValue(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/**
 * Plain-language summary callers can show or attach as alt text:
 * `Bar chart, 4 values; highest 82 in March; lowest 11 in May`.
 * Labels here are the full data labels — truncation is a layout concern.
 */
export function describeChart(spec: ChartSpec): string {
  const kindName = spec.kind.charAt(0).toUpperCase() + spec.kind.slice(1)
  const total = spec.values.length
  let high = 0
  let low = 0
  for (let i = 1; i < total; i++) {
    if (spec.values[i] > spec.values[high]) high = i
    if (spec.values[i] < spec.values[low]) low = i
  }
  const highPart = `${formatValue(spec.values[high])} in ${spec.labels[high]}`
  const lowPart = `${formatValue(spec.values[low])} in ${spec.labels[low]}`
  if (spec.kind === 'pie') {
    const sum = spec.values.reduce((acc, v) => acc + v, 0)
    const pct = (index: number) => `${Math.round((spec.values[index] / sum) * 100)}%`
    return `${kindName} chart, ${total} values; highest ${highPart} (${pct(high)}); lowest ${lowPart} (${pct(low)})`
  }
  return `${kindName} chart, ${total} values; highest ${highPart}; lowest ${lowPart}`
}
