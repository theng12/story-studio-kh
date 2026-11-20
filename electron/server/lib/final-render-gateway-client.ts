import { createHash } from 'node:crypto'
import { createIdleAbort } from './idle-abort.js'
import { validateRenderPacketSyntax } from './final-render-recipe.js'
import { canonicalRenderValue } from './render-hash-v1.js'
import { decodeStrictJson as decodeJsonSyntax, StrictJsonError } from './final-render-strict-json.js'
import { parseQualificationProvenance, RenderProvenanceError, type QualificationProvenance } from './final-render-provenance-contract.js'
import {
  pinGatewayBinding,
  repairGatewayBinding,
  readPrivateRenderAccess,
  readPrivateRenderConnection,
  type PrivateRenderAccess,
  type PrivateRenderConnection,
} from '../services/private-render-identity.js'

interface DescriptorText {
  descriptor_utf8: string
  digest: string
}

export interface FinalRenderEncodeEntry {
  container: 'mp4' | 'mov' | 'webm'
  requested_codec: 'h264' | 'h265'
  requested_effort: 'ultrafast' | 'medium' | 'slow' | 'hardware'
  crf: number
  quality_cpu_preset: 'ultrafast' | 'medium' | 'slow'
  bitrate_kbps: number | null
}

export interface FinalRenderLateLabelsCapability {
  format: 'studio.render.late-label.v3'
  motions: Array<'none' | 'pop' | 'slide' | 'float' | 'pulse' | 'wipe' | 'line-draw'>
}

export interface FinalRenderSubtitlesCapability {
  format: 'studio.render.subtitle.v1'
}

export interface FinalRenderEncodeAuthority {
  format: 'studio.render.encode-authority.v1'
  entries: FinalRenderEncodeEntry[]
}

interface FinalRenderBoundsCommon {
  working_fps: number[]
  max_duration_sec: number
  max_operations: number
  max_assets: number
  max_asset_bytes: number
  max_total_input_bytes: number
  max_pixel_frames: number
  scratch_reserve_bytes: number
  output_limit_bytes: number
  process_tree_rss_limit_bytes: number
  cumulative_wall_seconds: number
}

/** No `bounds_version`: the Gateway publishes an open canvas-pair list (v1). */
export interface FinalRenderBoundsV1 extends FinalRenderBoundsCommon {
  canvas_pairs: Array<{ width: number; height: number }>
}

/** `bounds_version: 2`: an even canvas anywhere inside a published range, instead of named pairs. */
export interface FinalRenderBoundsV2 extends FinalRenderBoundsCommon {
  bounds_version: 2
  canvas_range: { max_edge: number; max_pixels: number }
}

/** The v4 subtitle profile adds these three required counters; base v1/v2/v3 never carry them. */
export interface FinalRenderSubtitleBounds {
  max_subtitle_ass_bytes: number
  max_subtitle_font_bytes: number
  max_subtitle_fonts: number
}

export type FinalRenderExecutionBounds =
  | FinalRenderBoundsV1
  | FinalRenderBoundsV2
  | (FinalRenderBoundsV2 & FinalRenderSubtitleBounds)

export interface FinalRenderCapabilities {
  format: 'studio.render.gateway-capabilities.v1'
  private: true
  chargeable: false
  owner_scope: string
  gateway_instance_id: string
  story_instance_id: string
  eligible: number
  idle: number
  server_time: number
  profile_descriptor_utf8: string
  profile_digest: string
  tools: DescriptorText
  compiler: DescriptorText
  qualification_provenance?: QualificationProvenance | null
  encode?: FinalRenderEncodeAuthority | null
  /** The Gateway's echo of the exact tuple Story asked about. Absent when the Gateway did not answer a scoped query. */
  requested_encode?: FinalRenderEncodeEntry
  /** Present only in a late-label-scoped response that requested this exact contract. */
  late_labels?: FinalRenderLateLabelsCapability
  /**
   * Present only in a subtitle-scoped response that requested this exact contract.
   * Admitted only against the frozen v4 descriptor triple (profile `studio.render.profile.v4`
   * with implementation `story-classic-subtitle-v1`, compiler `hub-final-render-subtitle-v1`,
   * and the profile's three subtitle execution counters); any other descriptor pair is refused
   * at parse, so a capability flag alone never grants subtitle authority. Descriptor digests
   * and dependency links are checked here; installed pins and execution authority are checked
   * separately by the prepare path.
   */
  subtitles?: FinalRenderSubtitlesCapability
  execution_bounds?: FinalRenderExecutionBounds
}

/**
 * Revision-4 output-settings negotiation (`studio.render.output-settings-capabilities.v1`).
 * `supported` is protocol support only — never workload admission, and never by itself a
 * reason to offer Best.
 */
export interface FinalRenderOutputSettingsCapabilities {
  supported: boolean
  reason: string | null
  profile_descriptor_utf8: string | null
  profile_digest: string | null
}

export interface FinalRenderOutputReceipt {
  format: 'studio.render.gateway-output-receipt.v1'
  owner_scope: string
  gateway_instance_id: string
  story_instance_id: string
  gateway_job_id: string
  gateway_attempt_key: string
  story_uuid: string
  intent_id: string
  attempt_no: number
  inbound_story_body_sha256: string
  packet_digest: string
  outbound_hub_body_sha256: string
  hub_dispatch_key: string
  dispatch_fence: string
  hub_owner_scope: string
  hub_job_id: string
  hub_attempt_id: string
  hub_receipt_digest: string
  selected_machine: {
    id: string
    label: string
    chip: string
    memory_gb: number
    hardware_class: string
  }
  profile_digest: string
  tools_digest: string
  compiler_digest: string
  qualification_digest: string
  selected_tier: string
  generated_command_digest: string
  feature_losses: string[]
  output_sha256: string
  output_size_bytes: number
}

export type FinalRenderTerminalProof =
  | {
      format: 'studio.render.gateway-terminal-proof.v1'
      kind: 'launched_stopped'
      gateway_job_id: string
      gateway_attempt_key: string
      hub_job_id: string
      hub_attempt_id: string
      stopped_evidence_digest: string
    }
  | {
      format: 'studio.render.gateway-terminal-proof.v1'
      kind: 'never_launched'
      gateway_attempt_key: string
      inbound_story_body_sha256: string
      fence_receipt: string
      first_cancel_at: number
    }

export interface FinalRenderJobView {
  format: 'studio.render.gateway-job.v1'
  id: string
  state: 'staging' | 'hub_prepared' | 'send_may_start' | 'send_unknown' | 'accepted' | 'output_ready' | 'acknowledged'
  gateway_attempt_key: string
  story_uuid: string
  intent_id: string
  attempt_no: number
  output_ready: boolean
  idempotent_replay: boolean
  cancel_state?: 'requested' | 'cancelled'
  remote_state?: 'accepted' | 'launch_pending' | 'rendering' | 'cancel_requested' | 'uncertain' | 'stopped' | 'cancelled' | 'failed' | 'output_ready'
  receipt_digest?: string
  output?: {
    sha256: string
    size_bytes: number
    receipt_digest: string
    receipt_utf8: string
  }
  destination_node?: string
  inbound_story_body_sha256?: string
  terminal_proof?: FinalRenderTerminalProof
}

export interface FinalRenderBlobStatus {
  format: 'studio.render.gateway-blob.v1'
  sha256: string
  size_bytes: number
  state: 'missing' | 'uploading' | 'complete'
  offset: number
  upload_id?: string
  asset_handle?: string
}

export interface FinalRenderCancelView {
  format: 'studio.render.gateway-cancel.v1'
  state: 'cancel_requested' | 'cancelled_before_acceptance'
  gateway_attempt_key: string
  expected_request_sha256: string
  gateway_job_id?: string
  fence_receipt?: string
  first_cancel_at?: number
  terminal_proof?: FinalRenderTerminalProof
}

export interface FinalRenderOutputChunk {
  bytes: Uint8Array
  start: number
  end_inclusive: number
  total_bytes: number
  etag: string
  sha256: string
}

export interface FinalRenderAckView {
  format: 'studio.render.gateway-ack.v1'
  id: string
  acknowledged: true
  receipt_digest: string
}

const SHA256 = /^[0-9a-f]{64}$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_INTENT = /^[a-z][a-z0-9_-]{0,127}$/
const ASSET_HANDLE = /^[0-9a-f]{32}$/
const UPLOAD_ID = /^[0-9a-f]{32}$/
const HUB_OWNER_SCOPE = /^[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}:fleet$/
const MAX_JSON_BYTES = 1024 * 1024
/** The Hub's own bound on a display label (`render_jobs._DISPLAY_MAX_CHARACTERS`). */
const DISPLAY_MAX_CHARACTERS = 256
const DISPLAY_KEYS = ['channel', 'episode'] as const
const MAX_CHUNK_BYTES = 8 * 1024 * 1024
const JOB_STATES = new Set(['staging', 'hub_prepared', 'send_may_start', 'send_unknown', 'accepted', 'output_ready', 'acknowledged'])
const REMOTE_STATES = new Set(['accepted', 'launch_pending', 'rendering', 'cancel_requested', 'uncertain', 'stopped', 'cancelled', 'failed', 'output_ready'])
const CANCEL_STATES = new Set(['requested', 'cancelled'])

