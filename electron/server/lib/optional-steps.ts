/**
 * The Pipeline steps a channel's own settings can switch off.
 *
 * WHY THIS EXISTS. AGENTS.md §8: "Optional steps are skipped only through
 * explicit project configuration. A skipped optional step is not missing."
 *
 * A batch is admitted as a frozen chain: each link carries its step id and the
 * steps it needs, and the queue hands the next link on as each one finishes.
 * Switching an optional feature off AFTER a batch was admitted used to leave
 * that captured work stranded — the link was still enqueued, its generator
 * refused ("disabled for this project"), the job auto-retried three times,
 * failed, and held back every step that needed it (Night Atlas History
 * EP0011–EP0014, 2026-10-19: Scene Review, Motion Clips and Final Video stuck
 * behind a Contextual Cues step the owner had switched off on all 19 channels).
 *
 * The step is SKIPPED, and everything that needed it proceeds. That is the one
 * rule this module states, so every boundary that meets a captured link —
 * chain dispatch, a job about to start, an episode recovery plan, the Jobs
 * list's read-time classification — answers it the same way.
 *
 * GENERIC by construction: a step joins `OPTIONAL_PIPELINE_STEPS` and inherits
 * the same classification, the same plain reason and the same read-time display
 * everywhere. A step that is REQUIRED never belongs in this table, and neither
 * does a step that is merely missing output — only an explicit project setting
 * can skip one.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { getProjectDir } from '../services/project-manager.js'

interface OptionalStepDefinition {
  /** The plain name the owner knows the step by (`lib/pipeline-continuation.ts`). */
  label: string
  /** The channel's own explicit switch for this step. Absent means off. */
  enabled: (config: Record<string, any>) => boolean
}

/**
 * Every optional Pipeline step, and the explicit channel setting that decides it.
 *
 * `contextual_cues` is the only optional Pipeline step today; `sound_design` is
 * not a Pipeline step at all. A new one is added here and nowhere else.
 */
const OPTIONAL_PIPELINE_STEPS: Record<string, OptionalStepDefinition> = {
  contextual_cues: {
    label: 'Contextual Cues',
    enabled: config => config?.contextual_cues?.enabled === true,
  },
}

/** True when this step id is an optional step a channel's settings can switch off. */
export function isOptionalPipelineStep(step: unknown): step is string {
  return typeof step === 'string' && step in OPTIONAL_PIPELINE_STEPS
}

/**
 * Why this step is skipped, or null when it is not an optional step this channel
 * has switched off. The plain sentence the owner reads, in one place.
 *
 * Returns null for every step that is not in the table, so a REQUIRED step can
 * never be skipped by this rule.
 */
export function optionalStepSkipReason(step: unknown, config: unknown): string | null {
  if (!isOptionalPipelineStep(step)) return null
  const definition = OPTIONAL_PIPELINE_STEPS[step]!
  const body = config && typeof config === 'object' ? config as Record<string, any> : {}
  if (definition.enabled(body)) return null
  return `${definition.label} is switched off in this channel's settings, so this step is skipped.`
}

/** The `output_lines` prefix the Jobs list and the batch summary key on. */
export const SKIPPED_STEP_LINE_PREFIX = '⊘ Skipped:'

// ── The channel's config, re-read when the file changes ─────────────────────
//
// Read-time classification (the Jobs list showing an already-failed row for a
// now-disabled step as `skipped`) needs the channel's current setting, and
// `serializeJob` is synchronous. `project-manager.getConfig` is the wrong tool
// there — it re-parses config.json AND rebuilds the model catalogues on every
// call, which the comment in `services/asset-status.ts` records as the largest
// block of synchronous CPU in a cold episode list. So this reads just the one
// flag, and only when config.json's mtime actually moved.

interface CachedConfig {
  /** Nanoseconds, not milliseconds: two saves inside the same millisecond must not look identical. */
  mtimeNs: bigint
  config: Record<string, any> | null
}

const configCache = new Map<string, CachedConfig>()

/** Test hook: forget every cached channel config. */
export function _clearOptionalStepConfigCacheForTesting(): void {
  configCache.clear()
}

/**
 * The channel's config.json, or null when it cannot be read. Cached against the
 * file's own mtime, so a settings change is picked up on the next call and a
 * quiet read costs one `stat`.
 */
export function readChannelConfig(slug: string): Record<string, any> | null {
  const projectDir = getProjectDir(slug)
  if (!projectDir) return null
  const configPath = path.join(projectDir, 'config.json')
  let mtimeNs: bigint
  try {
    if (!existsSync(configPath)) { configCache.delete(slug); return null }
    mtimeNs = statSync(configPath, { bigint: true }).mtimeNs
  } catch {
    return configCache.get(slug)?.config ?? null
  }
  const cached = configCache.get(slug)
  if (cached && cached.mtimeNs === mtimeNs) return cached.config
  let config: Record<string, any> | null = null
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    config = null
  }
  configCache.set(slug, { mtimeNs, config })
  return config
}

/**
 * Why this channel skips this step right now, or null when it does not.
 *
 * An unreadable config never claims a step is disabled — the same direction
 * every other config reader in this app takes: absent evidence is not consent to
 * skip work.
 */
export function disabledOptionalStepReason(projectSlug: string, step: unknown): string | null {
  if (!isOptionalPipelineStep(step)) return null
  const config = readChannelConfig(projectSlug)
  if (!config) return null
  return optionalStepSkipReason(step, config)
}

/** Why this job's own Pipeline step is skipped right now, or null. */
export function disabledStepReasonForJob(job: { project_slug: string; params?: Record<string, any> | null }): string | null {
  return disabledOptionalStepReason(job.project_slug, job.params?.pipeline_step)
}
