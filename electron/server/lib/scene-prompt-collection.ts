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
    if (child.operation !== 'chat.response' || NO_ANSWER.has(child.state) || child.cancelled === true) continue
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