export class FinalRenderResponseValidationError extends Error {
  constructor(message: string) {
    super(`Invalid private final render ${message}`)
    this.name = 'FinalRenderResponseValidationError'
  }
}

function invalid(message: string): never {
  throw new FinalRenderResponseValidationError(message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = record(value, label)
  const accepted = new Set([...required, ...optional])
  const actual = Object.keys(result)
  if (required.some(key => !Object.hasOwn(result, key)) || actual.some(key => !accepted.has(key))) {
    invalid(`${label} must have the exact closed fields`)
  }
  return result
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  return closedRecord(value, keys, [], label)
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} SHA-256 digest is invalid`)
  return value
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) invalid(`${label} UUID is invalid`)
  return value
}

function gatewayJobId(value: string): string {
  return uuid(value, 'Gateway job')
}

function idempotencyKey(value: unknown, label = 'idempotency key'): string {
  if (typeof value !== 'string' || !SAFE_KEY.test(value)) invalid(`${label} is invalid`)
  return value
}

function intentId(value: unknown, label = 'intent_id'): string {
  if (typeof value !== 'string' || !SAFE_INTENT.test(value)) invalid(`${label} is invalid`)
  return value
}

function boundedText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value !== value.trim() || value.includes('\0')) {
    invalid(`${label} text is invalid`)
  }
  return value
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${label} must be a positive safe integer`)
  return value as number
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a nonnegative safe integer`)
  return value as number
}

function positiveFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid(`${label} must be a positive finite number`)
  return value
}

function nonnegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid(`${label} must be a nonnegative finite number`)
  return value
}

function digestBytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function decodeStrictJson(value: string | Uint8Array, label: string): unknown {
  let parsed: unknown
  try { parsed = decodeJsonSyntax(value, label) } catch (error) {
    if (error instanceof StrictJsonError) invalid(error.message)
    throw error
  }
  canonicalRenderValue(parsed)
  return parsed
}

function parseJsonText(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') invalid(`${label} bytes are invalid`)
  return record(decodeStrictJson(value, label), label)
}

function parseDescriptorLink(value: unknown, label: string): DescriptorText {
  const link = exactRecord(value, ['descriptor_utf8', 'digest'], label)
  const descriptorUtf8 = typeof link.descriptor_utf8 === 'string'
    ? link.descriptor_utf8
    : invalid(`${label}.descriptor_utf8 is invalid`)
  const digest = sha256(link.digest, `${label}.digest`)
  if (digestBytes(descriptorUtf8) !== digest) invalid(`${label} byte digest does not match`)
  return { descriptor_utf8: descriptorUtf8, digest }
}

function parseToolsDescriptor(raw: string): void {
  const tools = exactRecord(parseJsonText(raw, 'tools descriptor'), [
    'format', 'platform', 'ffmpeg_sha256', 'ffmpeg_size_bytes',
    'ffprobe_sha256', 'ffprobe_size_bytes', 'architecture_evidence_sha256',
    'minimum_os_evidence_sha256', 'linked_libraries_evidence_sha256',
    'build_configuration_evidence_sha256', 'capability_inventory_evidence_sha256',
  ], 'tools descriptor')
  if (tools.format !== 'studio.render.tools.v1' || tools.platform !== 'macos-arm64') {
    invalid('tools descriptor implementation is unsupported')
  }
  for (const key of [
    'ffmpeg_sha256', 'ffprobe_sha256', 'architecture_evidence_sha256',
    'minimum_os_evidence_sha256', 'linked_libraries_evidence_sha256',
    'build_configuration_evidence_sha256', 'capability_inventory_evidence_sha256',
  ]) sha256(tools[key], `tools descriptor.${key}`)
  positiveSafeInteger(tools.ffmpeg_size_bytes, 'tools descriptor.ffmpeg_size_bytes')
  positiveSafeInteger(tools.ffprobe_size_bytes, 'tools descriptor.ffprobe_size_bytes')
}

function parseCompilerDescriptor(raw: string, requestedLateLabels = false, requestedSubtitles = false): void {
  const compiler = exactRecord(parseJsonText(raw, 'compiler descriptor'), [
    'format', 'implementation', 'python_runtime_sha256', 'render_hash_sha256',
    'render_contract_sha256', 'final_render_compiler_sha256',
  ], 'compiler descriptor')
  const implementation = requestedSubtitles
    ? 'hub-final-render-subtitle-v1'
    : requestedLateLabels ? 'hub-final-render-late-label-v3' : 'hub-final-render-v1'
  if (compiler.format !== 'studio.render.compiler.v1' || compiler.implementation !== implementation) {
    invalid('compiler descriptor implementation is unsupported')
  }
  for (const key of [
    'python_runtime_sha256', 'render_hash_sha256', 'render_contract_sha256',
    'final_render_compiler_sha256',
  ]) sha256(compiler[key], `compiler descriptor.${key}`)
}

function parseProfileDescriptor(raw: string, toolsDigest: string, compilerDigest: string, requestedLateLabels = false, requestedSubtitles = false): FinalRenderExecutionBounds {
  const profile = exactRecord(parseJsonText(raw, 'profile descriptor'), [
    'format', 'implementation', 'recipe_namespace', 'compiler_artifact_sha256',
    'tools_artifact_sha256', 'combination_set', 'tier_policy', 'output_policy',
    'execution_bounds', 'hardware_qualification_record_sha256',
    'fidelity_record_sha256', 'production_eligible',
  ], 'profile descriptor')
  const literals: Record<string, string> = requestedSubtitles ? {
    format: 'studio.render.profile.v4',
    implementation: 'story-classic-subtitle-v1',
    recipe_namespace: 'studio.render.final.v1',
    combination_set: 'retained-classic-subtitle-candidate-v1',
    tier_policy: 'story-final-chain-v1',
    output_policy: 'story-final-output-v1',
  } : requestedLateLabels ? {
    format: 'studio.render.profile.v3',
    implementation: 'story-classic-late-label-v3',
    recipe_namespace: 'studio.render.final.v1',
    combination_set: 'retained-classic-late-label-candidate-v3',
    tier_policy: 'story-final-chain-v1',
    output_policy: 'story-final-output-v1',
  } : {
    format: 'studio.render.profile.v1',
    implementation: 'story-classic-no-font-v1',
    recipe_namespace: 'studio.render.final.v1',
    combination_set: 'retained-classic-no-font-candidate-v1',
    tier_policy: 'story-final-chain-v1',
    output_policy: 'story-final-output-v1',
  }
  for (const [key, expected] of Object.entries(literals)) {
    if (profile[key] !== expected) invalid(`profile descriptor.${key} is unsupported`)
  }
  if (sha256(profile.tools_artifact_sha256, 'profile descriptor.tools_artifact_sha256') !== toolsDigest
      || sha256(profile.compiler_artifact_sha256, 'profile descriptor.compiler_artifact_sha256') !== compilerDigest) {
    invalid('profile descriptor dependencies do not match supplied descriptors')
  }
  for (const key of ['hardware_qualification_record_sha256', 'fidelity_record_sha256']) {
    if (profile[key] !== null) sha256(profile[key], `profile descriptor.${key}`)
  }
  if (profile.production_eligible !== false) invalid('profile descriptor.production_eligible is unsupported')
  return parseExecutionBounds(profile.execution_bounds, requestedSubtitles)
}

const BOUNDS_COUNTERS = [
  'max_operations', 'max_assets', 'max_asset_bytes', 'max_total_input_bytes',
  'max_pixel_frames', 'scratch_reserve_bytes', 'output_limit_bytes',
  'process_tree_rss_limit_bytes', 'cumulative_wall_seconds',
] as const

/**
 * The Gateway states which canvas rule it enforces through `bounds_version`. An absent version is the
 * v1 pair list; version 2 replaces it with an even canvas inside a published range. A version this
 * build does not know is refused rather than read as one of them. The three subtitle counters are
 * required by the v4 subtitle profile and forbidden everywhere else, so a base/v3 profile cannot
 * smuggle them in and a v4 profile cannot omit them.
 */
const SUBTITLE_BOUNDS_KEYS = ['max_subtitle_ass_bytes', 'max_subtitle_font_bytes', 'max_subtitle_fonts'] as const

function parseExecutionBounds(value: unknown, requestedSubtitles = false): FinalRenderExecutionBounds {
  const label = 'profile descriptor.execution_bounds'
  const candidate = record(value, label)
  const bounds = exactRecord(candidate, [
    ...(Object.hasOwn(candidate, 'bounds_version')
      ? ['bounds_version', 'canvas_range']
      : ['canvas_pairs']),
    'working_fps', 'max_duration_sec', ...BOUNDS_COUNTERS,
    ...(requestedSubtitles ? SUBTITLE_BOUNDS_KEYS : []),
  ], label)
  if (Object.hasOwn(candidate, 'bounds_version')) {
    if (bounds.bounds_version !== 2) {
      invalid(`profile descriptor.execution_bounds.bounds_version `
        + `${JSON.stringify(bounds.bounds_version)} is unsupported`)
    }
    const range = exactRecord(bounds.canvas_range, ['max_edge', 'max_pixels'], `${label}.canvas_range`)
    positiveSafeInteger(range.max_edge, `${label}.canvas_range.max_edge`)
    positiveSafeInteger(range.max_pixels, `${label}.canvas_range.max_pixels`)
  } else {
    if (!Array.isArray(bounds.canvas_pairs) || bounds.canvas_pairs.length < 1) {
      invalid(`${label}.canvas_pairs is invalid`)
    }
    for (const [index, pairValue] of bounds.canvas_pairs.entries()) {
      const pair = exactRecord(pairValue, ['width', 'height'], `${label}.canvas_pairs[${index}]`)
      positiveSafeInteger(pair.width, `${label}.canvas_pairs[${index}].width`)
      positiveSafeInteger(pair.height, `${label}.canvas_pairs[${index}].height`)
    }
  }
  if (!Array.isArray(bounds.working_fps) || bounds.working_fps.length < 1) {
    invalid(`${label}.working_fps is invalid`)
  }
  bounds.working_fps.forEach((fps, index) => positiveSafeInteger(fps, `${label}.working_fps[${index}]`))
  positiveFinite(bounds.max_duration_sec, `${label}.max_duration_sec`)
  for (const key of BOUNDS_COUNTERS) positiveSafeInteger(bounds[key], `${label}.${key}`)
  // The v4 subtitle profile is the bounds_version 2 rule plus this exact counter triple; a v4-shaped
  // profile that drops the version is refused rather than read as the v1 pair list.
  if (requestedSubtitles) {
    if (!Object.hasOwn(candidate, 'bounds_version')) invalid(`${label} is missing the subtitle canvas rule`)
    for (const key of SUBTITLE_BOUNDS_KEYS) positiveSafeInteger(bounds[key], `${label}.${key}`)
  }
  return bounds as unknown as FinalRenderExecutionBounds
}

/** How long one range may deliver NOTHING before the transfer is treated as over. */
export const RANGE_IDLE_TIMEOUT_MS = 120_000

async function readBounded(
  response: Response,
  limit: number,
  /** Called per chunk: a caller bounding a transfer by PROGRESS, not by total time, resets its idle timer here. */
  onChunk?: (byteLength: number) => void,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new Error('Final render response body is not bytes')
      onChunk?.(next.value.byteLength)
      length += next.value.byteLength
      if (length > limit) {
        await reader.cancel().catch(() => {})
        throw new Error(`Final render response exceeds its ${limit}-byte limit`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export class FinalRenderHttpError extends Error {
  readonly status: number

  constructor(label: string, status: number, readonly code: string | null = null) {
    super(`${label} request failed with HTTP ${status}`)
    this.name = 'FinalRenderHttpError'
    this.status = status
  }
}

async function readJson(response: Response, label: string, expectedStatus: number): Promise<unknown> {
  const bytes = await readBounded(response, MAX_JSON_BYTES)
  if (response.status !== expectedStatus) {
    let code: string | null = null
    try {
      const body = decodeStrictJson(bytes, `${label} error`) as any
      if (body && Object.keys(body).length === 1 && body.error
        && Object.keys(body.error).length === 1 && typeof body.error.code === 'string'
        && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.error.code)) code = body.error.code
    } catch { /* An unrecognised error body cannot prove refusal. */ }
    throw new FinalRenderHttpError(label, response.status, code)
  }
  try {
    return decodeStrictJson(bytes, `${label} response`)
  } catch {
    throw new FinalRenderResponseValidationError(`${label} response schema is invalid`)
  }
}

/**
 * Every Gateway control call gets its own deadline.
 *
 * Owner, 2026-11-16: Brain-wise EP0105's `video_assembly` row ran about 11.5
 * hours for an 885-second video with progress and bytes null, and the log
 * stopped after "Logo shape: rounded corners (20%) · 96x96". Every one of these
 * routes is a small JSON request — a body measured in kilobytes — and none of
 * them had an `AbortSignal`, so a Gateway that accepted the connection and then
 * went quiet held the row open forever. A request that cannot finish in a
 * minute is not slow, it is stuck, and the row must hear that as an error it
 * can act on rather than as nothing at all.
 *
 * Bulk bytes are NOT covered here on purpose: an upload or a download of a real
 * video legitimately takes minutes, and it is bounded by its own byte ceiling.
 */
const CONTROL_REQUEST_TIMEOUT_MS = 60_000

function controlSignal(init: RequestInit): AbortSignal {
  const timeout = AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS)
  return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
}

async function fetchJson(
  access: Pick<PrivateRenderConnection, 'origin' | 'bearer' | 'story_instance_id'>,
  route: string,
  init: RequestInit,
  label: string,
  expectedStatus: number,
): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${access.bearer}`)
  headers.set('X-Story-Instance', access.story_instance_id)
  headers.set('Accept', 'application/json')
  const response = await fetch(`${access.origin}${route}`, {
    ...init, headers, redirect: 'error', signal: controlSignal(init),
  })
  return readJson(response, label, expectedStatus)
}

