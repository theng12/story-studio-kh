/**
 * Collect-first for Scene Plan prompts: which saved Gateway answers a job already holds.
 *
 * A Scene Plan run that repacks its missing scenes sends a request whose key differs from every
 * earlier one, so an answer the Gateway accepted but Story never saved is orphaned (Sprout SS0119/
 * SS0121, Science EP0011, History EP0015, 2026-10-20). The job's own `genstudio_jobs` children are
 * the evidence; this is the single reader of them. The generator collects each key it returns by
 * exact key before any new request, and Retry / episode recovery copy the result onto the row they
 * create (`withSavedPromptCollection`), because a new row carries params but not the old children.
 */
import type { Job } from '../models/types.js'
import { holdsUnknownProviderOutcome } from '../contracts/provider-task-state.js'

export interface ScenePromptCollectable {
  idempotency_key: string
  /** Absent when the child's scope is unknown (preview pruned or truncated): the run then uses whatever is still missing. */
  scene_ids?: string[]
}

type Child = NonNullable<Job['genstudio_jobs']>[number]

// A settled-failed, cancelled or never-created request has no answer to collect.
const NO_ANSWER = new Set(['failed', 'cancelled', 'not_created'])

function sceneIdsFromPreview(request: Child['request']): string[] | undefined {
  try {
    const parsed = JSON.parse(request?.response_format || 'null')
    const ids = parsed?.json_schema?.schema?.properties?.results?.items?.properties?.scene_id?.enum
    if (Array.isArray(ids) && ids.length && ids.every((id: unknown) => typeof id === 'string')) return ids
  } catch { /* json_object requests carry no id list */ }
  const user = [...(request?.messages || [])].reverse().find(message => message.role === 'user' && !message.truncated)
  const marker = user?.text.lastIndexOf('SCENES:\n') ?? -1
  if (!user || marker < 0) return undefined
  try {
    const scenes = JSON.parse(user.text.slice(marker + 'SCENES:\n'.length))
    const ids = Array.isArray(scenes) ? scenes.map(scene => scene?.scene_id) : []
    if (ids.length && ids.every(id => typeof id === 'string')) return ids
  } catch { /* a truncated list is an unknown scope */ }
  return undefined
}

function looksLikePromptPack(request: Child['request']): boolean {
  if (!request || (!request.response_format && !request.messages?.length)) return true // pruned: nothing says otherwise
  return !!request.response_format?.includes('story_scene_prompt_pack')
    || !!request.messages?.some(message => message.text.includes('"scene_id"'))
}

/** Every accepted or succeeded writing request on this job that could hold prompts, minus keys Story already refused. */
export function collectableScenePromptChildren(
  job: Pick<Job, 'genstudio_jobs' | 'rejected_idempotency_keys'>,
): ScenePromptCollectable[] {
  const rejected = new Set(job.rejected_idempotency_keys || [])
  const found = new Map<string, ScenePromptCollectable>()
  for (const child of job.genstudio_jobs || []) {
    // A `failed` child the Gateway still HOLDS is not settled: its answer may yet arrive and be
    // collected. Skipping it would make a fresh redo ask for prompts this account already paid for,
    // which is the one thing collect-first exists to prevent.
    if (child.operation !== 'chat.response' || child.cancelled === true) continue
    if (NO_ANSWER.has(child.state) && !holdsUnknownProviderOutcome(child)) continue
    // A pre-submit placeholder never reached the Gateway: nothing to read back.
    if (child.id.startsWith('pending:')) continue
    const key = (child.request?.idempotency_key || child.request_key || '').trim()
    if (!key || rejected.has(key) || found.has(key) || !looksLikePromptPack(child.request)) continue
    const scene_ids = sceneIdsFromPreview(child.request)
    found.set(key, { idempotency_key: key, ...(scene_ids ? { scene_ids } : {}) })
  }
  return [...found.values()]
}

/** `params` with the job's collectable children added to `scene_prompt_recoveries`; saved descriptors keep their scope. */
export function withSavedPromptCollection<P extends Record<string, any>>(
  params: P,
  job: Pick<Job, 'genstudio_jobs' | 'rejected_idempotency_keys'>,
): P {
  const saved: ScenePromptCollectable[] = Array.isArray(params.scene_prompt_recoveries) ? params.scene_prompt_recoveries : []
  const known = new Set(saved.map(entry => entry?.idempotency_key))
  const added = collectableScenePromptChildren(job).filter(entry => !known.has(entry.idempotency_key))
  return added.length ? { ...params, scene_prompt_recoveries: [...saved, ...added] } : params
}

/** What a saved answer must match to be about the plan on disk now: its scene ids, and the timeline it was built from. */
export interface ScenePlanIdentity {
  scene_ids: ReadonlySet<string>
  /** `timeline_built_at` of scene_plan.json, in ms. Prompt passes do not move it; a rebuilt timeline does. */
  built_at_ms: number
}

type SiblingRow = Pick<Job, 'status' | 'created_at' | 'params' | 'genstudio_jobs' | 'rejected_idempotency_keys'>

// A single-scene regenerate or reword must write the NEW answer, so an older one is never collected into it.
const stageOf = (params: Record<string, any> | undefined) => String(params?.stage || 'visual')
const isWholePlanVisualRun = (params: Record<string, any> | undefined) => stageOf(params) === 'visual'
  && !params?.regenerate_prompt_scene_id && !params?.regenerate_prompt_scene_ids?.length && !params?.reword_prompt

/**
 * A NEW Scene Plan row starts with no children, so an accepted answer a terminal sibling row of the
 * same episode holds would be orphaned. Carry only what is provably about this plan: a sibling that
 * ended in error/cancelled, started after the plan's timeline was built, with a child whose request
 * preview still names its scenes and every one of them is in the plan. Anything less certain is
 * left out rather than collected into the wrong plan (an unknown scope, a rebuilt timeline).
 */
export function withSiblingPromptCollection<P extends Record<string, any>>(
  params: P,
  siblings: readonly SiblingRow[],
  plan: ScenePlanIdentity | null,
): P {
  if (!plan || !Number.isFinite(plan.built_at_ms) || !isWholePlanVisualRun(params)) return params
  const rows = siblings.filter(row => (row.status === 'error' || row.status === 'cancelled')
    && isWholePlanVisualRun(row.params) && Date.parse(row.created_at) >= plan.built_at_ms)
  const rejected = new Set(rows.flatMap(row => row.rejected_idempotency_keys || []))
  const carried = new Map<string, ScenePromptCollectable>()
  for (const row of rows) {
    for (const entry of collectableScenePromptChildren(row)) {
      if (rejected.has(entry.idempotency_key) || carried.has(entry.idempotency_key)) continue
      if (entry.scene_ids && entry.scene_ids.every(id => plan.scene_ids.has(id))) carried.set(entry.idempotency_key, entry)
    }
  }
  const saved: ScenePromptCollectable[] = Array.isArray(params.scene_prompt_recoveries) ? params.scene_prompt_recoveries : []
  const known = new Set(saved.map(entry => entry?.idempotency_key))
  const added = [...carried.values()].filter(entry => !known.has(entry.idempotency_key))
  return added.length ? { ...params, scene_prompt_recoveries: [...saved, ...added] } : params
}
