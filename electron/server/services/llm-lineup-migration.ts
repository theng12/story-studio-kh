/**
 * The shared "LLM lineup" is retired (owner, 2026-10-03). Each writing step now
 * uses ONE writing model — the one chosen on its page or preset — and falling
 * back across several models is a Gateway pool's job.
 *
 * A project saved by an older build may still carry an enabled lineup that some
 * steps relied on. Once, on load, the steps whose saved preset has no writing
 * model of its own get the lineup's choice kept for them: the Gateway pool whose
 * members are exactly the lineup's models in the same order, otherwise the
 * lineup's FIRST model. The saved lineup is never deleted or read again.
 */
import * as pm from './project-manager.js'
import { getApiKey } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'
import type { LlmLineupMigration } from '../models/types.js'

export interface GatewayPool { id: string; members: string[] }

const retryAfter = new Map<string, number>()

/** The writing steps a lineup used to cover, with where each preset keeps its model. */
const STEP_MODEL_FIELD: Array<{ step: string; label: string; field: (data: Record<string, any>) => Record<string, any> | null; key: string }> = [
  { step: 'research', label: 'Research', field: data => data.form || data, key: 'source_model' },
  { step: 'script-only', label: 'Script', field: data => data.form || null, key: 'model' },
  { step: 'image_prompts', label: 'Thumbnail prompts', field: data => data.form || null, key: 'model' },
  { step: 'metadata', label: 'YouTube Finalizer', field: data => data, key: 'model' },
  { step: 'scene_plan', label: 'Scene Plan', field: data => data, key: 'model' },
  { step: 'contextual_cues', label: 'Contextual Cues', field: data => data, key: 'model' },
]

/**
 * The pools this Gateway publishes, with their members. `null` means the Gateway
 * could not be reached — try again on the next load rather than guess. Any
 * refusal means no pools are visible to Story Studio.
 */
export async function listGatewayPools(): Promise<GatewayPool[] | null> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey.trim()) return []
  let response: Response
  try {
    const base = (await getGenStudioUrl()).trim().replace(/\/+$/, '')
    response = await fetch(`${base}/admin/api/pools`, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(3_000),
    })
  } catch {
    return null
  }
  if (!response.ok) return []
  const body = await response.json().catch(() => null) as { pools?: unknown; namespace?: unknown } | null
  const namespace = typeof body?.namespace === 'string' && body.namespace ? body.namespace : 'pool::'
  return (Array.isArray(body?.pools) ? body.pools : [])
    .filter((pool: any) => typeof pool?.name === 'string' && Array.isArray(pool.members))
    .map((pool: any) => ({ id: `${namespace}${pool.name}`, members: pool.members.filter((m: unknown) => typeof m === 'string') }))
}

function lineupModels(value: unknown): string[] {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (row.enabled !== true || !Array.isArray(row.models)) return []
  return [...new Set(row.models
    .filter((model): model is string => typeof model === 'string')
    .map(model => model.trim().replace(/^genstudio-chat:/, ''))
    .filter(Boolean))]
}

/** The ONE model kept for a lineup: a pool with the same members in the same order, else its first model. */
export function keptLineupModel(models: string[], pools: GatewayPool[]): { model: string; pool: boolean } {
  const match = pools.find(pool => pool.members.length === models.length
    && pool.members.every((member, index) => member === models[index]))
  if (match) return { model: match.id, pool: true }
  return { model: models[0]!, pool: models.length === 1 && pools.some(pool => pool.id === models[0]) }
}

/**
 * Run the one-time migration for a project. Returns the record (new or already
 * written), or null when there is nothing to migrate or the Gateway's pools
 * could not be read yet.
 */
export async function migrateRetiredLlmLineup(
  slug: string,
  readPools: () => Promise<GatewayPool[] | null> = listGatewayPools,
): Promise<LlmLineupMigration | null> {
  const config = await pm.getConfig(slug)
  if (!config) return null
  if (config.llm_lineup_migration) return config.llm_lineup_migration
  const models = lineupModels(config.llm_lineup)
  if (!models.length) return null
  // An unreachable Gateway is retried, but not on every page load while it is down.
  if ((retryAfter.get(slug) || 0) > Date.now()) return null
  const pools = await readPools()
  if (!pools) {
    retryAfter.set(slug, Date.now() + 5 * 60_000)
    return null
  }
  const kept = keptLineupModel(models, pools)

  const { findActivePreset, PRESET_KEYS } = await import('../routes/pipeline.js')
  const update: Record<string, unknown> = {}
  const steps: string[] = []
  for (const { step, label, field, key } of STEP_MODEL_FIELD) {
    const preset = findActivePreset(config, step as any).preset
    if (!preset) continue
    const target = field((preset.data || preset) as Record<string, any>)
    const own = target?.[key] ?? (step === 'research' ? target?.model : undefined)
    if (!target || (typeof own === 'string' && own.trim())) continue
    target[key] = kept.model
    const listKey = PRESET_KEYS[step as keyof typeof PRESET_KEYS].list as string
    update[listKey] = config[listKey]
    steps.push(label)
  }
  const record: LlmLineupMigration = { model: kept.model, pool: kept.pool, steps, migrated_at: new Date().toISOString() }
  await pm.updateConfig(slug, { ...update, llm_lineup_migration: record })
  return record
}