/** Every route but capabilities runs only against an already pinned Gateway binding. */
async function requestJson<T>(
  route: string,
  init: RequestInit,
  label: string,
  expectedStatus: number,
  parse: (value: unknown, access: PrivateRenderAccess) => T,
): Promise<T> {
  const access = await readPrivateRenderAccess()
  return parse(await fetchJson(access, route, init, label, expectedStatus), access)
}

function parseEncodeEntry(value: unknown, label = 'capabilities encode entry'): FinalRenderEncodeEntry {
  const entry = exactRecord(value, [
    'container', 'requested_codec', 'requested_effort', 'crf',
    'quality_cpu_preset', 'bitrate_kbps',
  ], label)
  const container = entry.container
  if (container !== 'mp4' && container !== 'mov' && container !== 'webm') {
    invalid(`${label} container is unsupported`)
  }
  const codec = entry.requested_codec
  if (codec !== 'h264' && codec !== 'h265') {
    invalid(`${label} codec is unsupported`)
  }
  const effort = entry.requested_effort
  if (effort !== 'ultrafast' && effort !== 'medium'
      && effort !== 'slow' && effort !== 'hardware') {
    invalid(`${label} effort is unsupported`)
  }
  const preset = entry.quality_cpu_preset
  if (preset !== 'ultrafast' && preset !== 'medium' && preset !== 'slow') {
    invalid(`${label} CPU preset is unsupported`)
  }
  const crf = nonnegativeSafeInteger(entry.crf, `${label} crf`)
  const bitrate = entry.bitrate_kbps === null
    ? null
    : positiveSafeInteger(entry.bitrate_kbps, `${label} bitrate_kbps`)
  return {
    container,
    requested_codec: codec,
    requested_effort: effort,
    crf,
    quality_cpu_preset: preset,
    bitrate_kbps: bitrate,
  }
}

/** Two encodes are equal only when all six fields are equal. A null cap never equals a positive one. */
export function sameFinalRenderEncodeTuple(
  left: Readonly<FinalRenderEncodeEntry>,
  right: Readonly<FinalRenderEncodeEntry>,
): boolean {
  return left.container === right.container
    && left.requested_codec === right.requested_codec
    && left.requested_effort === right.requested_effort
    && left.crf === right.crf
    && left.quality_cpu_preset === right.quality_cpu_preset
    && left.bitrate_kbps === right.bitrate_kbps
}

function parseEncodeAuthority(value: unknown): FinalRenderEncodeAuthority {
  const authority = exactRecord(value, ['format', 'entries'], 'capabilities encode')
  const entries = authority.entries
  if (authority.format !== 'studio.render.encode-authority.v1' || !Array.isArray(entries)) {
    invalid('capabilities encode authority is invalid')
  }
  return {
    format: 'studio.render.encode-authority.v1',
    entries: entries.map(entry => parseEncodeEntry(entry)),
  }
}

function parseLateLabelsCapability(value: unknown): FinalRenderLateLabelsCapability {
  const capability = exactRecord(value, ['format', 'motions'], 'capabilities late_labels')
  if (capability.format !== 'studio.render.late-label.v3') invalid('capabilities late_labels.format is unsupported')
  if (!Array.isArray(capability.motions)) invalid('capabilities late_labels.motions is invalid')
  const allowed = ['none', 'pop', 'slide', 'float', 'pulse', 'wipe', 'line-draw'] as const
  if (capability.motions.length !== allowed.length) {
    invalid('capabilities late_labels.motions does not contain the complete supported set')
  }
  const seen = new Set<string>()
  for (const [index, motion] of capability.motions.entries()) {
    if (!allowed.includes(motion as (typeof allowed)[number])) {
      invalid(`capabilities late_labels.motions[${index}] is unsupported`)
    }
    if (seen.has(motion as string)) invalid(`capabilities late_labels.motions[${index}] is duplicated`)
    seen.add(motion as string)
  }
  return capability as unknown as FinalRenderLateLabelsCapability
}

