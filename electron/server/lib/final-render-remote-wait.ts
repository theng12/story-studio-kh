import type {
  FinalRenderIntentStagedReceiptV2,
  FinalRenderRemoteWaitReceipt,
  FinalRenderRemoteWaitReceiptV1,
  FinalRenderTransportReceiptV3,
  PublicFinalRenderWait,
} from '../models/types.js'

export const FINAL_RENDER_REMOTE_WAIT_FIELD = 'final_render_remote_wait'

/** The one line the reconciler writes when a remote render needs the customer's attention. */
export const FINAL_RENDER_ATTENTION_PREFIX = 'Final render needs attention: '

export type FinalRenderRemoteWaitInvalidReason =
  | 'not-object' | 'unknown-fields' | 'invalid-version' | 'invalid-phase' | 'invalid-revision'
  | 'invalid-job-id' | 'job-id-mismatch' | 'invalid-opaque-id' | 'invalid-story-attempt'
  | 'invalid-hash' | 'invalid-request-length' | 'invalid-gateway-id' | 'invalid-time'
  | 'invalid-cancel-transition'

const V1_FIELDS = new Set([
  'version', 'phase', 'revision', 'job_id', 'intent_id', 'story_attempt', 'gateway_attempt_key',
  'request_body_sha256', 'request_body_bytes', 'packet_sha256', 'render_fingerprint',
  'submission_scope_sha256', 'destination_fence_sha256', 'source_generation_fence_sha256',
  'gateway_job_id', 'committed_at', 'cancel_requested_at',
])
const V1_HASH_FIELDS = [
  'request_body_sha256', 'packet_sha256', 'render_fingerprint', 'submission_scope_sha256',
  'destination_fence_sha256', 'source_generation_fence_sha256',
] as const
const V2_FIELDS = new Set([
  'version', 'phase', 'revision', 'job_id', 'intent_id', 'story_instance_id', 'story_attempt',
  'gateway_attempt_key', 'packet_sha256', 'staging_manifest_sha256', 'submission_scope_sha256',
  'destination_fence_sha256', 'source_generation_fence_sha256', 'committed_at', 'cancel_requested_at',
])
const V2_HASH_FIELDS = [
  'packet_sha256', 'staging_manifest_sha256', 'submission_scope_sha256',
  'destination_fence_sha256', 'source_generation_fence_sha256',
] as const
const V3_FIELDS = new Set([
  'version', 'phase', 'revision', 'job_id', 'intent_id', 'story_instance_id', 'story_attempt',
  'gateway_attempt_key', 'packet_sha256', 'staging_manifest_sha256', 'submission_scope_sha256',
  'destination_fence_sha256', 'source_generation_fence_sha256', 'committed_at',
  'cancel_requested_at', 'request_body_sha256', 'request_body_bytes', 'gateway_job_id',
  'transport_revision_sha256',
])
const V3_PHASES = new Set([
  'request_persisted', 'send_may_start', 'send_unknown', 'lookup_not_found',
  'remote_wait', 'output_ready', 'importing', 'imported', 'acknowledged', 'recovery_hold', 'refused',
])
const V3_HASH_FIELDS = [...V2_HASH_FIELDS, 'request_body_sha256', 'transport_revision_sha256'] as const
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STAGED_INTENT = /^render_[0-9a-f]{32}$/

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

export function hasFinalRenderRemoteWaitMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.hasOwn(value, FINAL_RENDER_REMOTE_WAIT_FIELD)
}

export function parseFinalRenderRemoteWaitReceipt(
  value: unknown,
  expectedJobId: string,
): { ok: true; receipt: FinalRenderRemoteWaitReceipt } | { ok: false; reason: FinalRenderRemoteWaitInvalidReason } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not-object' }
  const candidate = value as Record<string, unknown>
  if (candidate.version === 1) return parseV1(candidate, expectedJobId)
  if (candidate.version === 2) return parseV2(candidate, expectedJobId)
  if (candidate.version === 3) return parseV3(candidate, expectedJobId)
  return { ok: false, reason: 'invalid-version' }
}

