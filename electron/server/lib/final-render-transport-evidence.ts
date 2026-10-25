import { createHash } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  validateFinalRenderBlobStatusEvidence,
  validateFinalRenderCancelEvidence,
  validateFinalRenderAckEvidence,
  validateFinalRenderJobEvidence,
  encodeFinalRenderAckBody,
  validateSubmitBytes,
  type FinalRenderEvidenceAccess,
  type FinalRenderJobView,
} from './final-render-gateway-client.js'
import { parseFinalRenderRemoteWaitReceipt, sameFinalRenderRemoteWaitIdentity } from './final-render-remote-wait.js'
import { classifyFinalRenderContainerEvidence } from './ffmpeg-validation.js'
import { finalLoudnessIssue } from './final-loudness.js'
import type {
  FinalRenderIntentStagedReceiptV2,
  FinalRenderRemoteWaitReceipt,
  FinalRenderTransportReceiptV3,
} from '../models/types.js'

export const FINAL_RENDER_MAX_REVISION_BYTES = 64 * 1024
export const FINAL_RENDER_MAX_REVISIONS = 16_384
const MAX_CHUNK_BYTES = 8 * 1024 * 1024

// Gateway accept() returns synchronously; an HTTP reply plus two same-key absences ten minutes
// apart outlives that completed create. A lost network reply never supplies this proof.
export const FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS = 10 * 60_000

/** Only RenderServiceError pairs emitted before staging by Gateway create/auth. */
export function isDefiniteFinalRenderRefusal(status: number, code: unknown): boolean {
  return (status === 400 && (code === 'IDEMPOTENCY_KEY_INVALID' || code === 'RENDER_REQUEST_INVALID'))
    || (status === 401 && code === 'UNAUTHORIZED')
    || (status === 403 && code === 'FORBIDDEN')
    || (status === 404 && code === 'RENDER_ASSET_NOT_FOUND')
    || (status === 409 && (code === 'RENDER_PROFILE_MISMATCH' || code === 'RENDER_ASSET_CONFLICT'))
    || (status === 413 && code === 'RENDER_REQUEST_INVALID')
    || (status === 422 && (code === 'RENDER_REQUEST_INVALID' || code === 'IDEMPOTENCY_KEY_REQUIRED'))
}