function parseSubtitlesCapability(value: unknown): FinalRenderSubtitlesCapability {
  const capability = exactRecord(value, ['format'], 'capabilities subtitles')
  if (capability.format !== 'studio.render.subtitle.v1') invalid('capabilities subtitles.format is unsupported')
  return capability as unknown as FinalRenderSubtitlesCapability
}

function parseCapabilities(
  value: unknown,
  connection: PrivateRenderConnection,
  requested?: FinalRenderEncodeEntry,
  requestedLateLabels = false,
  requestedSubtitles = false,
): FinalRenderCapabilities {
  const result = closedRecord(value, [
    'format', 'private', 'chargeable', 'owner_scope', 'gateway_instance_id',
    'story_instance_id', 'eligible', 'idle', 'server_time', 'profile_descriptor_utf8',
    'profile_digest', 'tools', 'compiler',
  ], [
    'qualification_provenance', 'encode', 'requested_encode',
    ...(requestedLateLabels ? ['late_labels'] : []),
    ...(requestedSubtitles ? ['subtitles'] : []),
  ], 'capabilities response')
  if (result.format !== 'studio.render.gateway-capabilities.v1'
      || result.private !== true || result.chargeable !== false) invalid('capabilities response literals are invalid')
  const ownerScope = uuid(result.owner_scope, 'capabilities owner_scope')
  const gatewayInstanceId = uuid(result.gateway_instance_id, 'capabilities gateway_instance_id')
  if (uuid(result.story_instance_id, 'capabilities story_instance_id') !== connection.story_instance_id
      || (connection.binding && (ownerScope !== connection.binding.owner_scope
        || gatewayInstanceId !== connection.binding.gateway_instance_id))) {
    invalid('capabilities response Gateway binding does not match')
  }
  const eligible = nonnegativeSafeInteger(result.eligible, 'capabilities eligible')
  const idle = nonnegativeSafeInteger(result.idle, 'capabilities idle')
  if (idle > eligible) invalid('capabilities idle exceeds eligible')
  const serverTime = positiveSafeInteger(result.server_time, 'capabilities server_time')
  const now = Math.floor(Date.now() / 1000)
  if (serverTime < now - 120 || serverTime > now + 30) invalid('capabilities response freshness is outside the allowed window')
  const tools = parseDescriptorLink(result.tools, 'capabilities tools')
  const compiler = parseDescriptorLink(result.compiler, 'capabilities compiler')
  parseToolsDescriptor(tools.descriptor_utf8)
  // Old Gateways ignore the scoped contract and keep the v1 descriptor pair. A present capability
  // is parsed before descriptor admission, so its presence alone does not select a newer pair.
  const hasLateLabels = Object.hasOwn(result, 'late_labels')
  if (!requestedLateLabels && hasLateLabels) {
    invalid('capabilities response advertised late labels Story never requested')
  }
  if (requestedLateLabels && hasLateLabels) {
    result.late_labels = parseLateLabelsCapability(result.late_labels)
  }
  const hasSubtitles = Object.hasOwn(result, 'subtitles')
  if (!requestedSubtitles && hasSubtitles) {
    invalid('capabilities response advertised subtitles Story never requested')
  }
  if (requestedSubtitles && hasSubtitles) {
    // Admitted only against the frozen v4 descriptor triple: the profile and compiler
    // parsers below re-check the exact subtitle literals against the supplied digests,
    // and the execution-bounds parser requires this profile's three subtitle counters.
    // A subtitle-scoped envelope that carries any other descriptor pair is refused there.
    parseSubtitlesCapability(result.subtitles)
  }
  const useLateLabelDescriptors = requestedLateLabels && hasLateLabels
  // The subtitle descriptor pair is selected by the response carrying subtitle authority, not by
  // the request alone: an old Gateway that answers the scoped query with its unchanged v1 pair
  // grants no subtitle authority and keeps its v1 descriptors.
  const useSubtitleDescriptors = requestedSubtitles && hasSubtitles
  parseCompilerDescriptor(compiler.descriptor_utf8, useLateLabelDescriptors, useSubtitleDescriptors)
  if (typeof result.profile_descriptor_utf8 !== 'string') invalid('capabilities profile descriptor bytes are invalid')
  const profileDigest = sha256(result.profile_digest, 'capabilities profile_digest')
  if (digestBytes(result.profile_descriptor_utf8) !== profileDigest) invalid('capabilities profile byte digest does not match')
  const parsedBounds = parseProfileDescriptor(result.profile_descriptor_utf8, tools.digest, compiler.digest, useLateLabelDescriptors, useSubtitleDescriptors)
  ;(result as any).execution_bounds = parsedBounds
  if (Object.hasOwn(result, 'qualification_provenance') && result.qualification_provenance !== null) {
    try { result.qualification_provenance = parseQualificationProvenance(result.qualification_provenance) } catch (error) {
      if (error instanceof RenderProvenanceError) invalid(error.message)
      throw error
    }
  }
  if (Object.hasOwn(result, 'encode') && result.encode !== null) {
    result.encode = parseEncodeAuthority(result.encode)
  }
  // A scoped query may be echoed with the exact tuple Story asked about, and only that tuple.
  // An unsolicited echo, an echo of a different tuple, or an entry claiming another tuple in an
  // echoed scope is refused: a flag or a near-match is not admission.
  const echoed = Object.hasOwn(result, 'requested_encode')
  if (!requested && echoed) invalid('capabilities response echoed an encode Story never requested')
  if (echoed) {
    const echo = parseEncodeEntry(result.requested_encode, 'capabilities requested_encode')
    if (!requested || !sameFinalRenderEncodeTuple(echo, requested)) {
      invalid('capabilities response echoed a different encode than the one requested')
    }
    if (result.encode !== null && result.encode !== undefined) {
      const authority = result.encode as FinalRenderEncodeAuthority
      if (authority.entries.length > 1
        || (authority.entries.length === 1 && !sameFinalRenderEncodeTuple(authority.entries[0]!, requested))) {
        invalid('capabilities response lists an encode entry other than the requested one')
      }
      if (authority.entries.length > 0 && eligible === 0) {
        invalid('capabilities response lists supported encode with no eligible nodes')
      }
    }
    result.requested_encode = echo
  }
  return result as unknown as FinalRenderCapabilities
}

function parseBlobStatus(
  value: unknown,
  expectedSha: string,
  expectedSize: number,
  expectedOffset?: number,
): FinalRenderBlobStatus {
  const result = closedRecord(value, ['format', 'sha256', 'size_bytes', 'state', 'offset'], ['upload_id', 'asset_handle'], 'blob response')
  if (result.format !== 'studio.render.gateway-blob.v1') invalid('blob response format is invalid')
  if (sha256(result.sha256, 'blob response sha256') !== expectedSha
      || positiveSafeInteger(result.size_bytes, 'blob response size_bytes') !== expectedSize) {
    invalid('blob response binding does not match')
  }
  const offset = nonnegativeSafeInteger(result.offset, 'blob response offset')
  if (offset > expectedSize || (expectedOffset !== undefined && offset !== expectedOffset)) {
    invalid('blob response offset does not match')
  }
  if (!['missing', 'uploading', 'complete'].includes(result.state as string)) invalid('blob response state is invalid')
  const hasUpload = Object.hasOwn(result, 'upload_id')
  const hasHandle = Object.hasOwn(result, 'asset_handle')
  if (hasUpload && (typeof result.upload_id !== 'string' || !UPLOAD_ID.test(result.upload_id))) {
    invalid('blob response upload_id is invalid')
  }
  if (hasHandle && (typeof result.asset_handle !== 'string' || !ASSET_HANDLE.test(result.asset_handle))) {
    invalid('blob response asset_handle is invalid')
  }
  if (result.state === 'missing' && (offset !== 0 || hasUpload || hasHandle)) invalid('missing blob response is inconsistent')
  if (result.state === 'uploading' && (!hasUpload || hasHandle || offset >= expectedSize)) invalid('uploading blob response is inconsistent')
  if (result.state === 'complete' && (!hasUpload || !hasHandle || offset !== expectedSize)) invalid('complete blob response is inconsistent')
  return result as unknown as FinalRenderBlobStatus
}

interface JobExpectation {
  id?: string
  key?: string
  storyUuid?: string
  intent?: string
  attemptNo?: number
  inboundDigest?: string
  packetDigest?: string
  acceptance: boolean
}

export interface FinalRenderLookupExpectation {
  id?: string
  storyUuid?: string
  intent?: string
  attemptNo?: number
  inboundDigest?: string
  packetDigest?: string
}

export type FinalRenderEvidenceAccess = Pick<
  PrivateRenderAccess,
  'owner_scope' | 'gateway_instance_id' | 'story_instance_id'