function parseV3(
  candidate: Record<string, unknown>,
  expectedJobId: string,
): { ok: true; receipt: FinalRenderTransportReceiptV3 } | { ok: false; reason: FinalRenderRemoteWaitInvalidReason } {
  if (Object.keys(candidate).length !== V3_FIELDS.size || Object.keys(candidate).some(key => !V3_FIELDS.has(key))) {
    return { ok: false, reason: 'unknown-fields' }
  }
  if (typeof candidate.phase !== 'string' || !V3_PHASES.has(candidate.phase)) return { ok: false, reason: 'invalid-phase' }
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 2) return { ok: false, reason: 'invalid-revision' }
  if (!bounded(candidate.job_id, 128)) return { ok: false, reason: 'invalid-job-id' }
  if (candidate.job_id !== expectedJobId) return { ok: false, reason: 'job-id-mismatch' }
  if (typeof candidate.intent_id !== 'string' || !STAGED_INTENT.test(candidate.intent_id)
    || typeof candidate.gateway_attempt_key !== 'string' || !CANONICAL_UUID.test(candidate.gateway_attempt_key)
    || typeof candidate.story_instance_id !== 'string' || !CANONICAL_UUID.test(candidate.story_instance_id)) {
    return { ok: false, reason: 'invalid-opaque-id' }
  }
  if (candidate.story_attempt !== 1) return { ok: false, reason: 'invalid-story-attempt' }
  if (V3_HASH_FIELDS.some(field => typeof candidate[field] !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate[field] as string))) return { ok: false, reason: 'invalid-hash' }
  if (!Number.isSafeInteger(candidate.request_body_bytes) || (candidate.request_body_bytes as number) <= 0) {
    return { ok: false, reason: 'invalid-request-length' }
  }
  const gatewayRequired = candidate.phase === 'remote_wait' || candidate.phase === 'output_ready'
    || candidate.phase === 'importing' || candidate.phase === 'imported' || candidate.phase === 'acknowledged'
  const gatewayOptional = candidate.phase === 'recovery_hold'
  const validGateway = typeof candidate.gateway_job_id === 'string' && CANONICAL_UUID.test(candidate.gateway_job_id)
  if ((gatewayRequired && !validGateway)
    || (gatewayOptional && candidate.gateway_job_id !== null && !validGateway)
    || (!gatewayRequired && !gatewayOptional && candidate.gateway_job_id !== null)) {
    return { ok: false, reason: 'invalid-gateway-id' }
  }
  if (!canonicalUtc(candidate.committed_at)
    || (candidate.cancel_requested_at !== null && !canonicalUtc(candidate.cancel_requested_at))) {
    return { ok: false, reason: 'invalid-time' }
  }
  if (candidate.cancel_requested_at !== null
    && Date.parse(candidate.cancel_requested_at as string) < Date.parse(candidate.committed_at as string)) {
    return { ok: false, reason: 'invalid-cancel-transition' }
  }
  return { ok: true, receipt: structuredClone(candidate) as unknown as FinalRenderTransportReceiptV3 }
}

