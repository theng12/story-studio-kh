/**
 * Recency-avoidance tracker (v1.0.106+).
 *
 * Generic across niches. A niche declares `recencyAvoidance` (label +
 * regex patterns + lookback default) and this service handles:
 *
 *   1. Pre-generation: build an "avoid these" instruction block from
 *      the project's recency log, ready to drop into the LLM prompt.
 *   2. Post-generation: extract used items from the freshly-generated
 *      script text, dedupe + normalize, append to the project's log,
 *      and trim the log so it stays bounded.
 *
 * Storage: `project.config.recency_log` — flat array of entries
 * `{ episode_code, used_at, kind, item }`. Multiple niches with
 * different `kind` values share the same log; readers filter by kind.
 * Cap: 500 entries — old entries fall off oldest-first.
 *
 * Use case driving v1: prayer-channel scripture references. Without
 * recency tracking, the LLM cycles back to the same 4-5 "comfort
 * verses" every 2-3 episodes. With it, the prompt is told which
 * references appeared in the last 30 episodes and the LLM branches
 * to less-quoted passages.
 *
 * Generic on purpose: same surface will work for true-crime "famous
 * cases", motivation "popular quotes", listicle "common myths", etc.
 * Each niche declares its own regex.
 */

import * as pm from './project-manager.js'
import { recentCharacterNamesAvoidance } from './recent-character-names.js'
import { getEffectiveNiche } from './niche-loader.js'
import { resolveRecencyStrategy, type RecencyStrategy } from './recency-strategies.js'
import { applyFormulaEpisodeProfile, resolveFormulaEpisodeDimensions } from './formula-production-kit.js'
import type { Niche, RecencyLogEntry, Format } from '../models/types.js'

/**
 * v1.0.108+ — generator output scopes the cycler can avoid items in.
 * Niche rules declare which scopes they apply to via `scopes?: Scope[]`.
 * Default when unset is ['script'] for backward compat.
 */
export type RecencyScope = 'script' | 'titles' | 'image_prompts' | 'metadata'

/** Resolve which scopes a niche's recency rule applies to. Defaults to
 *  ['script'] for backward compat with pre-v1.0.108 niche JSONs. */
function scopesFor(niche: Niche): RecencyScope[] {
  const declared = niche.recencyAvoidance?.scopes
  if (Array.isArray(declared) && declared.length > 0) return declared
  return ['script']
}

/** Signed Content Packs use an app-owned strategy ID. Legacy built-ins retain
 * their current raw fields until catalog migration moves them to this registry. */
function strategyFor(niche: Niche): RecencyStrategy | undefined {
  const id = niche.recencyAvoidance?.strategyId
  if (!id) return undefined
  try {
    return resolveRecencyStrategy(id)
  } catch {
    return undefined
  }
}

/** Is the given scope covered by the niche's recency rule? */
export function ruleAppliesToScope(niche: Niche | null, scope: RecencyScope): boolean {
  if (!niche?.recencyAvoidance) return false
  return scopesFor(niche).includes(scope)
}

async function effectiveNicheForEpisode(slug: string, episodeId?: string): Promise<Niche | null> {
  const niche = await getEffectiveNiche(slug)
  if (!niche) return null
  return applyFormulaEpisodeProfile(niche, await resolveFormulaEpisodeDimensions(slug, episodeId))
}

/** Hard cap on log size — trimmed oldest-first once exceeded. */
const LOG_CAP = 500
/** Default lookback when neither project config nor niche declare one. */
const DEFAULT_LOOKBACK = 30

/**
 * Run the niche's recency patterns over `text`, return deduped +
 * normalized matches. Returns [] when the niche has no recency rules.
 *
 * Normalization: collapses internal whitespace runs to single spaces
 * (so "Psalm 91" and "Psalm  91" hash to the same entry), trims edges,
 * skips empty captures. Match casing is preserved as-emitted by the
 * LLM, so "Psalm 91" and "psalm 91" log separately — desirable because
 * a niche that wants case-insensitive matching can put `(?i)` flags
 * inline in its pattern.
 */
export function extractItems(niche: Niche | null, text: string): string[] {
  if (!niche?.recencyAvoidance) return []
  if (!text) return []
  const patterns = strategyFor(niche)?.extractPatterns ?? niche.recencyAvoidance.extractPatterns
  if (!patterns?.length) return []
  const out = new Set<string>()
  for (const raw of patterns) {
    let re: RegExp
    try {
      re = new RegExp(raw, 'g')
    } catch (e: any) {
      console.warn(`[recency-tracker] niche '${niche.id}' has invalid extract pattern: ${e.message}`)
      continue
    }
    let m: RegExpExecArray | null
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(text)) !== null) {
      const item = m[0].replace(/\s+/g, ' ').trim()
      if (item) out.add(item)
      // Defensive: zero-length match (a pattern that's all optional
      // groups) would loop forever. Bump lastIndex to escape.
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return [...out]
}