>

export interface FinalRenderJobEvidenceExpectation {
  id?: string
  key?: string
  storyUuid?: string
  intent?: string
  attemptNo?: number
  inboundDigest?: string
  packetDigest?: string
  acceptance: boolean
}

function parseTerminalProof(
  value: unknown,
  expected: {
    id?: string
    key: string
    digest?: string
    fence?: string
    firstCancelAt?: number
  },
): FinalRenderTerminalProof {
  const candidate = record(value, 'terminal proof')
  if (candidate.kind === 'launched_stopped') {
    const proof = exactRecord(candidate, [
      'format', 'kind', 'gateway_job_id', 'gateway_attempt_key', 'hub_job_id',
      'hub_attempt_id', 'stopped_evidence_digest',
    ], 'terminal proof')
    const id = uuid(proof.gateway_job_id, 'terminal proof gateway_job_id')
    if (proof.format !== 'studio.render.gateway-terminal-proof.v1'
        || (expected.id && id !== expected.id)
        || idempotencyKey(proof.gateway_attempt_key, 'terminal proof gateway_attempt_key') !== expected.key) {
      invalid('terminal proof binding is invalid')
    }
    uuid(proof.hub_job_id, 'terminal proof hub_job_id')
    if (typeof proof.hub_attempt_id !== 'string' || !ASSET_HANDLE.test(proof.hub_attempt_id)) {
      invalid('terminal proof hub_attempt_id is invalid')
    }
    sha256(proof.stopped_evidence_digest, 'terminal proof stopped_evidence_digest')
    return proof as unknown as FinalRenderTerminalProof
  }
  if (candidate.kind === 'never_launched') {
    const proof = exactRecord(candidate, [
      'format', 'kind', 'gateway_attempt_key', 'inbound_story_body_sha256',
      'fence_receipt', 'first_cancel_at',
    ], 'terminal proof')
    const digest = sha256(proof.inbound_story_body_sha256, 'terminal proof inbound_story_body_sha256')
    const fence = typeof proof.fence_receipt === 'string' && ASSET_HANDLE.test(proof.fence_receipt)
      ? proof.fence_receipt
      : invalid('terminal proof fence_receipt is invalid')
    const firstCancelAt = nonnegativeFinite(proof.first_cancel_at, 'terminal proof first_cancel_at')
    if (proof.format !== 'studio.render.gateway-terminal-proof.v1'
        || idempotencyKey(proof.gateway_attempt_key, 'terminal proof gateway_attempt_key') !== expected.key
        || (expected.digest && digest !== expected.digest)
        || (expected.fence && fence !== expected.fence)
        || (expected.firstCancelAt !== undefined && firstCancelAt !== expected.firstCancelAt)) {
      invalid('terminal proof binding is invalid')
    }
    return proof as unknown as FinalRenderTerminalProof
  }
  return invalid('terminal proof kind is invalid')
}

function parseReceipt(
  receiptUtf8: unknown,
  receiptDigest: string,
  access: FinalRenderEvidenceAccess,
  jobView: {
    id: string
    key: string
    storyUuid: string
    intent: string
    attemptNo: number
  },
  expected: JobExpectation,
): FinalRenderOutputReceipt {
  if (typeof receiptUtf8 !== 'string' || Buffer.byteLength(receiptUtf8, 'utf8') > MAX_JSON_BYTES
      || digestBytes(receiptUtf8) !== receiptDigest) invalid('output receipt byte digest does not match')
  const receipt = exactRecord(parseJsonText(receiptUtf8, 'output receipt'), [
    'format', 'owner_scope', 'gateway_instance_id', 'story_instance_id', 'gateway_job_id',
    'gateway_attempt_key', 'story_uuid', 'intent_id', 'attempt_no', 'inbound_story_body_sha256',
    'packet_digest', 'outbound_hub_body_sha256', 'hub_dispatch_key', 'dispatch_fence',
    'hub_owner_scope', 'hub_job_id', 'hub_attempt_id', 'hub_receipt_digest', 'selected_machine',
    'profile_digest', 'tools_digest', 'compiler_digest', 'qualification_digest', 'selected_tier',
    'generated_command_digest', 'feature_losses', 'output_sha256', 'output_size_bytes',
  ], 'output receipt')
  if (receipt.format !== 'studio.render.gateway-output-receipt.v1') invalid('output receipt format is invalid')
  if (uuid(receipt.owner_scope, 'output receipt owner_scope') !== access.owner_scope
      || uuid(receipt.gateway_instance_id, 'output receipt gateway_instance_id') !== access.gateway_instance_id
      || uuid(receipt.story_instance_id, 'output receipt story_instance_id') !== access.story_instance_id
      || uuid(receipt.gateway_job_id, 'output receipt gateway_job_id') !== jobView.id
      || idempotencyKey(receipt.gateway_attempt_key, 'output receipt gateway_attempt_key') !== jobView.key
      || uuid(receipt.story_uuid, 'output receipt story_uuid') !== jobView.storyUuid
      || intentId(receipt.intent_id, 'output receipt intent_id') !== jobView.intent
      || positiveSafeInteger(receipt.attempt_no, 'output receipt attempt_no') !== jobView.attemptNo) {
    invalid('output receipt job binding does not match')
  }
  const inboundDigest = sha256(receipt.inbound_story_body_sha256, 'output receipt inbound_story_body_sha256')
  if (expected.inboundDigest && inboundDigest !== expected.inboundDigest) invalid('output receipt inbound request digest does not match')
  const packetDigest = sha256(receipt.packet_digest, 'output receipt packet_digest')
  if (expected.packetDigest && packetDigest !== expected.packetDigest) invalid('output receipt packet digest does not match')
  for (const key of [
    'outbound_hub_body_sha256', 'hub_receipt_digest', 'profile_digest', 'tools_digest',
    'compiler_digest', 'qualification_digest', 'generated_command_digest', 'output_sha256',
  ]) sha256(receipt[key], `output receipt ${key}`)
  boundedText(receipt.hub_dispatch_key, 'output receipt hub_dispatch_key')
  boundedText(receipt.dispatch_fence, 'output receipt dispatch_fence')
  if (typeof receipt.hub_owner_scope !== 'string' || !HUB_OWNER_SCOPE.test(receipt.hub_owner_scope)) {
    invalid('output receipt hub_owner_scope is invalid')
  }
  uuid(receipt.hub_job_id, 'output receipt hub_job_id')
  if (typeof receipt.hub_attempt_id !== 'string' || !ASSET_HANDLE.test(receipt.hub_attempt_id)) {
    invalid('output receipt hub_attempt_id is invalid')
  }
  const machine = exactRecord(receipt.selected_machine, ['id', 'label', 'chip', 'memory_gb', 'hardware_class'], 'output receipt selected_machine')
  for (const key of ['id', 'label', 'chip', 'hardware_class']) boundedText(machine[key], `output receipt selected_machine.${key}`)
  positiveFinite(machine.memory_gb, 'output receipt selected_machine.memory_gb')
  boundedText(receipt.selected_tier, 'output receipt selected_tier')
  if (!Array.isArray(receipt.feature_losses) || receipt.feature_losses.length > 64) {
    invalid('output receipt feature_losses is invalid')
  }
  receipt.feature_losses.forEach((entry, index) => boundedText(entry, `output receipt feature_losses[${index}]`))
  positiveSafeInteger(receipt.output_size_bytes, 'output receipt output_size_bytes')
  return receipt as unknown as FinalRenderOutputReceipt
}