function parseV1(
  candidate: Record<string, unknown>,
  expectedJobId: string,
): { ok: true; receipt: FinalRenderRemoteWaitReceiptV1 } | { ok: false; reason: FinalRenderRemoteWaitInvalidReason } {
  if (Object.keys(candidate).length !== V1_FIELDS.size || Object.keys(candidate).some(key => !V1_FIELDS.has(key))) {
    return { ok: false, reason: 'unknown-fields' }
  }
  if (candidate.phase !== 'remote_wait') return { ok: false, reason: 'invalid-phase' }
  if (candidate.revision !== 1 && candidate.revision !== 2) return { ok: false, reason: 'invalid-revision' }
  if (!bounded(candidate.job_id, 128)) return { ok: false, reason: 'invalid-job-id' }
  if (candidate.job_id !== expectedJobId) return { ok: false, reason: 'job-id-mismatch' }
  if (!bounded(candidate.intent_id, 512) || !bounded(candidate.gateway_attempt_key, 512)) return { ok: false, reason: 'invalid-opaque-id' }
  if (typeof candidate.story_attempt !== 'number' || !Number.isSafeInteger(candidate.story_attempt) || candidate.story_attempt <= 0) {
    return { ok: false, reason: 'invalid-story-attempt' }
  }
  if (V1_HASH_FIELDS.some(field => typeof candidate[field] !== 'string' || !/^[0-9a-f]{64}$/.test(candidate[field] as string))) {
    return { ok: false, reason: 'invalid-hash' }
  }
  if (typeof candidate.request_body_bytes !== 'number'
    || !Number.isSafeInteger(candidate.request_body_bytes) || candidate.request_body_bytes <= 0) {
    return { ok: false, reason: 'invalid-request-length' }
  }
  if (candidate.gateway_job_id !== null && !bounded(candidate.gateway_job_id, 256)) return { ok: false, reason: 'invalid-gateway-id' }
  if (!canonicalUtc(candidate.committed_at)
    || (candidate.cancel_requested_at !== null && !canonicalUtc(candidate.cancel_requested_at))) {
    return { ok: false, reason: 'invalid-time' }
  }
  if ((candidate.revision === 1) !== (candidate.cancel_requested_at === null)) return { ok: false, reason: 'invalid-cancel-transition' }
  if (candidate.cancel_requested_at !== null && Date.parse(candidate.cancel_requested_at as string) < Date.parse(candidate.committed_at as string)) {
    return { ok: false, reason: 'invalid-cancel-transition' }
  }
  return { ok: true, receipt: structuredClone(candidate) as unknown as FinalRenderRemoteWaitReceiptV1 }
}

function parseV2(
  candidate: Record<string, unknown>,
  expectedJobId: string,
): { ok: true; receipt: FinalRenderIntentStagedReceiptV2 } | { ok: false; reason: FinalRenderRemoteWaitInvalidReason } {
  if (Object.keys(candidate).length !== V2_FIELDS.size || Object.keys(candidate).some(key => !V2_FIELDS.has(key))) {
    return { ok: false, reason: 'unknown-fields' }
  }
  if (candidate.phase !== 'intent_staged') return { ok: false, reason: 'invalid-phase' }
  if (candidate.revision !== 1 && candidate.revision !== 2) return { ok: false, reason: 'invalid-revision' }
  if (!bounded(candidate.job_id, 128)) return { ok: false, reason: 'invalid-job-id' }
  if (candidate.job_id !== expectedJobId) return { ok: false, reason: 'job-id-mismatch' }
  if (typeof candidate.intent_id !== 'string' || !STAGED_INTENT.test(candidate.intent_id)
    || typeof candidate.gateway_attempt_key !== 'string' || !CANONICAL_UUID.test(candidate.gateway_attempt_key)
    || typeof candidate.story_instance_id !== 'string' || !CANONICAL_UUID.test(candidate.story_instance_id)) {
    return { ok: false, reason: 'invalid-opaque-id' }
  }
  if (candidate.story_attempt !== 1) return { ok: false, reason: 'invalid-story-attempt' }
  if (V2_HASH_FIELDS.some(field => typeof candidate[field] !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate[field] as string))) return { ok: false, reason: 'invalid-hash' }
  if (!canonicalUtc(candidate.committed_at)
    || (candidate.cancel_requested_at !== null && !canonicalUtc(candidate.cancel_requested_at))) {
    return { ok: false, reason: 'invalid-time' }
  }
  if ((candidate.revision === 1) !== (candidate.cancel_requested_at === null)) {
    return { ok: false, reason: 'invalid-cancel-transition' }
  }
  if (candidate.cancel_requested_at !== null
    && Date.parse(candidate.cancel_requested_at as string) < Date.parse(candidate.committed_at as string)) {
    return { ok: false, reason: 'invalid-cancel-transition' }
  }
  return { ok: true, receipt: structuredClone(candidate) as unknown as FinalRenderIntentStagedReceiptV2 }
}