/**
 * Read the project's recency log, filter to entries matching the
 * niche's `kind`, return the most recent N items (dedup preserved).
 *
 * `lookback` resolution: explicit arg → project.config.recency_lookback
 * → niche.recencyAvoidance.defaultLookback → DEFAULT_LOOKBACK (30).
 */
export async function getRecentItems(
  slug: string,
  niche: Niche | null,
  lookbackOverride?: number,
): Promise<{ items: string[]; lookback: number; kind: string | null }> {
  if (!niche?.recencyAvoidance) return { items: [], lookback: 0, kind: null }
  const kind = niche.recencyAvoidance.label
  const cfg = await pm.getConfig(slug)
  const log: RecencyLogEntry[] = Array.isArray(cfg?.recency_log) ? cfg!.recency_log! : []
  const lookback = lookbackOverride
    ?? (typeof cfg?.recency_lookback === 'number' && cfg.recency_lookback > 0 ? cfg.recency_lookback : undefined)
    ?? niche.recencyAvoidance.defaultLookback
    ?? DEFAULT_LOOKBACK
  // Walk log in reverse (most recent first), collect distinct items
  // until we've consulted `lookback` distinct episodes for this kind.
  const seenEpisodes = new Set<string>()
  const seenItems = new Set<string>()
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!
    if (e.kind !== kind) continue
    if (!seenEpisodes.has(e.episode_code)) {
      if (seenEpisodes.size >= lookback) break
      seenEpisodes.add(e.episode_code)
    }
    seenItems.add(e.item)
  }
  return { items: [...seenItems], lookback, kind }
}

/**
 * Build the "avoid these" prompt block for a niche, given the current
 * project's log. Returns '' (empty string) when no avoidance instruction
 * should be added (no niche rules / no items logged yet). Callers
 * concatenate this onto their script-prompt string.
 */
export async function buildAvoidanceInstruction(
  slug: string,
  niche: Niche | null,
  lookbackOverride?: number,
): Promise<string> {
  if (!niche?.recencyAvoidance) return ''
  const { items, lookback, kind } = await getRecentItems(slug, niche, lookbackOverride)
  if (!items.length || !kind) return ''
  const template = strategyFor(niche)?.instructionTemplate
    ?? (niche.recencyAvoidance.instructionTemplate
      || 'These {label} were used in this channel\'s recent {count} episodes — pick a DIFFERENT one for this prompt:\n{items}')
  const bulleted = items.map(i => `  • ${i}`).join('\n')
  return template
    .replace(/\{label\}/g, kind)
    .replace(/\{count\}/g, String(lookback))
    .replace(/\{items\}/g, bulleted)
}

/**
 * Run the niche's extract patterns over `text`, append every new match
 * to the project's recency log under `niche.recencyAvoidance.label`,
 * and trim the log to LOG_CAP. Idempotent within a single episode:
 * calling twice with the same text + episode_code dedupes via the
 * (episode_code, item) compound key — re-runs don't fatten the log.
 */
export async function recordUsage(
  slug: string,
  episode_code: string,
  niche: Niche | null,
  text: string,
): Promise<{ kind: string; added: string[] } | null> {
  if (!niche?.recencyAvoidance) return null
  const items = extractItems(niche, text)
  if (!items.length) return { kind: niche.recencyAvoidance.label, added: [] }

  const kind = niche.recencyAvoidance.label
  const cfg = await pm.getConfig(slug)
  const log: RecencyLogEntry[] = Array.isArray(cfg?.recency_log) ? [...cfg!.recency_log!] : []

  // Dedup by (episode_code, kind, item) — if this episode already
  // logged "Psalm 91" earlier in the same run (e.g. the user
  // regenerated chapter 2 after chapter 1 already extracted), we
  // don't duplicate the entry.
  const existing = new Set(
    log.filter(e => e.episode_code === episode_code && e.kind === kind).map(e => e.item),
  )
  const now = new Date().toISOString()
  const added: string[] = []
  for (const item of items) {
    if (existing.has(item)) continue
    log.push({ episode_code, used_at: now, kind, item })
    existing.add(item)
    added.push(item)
  }

  // Trim oldest first if we've blown past the cap. 500 entries covers
  // a long-running daily channel (16+ months at 1 verse / episode);
  // bumping is straightforward if a use case shows up.
  while (log.length > LOG_CAP) log.shift()

  await pm.updateConfig(slug, { recency_log: log } as any)

  if (added.length) {
    console.log(`[recency-tracker] ${slug}/${episode_code}: recorded ${added.length} ${kind} (${added.join(', ')})`)
  }
  return { kind, added }
}

