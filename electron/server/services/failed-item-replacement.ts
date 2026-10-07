import type { Job } from '../models/types.js'
import {
  GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
  getGenStudioJobByIdempotencyKey,
  holdsUnknownOutcome,
  isSubmissionUncertainCode,
  type GenStudioJob,
} from '../lib/genstudio-client.js'
import { getApiKey } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'

type Evidence = NonNullable<Job['genstudio_jobs']>[number]

export interface FailedItemReplacementPlan {
  params: Record<string, any>
  itemCount: number
  evidence: Evidence[]
}

const BLOCKED_FAILURE = /(?:UNCERTAIN|CANCEL|AUTH|CONFIG|CREDENTIAL|CREDIT|BILLING|PAYMENT|REFUS|REJECT|CONTENT|MODERATION|MALFORM|MODEL_MISMATCH)/i
const KNOWN_REPLACEABLE_FAILURES = new Set([
  // The gateway's own "no Mac is ready right now" endings. Zero-settlement and safe for the owner to
  // retry by hand; deliberately NOT in the automatic fleet-busy wait, which would stack minutes on
  // top of the gateway's own deferral.
  'LOCATION_NOT_READY',
  'LOCATION_UNREACHABLE',
  'PROVIDER_QUOTA_EXHAUSTED',
  'SITE_PLACEMENT_EXHAUSTED',
  'SITE_CAPACITY_UNAVAILABLE',
  'SITE_FAILOVER_EXHAUSTED',
  'CLOUD_PROVIDER_EXHAUSTED',
  'CLOUD_PROVIDER_FAILED',
  'CLOUD_PROVIDER_SUBMISSION_FAILED',
  'CLOUD_PROVIDER_UNAVAILABLE',
  'LANGUAGE_PROVIDER_BACKPRESSURE',
  'LANGUAGE_PROVIDER_FAILED',
  'LANGUAGE_PROVIDER_INCOMPLETE',
  'LANGUAGE_STRUCTURED_OUTPUT_INVALID',
  'PROVIDER_ERROR',
  'PROVIDER_FAILED',
  'VOICE_PROVIDER_RESULT_INVALID',
])

function conflict(message: string): never {
  throw Object.assign(new Error(message), { status: 409, expose: true })
}

