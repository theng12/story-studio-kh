/**
 * Usage tracker — estimates text-model API costs from token usage.
 *
 * Two layers:
 *   - sessionUsage (memory): live counter for the running process,
 *     powers the sidebar "session cost" indicator
 *   - usage-history.jsonl (disk): append-only log under userData,
 *     powers the Cost dashboard's rollups across time. Survives
 *     Electron restarts.
 *
 * Only text models (Anthropic, OpenAI) are tracked here. ElevenLabs
 * character usage + image/video provider calls aren't instrumented
 * yet — the dashboard surfaces a clear note about that limitation.
 */

import fs from 'fs/promises'
import path from 'path'

// Pricing per 1M tokens (input/output)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
}

/**
 * Pick a coarse provider label for grouping in the dashboard. We could
 * route through the registry here but that pulls a heavier dependency
 * graph into a hot path — string sniffing is fine since model ids are
 * stable.
 */
function providerForModel(model: string): string {
  const m = model.toLowerCase()
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai'
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gemini')) return 'google'
  return 'other'
}

interface UsageEntry {
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  cost: number
  timestamp: string
}

const sessionUsage: UsageEntry[] = []

/** Disk path for the persistent JSONL log. Cached after first resolve. */
let _historyPath: string | null = null
async function historyPath(): Promise<string> {
  if (_historyPath) return _historyPath
  const pm = await import('./project-manager.js')
  const dir = pm.getUserDataDir()
  _historyPath = path.join(dir, 'usage-history.jsonl')
  return _historyPath
}

/** Append a usage entry to disk. Best-effort — disk failures don't
 *  break the in-memory tracker or the call that triggered it. */
async function appendToHistory(entry: UsageEntry): Promise<void> {
  try {
    const fp = await historyPath()
    await fs.mkdir(path.dirname(fp), { recursive: true }).catch(() => {})
    await fs.appendFile(fp, JSON.stringify(entry) + '\n', 'utf-8')
  } catch { /* swallow */ }
}

export function trackUsage(model: string, inputTokens: number, outputTokens: number): void {
  const provider = providerForModel(model)
  const pricing = MODEL_PRICING[model] || { input: 5.0, output: 15.0 }
  const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000

  const entry: UsageEntry = {
    model,
    provider,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost,
    timestamp: new Date().toISOString(),
  }
  sessionUsage.push(entry)
  // Fire-and-forget disk persistence so the call site stays sync.
  void appendToHistory(entry)

  // Prevent unbounded growth in long sessions
  if (sessionUsage.length > 10000) {
    sessionUsage.splice(0, sessionUsage.length - 10000)
  }
}

// Estimate tokens from character count (~4 chars per token for English)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function trackFromText(model: string, inputText: string, outputText: string): void {
  trackUsage(model, estimateTokens(inputText), estimateTokens(outputText))
}

export function getSessionUsage(): {
  total_cost: number
  by_model: Record<string, { calls: number; cost: number }>
  entries: number
} {
  const byModel: Record<string, { calls: number; cost: number }> = {}
  let totalCost = 0

  for (const entry of sessionUsage) {
    totalCost += entry.cost
    if (!byModel[entry.model]) byModel[entry.model] = { calls: 0, cost: 0 }
    byModel[entry.model].calls++
    byModel[entry.model].cost += entry.cost
  }

  return {
    total_cost: Math.round(totalCost * 10000) / 10000,
    by_model: byModel,
    entries: sessionUsage.length,
  }
}

export function getModelPricing(): Record<string, { input: number; output: number }> {
  return { ...MODEL_PRICING }
}

// ── Persistent rollup (Cost dashboard) ─────────────────────────────────────

export interface UsageRollupOptions {
  /** Inclusive ISO date (YYYY-MM-DD). Defaults to 30 days ago. */
  since?: string
  /** Inclusive ISO date. Defaults to today. */
  until?: string
}

export interface UsageRollup {
  /** Total cost across the date range, in USD. */
  total_cost: number
  /** Total raw entries counted. */
  entries: number
  /** Per-model rollup. Sorted descending by cost in the route layer. */
  by_model: Record<string, { calls: number; cost: number; input_tokens: number; output_tokens: number }>
  /** Per-provider rollup. */
  by_provider: Record<string, { calls: number; cost: number }>
  /** Per-day rollup, keyed by YYYY-MM-DD. Sparse — days with no usage
   *  are simply absent. */
  by_day: Record<string, { calls: number; cost: number }>
  /** ISO date range honoured. */
  since: string
  until: string
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
function nDaysAgoIso(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/**
 * Roll up usage entries from the JSONL history file. Filters by the
 * inclusive [since, until] date range. Returns zeroes (with the date
 * fields populated) when the file doesn't exist yet.
 */
export async function getUsageRollup(opts: UsageRollupOptions = {}): Promise<UsageRollup> {
  const since = opts.since || nDaysAgoIso(30)
  const until = opts.until || todayIso()
  const empty: UsageRollup = { total_cost: 0, entries: 0, by_model: {}, by_provider: {}, by_day: {}, since, until }

  let raw: string
  try {
    const fp = await historyPath()
    raw = await fs.readFile(fp, 'utf-8')
  } catch {
    return empty  // no history yet
  }

  const sinceMs = Date.parse(`${since}T00:00:00Z`)
  // Inclusive end-of-day for `until`
  const untilMs = Date.parse(`${until}T23:59:59.999Z`)
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return empty

  let total = 0
  let count = 0
  const byModel: Record<string, { calls: number; cost: number; input_tokens: number; output_tokens: number }> = {}
  const byProvider: Record<string, { calls: number; cost: number }> = {}
  const byDay: Record<string, { calls: number; cost: number }> = {}

  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let entry: UsageEntry
    try {
      entry = JSON.parse(t)
    } catch {
      continue  // skip malformed line, keep going
    }
    const ts = Date.parse(entry.timestamp)
    if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue

    total += entry.cost
    count++
    const model = entry.model || 'unknown'
    if (!byModel[model]) byModel[model] = { calls: 0, cost: 0, input_tokens: 0, output_tokens: 0 }
    byModel[model].calls++
    byModel[model].cost += entry.cost
    byModel[model].input_tokens += entry.input_tokens
    byModel[model].output_tokens += entry.output_tokens

    const provider = entry.provider || 'other'
    if (!byProvider[provider]) byProvider[provider] = { calls: 0, cost: 0 }
    byProvider[provider].calls++
    byProvider[provider].cost += entry.cost

    const day = entry.timestamp.slice(0, 10)
    if (!byDay[day]) byDay[day] = { calls: 0, cost: 0 }
    byDay[day].calls++
    byDay[day].cost += entry.cost
  }

  return {
    total_cost: Math.round(total * 10000) / 10000,
    entries: count,
    by_model: byModel,
    by_provider: byProvider,
    by_day: byDay,
    since,
    until,
  }
}

/** Test-only — wipe the history file so cases stay isolated. */
export async function _clearUsageHistory(): Promise<void> {
  try {
    const fp = await historyPath()
    await fs.rm(fp, { force: true })
  } catch { /* ignore */ }
}

/** Test-only — reset the cached path so a new userData dir takes effect. */
export function _resetHistoryPathCache(): void {
  _historyPath = null
}