function parseJob(
  value: unknown,
  access: FinalRenderEvidenceAccess,
  expected: JobExpectation,
): FinalRenderJobView {
  const required = [
    'format', 'id', 'state', 'gateway_attempt_key', 'story_uuid', 'intent_id',
    'attempt_no', 'output_ready', 'idempotent_replay',
  ]
  if (expected.acceptance) required.push('destination_node', 'inbound_story_body_sha256')
  const result = closedRecord(value, required, [
    'cancel_state', 'remote_state', 'receipt_digest', 'output', 'terminal_proof',
  ], 'job response')
  if (result.format !== 'studio.render.gateway-job.v1') invalid('job response format is invalid')
  const id = uuid(result.id, 'job response id')
  const key = idempotencyKey(result.gateway_attempt_key, 'job response gateway_attempt_key')
  const storyUuid = uuid(result.story_uuid, 'job response story_uuid')
  const intent = intentId(result.intent_id, 'job response intent_id')
  const attemptNo = positiveSafeInteger(result.attempt_no, 'job response attempt_no')
  if (expected.id && id !== expected.id) invalid('job response id binding does not match')
  if (expected.key && key !== expected.key) invalid('job response key binding does not match')
  if (expected.storyUuid && storyUuid !== expected.storyUuid) invalid('job response story binding does not match')
  if (expected.intent && intent !== expected.intent) invalid('job response intent binding does not match')
  if (expected.attemptNo && attemptNo !== expected.attemptNo) invalid('job response attempt binding does not match')
  if (typeof result.state !== 'string' || !JOB_STATES.has(result.state)) invalid('job response state is invalid')
  if (typeof result.output_ready !== 'boolean' || typeof result.idempotent_replay !== 'boolean') {
    invalid('job response boolean projection is invalid')
  }
  if (Object.hasOwn(result, 'cancel_state')
      && (typeof result.cancel_state !== 'string' || !CANCEL_STATES.has(result.cancel_state))) invalid('job response cancel_state is invalid')
  if (Object.hasOwn(result, 'remote_state')
      && (typeof result.remote_state !== 'string' || !REMOTE_STATES.has(result.remote_state))) invalid('job response remote_state is invalid')
  if (Object.hasOwn(result, 'terminal_proof')) {
    result.terminal_proof = parseTerminalProof(result.terminal_proof, {
      id, key, digest: expected.inboundDigest,
    })
  }
  if (expected.acceptance) {
    boundedText(result.destination_node, 'job response destination_node')
    const inbound = sha256(result.inbound_story_body_sha256, 'job response inbound_story_body_sha256')
    if (expected.inboundDigest && inbound !== expected.inboundDigest) invalid('job response request digest binding does not match')
  }
  const hasOutput = Object.hasOwn(result, 'output')
  const hasReceiptDigest = Object.hasOwn(result, 'receipt_digest')
  if (!hasOutput) {
    if (hasReceiptDigest || result.output_ready !== false) invalid('job response output projection is inconsistent')
  } else {
    if (!hasReceiptDigest || result.output_ready !== true
        || (result.state !== 'output_ready' && result.state !== 'acknowledged')) invalid('job response output projection is inconsistent')
    const receiptDigest = sha256(result.receipt_digest, 'job response receipt_digest')
    const output = exactRecord(result.output, ['sha256', 'size_bytes', 'receipt_digest', 'receipt_utf8'], 'job response output')
    const outputSha = sha256(output.sha256, 'job response output.sha256')
    const outputSize = positiveSafeInteger(output.size_bytes, 'job response output.size_bytes')
    if (sha256(output.receipt_digest, 'job response output.receipt_digest') !== receiptDigest) {
      invalid('job response receipt digest projection does not match')
    }
    const receipt = parseReceipt(output.receipt_utf8, receiptDigest, access, {
      id, key, storyUuid, intent, attemptNo,
    }, expected)
    if (receipt.output_sha256 !== outputSha || receipt.output_size_bytes !== outputSize) {
      invalid('job response output does not match its receipt')
    }
  }
  return result as unknown as FinalRenderJobView
}

/** Pure validation seam for already-recorded blob evidence. */
export function validateFinalRenderBlobStatusEvidence(
  value: unknown,
  expectedSha: string,
  expectedSize: number,
  expectedOffset?: number,
): FinalRenderBlobStatus {
  return parseBlobStatus(value, expectedSha, expectedSize, expectedOffset)
}

/** Pure validation seam for already-recorded submit/lookup evidence. */
export function validateFinalRenderJobEvidence(
  value: unknown,
  access: FinalRenderEvidenceAccess,
  expected: FinalRenderJobEvidenceExpectation,
): FinalRenderJobView {
  return parseJob(value, access, expected)
}

/** Pure validation seam for already-recorded cancellation evidence. */
export function validateFinalRenderCancelEvidence(
  value: unknown,
  expected: { key: string; digest: string; id?: string },
): FinalRenderCancelView {
  return parseCancel(value, expected)
}

function parseCancel(
  value: unknown,
  expected: { key?: string; digest?: string; id?: string },
): FinalRenderCancelView {
  const result = closedRecord(value, [
    'format', 'state', 'gateway_attempt_key', 'expected_request_sha256',
  ], ['gateway_job_id', 'fence_receipt', 'first_cancel_at', 'terminal_proof'], 'cancellation response')
  if (result.format !== 'studio.render.gateway-cancel.v1'
      || (result.state !== 'cancel_requested' && result.state !== 'cancelled_before_acceptance')) {
    invalid('cancellation response state is invalid')
  }
  const key = idempotencyKey(result.gateway_attempt_key, 'cancellation response gateway_attempt_key')
  const digest = sha256(result.expected_request_sha256, 'cancellation response expected_request_sha256')
  if (expected.key && key !== expected.key) invalid('cancellation response key binding does not match')
  if (expected.digest && digest !== expected.digest) invalid('cancellation response request digest does not match')
  let id: string | undefined
  if (Object.hasOwn(result, 'gateway_job_id')) {
    id = uuid(result.gateway_job_id, 'cancellation response gateway_job_id')
    if (expected.id && id !== expected.id) invalid('cancellation response job binding does not match')
  } else if (expected.id) invalid('cancellation response job binding is missing')
  let fence: string | undefined
  if (Object.hasOwn(result, 'fence_receipt')) {
    fence = typeof result.fence_receipt === 'string' && ASSET_HANDLE.test(result.fence_receipt)
      ? result.fence_receipt
      : invalid('cancellation response fence_receipt is invalid')
  }
  let firstCancelAt: number | undefined
  if (Object.hasOwn(result, 'first_cancel_at')) {
    firstCancelAt = nonnegativeFinite(result.first_cancel_at, 'cancellation response first_cancel_at')
  }
  if (Object.hasOwn(result, 'terminal_proof')) {
    const proof = parseTerminalProof(result.terminal_proof, {
      id, key, digest, fence, firstCancelAt,
    })
    if (proof.kind === 'never_launched'
        && (result.state !== 'cancelled_before_acceptance' || fence === undefined || firstCancelAt === undefined)) {
      invalid('cancellation response terminal proof is inconsistent')
    }
    result.terminal_proof = proof
  }
  return result as unknown as FinalRenderCancelView
}

function parseAck(value: unknown, id: string, digest: string): FinalRenderAckView {
  const result = exactRecord(value, ['format', 'id', 'acknowledged', 'receipt_digest'], 'acknowledgement response')
  if (result.format !== 'studio.render.gateway-ack.v1' || result.acknowledged !== true
      || uuid(result.id, 'acknowledgement response id') !== id
      || sha256(result.receipt_digest, 'acknowledgement response receipt_digest') !== digest) {
    invalid('acknowledgement response binding is invalid')
  }
  return result as unknown as FinalRenderAckView
}

/** Pure validation seam for already-recorded acknowledgement evidence. */
export function validateFinalRenderAckEvidence(
  value: unknown,
  expectedGatewayJobId: string,
  expectedReceiptDigest: string,
): FinalRenderAckView {
  gatewayJobId(expectedGatewayJobId)
  sha256(expectedReceiptDigest, 'expected acknowledgement receipt')
  return parseAck(value, expectedGatewayJobId, expectedReceiptDigest)
}

export interface SubmitContext {
  storyUuid: string
  intent: string
  attemptNo: number
  packetDigest: string
  inboundDigest: string
}

/** The channel and episode labels the Hub's Render tab shows. Display only — never dispatch. */
export interface FinalRenderDisplay {
  channel?: string
  episode?: string
}

/**
 * One display label, or undefined when there is nothing the Hub would be able to show.
 *
 * The rule is the Hub's own (`render_jobs._display`): non-empty, at most 256 characters, no NUL.
 * It is deliberately the only rule: a channel or episode name is the customer's own words in
 * whatever script and with whatever punctuation, and a label that would fail a stricter test is
 * **left out** rather than allowed to fail a render — display must never be a reason a render is
 * refused. Nothing routes, dispatches, hashes or accepts on the result.
 */
export function finalRenderDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const label = value.trim()
  if (!label || label.length > DISPLAY_MAX_CHARACTERS || label.includes('\0')) return undefined
  return label
}

/** The `display` object of a request Gateway envelope, validated as a label and nothing else. */
export function validateFinalRenderDisplay(value: unknown): FinalRenderDisplay {
  const display = closedRecord(value, [], DISPLAY_KEYS, 'request Gateway display')
  const result: FinalRenderDisplay = {}
  for (const key of DISPLAY_KEYS) {
    if (!Object.hasOwn(display, key)) continue
    const label = display[key]
    if (typeof label !== 'string' || !label || label.length > DISPLAY_MAX_CHARACTERS
      || label.includes('\0')) {
      invalid(`request Gateway display ${key} is not a display label`)
    }
    result[key] = label
  }
  if (Object.keys(result).length === 0) invalid('request Gateway display names no channel or episode')
  return result
}