function requestKey(entry: Evidence): string | null {
  const keys = [
    entry.request_key,
    entry.request?.idempotency_key,
    entry.id.startsWith('pending:') ? entry.id.slice('pending:'.length) : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const unique = [...new Set(keys.map(value => value.trim()))]
  return unique.length === 1 ? unique[0]! : null
}

function originalFailureWasSuperseded(job: Job, entry: Evidence): boolean {
  const key = requestKey(entry)
  return !!key && ((job.generation_replacement_attempts || []).some(attempt => (
    attempt.original_idempotency_key === key || attempt.original_task_id === entry.id
  )) || (job.manual_failed_item_replacement?.requests || []).some(attempt => (
    attempt.original_idempotency_key === key || attempt.original_task_id === entry.id
  )))
}

function settledFailure(live: GenStudioJob): boolean {
  if (live.state !== 'failed' || live.cancelled === true || live.dispatch_state === 'pre_dispatch') return false
  if (holdsUnknownOutcome(live)) return false
  const failureCode = typeof live.failure_code === 'string' ? live.failure_code.trim() : ''
  const failureClass = typeof live.failure_class === 'string' ? live.failure_class.trim() : ''
  if (failureClass === 'content_refused' || isSubmissionUncertainCode(failureCode) || BLOCKED_FAILURE.test(failureCode)) return false
  if (!['provider_transient', 'provider_error'].includes(failureClass)
    && !KNOWN_REPLACEABLE_FAILURES.has(failureCode)) return false
  const credits = [live.reserved_credits, live.settled_credits, live.released_credits]
  if (!credits.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false
  return Math.abs((live.reserved_credits as number) - (live.settled_credits as number) - (live.released_credits as number)) < 1e-9
}

function withLiveEvidence(entry: Evidence, live: GenStudioJob): Evidence {
  return {
    ...entry,
    id: live.id,
    state: live.state,
    ...(live.dispatch_state !== undefined ? { dispatch_state: live.dispatch_state } : {}),
    ...(live.model_id || live.model_revision_id ? { model_id: live.model_id || live.model_revision_id } : {}),
    ...(typeof live.credit_cost === 'number' && Number.isFinite(live.credit_cost) ? { credit_cost: live.credit_cost } : {}),
    ...(typeof live.reserved_credits === 'number' && Number.isFinite(live.reserved_credits) ? { reserved_credits: live.reserved_credits } : {}),
    ...(typeof live.settled_credits === 'number' && Number.isFinite(live.settled_credits) ? { settled_credits: live.settled_credits } : {}),
    ...(typeof live.released_credits === 'number' && Number.isFinite(live.released_credits)
      ? { released_credits: live.released_credits, returned_credits: live.released_credits } : {}),
    ...(live.failure_code !== undefined ? { failure_code: live.failure_code } : {}),
    ...(live.failure_class !== undefined ? { failure_class: live.failure_class } : {}),
    ...(live.cancelled !== undefined ? { cancelled: live.cancelled } : {}),
    updated_at: new Date().toISOString(),
  } as Evidence
}

async function verifyFailure(entry: Evidence, operation: 'voice.tts' | 'chat.response'): Promise<Evidence> {
  const key = requestKey(entry)
  if (!key || !entry.id || entry.id.startsWith('pending:')) {
    return conflict('The failed request has no exact accepted Gateway identity. Story Studio did not queue replacement work.')
  }
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) return conflict('The Gateway could not be checked because the Gateway API Key is unavailable. No replacement was queued.')
  const baseUrl = await getGenStudioUrl()
  let live: GenStudioJob
  try {
    live = await getGenStudioJobByIdempotencyKey(
      operation,
      baseUrl,
      apiKey,
      key,
      {},
      Date.now() + GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    )
  } catch {
    return conflict('The Gateway could not confirm the failed request. Story Studio kept its recovery evidence and did not queue replacement work.')
  }
  if (live.id !== entry.id) {
    return conflict('The Gateway returned a different task for the saved request identity. No replacement was queued.')
  }
  if (!settledFailure(live)) {
    return conflict('The request is not a confirmed eligible failure with settled credits. No replacement was queued.')
  }
  return withLiveEvidence(entry, live)
}

function audioSection(assetKey: string, episodeId: string): string | null {
  const filename = assetKey.replace(/\\/g, '/').split('/').at(-1) || ''
  const prefix = `${episodeId.toUpperCase()}_`
  if (!filename.startsWith(prefix) || !filename.endsWith('.mp3')) return null
  const slug = filename.slice(prefix.length, -'.mp3'.length).replace(/_part\d+$/i, '')
  return slug && !/[\\/]/.test(slug) ? slug : null
}

async function planAudio(job: Job): Promise<FailedItemReplacementPlan> {
  const checkpoint = job.params?.genstudio_recovery as any
  if (checkpoint?.version !== 1 || checkpoint?.route !== 'genstudio'
    || !checkpoint.assets || typeof checkpoint.assets !== 'object') {
    return conflict('This audio job has no complete saved Gateway recovery map. No replacement was queued.')
  }
  const evidence = structuredClone(job.genstudio_jobs || []) as Evidence[]
  const byId = new Map(evidence.filter(entry => entry.operation === 'voice.tts').map(entry => [entry.id, entry]))
  const sections = new Set<string>()
  let failedChunks = 0
  for (const [assetKey, raw] of Object.entries(checkpoint.assets as Record<string, any>)) {
    if (!raw || raw.operation !== 'tts') continue
    const section = audioSection(assetKey, job.episode_id)
    if (!section || typeof raw.job_id !== 'string' || !raw.job_id.trim()) {
      return conflict('Story Studio cannot prove the exact failed audio section from the saved recovery map. No replacement was queued.')
    }
    const stored = byId.get(raw.job_id)
    if (!stored) return conflict('The saved audio task does not match its provider evidence. No replacement was queued.')
    if (stored.cancelled === true || !['succeeded', 'failed'].includes(stored.state)) {
      return conflict('Audio recovery still has cancelled or unsettled provider work. Check it again before replacing failures.')
    }
    if (stored.state !== 'failed') continue
    const checkpointKey = String(raw.idempotency_key || '').trim()
    const storedWithKey = requestKey(stored) ? stored : { ...stored, request_key: checkpointKey }
    const key = requestKey(storedWithKey)
    if (!key || key !== checkpointKey) {
      return conflict('The failed audio task does not match its saved request identity. No replacement was queued.')
    }
    if (originalFailureWasSuperseded(job, storedWithKey)) continue
    const verified = await verifyFailure(storedWithKey, 'voice.tts')
    evidence[evidence.findIndex(entry => entry.operation === stored.operation && entry.id === stored.id)] = verified
    sections.add(section)
    failedChunks++
  }
  if (!failedChunks || !sections.size) return conflict('No confirmed failed audio section is available to replace.')
  const params = structuredClone(job.params || {})
  params.sections = [...sections].join(',')
  delete params.force
  delete params.no_overwrite
  delete params.generation_action
  delete params.generation_action_fingerprint
  delete params.operation_id
  delete params.quality_check
  delete params.quality_repair
  return { params, itemCount: sections.size, evidence }
}

function chaptersFromPreview(entry: Evidence): number[] | null {
  const preview = entry.request
  if (!preview || preview.messages?.some(message => message.truncated)) return null
  const user = preview.messages?.find(message => message.role === 'user')
  if (!user || user.truncated) return null
  const slots = user.text.match(/SLOTS TO WRITE NOW:\s*\n([\s\S]*?)\n(?:OUTPUT|Output)/)
  if (!slots) return null
  const chapters = [...slots[1]!.matchAll(/^\s*[A-Za-z][A-Za-z ]*\s+(\d+):/gm)].map(match => Number(match[1]))
  const requested = /^Write (\d+)\s+[^\n]+\(s\) of an in-progress episode\./.exec(user.text)
  if (!requested || Number(requested[1]) !== chapters.length
    || !chapters.length || chapters.some(value => !Number.isSafeInteger(value) || value < 1)) return null
  return chapters
}

async function planWriting(job: Job): Promise<FailedItemReplacementPlan> {
  const evidence = structuredClone(job.genstudio_jobs || []) as Evidence[]
  const chat = evidence.filter(entry => entry.operation === 'chat.response')
  if (!chat.length) return conflict('This writing job has no saved Gateway request evidence. No replacement was queued.')
  if (chat.some(entry => entry.cancelled === true || !['succeeded', 'failed'].includes(entry.state))) {
    return conflict('Writing recovery still has cancelled or unsettled provider work. Check it again before replacing failures.')
  }
  // A failed automatic replacement supersedes its original failure. Keep the
  // old receipt for audit, but let an explicit click target the newer failed
  // task rather than either replacing both or trapping the customer.
  const failed = chat.filter(entry => entry.state === 'failed' && !originalFailureWasSuperseded(job, entry))
  if (!failed.length) return conflict('No confirmed failed writing request is available to replace.')
  const chapters = new Set<number>()
  for (const stored of failed) {
    const verified = await verifyFailure(stored, 'chat.response')
    evidence[evidence.findIndex(entry => entry.operation === stored.operation && entry.id === stored.id)] = verified
    if (job.type === 'expand_chapters') {
      const scoped = chaptersFromPreview(stored)
      if (!scoped) return conflict('Story Studio cannot prove the exact failed chapter request from its saved preview. No replacement was queued.')
      for (const chapter of scoped) chapters.add(chapter)
    }
  }
  const params = structuredClone(job.params || {})
  if (job.type === 'expand_chapters') params.chapters_to_expand = [...chapters].sort((a, b) => a - b)
  if (job.type === 'image_prompts') params.fill_gaps = true
  return { params, itemCount: failed.length, evidence }
}

export async function planFailedItemReplacement(job: Job): Promise<FailedItemReplacementPlan> {
  if (job.status !== 'error') return conflict('Only a failed job can replace failed items.')
  if (job.type === 'audio') return planAudio(job)
  if ((job.genstudio_jobs || []).some(entry => entry.operation === 'chat.response')) return planWriting(job)
  return conflict('Replace failed items is available only for failed audio or writing requests.')
}