export function finalRenderRefusalMessage(refusal: FinalRenderTransportRevisionRecord): string {
  if (refusal.event !== 'post_refused' && refusal.event !== 'lookup_refused') fail('local fallback lacks refusal proof')
  return refusal.event === 'post_refused'
    ? `Private final render: the paired Gateway refused this render (${refusal.payload.code}), so this video renders on this Mac.`
    : 'Private final render: two authoritative original-key lookups at least 10 minutes apart found no render after an HTTP create failure; the Gateway never accepted this render, so this video renders on this Mac.'
}
const REVISION_KEYS = [
  'version', 'sequence', 'previous_sha256', 'canonical_before_sha256', 'event',
  'recorded_at', 'owner_token', 'owner_epoch', 'payload',
] as const
const SUBMISSION_KEYS = [
  'format', 'job_id', 'intent_id', 'story_instance_id', 'story_attempt', 'gateway_attempt_key',
  'request_body_sha256', 'request_body_bytes', 'packet_sha256', 'staging_manifest_sha256',
  'pairing_identity_sha256', 'profile_sha256', 'tools_sha256', 'compiler_sha256', 'sources',
] as const
const SOURCE_KEYS = ['logical_id', 'safe_name', 'source_sha256', 'size_bytes', 'gateway_asset_handle'] as const
const MANIFEST_SOURCE_KEYS = ['logical_id', 'role', 'safe_name', 'canonical_source_path', 'size_bytes', 'sha256'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const HANDLE = /^[0-9a-f]{32}$/

export interface FinalRenderTransportRevisionFile {
  name: string
  bytes: Uint8Array
}

export interface FinalRenderTransportRevisionRecord {
  version: 1
  sequence: number
  previous_sha256: string | null
  canonical_before_sha256: string
  event: string
  recorded_at: string
  owner_token: string
  owner_epoch: number
  payload: Record<string, any>
}

export interface ValidatedFinalRenderTransportEvidence {
  records: Array<{ value: FinalRenderTransportRevisionRecord; bytes: Buffer; sha256: string }>
  ownerToken: string | null
  ownerEpoch: number
  unresolvedPut: FinalRenderTransportRevisionRecord | null
  repeatPut: FinalRenderTransportRevisionRecord | null
  importOutput: null | {
    sha256: string
    sizeBytes: number
    receiptSha256: string
    destinationPath: string | null
    candidatePath: string | null
  }
}

export interface ValidateFinalRenderTransportEvidenceInput {
  staged: FinalRenderIntentStagedReceiptV2
  canonical: FinalRenderRemoteWaitReceipt
  manifestBytes: Uint8Array
  revisions: FinalRenderTransportRevisionFile[]
  requestBytes?: Uint8Array
  submissionBytes?: Uint8Array
  expectedPairingIdentitySha256?: string
  expectedOwner?: { token: string; epoch: number }
}

function fail(message: string): never {
  throw new Error(`Private final render evidence ${message}.`)
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function finalRenderCanonicalReceiptHash(receipt: FinalRenderRemoteWaitReceipt): string {
  return digest(JSON.stringify(receipt))
}

export function samePinnedOutput(left: FinalRenderJobView, right: FinalRenderJobView): boolean {
  return left.id === right.id
    && left.gateway_attempt_key === right.gateway_attempt_key
    && left.story_uuid === right.story_uuid
    && left.intent_id === right.intent_id
    && left.attempt_no === right.attempt_no
    && left.output_ready === right.output_ready
    && isDeepStrictEqual(left.output, right.output)
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}

function sameReceipt(left: FinalRenderRemoteWaitReceipt, right: FinalRenderRemoteWaitReceipt): boolean {
  return sameFinalRenderRemoteWaitIdentity(left, right)
    && left.revision === right.revision
    && left.cancel_requested_at === right.cancel_requested_at
}

function sameV2V3Lineage(before: FinalRenderIntentStagedReceiptV2, after: FinalRenderTransportReceiptV3): boolean {
  return before.job_id === after.job_id && before.intent_id === after.intent_id
    && before.story_instance_id === after.story_instance_id && before.story_attempt === after.story_attempt
    && before.gateway_attempt_key === after.gateway_attempt_key && before.packet_sha256 === after.packet_sha256
    && before.staging_manifest_sha256 === after.staging_manifest_sha256
    && before.submission_scope_sha256 === after.submission_scope_sha256
    && before.destination_fence_sha256 === after.destination_fence_sha256
    && before.source_generation_fence_sha256 === after.source_generation_fence_sha256
    && before.committed_at === after.committed_at
}

function validTransition(before: FinalRenderRemoteWaitReceipt, after: FinalRenderTransportReceiptV3): boolean {
  if (before.version === 2) {
    return before.revision === 1 && before.cancel_requested_at === null
      && after.phase === 'request_persisted' && after.revision === 2
      && after.cancel_requested_at === null && after.gateway_job_id === null
      && sameV2V3Lineage(before, after)
  }
  if (before.version !== 3 || after.revision !== before.revision + 1
    || before.job_id !== after.job_id || before.intent_id !== after.intent_id
    || before.story_instance_id !== after.story_instance_id || before.story_attempt !== after.story_attempt
    || before.gateway_attempt_key !== after.gateway_attempt_key || before.packet_sha256 !== after.packet_sha256
    || before.staging_manifest_sha256 !== after.staging_manifest_sha256
    || before.submission_scope_sha256 !== after.submission_scope_sha256
    || before.destination_fence_sha256 !== after.destination_fence_sha256
    || before.source_generation_fence_sha256 !== after.source_generation_fence_sha256
    || before.committed_at !== after.committed_at || before.request_body_sha256 !== after.request_body_sha256
    || before.request_body_bytes !== after.request_body_bytes
    || before.cancel_requested_at !== after.cancel_requested_at) return false
  if (before.phase === 'request_persisted') {
    return after.phase === 'send_may_start' && before.gateway_job_id === null && after.gateway_job_id === null
  }
  if (before.phase === 'send_may_start') {
    return (after.phase === 'remote_wait' && after.gateway_job_id !== null)
      || ((after.phase === 'send_unknown' || after.phase === 'lookup_not_found' || after.phase === 'recovery_hold' || after.phase === 'refused')
        && after.gateway_job_id === null)
  }
  if (before.phase === 'send_unknown') {
    return (after.phase === 'remote_wait' && after.gateway_job_id !== null)
      || ((after.phase === 'lookup_not_found' || after.phase === 'recovery_hold') && after.gateway_job_id === null)
  }
  if (before.phase === 'lookup_not_found') {
    return (after.phase === 'remote_wait' && after.gateway_job_id !== null)
      || ((after.phase === 'recovery_hold' || after.phase === 'refused') && after.gateway_job_id === null)
  }
  if (before.phase === 'remote_wait') {
    return (after.phase === 'output_ready' || after.phase === 'recovery_hold')
      && after.gateway_job_id === before.gateway_job_id
  }
  if (before.phase === 'output_ready') {
    return after.phase === 'importing' && after.gateway_job_id === before.gateway_job_id
  }
  if (before.phase === 'importing') {
    return after.phase === 'imported' && after.gateway_job_id === before.gateway_job_id
  }
  if (before.phase === 'imported') {
    return after.phase === 'acknowledged' && after.gateway_job_id === before.gateway_job_id
  }
  return false
}

function cancellationBase(
  candidate: FinalRenderRemoteWaitReceipt,
  canonical: FinalRenderRemoteWaitReceipt,
): boolean {
  if (candidate.version !== canonical.version) return false
  const projected = {
    ...canonical,
    revision: candidate.revision,
    cancel_requested_at: candidate.cancel_requested_at,
  } as FinalRenderRemoteWaitReceipt
  return (candidate.version === 2 || candidate.version === 3)
    && candidate.cancel_requested_at === null && canonical.cancel_requested_at !== null
    && canonical.revision === candidate.revision + 1
    && sameReceipt(candidate, projected)
}

function cancellationOverlay(
  candidate: FinalRenderRemoteWaitReceipt,
  canonical: FinalRenderRemoteWaitReceipt,
): FinalRenderRemoteWaitReceipt | null {
  if ((candidate.version !== 2 && candidate.version !== 3)
    || candidate.cancel_requested_at !== null || canonical.cancel_requested_at === null) return null
  const parsed = parseFinalRenderRemoteWaitReceipt({
    ...candidate,
    revision: candidate.revision + 1,
    cancel_requested_at: canonical.cancel_requested_at,
  }, candidate.job_id)
  return parsed.ok ? parsed.receipt : null
}

function validateManifest(bytes: Uint8Array, staged: FinalRenderIntentStagedReceiptV2): Record<string, any> {
  if (digest(bytes) !== staged.staging_manifest_sha256) fail('manifest hash does not match its staged root')
  let manifest: any
  try { manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { fail('manifest JSON is invalid') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.format !== 'studio.render.story-intent.v1' || manifest.job_id !== staged.job_id
    || manifest.intent_id !== staged.intent_id || manifest.story_instance_id !== staged.story_instance_id
    || manifest.story_attempt !== staged.story_attempt || manifest.gateway_attempt_key !== staged.gateway_attempt_key
    || manifest.committed_at !== staged.committed_at || manifest.packet?.packet_digest !== staged.packet_sha256
    || !Array.isArray(manifest.sources) || manifest.sources.length < 1 || manifest.sources.length > 32) {
    fail('manifest lineage is invalid')
  }
  const logicalIds = new Set<string>()
  const safeNames = new Set<string>()
  for (const source of manifest.sources) {
    if (!exactKeys(source, MANIFEST_SOURCE_KEYS)
      || typeof source.logical_id !== 'string' || !source.logical_id || logicalIds.has(source.logical_id)
      || typeof source.role !== 'string' || !source.role
      || typeof source.safe_name !== 'string' || !source.safe_name
      || source.safe_name === '.' || source.safe_name === '..' || path.basename(source.safe_name) !== source.safe_name
      || safeNames.has(source.safe_name)
      || typeof source.canonical_source_path !== 'string' || !source.canonical_source_path
      || !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 0
      || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) fail('manifest source binding is invalid')
    logicalIds.add(source.logical_id)
    safeNames.add(source.safe_name)
  }
  const destination = manifest.destination
  const route = destination?.route
  const state = destination?.state
  if (!exactKeys(destination, ['pathname', 'route', 'state', 'recovery_root'])
    || typeof destination.pathname !== 'string' || !path.isAbsolute(destination.pathname)
    || !exactKeys(route, ['code', 'title', 'format', 'external'])
    || typeof route.code !== 'string' || !route.code
    || typeof route.title !== 'string' || route.format !== 'mp4' || typeof route.external !== 'boolean'
    || (!exactKeys(state, ['kind']) && !exactKeys(state, ['kind', 'size_bytes', 'sha256']))
    || (state.kind !== 'absent' && state.kind !== 'file')
    || (state.kind === 'absent' && !exactKeys(state, ['kind']))
    || (state.kind === 'absent' && destination.recovery_root !== null)
    || (state.kind === 'file' && (!exactKeys(state, ['kind', 'size_bytes', 'sha256'])
      || !Number.isSafeInteger(state.size_bytes) || state.size_bytes <= 0
      || typeof state.sha256 !== 'string' || !SHA256.test(state.sha256)
      || typeof destination.recovery_root !== 'string' || !path.isAbsolute(destination.recovery_root)))) {
    fail('manifest destination binding is invalid')
  }
  if (!exactKeys(manifest.loudness, ['lufs', 'true_peak_db', 'tolerance_pct', 'check'])
    || !Number.isFinite(manifest.loudness.lufs) || !Number.isFinite(manifest.loudness.true_peak_db)
    || !Number.isFinite(manifest.loudness.tolerance_pct) || manifest.loudness.tolerance_pct < 0
    || !['off', 'warn', 'block'].includes(manifest.loudness.check)) {
    fail('manifest loudness target is invalid')
  }
  return manifest
}

function validateSealedFiles(
  input: ValidateFinalRenderTransportEvidenceInput,
  manifest: Record<string, any>,
): {
  access: FinalRenderEvidenceAccess
  requestDigest?: string
  sources: Array<{ assetSha256: string; sizeBytes: number; handle: string }>
} {
  const scope = manifest.scope
  if (!scope || typeof scope !== 'object' || !UUID.test(scope.owner_scope)
    || !UUID.test(scope.gateway_instance_id) || !UUID.test(scope.story_instance_id)) fail('manifest scope is invalid')
  const access = {
    owner_scope: scope.owner_scope,
    gateway_instance_id: scope.gateway_instance_id,
    story_instance_id: scope.story_instance_id,
  }
  if (!input.requestBytes && !input.submissionBytes) {
    if (input.canonical.version === 3) fail('sealed request or submission is missing')
    return { access, sources: [] }
  }
  if (!input.requestBytes || !input.submissionBytes) fail('sealed request and submission are not an exact pair')
  if (input.canonical.version === 1) fail('sealed request canonical lineage is invalid')
  const request = Buffer.from(input.requestBytes)
  const requestDigest = digest(request)
  if (input.canonical.version === 3 && (request.byteLength !== input.canonical.request_body_bytes
    || requestDigest !== input.canonical.request_body_sha256)) fail('request bytes do not match canonical')
  const context = validateSubmitBytes(request)
  if (context.storyUuid !== input.canonical.story_instance_id || context.intent !== input.canonical.intent_id
    || context.attemptNo !== input.canonical.story_attempt || context.packetDigest !== input.canonical.packet_sha256) {
    fail('request lineage does not match canonical')
  }
  let requestValue: any
  let submission: any
  try {
    requestValue = JSON.parse(request.toString('utf8'))
    submission = JSON.parse(Buffer.from(input.submissionBytes).toString('utf8'))
  } catch { fail('sealed JSON is invalid') }
  if (!exactKeys(submission, SUBMISSION_KEYS) || submission.format !== 'studio.render.story-submission.v1'
    || submission.job_id !== input.staged.job_id || submission.intent_id !== input.staged.intent_id
    || submission.story_instance_id !== input.staged.story_instance_id
    || submission.story_attempt !== input.staged.story_attempt
    || submission.gateway_attempt_key !== input.staged.gateway_attempt_key
    || submission.request_body_sha256 !== requestDigest || submission.request_body_bytes !== request.byteLength
    || submission.packet_sha256 !== input.staged.packet_sha256
    || submission.staging_manifest_sha256 !== input.staged.staging_manifest_sha256
    || !SHA256.test(submission.pairing_identity_sha256)
    || (input.expectedPairingIdentitySha256 !== undefined
      && submission.pairing_identity_sha256 !== input.expectedPairingIdentitySha256)
    || submission.profile_sha256 !== manifest.descriptors?.profile?.sha256
    || submission.tools_sha256 !== manifest.descriptors?.tools?.sha256
    || submission.compiler_sha256 !== manifest.descriptors?.compiler?.sha256
    || !Array.isArray(submission.sources) || submission.sources.length !== manifest.sources.length) {
    fail('submission record does not match its sealed request')
  }
  const manifestSources = new Map(manifest.sources.map((source: any) => [source.logical_id, source]))
  const requestAssets = requestValue.assets as Record<string, unknown>
  const seen = new Set<string>()
  const sources: Array<{ assetSha256: string; sizeBytes: number; handle: string }> = []
  for (const source of submission.sources) {
    const stagedSource = manifestSources.get(source?.logical_id) as any
    if (!exactKeys(source, SOURCE_KEYS) || seen.has(source.logical_id) || !stagedSource
      || source.safe_name !== stagedSource.safe_name || source.source_sha256 !== stagedSource.sha256
      || source.size_bytes !== stagedSource.size_bytes || !HANDLE.test(source.gateway_asset_handle)
      || requestAssets?.[source.logical_id] !== source.gateway_asset_handle) fail('submission source binding is invalid')
    seen.add(source.logical_id)
    sources.push({
      assetSha256: source.source_sha256,
      sizeBytes: source.size_bytes,
      handle: source.gateway_asset_handle,
    })
  }
  return { access, requestDigest, sources }
}

function parseAfter(record: FinalRenderTransportRevisionRecord, sha256: string, jobId: string): FinalRenderTransportReceiptV3 {
  if (!record.payload.after || typeof record.payload.after !== 'object'
    || Array.isArray(record.payload.after) || Object.hasOwn(record.payload.after, 'transport_revision_sha256')) {
    fail('canonical after projection is invalid')
  }
  const parsed = parseFinalRenderRemoteWaitReceipt({ ...record.payload.after, transport_revision_sha256: sha256 }, jobId)
  if (!parsed.ok || parsed.receipt.version !== 3) fail('canonical after receipt is invalid')
  return parsed.receipt
}

/**
 * Pure, bounded validator shared by the transport and the independent queue CAS.
 * It receives only already-reopened bytes and expected authority; it performs no I/O.
 */
export function validateFinalRenderTransportEvidence(
  input: ValidateFinalRenderTransportEvidenceInput,
): ValidatedFinalRenderTransportEvidence {
  if (input.staged.version !== 2 || input.staged.revision !== 1
    || input.staged.cancel_requested_at !== null) fail('staged root is invalid')
  const manifest = validateManifest(input.manifestBytes, input.staged)
  const sealed = validateSealedFiles(input, manifest)
  if (input.revisions.length > FINAL_RENDER_MAX_REVISIONS) fail('revision bound is exceeded')

  const records: ValidatedFinalRenderTransportEvidence['records'] = []
  const manifestSources = new Map(manifest.sources.map((source: any) => [source.logical_id, source]))
  const hops = new Map<string, FinalRenderTransportRevisionRecord>()
  const observed = new Set<string>()
  const reconciledPuts = new Set<string>()
  const unresolvedPuts = new Set<string>()
  const completeHandles = new Map<string, string>()
  const completeBlobs = new Map<string, string>()
  const cancelIntents = new Map<string, FinalRenderTransportRevisionRecord>()
  const consumedCancelIntents = new Set<string>()
  const ackIntents = new Map<string, FinalRenderTransportRevisionRecord>()
  const consumedAckIntents = new Set<string>()
  const canonicalStates: FinalRenderRemoteWaitReceipt[] = [input.staged]
  let logicalCanonical: FinalRenderRemoteWaitReceipt = input.staged
  let ownerToken: string | null = null
  let ownerEpoch = 0
  let postUnknown: FinalRenderTransportRevisionRecord | null = null
  let firstAbsent: FinalRenderTransportRevisionRecord | null = null
  let repeatPut: FinalRenderTransportRevisionRecord | null = null
  let pinnedOutput: FinalRenderJobView | null = null
  let importOutputSha256: string | null = null
  let importOutputSize = 0
  let importReceiptSha256: string | null = null
  let importDestinationPath: string | null = null
  let importDestinationIdentity: { dev: string; ino: string } | null = null
  let outputPrefixLength = 0
  let outputCandidate: string | null = null
  let outputCandidateIdentity: string | null = null
  const outputValidations = new Map<string, FinalRenderTransportRevisionRecord>()
  const outputPublishIntents = new Map<string, FinalRenderTransportRevisionRecord>()

  for (const [index, file] of [...input.revisions].sort((a, b) => a.name.localeCompare(b.name)).entries()) {
    const match = /^(\d{8})-([0-9a-f]{64})\.json$/.exec(file.name)
    const bytes = Buffer.from(file.bytes)
    const sha256 = digest(bytes)
    if (!match || Number(match[1]) !== index + 1 || match[2] !== sha256
      || bytes.byteLength < 1 || bytes.byteLength > FINAL_RENDER_MAX_REVISION_BYTES) fail('revision filename or bytes are invalid')
    let value: FinalRenderTransportRevisionRecord
    try { value = JSON.parse(bytes.toString('utf8')) as FinalRenderTransportRevisionRecord } catch { fail('revision JSON is invalid') }
    if (value && typeof value === 'object' && !Array.isArray(value)
      && value.canonical_before_sha256 !== finalRenderCanonicalReceiptHash(logicalCanonical)) {
      const cancelled = cancellationOverlay(logicalCanonical, input.canonical)
      if (cancelled && value.canonical_before_sha256 === finalRenderCanonicalReceiptHash(cancelled)) {
        logicalCanonical = cancelled
        canonicalStates.push(cancelled)
      }
    }
    if (!exactKeys(value, REVISION_KEYS) || value.version !== 1 || value.sequence !== index + 1
      || value.previous_sha256 !== (index === 0 ? null : records[index - 1].sha256)
      || value.canonical_before_sha256 !== finalRenderCanonicalReceiptHash(logicalCanonical)
      || !Number.isFinite(Date.parse(value.recorded_at)) || !UUID.test(value.owner_token)
      || !Number.isSafeInteger(value.owner_epoch) || value.owner_epoch <= 0
      || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
      fail('revision chain fields are invalid')
    }
    if (value.event === 'owner_acquired') {
      if (!exactKeys(value.payload, ['lineage', 'previous_owner_epoch', 'owner_epoch'])
        || value.payload.previous_owner_epoch !== ownerEpoch || value.payload.owner_epoch !== ownerEpoch + 1
        || value.owner_epoch !== ownerEpoch + 1
        || JSON.stringify(value.payload.lineage) !== JSON.stringify({
          job_id: input.staged.job_id, intent_id: input.staged.intent_id,
          story_instance_id: input.staged.story_instance_id, story_attempt: input.staged.story_attempt,
          gateway_attempt_key: input.staged.gateway_attempt_key, packet_sha256: input.staged.packet_sha256,
          staging_manifest_sha256: input.staged.staging_manifest_sha256,
          submission_scope_sha256: input.staged.submission_scope_sha256,
          destination_fence_sha256: input.staged.destination_fence_sha256,
          source_generation_fence_sha256: input.staged.source_generation_fence_sha256,
          committed_at: input.staged.committed_at,
        })) fail('owner acquisition is invalid')
      ownerToken = value.owner_token
      ownerEpoch = value.owner_epoch
    } else if (value.owner_token !== ownerToken || value.owner_epoch !== ownerEpoch) {
      fail('revision owner fence is invalid')
    }

    if (logicalCanonical.phase === 'refused' && value.event !== 'owner_acquired') fail('refused lineage is terminal')

    if (value.event === 'blob_status_intent' || value.event === 'blob_put_intent') {
      const keys = value.event === 'blob_status_intent'
        ? ['hop_id', 'logical_id', 'safe_name', 'asset_sha256', 'size_bytes', 'offset', 'length', 'reconciles_hop_id']
        : ['hop_id', 'logical_id', 'safe_name', 'asset_sha256', 'size_bytes', 'offset', 'length', 'chunk_sha256']
      const stagedSource = manifestSources.get(value.payload.logical_id) as Record<string, any> | undefined
      if (!exactKeys(value.payload, keys) || !HANDLE.test(value.payload.hop_id)
        || typeof value.payload.logical_id !== 'string' || !value.payload.logical_id
        || typeof value.payload.safe_name !== 'string' || path.basename(value.payload.safe_name) !== value.payload.safe_name
        || !SHA256.test(value.payload.asset_sha256) || !Number.isSafeInteger(value.payload.size_bytes)
        || value.payload.size_bytes <= 0 || !Number.isSafeInteger(value.payload.offset) || value.payload.offset < 0
        || !Number.isSafeInteger(value.payload.length) || value.payload.length < 0 || !stagedSource
        || stagedSource.safe_name !== value.payload.safe_name || stagedSource.sha256 !== value.payload.asset_sha256
        || stagedSource.size_bytes !== value.payload.size_bytes
        || value.payload.offset + value.payload.length > value.payload.size_bytes || hops.has(value.payload.hop_id)) {
        fail('blob intent is invalid')
      }
      if (value.event === 'blob_put_intent'
        && (value.payload.length < 1 || value.payload.length > MAX_CHUNK_BYTES || !SHA256.test(value.payload.chunk_sha256))) {
        fail('blob PUT intent is invalid')
      }
      if (value.event === 'blob_put_intent' && repeatPut) {
        if (value.payload.logical_id !== repeatPut.payload.logical_id
          || value.payload.safe_name !== repeatPut.payload.safe_name
          || value.payload.asset_sha256 !== repeatPut.payload.asset_sha256
          || value.payload.size_bytes !== repeatPut.payload.size_bytes
          || value.payload.offset !== repeatPut.payload.offset
          || value.payload.length !== repeatPut.payload.length
          || value.payload.chunk_sha256 !== repeatPut.payload.chunk_sha256) {
          fail('uncertain PUT exact repeat is invalid')
        }
        repeatPut = null
      }
      if (value.event === 'blob_status_intent') {
        const linked = value.payload.reconciles_hop_id
        if (linked !== null) {
          const put = hops.get(linked)
          if (!put || put.event !== 'blob_put_intent' || observed.has(linked) || reconciledPuts.has(linked)
            || repeatPut !== null || value.owner_epoch <= put.owner_epoch || value.owner_token === put.owner_token
            || put.payload.logical_id !== value.payload.logical_id || put.payload.safe_name !== value.payload.safe_name
            || put.payload.asset_sha256 !== value.payload.asset_sha256 || put.payload.size_bytes !== value.payload.size_bytes
            || value.payload.offset !== put.payload.offset || value.payload.length !== 0) fail('PUT reconciliation link is invalid')
        }
      }
      hops.set(value.payload.hop_id, value)
      if (value.event === 'blob_put_intent') unresolvedPuts.add(value.payload.hop_id)
    } else if (value.event === 'blob_status_observed' || value.event === 'blob_put_observed') {
      if (!exactKeys(value.payload, ['hop_id', 'response'])) fail('blob observation is invalid')
      const intent = hops.get(value.payload.hop_id)
      const expectedEvent = value.event === 'blob_status_observed' ? 'blob_status_intent' : 'blob_put_intent'
      if (!intent || intent.event !== expectedEvent || observed.has(value.payload.hop_id)
        || intent.owner_token !== value.owner_token || intent.owner_epoch !== value.owner_epoch) fail('blob observation lineage is invalid')
      const expectedOffset = value.event === 'blob_put_observed'
        ? intent.payload.offset + intent.payload.length : undefined
      const response = validateFinalRenderBlobStatusEvidence(
        value.payload.response, intent.payload.asset_sha256, intent.payload.size_bytes, expectedOffset,
      )
      if (response.state === 'complete') {
        const blob = `${response.sha256}:${response.size_bytes}`
        const handle = response.asset_handle!
        if ((completeHandles.has(blob) && completeHandles.get(blob) !== handle)
          || (completeBlobs.has(handle) && completeBlobs.get(handle) !== blob)) {
          fail('complete blob handle binding is inconsistent')
        }
        completeHandles.set(blob, handle)
        completeBlobs.set(handle, blob)
      }
      observed.add(value.payload.hop_id)
      if (value.event === 'blob_put_observed') unresolvedPuts.delete(value.payload.hop_id)
      if (value.event === 'blob_status_observed' && intent.payload.reconciles_hop_id !== null) {
        const put = hops.get(intent.payload.reconciles_hop_id)!
        const start = put.payload.offset
        const end = start + put.payload.length
        if (response.offset !== start && response.offset !== end) fail('uncertain PUT offset is not exact')
        reconciledPuts.add(intent.payload.reconciles_hop_id)
        unresolvedPuts.delete(intent.payload.reconciles_hop_id)
        if (response.offset === start) repeatPut = put
      }
    } else if (value.event === 'output_download_prefix') {
      if (!exactKeys(value.payload, [
        'candidate', 'start', 'end_inclusive', 'total_bytes', 'etag', 'response_sha256',
        'prefix_length', 'prefix_sha256',
      ]) || logicalCanonical.version !== 3 || logicalCanonical.phase !== 'importing'
        || !Number.isSafeInteger(value.payload.start) || value.payload.start < 0
        || !Number.isSafeInteger(value.payload.end_inclusive) || value.payload.end_inclusive < value.payload.start
        || !Number.isSafeInteger(value.payload.total_bytes) || value.payload.total_bytes <= value.payload.end_inclusive
        || value.payload.start !== outputPrefixLength
        || value.payload.end_inclusive - value.payload.start + 1 > MAX_CHUNK_BYTES
        || (importOutputSize > 0 && value.payload.total_bytes !== importOutputSize)
        || value.payload.prefix_length !== value.payload.end_inclusive + 1
        || (value.payload.prefix_length === value.payload.total_bytes
          && value.payload.prefix_sha256 !== value.payload.response_sha256)
        || value.payload.etag !== `"${value.payload.response_sha256}"`
        || (importOutputSha256 !== null && value.payload.response_sha256 !== importOutputSha256)
        || !SHA256.test(value.payload.response_sha256) || !SHA256.test(value.payload.prefix_sha256)
        || !exactKeys(value.payload.candidate, ['pathname', 'dev', 'ino'])
        || typeof value.payload.candidate.pathname !== 'string'
        || !path.isAbsolute(value.payload.candidate.pathname)
        || (outputCandidate !== null && value.payload.candidate.pathname !== outputCandidate)
        || typeof value.payload.candidate.dev !== 'string' || typeof value.payload.candidate.ino !== 'string'
        || (outputCandidateIdentity !== null
          && `${value.payload.candidate.dev}:${value.payload.candidate.ino}` !== outputCandidateIdentity)) {
        fail('output download prefix evidence is invalid')
      }
      outputPrefixLength = value.payload.prefix_length
      outputCandidate = value.payload.candidate.pathname
      outputCandidateIdentity = `${value.payload.candidate.dev}:${value.payload.candidate.ino}`
    } else if (value.event === 'output_validation_observed') {
      const media = value.payload.media
      const loudness = value.payload.loudness
      const target = value.payload.target
      const recipe = manifest.packet?.recipe
      const canvas = recipe?.canvas
      const encode = recipe?.encode
      const expectedCodec = encode?.requested_codec === 'h265' ? 'hevc' : 'h264'
      const durationTolerance = Math.max(0.25, Number(recipe?.target_duration_sec) * 0.01)
      let classifiedContainer: 'mp4' | 'mov' | 'webm' | 'unknown' = 'unknown'
      try {
        classifiedContainer = classifyFinalRenderContainerEvidence({
          containerNames: media?.containerNames, containerBrand: media?.containerBrand,
        })
      } catch {
        fail('output validation container evidence is invalid')
      }
      if (!exactKeys(value.payload, [
        'candidate_sha256', 'size_bytes', 'candidate', 'media', 'loudness', 'target', 'verdict',
      ])
        || logicalCanonical.version !== 3 || logicalCanonical.phase !== 'importing'
        || value.payload.candidate_sha256 !== importOutputSha256
        || value.payload.size_bytes !== importOutputSize
        || outputPrefixLength !== importOutputSize
        || !SHA256.test(value.payload.candidate_sha256)
        || !Number.isSafeInteger(value.payload.size_bytes) || value.payload.size_bytes <= 0
        || !exactKeys(value.payload.candidate, ['pathname', 'dev', 'ino'])
        || value.payload.candidate.pathname !== outputCandidate
        || `${value.payload.candidate.dev}:${value.payload.candidate.ino}` !== outputCandidateIdentity
        || !exactKeys(media, [
          'durationSec', 'hasVideo', 'hasAudio', 'videoCodec', 'audioCodec', 'width', 'height',
          'frameRate', 'containerNames', 'containerBrand', 'container', 'loudness',
        ])
        || !Number.isFinite(media.durationSec) || media.durationSec <= 0
        || media.hasVideo !== true || media.hasAudio !== true
        || typeof media.videoCodec !== 'string' || !media.videoCodec
        || typeof media.audioCodec !== 'string' || !media.audioCodec
        || !Number.isSafeInteger(media.width) || media.width <= 0
        || !Number.isSafeInteger(media.height) || media.height <= 0
        || !Number.isFinite(media.frameRate) || media.frameRate <= 0
        || !Array.isArray(media.containerNames) || media.containerNames.length < 1 || media.containerNames.length > 16
        || media.containerNames.some((name: unknown) => typeof name !== 'string' || !name || name.length > 32)
        || (media.containerBrand !== null && (typeof media.containerBrand !== 'string'
          || media.containerBrand.length < 1 || media.containerBrand.length > 64))
        || !['mp4', 'mov', 'webm', 'unknown'].includes(media.container)
        || media.container !== classifiedContainer
        || media.container !== 'mp4' || media.videoCodec !== expectedCodec || media.audioCodec !== 'aac'
        || media.width !== canvas?.width || media.height !== canvas?.height
        || Math.abs(media.frameRate - Number(canvas?.working_fps)) > 0.01
        || Math.abs(media.durationSec - Number(recipe?.target_duration_sec)) > durationTolerance
        || !exactKeys(loudness, ['lufs', 'true_peak_db'])
        || !Number.isFinite(loudness.lufs) || !Number.isFinite(loudness.true_peak_db)
        || !isDeepStrictEqual(media.loudness, loudness)
        || !isDeepStrictEqual(target, manifest.loudness)
        || value.payload.verdict !== 'pass') fail('output validation evidence is invalid')
      if (target.check === 'block' && finalLoudnessIssue(
        { lufs: loudness.lufs, true_peak_db: loudness.true_peak_db },
        { lufs: target.lufs, true_peak_db: target.true_peak_db, tolerance_pct: target.tolerance_pct, check: target.check },
      )) fail('output validation contradicts its blocking loudness target')
      outputValidations.set(sha256, value)
    } else if (value.event === 'output_publish_intent') {
      const candidate = value.payload.candidate
      const expectedRecoveryPath = manifest.destination.recovery_root === null ? null : path.join(
        manifest.destination.recovery_root,
        'final-render-recovery', input.staged.intent_id, path.basename(manifest.destination.pathname),
      )
      if (!exactKeys(value.payload, [
        'candidate_sha256', 'size_bytes', 'candidate', 'destination', 'expected_state', 'recovery_path',
      ])
        || logicalCanonical.version !== 3 || logicalCanonical.phase !== 'importing'
        || value.payload.candidate_sha256 !== importOutputSha256
        || value.payload.size_bytes !== importOutputSize
        || !outputValidations.size
        || !SHA256.test(value.payload.candidate_sha256)
        || !Number.isSafeInteger(value.payload.size_bytes) || value.payload.size_bytes <= 0
        || !exactKeys(candidate, ['pathname', 'dev', 'ino', 'sha256', 'size_bytes'])
        || candidate.pathname !== outputCandidate
        || `${candidate.dev}:${candidate.ino}` !== outputCandidateIdentity
        || candidate.sha256 !== value.payload.candidate_sha256
        || candidate.size_bytes !== value.payload.size_bytes
        || value.payload.destination !== manifest.destination.pathname
        || !isDeepStrictEqual(value.payload.expected_state, manifest.destination.state)
        || (manifest.destination.state.kind === 'absent' && value.payload.recovery_path !== null)
        || (manifest.destination.state.kind === 'file'
          && (expectedRecoveryPath === null || value.payload.recovery_path !== expectedRecoveryPath))
      ) fail('output publication intent is invalid')
      outputPublishIntents.set(sha256, value)
    } else if (value.event === 'output_ack_intent') {
      if (!exactKeys(value.payload, [
        'gateway_job_id', 'body_sha256', 'body_utf8', 'receipt_digest', 'destination',
      ])
        || logicalCanonical.version !== 3 || logicalCanonical.phase !== 'imported'
        || value.payload.gateway_job_id !== logicalCanonical.gateway_job_id
        || value.payload.receipt_digest !== importReceiptSha256
        || !SHA256.test(value.payload.body_sha256) || !SHA256.test(value.payload.receipt_digest)
        || typeof value.payload.body_utf8 !== 'string'
        || digest(Buffer.from(value.payload.body_utf8, 'utf8')) !== value.payload.body_sha256
        || !Buffer.from(encodeFinalRenderAckBody(value.payload.receipt_digest))
          .equals(Buffer.from(value.payload.body_utf8, 'utf8'))
        || !exactKeys(value.payload.destination, ['pathname', 'sha256', 'size_bytes', 'dev', 'ino'])
        || value.payload.destination.pathname !== importDestinationPath
        || value.payload.destination.sha256 !== importOutputSha256
        || value.payload.destination.size_bytes !== importOutputSize
        || !importDestinationIdentity
        || value.payload.destination.dev !== importDestinationIdentity.dev
        || value.payload.destination.ino !== importDestinationIdentity.ino) {
        fail('output acknowledgement intent is invalid')
      }
      ackIntents.set(sha256, value)
    } else if (value.event === 'output_ack_unknown') {
      if (!exactKeys(value.payload, ['ack_intent_sha256', 'failure_class'])
        || typeof value.payload.ack_intent_sha256 !== 'string'
        || !ackIntents.has(value.payload.ack_intent_sha256)
        || consumedAckIntents.has(value.payload.ack_intent_sha256)
        || !['http', 'network', 'invalid-response'].includes(value.payload.failure_class)) {
        fail('output acknowledgement uncertainty is invalid')
      }
    } else if (value.event === 'output_ack_reconciled'
      && value.payload?.result === 'not_acknowledged') {
      if (!exactKeys(value.payload, ['ack_intent_sha256', 'result', 'response'])
        || typeof value.payload.ack_intent_sha256 !== 'string'
        || logicalCanonical.version !== 3 || logicalCanonical.phase !== 'imported') {
        fail('output acknowledgement retry reconciliation is invalid')
      }
      const intent = ackIntents.get(value.payload.ack_intent_sha256)
      if (!intent || consumedAckIntents.has(value.payload.ack_intent_sha256)) {
        fail('output acknowledgement retry reconciliation lineage is invalid')
      }
      const response = validateFinalRenderJobEvidence(value.payload.response, sealed.access, {
        id: logicalCanonical.gateway_job_id!, key: logicalCanonical.gateway_attempt_key,
        storyUuid: logicalCanonical.story_instance_id, intent: logicalCanonical.intent_id,
        attemptNo: logicalCanonical.story_attempt, inboundDigest: sealed.requestDigest,
        packetDigest: logicalCanonical.packet_sha256, acceptance: false,
      })
      if (response.state !== 'output_ready' || !response.output_ready || !response.output
        || !pinnedOutput || !samePinnedOutput(pinnedOutput, response)) {
        fail('output acknowledgement retry reconciliation response is invalid')
      }
      consumedAckIntents.add(value.payload.ack_intent_sha256)
    } else if (value.event === 'monitor_cancel_intent') {
      if (!exactKeys(value.payload, ['gateway_attempt_key', 'request_body_sha256', 'cancel_requested_at'])
        || logicalCanonical.version !== 3 || logicalCanonical.cancel_requested_at === null
        || value.payload.gateway_attempt_key !== logicalCanonical.gateway_attempt_key
        || value.payload.request_body_sha256 !== logicalCanonical.request_body_sha256
        || value.payload.cancel_requested_at !== logicalCanonical.cancel_requested_at) {
        fail('monitor cancellation intent is invalid')
      }
      cancelIntents.set(sha256, value)
    } else if (value.event === 'monitor_cancel_observed' || value.event === 'monitor_cancel_unknown') {
      const observedCancel = value.event === 'monitor_cancel_observed'
      const keys = observedCancel
        ? ['cancel_intent_sha256', 'response']
        : ['cancel_intent_sha256', 'failure_class']
      const cancelIntentSha256 = exactKeys(value.payload, keys)
        && typeof value.payload.cancel_intent_sha256 === 'string'
        ? value.payload.cancel_intent_sha256
        : null
      if (!cancelIntentSha256) fail('monitor cancellation outcome lineage is invalid')
      const intent = cancelIntents.get(cancelIntentSha256)
      if (!intent || intent.owner_token !== value.owner_token || intent.owner_epoch !== value.owner_epoch
        || logicalCanonical.version !== 3 || consumedCancelIntents.has(cancelIntentSha256)) {
        fail('monitor cancellation outcome lineage is invalid')
      }
      if (observedCancel) {
        validateFinalRenderCancelEvidence(value.payload.response, {
          key: logicalCanonical.gateway_attempt_key,
          digest: logicalCanonical.request_body_sha256,
          id: logicalCanonical.gateway_job_id ?? undefined,
        })
      } else if (!['http', 'network', 'invalid-response'].includes(value.payload.failure_class)) {
        fail('monitor cancellation failure class is invalid')
      }
      consumedCancelIntents.add(cancelIntentSha256)
    } else if (value.event !== 'owner_acquired') {
      const refused = value.event === 'post_refused' || value.event === 'lookup_refused'
      const accepted = value.event === 'post_accepted' || value.event === 'lookup_accepted'
      const monitorOutput = value.event === 'monitor_output_ready'
      const monitorHold = value.event === 'monitor_recovery_hold'
      const monitorCancelTerminal = value.event === 'monitor_cancel_terminal'
      const importIntent = value.event === 'output_import_intent'
      const imported = value.event === 'output_imported'
      const ackObserved = value.event === 'output_ack_observed'
      const ackReconciled = value.event === 'output_ack_reconciled'
      const keys = value.event === 'request_sealed' || value.event === 'send_may_start' ? ['after']
        : refused ? ['after', 'status', 'code']
          : accepted ? ['after', 'response']
          : value.event === 'post_unknown' ? ['after', 'failure_class']
            : value.event === 'lookup_not_found' ? ['after', 'status']
              : monitorOutput ? ['after', 'response']
                : monitorHold && Object.hasOwn(value.payload, 'status') ? ['after', 'reason', 'status']
                  : monitorHold ? ['after', 'reason', 'response']
                    : monitorCancelTerminal ? ['cancel_intent_sha256', 'response', 'after']
                      : importIntent ? ['after', 'response', 'receipt_utf8', 'receipt_sha256', 'output_sha256', 'output_size_bytes', 'destination']
                        : imported ? [
                            'after', 'destination', 'destination_identity',
                            'publish_intent_sha256', 'validation_sha256',
                          ]
                          : ackObserved ? ['after', 'ack_intent_sha256', 'response']
                            : ackReconciled ? ['after', 'ack_intent_sha256', 'result', 'response'] : []
      if (keys.length === 0 || !exactKeys(value.payload, keys)) fail('canonical event is invalid')
      const after = parseAfter(value, sha256, input.staged.job_id)
      if (!validTransition(logicalCanonical, after)) fail('canonical transition is invalid')
      if (value.event === 'request_sealed') {
        if (repeatPut || unresolvedPuts.size > 0) fail('request is sealed while a PUT outcome remains unresolved')
        if (sealed.sources.some(source => (
          completeHandles.get(`${source.assetSha256}:${source.sizeBytes}`) !== source.handle
        ))) fail('sealed source handle lacks exact complete blob proof')
      }
      if (value.event === 'post_accepted' && logicalCanonical.version === 3
        && logicalCanonical.phase !== 'send_may_start') fail('POST acceptance is not valid from this phase')
      const expectedEvent = monitorOutput || monitorHold || monitorCancelTerminal
        || importIntent || imported || ackObserved || ackReconciled
        ? value.event
        : logicalCanonical.version === 2 ? 'request_sealed'
          : after.phase === 'send_may_start' ? 'send_may_start'
            : after.phase === 'send_unknown' ? 'post_unknown'
              : after.phase === 'lookup_not_found' ? 'lookup_not_found'
                : after.phase === 'refused' ? (logicalCanonical.phase === 'send_may_start' ? 'post_refused' : 'lookup_refused')
                  : value.event
      if (value.event !== expectedEvent) fail('canonical transition event does not match')
      if (refused) {
        if (logicalCanonical.version !== 3 || logicalCanonical.gateway_job_id !== null
          || logicalCanonical.cancel_requested_at !== null || after.phase !== 'refused') fail('refusal lineage is invalid')
        if (value.event === 'post_refused') {
          if (logicalCanonical.phase !== 'send_may_start'
            || !isDefiniteFinalRenderRefusal(value.payload.status, value.payload.code)) fail('POST refusal proof is invalid')
        } else if (logicalCanonical.phase !== 'lookup_not_found' || !postUnknown || !firstAbsent
          || postUnknown.payload.failure_class !== 'http'
          || value.payload.status !== 404 || value.payload.code !== 'RENDER_NOT_FOUND'
          || Date.parse(firstAbsent.recorded_at) < Date.parse(postUnknown.recorded_at)
          || Date.parse(value.recorded_at) - Date.parse(firstAbsent.recorded_at) < FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS) {
          fail('lookup refusal proof is invalid')
        }
      } else if (accepted) {
        validateFinalRenderJobEvidence(value.payload.response, sealed.access, {
          key: after.gateway_attempt_key, storyUuid: after.story_instance_id, intent: after.intent_id,
          attemptNo: after.story_attempt, inboundDigest: sealed.requestDigest,
          packetDigest: after.packet_sha256, acceptance: value.event === 'post_accepted',
        })
        if (value.payload.response.id !== after.gateway_job_id) fail('Gateway job id does not match canonical')
      } else if (value.event === 'post_unknown') {
        if (value.payload.failure_class !== 'http' && value.payload.failure_class !== 'network') {
          fail('unknown POST failure class is invalid')
        }
        postUnknown = value
      } else if (value.event === 'lookup_not_found') {
        if (value.payload.status !== 404) fail('lookup absence status is invalid')
        firstAbsent ??= value
      } else if (importIntent) {
        const response = validateFinalRenderJobEvidence(value.payload.response, sealed.access, {
          id: after.gateway_job_id ?? undefined, key: after.gateway_attempt_key,
          storyUuid: after.story_instance_id, intent: after.intent_id, attemptNo: after.story_attempt,
          inboundDigest: sealed.requestDigest, packetDigest: after.packet_sha256, acceptance: false,
        })
        if (logicalCanonical.version !== 3 || logicalCanonical.phase !== 'output_ready'
          || after.phase !== 'importing' || response.state !== 'output_ready' || !response.output
          || value.payload.receipt_utf8 !== response.output.receipt_utf8
          || value.payload.receipt_sha256 !== response.output.receipt_digest
          || value.payload.output_sha256 !== response.output.sha256
          || value.payload.output_size_bytes !== response.output.size_bytes
          || typeof value.payload.destination !== 'string') fail('output import intent is invalid')
        if (pinnedOutput && !samePinnedOutput(pinnedOutput, response)) {
          fail('output import intent changed its pinned monitor output')
        }
        pinnedOutput = structuredClone(response)
        importOutputSha256 = response.output.sha256
        importOutputSize = response.output.size_bytes
        importReceiptSha256 = response.output.receipt_digest
      } else if (imported) {
        const publishIntent = outputPublishIntents.get(value.payload.publish_intent_sha256)
        const validation = outputValidations.get(value.payload.validation_sha256)
        if (logicalCanonical.version !== 3 || logicalCanonical.phase !== 'importing'
          || after.phase !== 'imported'
          || !publishIntent || !validation
          || !exactKeys(value.payload.destination, ['pathname', 'sha256', 'size_bytes'])
          || !exactKeys(value.payload.destination_identity, ['dev', 'ino'])
          || typeof value.payload.destination_identity.dev !== 'string'
          || typeof value.payload.destination_identity.ino !== 'string'
          || typeof value.payload.destination.pathname !== 'string'
          || value.payload.destination.pathname !== manifest.destination.pathname
          || value.payload.destination.pathname !== publishIntent.payload.destination
          || !SHA256.test(value.payload.destination.sha256)
          || value.payload.destination.sha256 !== importOutputSha256
          || value.payload.destination.sha256 !== publishIntent.payload.candidate_sha256
          || value.payload.destination.sha256 !== validation.payload.candidate_sha256
          || value.payload.destination.size_bytes !== importOutputSize
          || value.payload.destination.size_bytes !== publishIntent.payload.size_bytes
          || value.payload.destination.size_bytes !== validation.payload.size_bytes
          || value.payload.destination_identity.dev !== publishIntent.payload.candidate.dev
          || value.payload.destination_identity.ino !== publishIntent.payload.candidate.ino
          || !Number.isSafeInteger(value.payload.destination.size_bytes)
          || value.payload.destination.size_bytes <= 0) fail('output imported evidence is invalid')
        importDestinationPath = value.payload.destination.pathname
        importDestinationIdentity = {
          dev: value.payload.destination_identity.dev,
          ino: value.payload.destination_identity.ino,
        }
      } else if (ackObserved || ackReconciled) {
        const intentSha256 = typeof value.payload.ack_intent_sha256 === 'string'
          ? value.payload.ack_intent_sha256 : ''
        const intent = ackIntents.get(intentSha256)
        if (!intent || consumedAckIntents.has(intentSha256)
          || logicalCanonical.version !== 3 || logicalCanonical.phase !== 'imported'
          || after.phase !== 'acknowledged') fail('output acknowledgement outcome lineage is invalid')
        if (ackObserved) {
          validateFinalRenderAckEvidence(
            value.payload.response, logicalCanonical.gateway_job_id!, intent.payload.receipt_digest,
          )
        } else {
          const response = validateFinalRenderJobEvidence(value.payload.response, sealed.access, {
            id: logicalCanonical.gateway_job_id!, key: logicalCanonical.gateway_attempt_key,
            storyUuid: logicalCanonical.story_instance_id, intent: logicalCanonical.intent_id,
            attemptNo: logicalCanonical.story_attempt, inboundDigest: sealed.requestDigest,
            packetDigest: logicalCanonical.packet_sha256, acceptance: false,
          })
          if (value.payload.result !== 'acknowledged' || response.state !== 'acknowledged'
            || !pinnedOutput || !samePinnedOutput(pinnedOutput, response)) {
            fail('output acknowledgement reconciliation is invalid')
          }
        }
        consumedAckIntents.add(intentSha256)
      } else if (monitorOutput || (monitorHold && Object.hasOwn(value.payload, 'response'))) {
        const response = validateFinalRenderJobEvidence(value.payload.response, sealed.access, {
          id: logicalCanonical.version === 3 ? logicalCanonical.gateway_job_id ?? undefined : undefined,
          key: after.gateway_attempt_key, storyUuid: after.story_instance_id, intent: after.intent_id,
          attemptNo: after.story_attempt, inboundDigest: sealed.requestDigest,
          packetDigest: after.packet_sha256, acceptance: false,
        })
        if (monitorOutput && (after.phase !== 'output_ready' || response.state !== 'output_ready'
          || response.output_ready !== true || !response.output)) fail('monitor output-ready evidence is invalid')
        if (monitorOutput && response.output) {
          if (pinnedOutput && !samePinnedOutput(pinnedOutput, response)) {
            fail('monitor output-ready evidence changed its pinned output')
          }
          pinnedOutput = structuredClone(response)
          importOutputSha256 = response.output.sha256
          importOutputSize = response.output.size_bytes
          importReceiptSha256 = response.output.receipt_digest
        }
        if (monitorHold) {
          const validReason = (value.payload.reason === 'remote_failed' && response.remote_state === 'failed')
            || (value.payload.reason === 'remote_cancelled' && response.remote_state === 'cancelled'
              && response.terminal_proof?.kind === 'launched_stopped')
            || (value.payload.reason === 'acknowledged_without_story_import' && response.state === 'acknowledged')
          if (after.phase !== 'recovery_hold' || !validReason) fail('monitor recovery hold evidence is invalid')
        }
      } else if (monitorHold) {
        if (after.phase !== 'recovery_hold' || value.payload.reason !== 'bound_key_not_found'
          || value.payload.status !== 404 || logicalCanonical.version !== 3
          || logicalCanonical.gateway_job_id === null) fail('monitor bound-key hold is invalid')
      } else if (monitorCancelTerminal) {
        const cancelIntentSha256 = typeof value.payload.cancel_intent_sha256 === 'string'
          ? value.payload.cancel_intent_sha256
          : null
        if (!cancelIntentSha256) fail('monitor terminal cancellation lineage is invalid')
        const intent = cancelIntents.get(cancelIntentSha256)
        if (!intent
          || intent.owner_token !== value.owner_token
          || intent.owner_epoch !== value.owner_epoch
          || consumedCancelIntents.has(cancelIntentSha256)
          || logicalCanonical.version !== 3 || logicalCanonical.gateway_job_id !== null
          || after.phase !== 'recovery_hold') fail('monitor terminal cancellation lineage is invalid')
        const response = validateFinalRenderCancelEvidence(value.payload.response, {
          key: logicalCanonical.gateway_attempt_key,
          digest: logicalCanonical.request_body_sha256,
        })
        if (response.state !== 'cancelled_before_acceptance'
          || response.gateway_job_id !== undefined
          || response.terminal_proof?.kind !== 'never_launched') fail('monitor terminal cancellation evidence is invalid')
        consumedCancelIntents.add(cancelIntentSha256)
      }
      logicalCanonical = after
      canonicalStates.push(after)
    }
    if (unresolvedPuts.size > 1 || (repeatPut && unresolvedPuts.size > 0)) {
      fail('revision prefix has more than one outstanding PUT obligation')
    }
    records.push({ value, bytes, sha256 })
  }

  const canonicalKnown = canonicalStates.some(candidate => sameReceipt(candidate, input.canonical)
    || cancellationBase(candidate, input.canonical))
  if (!canonicalKnown) fail('canonical receipt is not rooted in the revision chain')
  const canonicalRevision = input.canonical.version === 3
    ? input.canonical.transport_revision_sha256 : null
  if (canonicalRevision && !records.some(record => record.sha256 === canonicalRevision)) {
    fail('canonical referenced revision is missing')
  }
  if (input.expectedOwner
    && (ownerToken !== input.expectedOwner.token || ownerEpoch !== input.expectedOwner.epoch)) {
    fail('current owner does not match the reopened chain')
  }
  if (unresolvedPuts.size > 1 || (repeatPut && unresolvedPuts.size > 0)) {
    fail('more than one PUT obligation remains unresolved')
  }
  const unresolvedHop = unresolvedPuts.values().next().value
  return {
    records, ownerToken, ownerEpoch,
    unresolvedPut: unresolvedHop === undefined ? null : hops.get(unresolvedHop)!, repeatPut,
    importOutput: importOutputSha256 === null || importReceiptSha256 === null
      ? null
      : {
          sha256: importOutputSha256, sizeBytes: importOutputSize,
          receiptSha256: importReceiptSha256, destinationPath: importDestinationPath,
          candidatePath: outputCandidate,
        },
  }
}