export function validateSubmitBytes(bytes: Uint8Array): SubmitContext {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_JSON_BYTES) {
    invalid('request Gateway envelope bytes are empty or too large')
  }
  const value = decodeStrictJson(bytes, 'request Gateway envelope')
  const envelope = closedRecord(value, [
    'format', 'story_uuid', 'intent_id', 'attempt_no', 'packet', 'assets',
  ], ['display'], 'request Gateway envelope')
  if (envelope.format !== 'studio.render.gateway-request.v1') invalid('request Gateway envelope format is invalid')
  // Optional and display only: the presentation a render travels with, never anything the
  // Gateway or Hub decides with.
  if (Object.hasOwn(envelope, 'display')) validateFinalRenderDisplay(envelope.display)
  const storyUuid = uuid(envelope.story_uuid, 'request Gateway envelope story_uuid')
  const intent = intentId(envelope.intent_id, 'request Gateway envelope intent_id')
  const attemptNo = positiveSafeInteger(envelope.attempt_no, 'request Gateway envelope attempt_no')
  const packet = validateRenderPacketSyntax(envelope.packet)
  const assets = exactRecord(envelope.assets, packet.manifest.map(item => String(item.logical_id)), 'request Gateway assets')
  for (const item of packet.manifest) {
    const logicalId = String(item.logical_id)
    if (typeof assets[logicalId] !== 'string' || !ASSET_HANDLE.test(assets[logicalId] as string)) {
      invalid(`request Gateway asset handle for ${logicalId} is invalid`)
    }
  }
  return {
    storyUuid, intent, attemptNo, packetDigest: packet.packet_digest,
    inboundDigest: digestBytes(bytes),
  }
}

async function readExactBody(body: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  if (!body || typeof body.getReader !== 'function') invalid('request blob body must be a readable byte stream')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let actual = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) invalid('request blob body must contain only byte chunks')
      actual += next.value.byteLength
      if (actual > length) {
        await reader.cancel().catch(() => {})
        invalid('request blob body contains more bytes than its declared length')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (actual !== length) invalid('request blob body contains fewer bytes than its declared length')
  const bytes = new Uint8Array(actual)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * The first valid capabilities response pins the Gateway identity. A pin for another origin means
 * the owner moved the Gateway, so this call re-pairs to the identity that answers at the configured
 * origin; a different identity at the *same* origin is refused, never re-paired.
 *
 * With a `requested` tuple the read is scoped: the Gateway answers about that exact encode and may
 * echo it. `requestedLateLabels` opts into the late-label contract; a Gateway that ignores the query
 * may answer with v1 and no late-label capability. `requestedSubtitles` opts into the subtitle
 * contract (`studio.render.subtitle.v1`), which takes the single `requested_contract` slot; a
 * response carrying a subtitle record is refused until this build carries the frozen subtitle
 * descriptor pins. The GET stays read-only and carries no input file, credential or destination
 * origin.
 */
export async function getFinalRenderCapabilities(
  requested?: FinalRenderEncodeEntry,
  options: { readonly requestedLateLabels?: boolean; readonly requestedSubtitles?: boolean } = {},
): Promise<FinalRenderCapabilities> {
  const connection = await readPrivateRenderConnection()
  const originChanged = connection.binding !== null && connection.binding.origin !== connection.origin
  const requestedLateLabels = options.requestedLateLabels === true
  const requestedSubtitles = options.requestedSubtitles === true
  const query = new URLSearchParams()
  if (requested) query.set('requested_encode', JSON.stringify(requested))
  if (requestedSubtitles) query.set('requested_contract', 'studio.render.subtitle.v1')
  else if (requestedLateLabels) query.set('requested_contract', 'studio.render.late-label.v3')
  const queryString = query.toString()
  const route = queryString
    ? `/v1/final-renders/capabilities?${queryString}`
    : '/v1/final-renders/capabilities'
  const capabilities = parseCapabilities(await fetchJson(
    connection, route, { method: 'GET' }, 'Final render capabilities', 200,
  ), originChanged ? { ...connection, binding: null } : connection, requested, requestedLateLabels, requestedSubtitles)
  const answered = {
    origin: connection.origin,
    owner_scope: capabilities.owner_scope,
    gateway_instance_id: capabilities.gateway_instance_id,
  }
  if (originChanged) await repairGatewayBinding(answered)
  else await pinGatewayBinding(answered)
  return capabilities
}

const OUTPUT_SETTINGS_FORMAT = 'studio.render.output-settings-capabilities.v1'

/**
 * The v2 profile travels alone in this response — no tools/compiler link to cross-check — so it is
 * validated against the revision-4 literals only. An unknown profile format fails admission.
 */
function parseOutputSettingsProfile(raw: string): void {
  const profile = exactRecord(parseJsonText(raw, 'output-settings profile descriptor'), [
    'format', 'implementation', 'recipe_namespace', 'compiler_artifact_sha256',
    'tools_artifact_sha256', 'combination_set', 'tier_policy', 'output_policy',
    'execution_bounds', 'hardware_qualification_record_sha256',
    'fidelity_record_sha256', 'production_eligible',
  ], 'output-settings profile descriptor')
  const literals: Record<string, string> = {
    format: 'studio.render.profile.v2',
    implementation: 'story-classic-no-font-v2',
    recipe_namespace: 'studio.render.final.v2',
    combination_set: 'retained-classic-no-font-candidate-v1',
    tier_policy: 'story-final-chain-v1',
    output_policy: 'story-final-output-v2',
  }
  for (const [key, expected] of Object.entries(literals)) {
    if (profile[key] !== expected) invalid(`output-settings profile descriptor.${key} is unsupported`)
  }
  for (const key of ['compiler_artifact_sha256', 'tools_artifact_sha256']) {
    sha256(profile[key], `output-settings profile descriptor.${key}`)
  }
  for (const key of ['hardware_qualification_record_sha256', 'fidelity_record_sha256']) {
    if (profile[key] !== null) sha256(profile[key], `output-settings profile descriptor.${key}`)
  }
  if (profile.production_eligible !== false) invalid('output-settings profile descriptor.production_eligible is unsupported')
  parseExecutionBounds(profile.execution_bounds)
}

function parseOutputSettingsCapabilities(
  value: unknown,
  connection: Pick<PrivateRenderConnection, 'story_instance_id' | 'binding'>,
): FinalRenderOutputSettingsCapabilities {
  const shape = record(value, 'output-settings capabilities response')
  if (typeof shape.format !== 'string') invalid('output-settings capabilities response format is invalid')
  // A version this build does not implement is "not offered", never support and never a crash.
  if (shape.format !== OUTPUT_SETTINGS_FORMAT) {
    return {
      supported: false,
      reason: `This Gateway answers with "${shape.format}", which this Story build does not implement.`,
      profile_descriptor_utf8: null,
      profile_digest: null,
    }
  }
  const result = closedRecord(shape, [
    'format', 'private', 'chargeable', 'owner_scope', 'gateway_instance_id',
    'story_instance_id', 'server_time', 'supported', 'reason',
    'profile_descriptor_utf8', 'profile_digest',
  ], [], 'output-settings capabilities response')
  if (result.private !== true || result.chargeable !== false) {
    invalid('output-settings capabilities response literals are invalid')
  }
  const ownerScope = uuid(result.owner_scope, 'output-settings capabilities owner_scope')
  const gatewayInstanceId = uuid(result.gateway_instance_id, 'output-settings capabilities gateway_instance_id')
  if (uuid(result.story_instance_id, 'output-settings capabilities story_instance_id') !== connection.story_instance_id
      || (connection.binding && (ownerScope !== connection.binding.owner_scope
        || gatewayInstanceId !== connection.binding.gateway_instance_id))) {
    invalid('output-settings capabilities response Gateway binding does not match')
  }
  const serverTime = positiveSafeInteger(result.server_time, 'output-settings capabilities server_time')
  const now = Math.floor(Date.now() / 1000)
  if (serverTime < now - 120 || serverTime > now + 30) {
    invalid('output-settings capabilities response freshness is outside the allowed window')
  }
  if (typeof result.supported !== 'boolean') invalid('output-settings capabilities response supported is invalid')
  const reason = result.reason
  if (reason !== null && (typeof reason !== 'string' || !reason || reason !== reason.trim() || reason.length > 256)) {
    invalid('output-settings capabilities response reason is invalid')
  }
  const descriptor = result.profile_descriptor_utf8
  if (result.supported) {
    if (reason !== null) invalid('output-settings capabilities response reason must be null when supported')
    if (typeof descriptor !== 'string') invalid('output-settings capabilities response profile is missing while supported')
    const profileDigest = sha256(result.profile_digest, 'output-settings capabilities profile_digest')
    if (digestBytes(descriptor) !== profileDigest) invalid('output-settings capabilities profile byte digest does not match')
    parseOutputSettingsProfile(descriptor)
    return { supported: true, reason: null, profile_descriptor_utf8: descriptor, profile_digest: profileDigest }
  }
  if (reason === null) invalid('output-settings capabilities response reason is required when unsupported')
  if (descriptor !== null || result.profile_digest !== null) {
    invalid('output-settings capabilities response profile must be null when unsupported')
  }
  return { supported: false, reason, profile_descriptor_utf8: null, profile_digest: null }
}

/**
 * Revision-4 output-settings negotiation on the paired Gateway origin, with the same authentication
 * and owner/Story identity checks as the v1 capabilities read (but no pinning: v1 still owns pairing).
 * A 404/405 is "this Gateway does not offer it"; a version it does not implement is unavailable with
 * a reason. Malformed output or a mismatched identity is a validation error, never support.
 */
export async function getFinalRenderOutputSettingsCapabilities(): Promise<FinalRenderOutputSettingsCapabilities> {
  const connection = await readPrivateRenderConnection()
  let body: unknown
  try {
    body = await fetchJson(
      connection, '/v2/final-renders/capabilities', { method: 'GET' },
      'Output settings capabilities', 200,
    )
  } catch (error) {
    if (error instanceof FinalRenderHttpError && (error.status === 404 || error.status === 405)) {
      return {
        supported: false,
        reason: `This Gateway does not offer output-settings capabilities (HTTP ${error.status}).`,
        profile_descriptor_utf8: null,
        profile_digest: null,
      }
    }
    throw error
  }
  return parseOutputSettingsCapabilities(body, connection)
}

export function getFinalRenderBlobStatus(sha: string, sizeBytes: number): Promise<FinalRenderBlobStatus> {
  sha256(sha, 'request blob')
  positiveSafeInteger(sizeBytes, 'request blob size_bytes')
  return requestJson(
    `/v1/final-renders/blobs/${sha}/status?size_bytes=${sizeBytes}`,
    { method: 'GET' }, 'Final render blob status', 200,
    value => parseBlobStatus(value, sha, sizeBytes),
  )
}

export async function putFinalRenderBlob(input: {
  sha256: string
  total_bytes: number
  offset: number
  length: number
  body: ReadableStream<Uint8Array>
}): Promise<FinalRenderBlobStatus> {
  sha256(input.sha256, 'request blob')
  positiveSafeInteger(input.total_bytes, 'request blob total_bytes')
  nonnegativeSafeInteger(input.offset, 'request blob offset')
  positiveSafeInteger(input.length, 'request blob length')
  if (input.length > MAX_CHUNK_BYTES) invalid('request blob length exceeds the 8 MiB chunk limit')
  if (!Number.isSafeInteger(input.offset + input.length) || input.offset + input.length > input.total_bytes) {
    invalid('request blob byte range exceeds total_bytes')
  }
  const bytes = await readExactBody(input.body, input.length)
  const end = input.offset + input.length - 1
  const init = {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(input.length),
      'Content-Range': `bytes ${input.offset}-${end}/${input.total_bytes}`,
    },
    body: byteStream(bytes) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }
  return requestJson(
    `/v1/final-renders/blobs/${input.sha256}?size_bytes=${input.total_bytes}&offset=${input.offset}`,
    init, 'Final render blob status', 200,
    value => parseBlobStatus(value, input.sha256, input.total_bytes, input.offset + input.length),
  )
}