export function sameFinalRenderRemoteWaitIdentity(
  left: FinalRenderRemoteWaitReceipt,
  right: FinalRenderRemoteWaitReceipt,
): boolean {
  if (left.version !== right.version || left.phase !== right.phase) return false
  if (left.version === 2 && right.version === 2) {
    return left.job_id === right.job_id
      && left.intent_id === right.intent_id
      && left.story_instance_id === right.story_instance_id
      && left.story_attempt === right.story_attempt
      && left.gateway_attempt_key === right.gateway_attempt_key
      && left.packet_sha256 === right.packet_sha256
      && left.staging_manifest_sha256 === right.staging_manifest_sha256
      && left.submission_scope_sha256 === right.submission_scope_sha256
      && left.destination_fence_sha256 === right.destination_fence_sha256
      && left.source_generation_fence_sha256 === right.source_generation_fence_sha256
      && left.committed_at === right.committed_at
  }
  if (left.version === 3 && right.version === 3) {
    return left.job_id === right.job_id
      && left.intent_id === right.intent_id
      && left.story_instance_id === right.story_instance_id
      && left.story_attempt === right.story_attempt
      && left.gateway_attempt_key === right.gateway_attempt_key
      && left.packet_sha256 === right.packet_sha256
      && left.staging_manifest_sha256 === right.staging_manifest_sha256
      && left.submission_scope_sha256 === right.submission_scope_sha256
      && left.destination_fence_sha256 === right.destination_fence_sha256
      && left.source_generation_fence_sha256 === right.source_generation_fence_sha256
      && left.committed_at === right.committed_at
      && left.cancel_requested_at === right.cancel_requested_at
      && left.request_body_sha256 === right.request_body_sha256
      && left.request_body_bytes === right.request_body_bytes
      && left.gateway_job_id === right.gateway_job_id
      && left.revision === right.revision
      && left.transport_revision_sha256 === right.transport_revision_sha256
  }
  if (left.version !== 1 || right.version !== 1) return false
  return left.phase === right.phase
    && left.job_id === right.job_id
    && left.intent_id === right.intent_id
    && left.story_attempt === right.story_attempt
    && left.gateway_attempt_key === right.gateway_attempt_key
    && left.request_body_sha256 === right.request_body_sha256
    && left.request_body_bytes === right.request_body_bytes
    && left.packet_sha256 === right.packet_sha256
    && left.render_fingerprint === right.render_fingerprint
    && left.submission_scope_sha256 === right.submission_scope_sha256
    && left.destination_fence_sha256 === right.destination_fence_sha256
    && left.source_generation_fence_sha256 === right.source_generation_fence_sha256
    && left.gateway_job_id === right.gateway_job_id
    && left.committed_at === right.committed_at
}

export function publicFinalRenderWait(job: unknown, inProcessRecoveryHold = false): PublicFinalRenderWait | undefined {
  if (inProcessRecoveryHold) {
    const candidate = job && typeof job === 'object' ? job as Record<string, unknown> : null
    const parsed = candidate && hasFinalRenderRemoteWaitMarker(candidate)
      ? parseFinalRenderRemoteWaitReceipt(candidate[FINAL_RENDER_REMOTE_WAIT_FIELD], String(candidate.job_id || ''))
      : null
    return {
      state: 'recovery_hold',
      cancellation_requested: parsed?.ok ? parsed.receipt.cancel_requested_at !== null : false,
      gateway_id_known: parsed?.ok && parsed.receipt.version !== 2
        ? parsed.receipt.gateway_job_id !== null
        : false,
      committed_at: parsed?.ok ? parsed.receipt.committed_at : null,
    }
  }
  if (!job || typeof job !== 'object') return undefined
  const candidate = job as Record<string, unknown>
  if (!hasFinalRenderRemoteWaitMarker(candidate)) return undefined
  const parsed = parseFinalRenderRemoteWaitReceipt(candidate[FINAL_RENDER_REMOTE_WAIT_FIELD], String(candidate.job_id || ''))
  if (!parsed.ok) return { state: 'recovery_hold', cancellation_requested: false, gateway_id_known: false, committed_at: null }
  const receipt = parsed.receipt
  if (receipt.version === 3 && receipt.phase === 'refused') return undefined
  const state = receipt.version === 2 ? 'intent_staged'
    : receipt.version === 3 ? (receipt.phase === 'lookup_not_found' || receipt.phase === 'refused' ? 'recovery_hold' : receipt.phase)
      : 'remote_wait'
  return {
    state,
    cancellation_requested: parsed.receipt.cancel_requested_at !== null,
    gateway_id_known: parsed.receipt.version !== 2 && parsed.receipt.gateway_job_id !== null,
    committed_at: parsed.receipt.committed_at,
  }
}