/**
 * Higher-level helper for the SCRIPT generator path. Loads the project's
 * effective niche, builds the avoidance instruction, and returns a
 * NEW format object with the instruction appended to
 * `format.script.additionalRules` (so it flows naturally through
 * `systemPrompt()` in episode.ts).
 *
 * Returns the format unchanged when:
 *   - the niche has no recencyAvoidance config (most niches today), or
 *   - the niche's rule doesn't apply to the 'script' scope, or
 *   - the project's recency_log is empty for this kind (first episode)
 *   (and, separately, a "fresh main character names" rule is added whenever
 *   recent episodes already used some — see recent-character-names.ts)
 *
 * Callers should immediately use the returned format for subsequent
 * prompt builds. Does NOT mutate the input format.
 */
export async function applyRecencyToFormat(format: Format, slug: string, episodeId?: string): Promise<Format> {
  let niche: Niche | null = null
  try {
    niche = await effectiveNicheForEpisode(slug, episodeId)
  } catch {
    // No niche rule; the character-name line below does not depend on one.
  }
  const rules = [
    ruleAppliesToScope(niche, 'script') ? await buildAvoidanceInstruction(slug, niche) : '',
    // Fresh main-character names for this channel (skipped for Character Continuity).
    await recentCharacterNamesAvoidance(slug, episodeId),
  ].filter(Boolean)
  if (!rules.length) return format
  return {
    ...format,
    script: {
      ...format.script,
      additionalRules: [...format.script.additionalRules, ...rules],
    },
  }
}

/**
 * v1.0.108+ — scope-aware avoidance fetch. Returns the prompt text to
 * inject for `scope` (or empty when the niche's rule doesn't cover
 * that scope OR the log is empty). Callers stitch this into their own
 * prompt builder — script uses `applyRecencyToFormat` above; other
 * scopes (titles, image_prompts, metadata) call this directly because
 * their prompts aren't built through `format.script.additionalRules`.
 */
export async function getAvoidanceForScope(slug: string, scope: RecencyScope, episodeId?: string): Promise<string> {
  let niche: Niche | null
  try {
    niche = await effectiveNicheForEpisode(slug, episodeId)
  } catch {
    return ''
  }
  if (!ruleAppliesToScope(niche, scope)) return ''
  return await buildAvoidanceInstruction(slug, niche!)
}

/**
 * v1.0.108+ — convenience wrapper that prepends the scope's avoidance
 * instruction (if any) onto an existing prompt string. No-op when the
 * niche's rule doesn't apply to the scope or the log is empty.
 * Keeps caller sites short: one line replaces three.
 */
export async function prependAvoidanceToPrompt(
  slug: string,
  scope: RecencyScope,
  prompt: string,
  episodeId?: string,
): Promise<string> {
  const text = await getAvoidanceForScope(slug, scope, episodeId)
  if (!text) return prompt
  return `${text}\n\n${prompt}`
}

/**
 * v1.0.108+ — scope-gated post-generation recording. Same shape as
 * `recordUsage` but skips the write when the niche's rule doesn't
 * cover the given scope. Lets generator paths call this unconditionally
 * after each successful generation without first checking scope
 * applicability.
 */
export async function recordUsageForScope(
  slug: string,
  episode_code: string,
  scope: RecencyScope,
  text: string,
): Promise<{ kind: string; added: string[] } | null> {
  let niche: Niche | null
  try {
    niche = await effectiveNicheForEpisode(slug, episode_code)
  } catch {
    return null
  }
  if (!ruleAppliesToScope(niche, scope)) return null
  return await recordUsage(slug, episode_code, niche, text)
}

/** Test/utility — wipe all recency entries (or a single kind). */
export async function clearLog(slug: string, kindFilter?: string): Promise<number> {
  const cfg = await pm.getConfig(slug)
  const log: RecencyLogEntry[] = Array.isArray(cfg?.recency_log) ? cfg!.recency_log! : []
  if (!log.length) return 0
  const kept = kindFilter ? log.filter(e => e.kind !== kindFilter) : []
  const removed = log.length - kept.length
  await pm.updateConfig(slug, { recency_log: kept } as any)
  return removed
}