export function submitFinalRender(requestBody: Uint8Array, key: string): Promise<FinalRenderJobView> {
  const context = validateSubmitBytes(requestBody)
  idempotencyKey(key)
  return requestJson('/v1/final-renders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(requestBody.byteLength),
      'Idempotency-Key': key,
    },
    body: requestBody,
  }, 'Final render job', 202, (value, access) => parseJob(value, access, {
    key, storyUuid: context.storyUuid, intent: context.intent, attemptNo: context.attemptNo,
    inboundDigest: context.inboundDigest, packetDigest: context.packetDigest, acceptance: true,
  }))
}

export function lookupFinalRenderByKey(
  key: string,
  expected: FinalRenderLookupExpectation = {},
): Promise<FinalRenderJobView> {
  idempotencyKey(key)
  return requestJson(
    `/v1/final-renders/by-idempotency-key/${encodeURIComponent(key)}`,
    { method: 'GET' }, 'Final render job', 200,
    (value, access) => parseJob(value, access, { key, ...expected, acceptance: false }),
  )
}

export function getFinalRenderStatus(
  jobId: string,
  expected: FinalRenderLookupExpectation = {},
): Promise<FinalRenderJobView> {
  gatewayJobId(jobId)
  return requestJson(
    `/v1/final-renders/${jobId}`, { method: 'GET' }, 'Final render job', 200,
    (value, access) => parseJob(value, access, { ...expected, id: jobId, acceptance: false }),
  )
}

export function cancelFinalRenderByKey(
  key: string,
  expectedRequestSha256: string,
  expectedGatewayJobId?: string,
): Promise<FinalRenderCancelView> {
  idempotencyKey(key)
  sha256(expectedRequestSha256, 'request expected request')
  if (expectedGatewayJobId !== undefined) gatewayJobId(expectedGatewayJobId)
  const body = JSON.stringify({ expected_request_sha256: expectedRequestSha256 })
  return requestJson(
    `/v1/final-renders/by-idempotency-key/${encodeURIComponent(key)}/cancel`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    'Final render cancellation', 200,
    value => parseCancel(value, { key, digest: expectedRequestSha256, id: expectedGatewayJobId }),
  )
}

export function cancelFinalRender(jobId: string): Promise<FinalRenderCancelView> {
  gatewayJobId(jobId)
  return requestJson(
    `/v1/final-renders/${jobId}/cancel`, { method: 'POST' },
    'Final render cancellation', 200,
    value => parseCancel(value, { id: jobId }),
  )
}

export async function downloadFinalRenderOutputRange(input: {
  gateway_job_id: string
  start: number
  end_inclusive: number
  etag: string
  /** Tests shorten the idle bound; production keeps `RANGE_IDLE_TIMEOUT_MS`. */
  idle_timeout_ms?: number
}): Promise<FinalRenderOutputChunk> {
  gatewayJobId(input.gateway_job_id)
  nonnegativeSafeInteger(input.start, 'request output range start')
  nonnegativeSafeInteger(input.end_inclusive, 'request output range end')
  if (input.end_inclusive < input.start) invalid('request output range is reversed')
  const length = input.end_inclusive - input.start + 1
  if (!Number.isSafeInteger(length) || length > MAX_CHUNK_BYTES) invalid('request output range exceeds the 8 MiB limit')
  if (typeof input.etag !== 'string' || !/^"[0-9a-f]{64}"$/.test(input.etag)) invalid('request output ETag is invalid')
  const access = await readPrivateRenderAccess()
  // 1.4.415 — an IDLE bound per range, because the phase no longer has a wall-clock ceiling over it.
  // A range that keeps delivering bytes is progress; one that stops is over. Without this, removing the
  // phase ceiling would trade a false failure for a transfer that can hang for ever.
  const idleBoundMs = input.idle_timeout_ms ?? RANGE_IDLE_TIMEOUT_MS
  const idle = createIdleAbort(idleBoundMs, seconds => `Final render range stalled: no bytes for ${seconds}s`)
  let response: Response
  try {
    response = await fetch(`${access.origin}/v1/final-renders/${input.gateway_job_id}/output`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${access.bearer}`,
        'X-Story-Instance': access.story_instance_id,
        Accept: 'video/mp4',
        Range: `bytes=${input.start}-${input.end_inclusive}`,
        'If-Match': input.etag,
      },
      redirect: 'error',
      signal: idle.signal,
    })
  } catch (error) {
    idle.dispose()
    throw error
  }
  let bytes: Uint8Array
  try {
    bytes = await readBounded(response, length, () => idle.touch())
  } finally {
    idle.dispose()
  }
  const range = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(response.headers.get('Content-Range') ?? '')
  const contentLength = response.headers.get('Content-Length')
  const parsedLength = contentLength && /^[0-9]+$/.test(contentLength) ? Number(contentLength) : Number.NaN
  const start = range ? Number(range[1]) : Number.NaN
  const end = range ? Number(range[2]) : Number.NaN
  const total = range ? Number(range[3]) : Number.NaN
  if (response.status !== 206 || response.headers.get('Accept-Ranges') !== 'bytes'
      || response.headers.get('ETag') !== input.etag
      || response.headers.get('Content-Type') !== 'video/mp4'
      || !Number.isSafeInteger(parsedLength) || parsedLength !== length
      || !Number.isSafeInteger(start) || start !== input.start
      || !Number.isSafeInteger(end) || end !== input.end_inclusive
      || !Number.isSafeInteger(total) || total <= end
      || bytes.byteLength !== length) {
    throw new Error('Final render output range contract is invalid')
  }
  return {
    bytes, start, end_inclusive: end, total_bytes: total,
    etag: input.etag, sha256: input.etag.slice(1, -1),
  }
}

export function encodeFinalRenderAckBody(expectedReceiptDigest: string): Uint8Array {
  sha256(expectedReceiptDigest, 'request expected receipt')
  return Buffer.from(JSON.stringify({ expected_receipt_digest: expectedReceiptDigest }), 'utf8')
}

export function ackFinalRender(jobId: string, expectedReceiptDigest: string): Promise<FinalRenderAckView> {
  gatewayJobId(jobId)
  const body = encodeFinalRenderAckBody(expectedReceiptDigest)
  return requestJson(
    `/v1/final-renders/${jobId}/ack`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) },
      body,
    },
    'Final render acknowledgement', 200,
    value => parseAck(value, jobId, expectedReceiptDigest),
  )
}
