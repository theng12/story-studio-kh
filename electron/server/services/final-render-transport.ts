import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { describeFinalRenderExport, type FinalRenderExportDescription } from '../lib/final-render-export.js'
import { readInstalledStoryRenderProvenance } from '../lib/final-render-build-provenance.js'
import { RenderProvenanceError, sameDescriptorPins } from '../lib/final-render-provenance-contract.js'
import {
  FINAL_RENDER_MAX_REVISION_BYTES,
  FINAL_RENDER_MAX_REVISIONS,
  FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS,
  isDefiniteFinalRenderRefusal,
  finalRenderCanonicalReceiptHash,
  validateFinalRenderTransportEvidence,
  type FinalRenderTransportRevisionRecord,
  type ValidatedFinalRenderTransportEvidence,
} from '../lib/final-render-transport-evidence.js'
import {
  FinalRenderHttpError,
  FinalRenderResponseValidationError,
  cancelFinalRenderByKey,
  getFinalRenderStatus,
  getFinalRenderBlobStatus,
  getFinalRenderCapabilities,
  lookupFinalRenderByKey,
  putFinalRenderBlob,
  submitFinalRender,
  validateSubmitBytes,
  type FinalRenderBlobStatus,
  type FinalRenderCapabilities,
  type FinalRenderCancelView,
  type FinalRenderEncodeEntry,
  type FinalRenderJobView,
} from '../lib/final-render-gateway-client.js'
import { withCrossProcessLock } from '../lib/atomic-store.js'
import type { CompositionDestinationFacts, CompositionOpts } from '../generators/video.js'
import type {
  FinalRenderIntentStagedReceiptV2,
  FinalRenderRemoteWaitReceipt,
  FinalRenderTransportReceiptV3,
} from '../models/types.js'
import { parseFinalRenderRemoteWaitReceipt, sameFinalRenderRemoteWaitIdentity } from '../lib/final-render-remote-wait.js'
import { getPrivateFinalRenderSetting } from './app-settings.js'
import {
  checkpointJobState,
  commitFinalRenderTransportTransition,
  clearFinalRenderMonitorTransientHold,
  loadAuthoritativeJob,
  loadKnownFinalRenderIntentStagedReceipt,
  markFinalRenderMonitorTransientHold,
  validateRefusedFinalRenderForLocal,
} from './job-queue.js'
import { readPrivateRenderAccess, type PrivateRenderAccess } from './private-render-identity.js'
import { getUserDataDir } from './project-manager.js'
import {
  reopenFinalRenderStagedIntent,
  stageFinalRenderIntent,
  type FinalRenderStagedSourceIdentity,
  type ReopenedFinalRenderStagedIntent,
} from './final-render-staging.js'

type PrepareOpts = Readonly<CompositionOpts & CompositionDestinationFacts>

function sameRequestedEncode(entry: FinalRenderEncodeEntry, encode: Record<string, any>): boolean {
  return entry.container === encode.container
    && entry.requested_codec === (encode.requested_codec ?? 'h264')
    && entry.requested_effort === encode.requested_effort
    && entry.crf === encode.crf
    && entry.quality_cpu_preset === encode.quality_cpu_preset
    && entry.bitrate_kbps === (encode.bitrate_kbps ?? null)
}

function destinationFacts(opts: PrepareOpts): {
  code: string
  title: string
  format: string
  project_tree_video_dir: string
} {
  if (typeof opts.code !== 'string' || !opts.code.trim() || opts.code.includes('\0')
    || typeof opts.titleHint !== 'string' || !opts.titleHint.trim() || opts.titleHint.includes('\0')
    || typeof opts.videoDir !== 'string' || !opts.videoDir.trim() || opts.videoDir.includes('\0')) {
    throw new Error('Private final render destination facts are incomplete.')
  }
  return {
    code: opts.code,
    title: opts.titleHint,
    format: opts.format,
    project_tree_video_dir: opts.videoDir,
  }
}

/**
 * The packet the Gateway will measure against its own published execution bounds, checked before any
 * durable intent exists so a composition it must refuse never becomes a parked unknown POST. Every
 * figure comes from the live descriptor (§1), and a source whose size cannot be read keeps the local
 * render rather than being guessed past.
 */
async function privateFinalRenderBoundsViolation(
  description: Readonly<FinalRenderExportDescription>,
  bounds: NonNullable<FinalRenderCapabilities['execution_bounds']>,
): Promise<string | null> {
  const recipe = description.recipe
  const canvas = recipe.canvas as { width: number; height: number; working_fps: number }
  const width = canvas.width
  const height = canvas.height
  const publishedFps = [...bounds.working_fps].sort((left, right) => left - right)
  if (!publishedFps.includes(canvas.working_fps)) {
    return `this video is ${canvas.working_fps} fps and the paired Gateway renders only `
      + `${publishedFps.join(' or ')} fps`
  }
  // v2 publishes a range instead of named pairs, and the Gateway enforces the same rule it states:
  // even edges, no longer than `max_edge`, no more than `max_pixels`.
  if ('canvas_range' in bounds) {
    const { max_edge: maxEdge, max_pixels: maxPixels } = bounds.canvas_range
    if (width % 2 !== 0 || height % 2 !== 0) {
      return `this video is ${width}x${height} and the paired Gateway renders only even width and height`
    }
    if (Math.max(width, height) > maxEdge || width * height > maxPixels) {
      return `this video is ${width}x${height} and the paired Gateway renders canvases up to `
        + `${maxEdge} px on the long edge and ${maxPixels} pixels`
    }
  } else if (!bounds.canvas_pairs.some(pair => pair.width === width && pair.height === height)) {
    return `this video is ${width}x${height} and the paired Gateway renders only `
      + bounds.canvas_pairs.map(pair => `${pair.width}x${pair.height}`).join(' or ')
  }
  const duration = recipe.target_duration_sec as number
  if (duration > bounds.max_duration_sec) {
    return `this video is ${Math.round(duration)} seconds and the paired Gateway renders at most `
      + `${bounds.max_duration_sec} seconds`
  }
  const operations = (recipe.operations as unknown[]).length
  if (operations > bounds.max_operations) {
    return `this video needs ${operations} effects and the paired Gateway renders at most `
      + `${bounds.max_operations}`
  }
  const sources = description.source_requirements
  const sizes: number[] = []
  for (const source of sources) {
    try {
      const info = await fs.stat(source.source_path)
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0) return null
      sizes.push(info.size)
    } catch {
      return null
    }
  }
  if (sources.length > bounds.max_assets) {
    return `this video sends ${sources.length} source files and the paired Gateway accepts at most `
      + `${bounds.max_assets}`
  }
  const largest = Math.max(...sizes)
  if (largest > bounds.max_asset_bytes) {
    return `one source file is ${Math.ceil(largest / (1024 * 1024))} MB and the paired Gateway accepts at `
      + `most ${Math.floor(bounds.max_asset_bytes / (1024 * 1024))} MB per file`
  }
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total > bounds.max_total_input_bytes) {
    return `the sources total ${Math.ceil(total / (1024 * 1024))} MB and the paired Gateway accepts at `
      + `most ${Math.floor(bounds.max_total_input_bytes / (1024 * 1024))} MB`
  }
  // Whole frames, exactly as the Gateway counts them: `width * height * ceil(fps * duration)`.
  const frames = Math.ceil(duration * canvas.working_fps)
  const pixelFrames = width * height * frames
  if (pixelFrames > bounds.max_pixel_frames) {
    return `this video needs ${Math.ceil(pixelFrames / 1_000_000)}M pixel-frames and the paired Gateway `
      + `allows ${Math.floor(bounds.max_pixel_frames / 1_000_000)}M`
  }
  return null
}

/** Prepare and durably hold a local S2A snapshot. This grants no send authority. */
export async function preparePrivateFinalRenderDescriptor(
  opts: PrepareOpts,
): Promise<{ kind: 'video-assembly-remote-wait' } | null> {
  if (await validateRefusedFinalRenderForLocal(opts.job)) return null
  const known = await loadKnownFinalRenderIntentStagedReceipt(opts.job.project_slug, opts.job.job_id)
  const setting = await getPrivateFinalRenderSetting()
  if (!setting.enabled) {
    if (known) throw new Error('Existing private final render lineage is recovery-blocked; local rendering is refused.')
    opts.job.output_lines.push('Private final render: off in Settings, so this video stays on this Mac.')
    return null
  }

  const installed = await readInstalledStoryRenderProvenance()
  if (installed.status === 'unavailable' || installed.provenance.mode === 'tool-only') {
    if (known) throw new Error('Existing private final render lineage requires recovery; this build refuses local rendering.')
    opts.job.output_lines.push('Private final render: this build carries no paired render descriptor pins, '
      + 'so this video stays on this Mac. The render is otherwise unchanged.')
    return null
  }
  if (installed.provenance.mode === 'sealed-candidate') {
    throw new RenderProvenanceError('sealed-candidate builds cannot prepare or replace a private snapshot')
  }

  if (opts.format !== 'mp4') {
    if (known) throw new Error('Existing private final render lineage requires recovery before local rendering.')
    opts.job.output_lines.push(`Private final render: ${opts.format} output is not supported remotely, `
      + 'so this video stays on this Mac. The render is otherwise unchanged.')
    return null
  }
  // The paired Gateway profile only qualifies an H.264 render, and its output
  // check requires exactly one H.264/AAC stream. An accepted H.265 packet would
  // therefore fail on the Hub after the assets were staged and the job accepted,
  // so refuse it before discovery and keep the local encode.
  if (opts.codec === 'h265') {
    if (known) throw new Error('Existing private final render lineage requires recovery before local rendering.')
    opts.job.output_lines.push('Private final render: H.265 output is not supported remotely, '
      + 'so this video stays on this Mac. The render is otherwise unchanged.')
    return null
  }
  const loudness = opts.resolvedLoudness
  if (!loudness || !Number.isFinite(loudness.lufs) || !Number.isFinite(loudness.true_peak_db)
    || !Number.isFinite(loudness.tolerance_pct)
    || (loudness.check !== 'off' && loudness.check !== 'warn' && loudness.check !== 'block')) {
    throw new Error('Private final render resolved loudness authority is incomplete.')
  }

  const destination = destinationFacts(opts)
  let discovery: Awaited<ReturnType<typeof getFinalRenderCapabilities>>
  let access: Awaited<ReturnType<typeof readPrivateRenderAccess>>
  try {
    discovery = await getFinalRenderCapabilities()
    access = await readPrivateRenderAccess()
  } catch (error) {
    if (known) throw new Error('Existing private final render lineage requires recovery before local rendering.')
    opts.job.output_lines.push('Private final render: the paired Gateway render capability could not be read, '
      + `so this video stays on this Mac (${(error as Error)?.message || error}). The render is otherwise unchanged.`)
    return null
  }
  if (!sameDescriptorPins(installed.provenance.descriptors, {
    profile_digest: discovery.profile_digest,
    tools_digest: discovery.tools.digest,
    compiler_digest: discovery.compiler.digest,
  })) {
    if (known) throw new RenderProvenanceError('installed descriptor pins do not match the paired Gateway')
    opts.job.output_lines.push('Private final render: this build’s descriptor pins do not match the paired Gateway, '
      + 'so this video stays on this Mac. The render is otherwise unchanged.')
    return null
  }
  const description = describeFinalRenderExport(opts, discovery)
  if (description.kind !== 'exportable') {
    if (known) throw new Error('Existing private final render lineage requires recovery before local rendering.')
    opts.job.output_lines.push(`Private final render: this video stays on this Mac — the composition is not `
      + `representable remotely (${description.reason.replaceAll('_', ' ')}). The render is otherwise unchanged.`)
    return null
  }
  // The paired machine advertises, from its own pinned compiler, exactly which encode
  // combinations its qualified tier can execute. Present-but-null means the Gateway had
  // no common authority to publish, so nothing is claimed executable; an absent key is
  // an older Gateway and keeps today's behavior. Without this check the packet would be
  // staged and accepted only to fail at the render boundary, so an unqualified encode
  // stays local with the user's settings untouched.
  if (discovery.encode !== undefined
      && (discovery.encode === null
        || !discovery.encode.entries.some(entry =>
          sameRequestedEncode(entry, description.recipe.encode as Record<string, any>)))) {
    if (known) throw new Error('Existing private final render lineage requires recovery before local rendering.')
    // Two unrelated causes reach this branch and the owner acts on them differently. The Gateway
    // publishes `encode: null` when NO candidate was eligible at all (`render_service.capabilities`
    // intersects an empty list, and `fleet.render_encode_intersection` answers None for it) as well
    // as when the eligible Macs share no encode. Telling a customer their encode is unqualified
    // when the truth is "no Mac was free" is a reason they will act on wrongly, so name the cause
    // the Gateway actually published.
    opts.job.output_lines.push(discovery.eligible === 0
      ? 'Private final render: no other Mac was free to take this render, so this video stays on '
        + 'this Mac. The render is otherwise unchanged.'
      : 'Private final render: this exact encode is not qualified for remote rendering, '
        + 'so this video stays on this Mac. The render is otherwise unchanged.')
    return null
  }
  if (description.composition.still_tail_from_sec !== null) {
    opts.job.output_lines.push('Private final render: the still tail is sent in full; this build does not claim '
      + 'the local still-loop acceleration for a remote encode.')
  }
  // The Gateway enforces these same published figures in `_require_packet_bounds` and answers an
  // outside packet with 409 RENDER_PROFILE_MISMATCH — after it has already accepted the key. Checking
  // them here keeps that refusal from becoming an unknown POST, and keeps the composition local.
  if (discovery.execution_bounds) {
    const violation = await privateFinalRenderBoundsViolation(description, discovery.execution_bounds)
    if (violation) {
      if (known) throw new Error('Existing private final render lineage requires recovery before local rendering.')
      opts.job.output_lines.push(`Private final render: ${violation}, so it stays on this Mac. `
        + 'The render is otherwise unchanged.')
      return null
    }
  }

  // The imported finish runs this render's own final checks. Its expectation and level authority are
  // staged with the intent: a receipt freezes job.result, so they survive every recovery path, and a
  // later build can never substitute today's settings for what this render was asked to produce.
  if (opts.finalCheckExpected) {
    opts.job.result = {
      ...(opts.job.result || {}),
      final_render_finish: {
        ...((opts.job.result?.final_render_finish as Record<string, unknown> | undefined) || {}),
        format: opts.format,
        total_render_duration: opts.targetDuration,
        final_check_expected: structuredClone(opts.finalCheckExpected),
        loudness: opts.resolvedLoudness ? structuredClone(opts.resolvedLoudness) : null,
      },
    }
    await checkpointJobState(opts.job)
  }

  return stageFinalRenderIntent({
    job: opts.job,
    description,
    discovery,
    scope: {
      origin: access.origin,
      owner_scope: access.owner_scope,
      gateway_instance_id: access.gateway_instance_id,
      story_instance_id: access.story_instance_id,
    },
    destination,
    loudness: structuredClone(loudness),
  })
}

const MAX_CHUNK_BYTES = 8 * 1024 * 1024
const TRANSITION_EVENTS = new Set([
  'request_sealed', 'send_may_start', 'post_accepted', 'post_unknown', 'lookup_accepted', 'lookup_not_found',
  'monitor_output_ready', 'monitor_recovery_hold', 'monitor_cancel_terminal', 'post_refused', 'lookup_refused',
  'output_import_intent', 'output_imported', 'output_ack_observed', 'output_ack_reconciled',
])

export type Chain = ValidatedFinalRenderTransportEvidence

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalReceiptHash(receipt: FinalRenderRemoteWaitReceipt): string {
  return finalRenderCanonicalReceiptHash(receipt)
}

function sameReceipt(left: FinalRenderRemoteWaitReceipt, right: FinalRenderRemoteWaitReceipt): boolean {
  return sameFinalRenderRemoteWaitIdentity(left, right)
    && left.revision === right.revision
    && left.cancel_requested_at === right.cancel_requested_at
}

function v2Projection(receipt: FinalRenderRemoteWaitReceipt): FinalRenderIntentStagedReceiptV2 {
  if (receipt.version === 2) return receipt
  if (receipt.version !== 3) throw new Error('Private final render staged lineage is unavailable.')
  return {
    version: 2, phase: 'intent_staged', revision: 1,
    job_id: receipt.job_id, intent_id: receipt.intent_id,
    story_instance_id: receipt.story_instance_id, story_attempt: receipt.story_attempt,
    gateway_attempt_key: receipt.gateway_attempt_key, packet_sha256: receipt.packet_sha256,
    staging_manifest_sha256: receipt.staging_manifest_sha256,
    submission_scope_sha256: receipt.submission_scope_sha256,
    destination_fence_sha256: receipt.destination_fence_sha256,
    source_generation_fence_sha256: receipt.source_generation_fence_sha256,
    committed_at: receipt.committed_at, cancel_requested_at: null,
  }
}

function nonSecretAccess(access: PrivateRenderAccess): Record<string, unknown> {
  return {
    origin: access.origin, owner_scope: access.owner_scope,
    gateway_instance_id: access.gateway_instance_id, story_instance_id: access.story_instance_id,
  }
}

const SUBMISSION_KEYS = [
  'format', 'job_id', 'intent_id', 'story_instance_id', 'story_attempt', 'gateway_attempt_key',
  'request_body_sha256', 'request_body_bytes', 'packet_sha256', 'staging_manifest_sha256',
  'pairing_identity_sha256', 'profile_sha256', 'tools_sha256', 'compiler_sha256', 'sources',
] as const

function validateSubmission(
  value: unknown,
  receipt: FinalRenderRemoteWaitReceipt,
  access: PrivateRenderAccess,
): void {
  if (!exactKeys(value, SUBMISSION_KEYS)) throw new Error('Private final render submission record is not closed.')
  if (value.format !== 'studio.render.story-submission.v1'
    || value.job_id !== receipt.job_id || value.intent_id !== receipt.intent_id
    || value.story_instance_id !== v2Projection(receipt).story_instance_id
    || value.story_attempt !== v2Projection(receipt).story_attempt
    || value.gateway_attempt_key !== v2Projection(receipt).gateway_attempt_key
    || value.packet_sha256 !== v2Projection(receipt).packet_sha256
    || value.staging_manifest_sha256 !== v2Projection(receipt).staging_manifest_sha256
    || value.pairing_identity_sha256 !== digest(JSON.stringify(nonSecretAccess(access)))
    || !/^[0-9a-f]{64}$/.test(value.profile_sha256)
    || !/^[0-9a-f]{64}$/.test(value.tools_sha256)
    || !/^[0-9a-f]{64}$/.test(value.compiler_sha256)
    || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 32) {
    throw new Error('Private final render submission lineage is invalid.')
  }
}

/** Gateway API key rotation must not abort an in-flight transfer; identity must not change. */
function sameAccess(left: PrivateRenderAccess, right: PrivateRenderAccess): boolean {
  return JSON.stringify(nonSecretAccess(left)) === JSON.stringify(nonSecretAccess(right))
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

async function readStable(pathname: string, maximum: number): Promise<Buffer> {
  const handle = await fs.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximum)) throw new Error('Private render file is unsafe.')
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) throw new Error('Private render file ended early.')
      offset += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const visible = await fs.lstat(pathname, { bigint: true })
    if (!visible.isFile() || visible.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || visible.dev !== after.dev || visible.ino !== after.ino || visible.size !== after.size
      || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs) {
      throw new Error('Private render file identity changed during readback.')
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function publishImmutable(pathname: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 })
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await syncDirectory(path.dirname(pathname))
  } catch (error: any) {
    await handle?.close().catch(() => undefined)
    if (error?.code !== 'EEXIST') throw error
    const existing = await readStable(pathname, Math.max(bytes.byteLength, FINAL_RENDER_MAX_REVISION_BYTES, 1024 * 1024))
    if (!existing.equals(bytes)) throw new Error('Private final render immutable file changed; recovery is required.')
  }
}

async function readOptionalStable(pathname: string, maximum: number): Promise<Buffer | undefined> {
  try { return await readStable(pathname, maximum) }
  catch (error: any) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function loadChain(
  intentDir: string,
  staged: FinalRenderIntentStagedReceiptV2,
  canonical: FinalRenderRemoteWaitReceipt,
  manifestBytes: Uint8Array,
  expectedPairingIdentitySha256: string,
  expectedOwner?: { token: string; epoch: number },
): Promise<Chain> {
  const directory = path.join(intentDir, 'transport', 'revisions')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const names = (await fs.readdir(directory)).sort()
  if (names.length > FINAL_RENDER_MAX_REVISIONS) {
    throw new Error('Private final render revision chain exceeds its bound.')
  }
  const revisions = []
  for (const name of names) {
    revisions.push({ name, bytes: await readStable(path.join(directory, name), FINAL_RENDER_MAX_REVISION_BYTES) })
  }
  const requestBytes = await readOptionalStable(path.join(intentDir, 'transport', 'request.json'), 1024 * 1024)
  const submissionBytes = await readOptionalStable(path.join(intentDir, 'transport', 'submission.json'), 1024 * 1024)
  return validateFinalRenderTransportEvidence({
    staged, canonical, manifestBytes, revisions, requestBytes, submissionBytes,
    expectedPairingIdentitySha256, expectedOwner,
  })
}

async function appendRevision(
  intentDir: string,
  chain: Chain,
  canonical: FinalRenderRemoteWaitReceipt,
  ownerToken: string,
  ownerEpoch: number,
  event: string,
  payload: Record<string, any>,
): Promise<{ value: FinalRenderTransportRevisionRecord; bytes: Buffer; sha256: string }> {
  const value: FinalRenderTransportRevisionRecord = {
    version: 1, sequence: chain.records.length + 1,
    previous_sha256: chain.records.at(-1)?.sha256 ?? null,
    canonical_before_sha256: canonicalReceiptHash(canonical), event,
    recorded_at: new Date().toISOString(), owner_token: ownerToken, owner_epoch: ownerEpoch, payload,
  }
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.byteLength > FINAL_RENDER_MAX_REVISION_BYTES || value.sequence > FINAL_RENDER_MAX_REVISIONS) {
    throw new Error('Private final render revision bound is exceeded.')
  }
  const sha256 = digest(bytes)
  const filename = `${String(value.sequence).padStart(8, '0')}-${sha256}.json`
  await publishImmutable(path.join(intentDir, 'transport', 'revisions', filename), bytes)
  const readback = await readStable(path.join(intentDir, 'transport', 'revisions', filename), FINAL_RENDER_MAX_REVISION_BYTES)
  if (!readback.equals(bytes)) throw new Error('Private final render revision readback changed.')
  const item = { value, bytes, sha256 }
  chain.records.push(item)
  chain.ownerToken = ownerToken
  chain.ownerEpoch = ownerEpoch
  return item
}

function afterProjection(receipt: FinalRenderTransportReceiptV3): Omit<FinalRenderTransportReceiptV3, 'transport_revision_sha256'> {
  const { transport_revision_sha256: _digest, ...after } = receipt
  return after
}

function withRevision(
  after: Omit<FinalRenderTransportReceiptV3, 'transport_revision_sha256'>,
  revisionSha256: string,
): FinalRenderTransportReceiptV3 {
  return { ...after, transport_revision_sha256: revisionSha256 }
}

function lineage(receipt: FinalRenderIntentStagedReceiptV2): Record<string, unknown> {
  return {
    job_id: receipt.job_id, intent_id: receipt.intent_id, story_instance_id: receipt.story_instance_id,
    story_attempt: receipt.story_attempt, gateway_attempt_key: receipt.gateway_attempt_key,
    packet_sha256: receipt.packet_sha256, staging_manifest_sha256: receipt.staging_manifest_sha256,
    submission_scope_sha256: receipt.submission_scope_sha256,
    destination_fence_sha256: receipt.destination_fence_sha256,
    source_generation_fence_sha256: receipt.source_generation_fence_sha256,
    committed_at: receipt.committed_at,
  }
}

async function canonicalReceipt(projectSlug: string, jobId: string): Promise<FinalRenderRemoteWaitReceipt> {
  const job = await loadAuthoritativeJob(projectSlug, jobId)
  const parsed = parseFinalRenderRemoteWaitReceipt(job?.final_render_remote_wait, jobId)
  if (!job || job.project_slug !== projectSlug || job.type !== 'video_assembly' || job.status !== 'running' || !parsed.ok) {
    throw new Error('Private final render canonical lineage requires recovery.')
  }
  return parsed.receipt
}

export type AuthorityEvidence = {
  intentDir: string
  staged: FinalRenderIntentStagedReceiptV2
  manifestBytes: Uint8Array
  pairingIdentitySha256: string
}

async function assertAuthority(
  projectSlug: string,
  jobId: string,
  expected: FinalRenderRemoteWaitReceipt,
  access: PrivateRenderAccess,
  evidence: AuthorityEvidence,
  owner: { token: string; epoch: number },
): Promise<void> {
  const setting = await getPrivateFinalRenderSetting()
  if (!setting.enabled) throw new Error('Private final render setting is no longer enabled.')
  const currentAccess = await readPrivateRenderAccess()
  if (!sameAccess(access, currentAccess)) throw new Error('Private final render pairing authority changed.')
  const current = await canonicalReceipt(projectSlug, jobId)
  if (!sameReceipt(current, expected) || current.cancel_requested_at !== null) {
    throw new Error('Private final render canonical authority changed or was cancelled.')
  }
  await loadChain(
    evidence.intentDir, evidence.staged, current, evidence.manifestBytes,
    evidence.pairingIdentitySha256, owner,
  )
}

async function assertMonitorAuthority(
  projectSlug: string,
  jobId: string,
  expected: FinalRenderRemoteWaitReceipt,
  access: PrivateRenderAccess,
  evidence: AuthorityEvidence,
  owner?: { token: string; epoch: number },
): Promise<void> {
  const currentAccess = await readPrivateRenderAccess()
  if (!sameAccess(access, currentAccess)) throw new Error('Private final render monitor pairing authority changed.')
  const current = await canonicalReceipt(projectSlug, jobId)
  if (!sameReceipt(current, expected)) throw new Error('Private final render monitor canonical authority changed.')
  await loadChain(
    evidence.intentDir, evidence.staged, current, evidence.manifestBytes,
    evidence.pairingIdentitySha256, owner,
  )
}

async function acquireOwner(
  intentDir: string,
  chain: Chain,
  canonical: FinalRenderRemoteWaitReceipt,
): Promise<{ token: string; epoch: number }> {
  const token = randomUUID()
  const epoch = chain.ownerEpoch + 1
  await appendRevision(intentDir, chain, canonical, token, epoch, 'owner_acquired', {
    lineage: lineage(v2Projection(canonical)), previous_owner_epoch: chain.ownerEpoch, owner_epoch: epoch,
  })
  return { token, epoch }
}

function sameSourceIdentity(value: any, expected: FinalRenderStagedSourceIdentity): boolean {
  return value.dev === expected.dev && value.ino === expected.ino && value.size === expected.size
    && value.mtimeNs === expected.mtimeNs && value.ctimeNs === expected.ctimeNs
}

async function readChunk(
  pathname: string,
  expected: FinalRenderStagedSourceIdentity,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (pathname !== expected.pathname) throw new Error('Private final render source identity changed before upload.')
  const handle = await fs.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameSourceIdentity(before, expected)
      || offset + length > Number(before.size)) throw new Error('Private final render source range is invalid or changed.')
    const bytes = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, offset + read)
      if (!result.bytesRead) throw new Error('Private final render source range ended early.')
      read += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const visible = await fs.lstat(pathname, { bigint: true })
    if (!sameSourceIdentity(after, expected) || !visible.isFile() || visible.isSymbolicLink()
      || !sameSourceIdentity(visible, expected)) {
      throw new Error('Private final render source changed during upload.')
    }
    return bytes
  } finally { await handle.close().catch(() => undefined) }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

async function appendObserved(
  intentDir: string,
  chain: Chain,
  canonical: FinalRenderRemoteWaitReceipt,
  owner: { token: string; epoch: number },
  event: 'blob_status_observed' | 'blob_put_observed',
  hopId: string,
  response: FinalRenderBlobStatus,
): Promise<void> {
  await appendRevision(intentDir, chain, canonical, owner.token, owner.epoch, event, {
    hop_id: hopId, response: structuredClone(response),
  })
}

async function uploadAssets(input: {
  projectSlug: string
  jobId: string
  canonical: FinalRenderRemoteWaitReceipt
  access: PrivateRenderAccess
  intentDir: string
  manifest: Record<string, any>
  sourceIdentities: Record<string, FinalRenderStagedSourceIdentity>
  evidence: AuthorityEvidence
  chain: Chain
  owner: { token: string; epoch: number }
}): Promise<Record<string, string>> {
  const assets: Record<string, string> = {}
  const completed = new Map<string, string>()
  const sources = new Map((input.manifest.sources as any[]).map(source => [source.logical_id, source]))
  for (const item of input.manifest.packet.manifest as any[]) {
    const source = sources.get(item.logical_id) as any
    const sourceIdentity = input.sourceIdentities[item.logical_id]
    if (!source || source.sha256 !== item.sha256 || source.size_bytes !== item.size_bytes) {
      throw new Error('Private final render packet/source binding is invalid.')
    }
    if (!sourceIdentity || sourceIdentity.pathname !== path.join(input.intentDir, source.safe_name)) {
      throw new Error('Private final render staged source identity is unavailable.')
    }
    const blobKey = `${source.sha256}:${source.size_bytes}`
    const reused = completed.get(blobKey)
    if (reused) { assets[item.logical_id] = reused; continue }
    const outstandingPending = input.chain.unresolvedPut
    const outstandingRepeat = input.chain.repeatPut
    const recovery = outstandingPending ?? outstandingRepeat
    const recoveringThisSource = recovery !== null
      && recovery.payload.logical_id === item.logical_id
      && recovery.payload.safe_name === source.safe_name
      && recovery.payload.asset_sha256 === source.sha256
      && recovery.payload.size_bytes === source.size_bytes
    const blockedByOtherRecovery = !!recovery && !recoveringThisSource
    let pending = recoveringThisSource ? outstandingPending : null
    let repeat = recoveringThisSource ? outstandingRepeat : null
    let status: FinalRenderBlobStatus | null = null
    while (!status || status.state !== 'complete') {
      await assertAuthority(input.projectSlug, input.jobId, input.canonical, input.access, input.evidence, input.owner)
      const hopId = randomBytes(16).toString('hex')
      const pendingPayload = pending?.payload
      const reconciles = pendingPayload ? pendingPayload.hop_id : null
      await appendRevision(input.intentDir, input.chain, input.canonical, input.owner.token, input.owner.epoch,
        'blob_status_intent', {
          hop_id: hopId, logical_id: item.logical_id, safe_name: source.safe_name,
          asset_sha256: source.sha256, size_bytes: source.size_bytes,
          offset: status?.offset ?? pendingPayload?.offset ?? repeat?.payload.offset ?? 0,
          length: 0, reconciles_hop_id: reconciles,
        })
      await assertAuthority(input.projectSlug, input.jobId, input.canonical, input.access, input.evidence, input.owner)
      status = await getFinalRenderBlobStatus(source.sha256, source.size_bytes)
      await assertAuthority(input.projectSlug, input.jobId, input.canonical, input.access, input.evidence, input.owner)
      await appendObserved(input.intentDir, input.chain, input.canonical, input.owner, 'blob_status_observed', hopId, status)
      if (blockedByOtherRecovery && status.state !== 'complete') {
        throw new Error('Private final render preceding source is incomplete while PUT recovery is outstanding.')
      }
      if (pending && reconciles) {
        const start = pending.payload.offset
        const end = start + pending.payload.length
        if (status.offset !== start && status.offset !== end) throw new Error('Private final render uncertain PUT offset requires recovery.')
        input.chain.unresolvedPut = null
        if (status.offset === start) {
          repeat = pending
          input.chain.repeatPut = repeat
        }
        pending = null
      }
      if (repeat && status.state === 'complete') {
        throw new Error('Private final render exact PUT repeat remains required.')
      }
      if (status.state === 'complete') break
      const offset = status.offset
      const length = Math.min(MAX_CHUNK_BYTES, source.size_bytes - offset)
      if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Private final render upload range is invalid.')
      const chunk = await readChunk(path.join(input.intentDir, source.safe_name), sourceIdentity, offset, length)
      const chunkSha256 = digest(chunk)
      const requiredRepeat = repeat ?? pending
      if (requiredRepeat && (requiredRepeat.payload.offset !== offset || requiredRepeat.payload.length !== length
        || requiredRepeat.payload.chunk_sha256 !== chunkSha256)) {
        throw new Error('Private final render uncertain PUT range changed before retry.')
      }
      await assertAuthority(input.projectSlug, input.jobId, input.canonical, input.access, input.evidence, input.owner)
      const putHop = randomBytes(16).toString('hex')
      const putPayload = {
        hop_id: putHop, logical_id: item.logical_id, safe_name: source.safe_name,
        asset_sha256: source.sha256, size_bytes: source.size_bytes,
        offset, length, chunk_sha256: chunkSha256,
      }
      await appendRevision(input.intentDir, input.chain, input.canonical, input.owner.token, input.owner.epoch,
        'blob_put_intent', putPayload)
      repeat = null
      input.chain.repeatPut = null
      await assertAuthority(input.projectSlug, input.jobId, input.canonical, input.access, input.evidence, input.owner)
      try {
        status = await putFinalRenderBlob({
          sha256: source.sha256, total_bytes: source.size_bytes, offset, length, body: byteStream(chunk),
        })
      } catch (error) {
        throw new Error('Private final render PUT outcome is uncertain.', { cause: error })
      }
      await assertAuthority(input.projectSlug, input.jobId, input.canonical, input.access, input.evidence, input.owner)
      await appendObserved(input.intentDir, input.chain, input.canonical, input.owner, 'blob_put_observed', putHop, status)
      pending = null
    }
    if (!status.asset_handle || !/^[0-9a-f]{32}$/.test(status.asset_handle)) {
      throw new Error('Private final render Gateway asset handle is invalid.')
    }
    completed.set(blobKey, status.asset_handle)
    assets[item.logical_id] = status.asset_handle
  }
  if (input.chain.unresolvedPut || input.chain.repeatPut) {
    throw new Error('Private final render PUT recovery source is absent from the fixed packet order.')
  }
  return assets
}

async function appendCanonicalTransition(
  projectSlug: string,
  jobId: string,
  intentDir: string,
  chain: Chain,
  before: FinalRenderRemoteWaitReceipt,
  owner: { token: string; epoch: number },
  event: string,
  after: Omit<FinalRenderTransportReceiptV3, 'transport_revision_sha256'>,
  extra: Record<string, unknown> = {},
): Promise<{ kind: 'fresh_transition' | 'already_after'; receipt: FinalRenderTransportReceiptV3 }> {
  const revision = await appendRevision(intentDir, chain, before, owner.token, owner.epoch, event, {
    after, ...extra,
  })
  const target = withRevision(after, revision.sha256)
  return commitFinalRenderTransportTransition(projectSlug, jobId, before, target)
}

async function reconcilePrivateTransition(
  projectSlug: string,
  jobId: string,
  chain: Chain,
  current: FinalRenderRemoteWaitReceipt,
): Promise<{ receipt: FinalRenderRemoteWaitReceipt; sendGranted: boolean }> {
  const candidate = [...chain.records].reverse().find(item => TRANSITION_EVENTS.has(item.value.event)
    && item.value.payload?.after && item.value.canonical_before_sha256 === canonicalReceiptHash(current))
  if (!candidate) return { receipt: current, sendGranted: false }
  const target = withRevision(candidate.value.payload.after, candidate.sha256)
  const parsed = parseFinalRenderRemoteWaitReceipt(target, jobId)
  if (!parsed.ok || parsed.receipt.version !== 3) throw new Error('Private final render pending transition is invalid.')
  const committed = await commitFinalRenderTransportTransition(projectSlug, jobId, current, parsed.receipt)
  return {
    receipt: committed.receipt,
    sendGranted: candidate.value.event === 'send_may_start' && committed.kind === 'fresh_transition',
  }
}

function v3Base(
  receipt: FinalRenderIntentStagedReceiptV2,
  requestSha256: string,
  requestBytes: number,
): Omit<FinalRenderTransportReceiptV3, 'transport_revision_sha256'> {
  return {
    version: 3, phase: 'request_persisted', revision: 2,
    job_id: receipt.job_id, intent_id: receipt.intent_id, story_instance_id: receipt.story_instance_id,
    story_attempt: receipt.story_attempt, gateway_attempt_key: receipt.gateway_attempt_key,
    packet_sha256: receipt.packet_sha256, staging_manifest_sha256: receipt.staging_manifest_sha256,
    submission_scope_sha256: receipt.submission_scope_sha256,
    destination_fence_sha256: receipt.destination_fence_sha256,
    source_generation_fence_sha256: receipt.source_generation_fence_sha256,
    committed_at: receipt.committed_at, cancel_requested_at: null,
    request_body_sha256: requestSha256, request_body_bytes: requestBytes, gateway_job_id: null,
  }
}

async function acceptRemoteResult(input: {
  projectSlug: string
  jobId: string
  intentDir: string
  chain: Chain
  before: FinalRenderTransportReceiptV3
  owner: { token: string; epoch: number }
  event: 'post_accepted' | 'lookup_accepted'
  response: FinalRenderJobView
}): Promise<FinalRenderTransportReceiptV3> {
  const after = afterProjection({
    ...input.before, phase: 'remote_wait', revision: input.before.revision + 1,
    gateway_job_id: input.response.id, transport_revision_sha256: '0'.repeat(64),
  })
  const result = await appendCanonicalTransition(input.projectSlug, input.jobId, input.intentDir, input.chain,
    input.before, input.owner, input.event, after, { response: structuredClone(input.response) })
  return result.receipt
}

type MonitorContext = {
  current: FinalRenderTransportReceiptV3
  staged: FinalRenderIntentStagedReceiptV2
  access: PrivateRenderAccess
  intentDir: string
  evidence: AuthorityEvidence
  chain: Chain
}

export interface FinalRenderImportSession {
  projectSlug: string
  jobId: string
  current: FinalRenderTransportReceiptV3
  staged: FinalRenderIntentStagedReceiptV2
  access: PrivateRenderAccess
  reopened: ReopenedFinalRenderStagedIntent
  evidence: AuthorityEvidence
  chain: Chain
  owner: { token: string; epoch: number }
  outputView: FinalRenderJobView
}

function cancellationOverlayOf(
  expected: FinalRenderTransportReceiptV3,
  candidate: FinalRenderTransportReceiptV3,
): boolean {
  if (expected.cancel_requested_at !== null || candidate.cancel_requested_at === null
    || candidate.revision !== expected.revision + 1) return false
  return sameFinalRenderRemoteWaitIdentity({
    ...candidate,
    revision: expected.revision,
    cancel_requested_at: expected.cancel_requested_at,
  }, expected)
}

export async function refreshFinalRenderImportSession(
  session: FinalRenderImportSession,
): Promise<FinalRenderTransportReceiptV3> {
  if (!(await getPrivateFinalRenderSetting()).enabled) {
    throw new Error('Private final render setting is no longer enabled.')
  }
  const current = await canonicalReceipt(session.projectSlug, session.jobId)
  if (current.version !== 3 || (!sameReceipt(current, session.current)
    && !cancellationOverlayOf(session.current, current))) {
    throw new Error('Private final render import canonical authority changed.')
  }
  if (!sameAccess(session.access, await readPrivateRenderAccess())) {
    throw new Error('Private final render import pairing authority changed.')
  }
  const reopened = await reopenFinalRenderStagedIntent(session.projectSlug, session.jobId, session.staged)
  if (!reopened.manifest_bytes.equals(session.reopened.manifest_bytes)) {
    throw new Error('Private final render staged authority changed during import.')
  }
  session.chain = await loadChain(
    reopened.intent_dir, session.staged, current, reopened.manifest_bytes,
    session.evidence.pairingIdentitySha256, session.owner,
  )
  session.current = current
  session.reopened = reopened
  return current
}

export async function appendFinalRenderImportRevision(
  session: FinalRenderImportSession,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ value: FinalRenderTransportRevisionRecord; bytes: Buffer; sha256: string }> {
  await refreshFinalRenderImportSession(session)
  return appendRevision(
    session.reopened.intent_dir, session.chain, session.current,
    session.owner.token, session.owner.epoch, event, payload,
  )
}

export async function transitionFinalRenderImportSession(
  session: FinalRenderImportSession,
  event: string,
  phase: 'importing' | 'imported' | 'acknowledged',
  extra: Record<string, unknown> = {},
): Promise<FinalRenderTransportReceiptV3> {
  await refreshFinalRenderImportSession(session)
  if (session.current.cancel_requested_at !== null) {
    throw new Error('Private final render import was cancelled before its transition.')
  }
  const after = afterProjection({
    ...session.current,
    phase,
    revision: session.current.revision + 1,
    transport_revision_sha256: '0'.repeat(64),
  })
  const result = await appendCanonicalTransition(
    session.projectSlug, session.jobId, session.reopened.intent_dir, session.chain,
    session.current, session.owner, event, after, extra,
  )
  session.current = result.receipt
  return result.receipt
}

export async function withFinalRenderImportSession<T>(
  projectSlug: string,
  jobId: string,
  run: (session: FinalRenderImportSession) => Promise<T>,
): Promise<T> {
  const initial = await canonicalReceipt(projectSlug, jobId)
  if (initial.version !== 3 || !['output_ready', 'importing', 'imported', 'acknowledged'].includes(initial.phase)) {
    throw new Error('Private final render output is not ready for import.')
  }
  const outputKey = path.join(getUserDataDir(), 'private-render', 'locks', `${initial.intent_id}.output`)
  return withCrossProcessLock(outputKey, async () => {
    let current = await canonicalReceipt(projectSlug, jobId)
    if (current.version !== 3) throw new Error('Private final render import lineage is invalid.')
    const staged = v2Projection(current)
    const access = await readPrivateRenderAccess()
    const reopened = await reopenFinalRenderStagedIntent(projectSlug, jobId, staged)
    if (!sameAccess(access, await readPrivateRenderAccess())) {
      throw new Error('Private final render import pairing authority changed.')
    }
    const pairingIdentitySha256 = digest(JSON.stringify(nonSecretAccess(access)))
    const evidence: AuthorityEvidence = {
      intentDir: reopened.intent_dir, staged, manifestBytes: reopened.manifest_bytes,
      pairingIdentitySha256,
    }
    let chain = await loadChain(
      reopened.intent_dir, staged, current, reopened.manifest_bytes, pairingIdentitySha256,
    )
    const reconciled = await reconcilePrivateTransition(projectSlug, jobId, chain, current)
    if (reconciled.receipt.version !== 3) throw new Error('Private final render import transition recovery failed.')
    current = reconciled.receipt
    chain = await loadChain(
      reopened.intent_dir, staged, current, reopened.manifest_bytes, pairingIdentitySha256,
    )
    const owner = await acquireOwner(reopened.intent_dir, chain, current)
    const outputRecord = [...chain.records].reverse().find(record => record.value.event === 'monitor_output_ready')
    const outputView = outputRecord?.value.payload?.response as FinalRenderJobView | undefined
    if (!outputView || outputView.state !== 'output_ready' || !outputView.output_ready || !outputView.output) {
      throw new Error('Private final render authenticated output-ready evidence is missing.')
    }
    const session: FinalRenderImportSession = {
      projectSlug, jobId, current, staged, access, reopened, evidence, chain, owner,
      outputView: structuredClone(outputView),
    }
    await refreshFinalRenderImportSession(session)
    return run(session)
  })
}

function sameGatewayJobIdentity(left: FinalRenderJobView, right: FinalRenderJobView): boolean {
  return left.id === right.id
    && left.gateway_attempt_key === right.gateway_attempt_key
    && left.story_uuid === right.story_uuid
    && left.intent_id === right.intent_id
    && left.attempt_no === right.attempt_no
}

async function monitorContext(projectSlug: string, jobId: string): Promise<MonitorContext | null> {
  let current = await canonicalReceipt(projectSlug, jobId)
  if (current.version !== 3) return null
  const staged = v2Projection(current)
  const access = await readPrivateRenderAccess()
  const reopened = await reopenFinalRenderStagedIntent(projectSlug, jobId, staged)
  if (!sameAccess(access, await readPrivateRenderAccess())
    || reopened.manifest.scope?.origin !== access.origin
    || reopened.manifest.scope?.owner_scope !== access.owner_scope
    || reopened.manifest.scope?.gateway_instance_id !== access.gateway_instance_id
    || reopened.manifest.scope?.story_instance_id !== access.story_instance_id) {
    throw new Error('Private final render monitor pairing does not match the staged authority.')
  }
  const pairingIdentitySha256 = digest(JSON.stringify(nonSecretAccess(access)))
  const evidence: AuthorityEvidence = {
    intentDir: reopened.intent_dir,
    staged,
    manifestBytes: reopened.manifest_bytes,
    pairingIdentitySha256,
  }
  const chain = await loadChain(
    reopened.intent_dir, staged, current, reopened.manifest_bytes, pairingIdentitySha256,
  )
  const reconciled = await reconcilePrivateTransition(projectSlug, jobId, chain, current)
  if (reconciled.receipt.version !== 3) return null
  current = reconciled.receipt
  return { current, staged, access, intentDir: reopened.intent_dir, evidence, chain }
}

async function acquireMonitorMutationOwner(
  projectSlug: string,
  jobId: string,
  context: MonitorContext,
): Promise<{ token: string; epoch: number }> {
  await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence)
  if (!await clearFinalRenderMonitorTransientHold(projectSlug, jobId, context.current)) {
    throw new Error('Private final render monitor recovery hold could not be cleared safely.')
  }
  const owner = await acquireOwner(context.intentDir, context.chain, context.current)
  await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence, owner)
  return owner
}

async function appendMonitorJobTransition(
  projectSlug: string,
  jobId: string,
  context: MonitorContext,
  event: 'monitor_output_ready' | 'monitor_recovery_hold',
  phase: 'output_ready' | 'recovery_hold' | 'remote_failed',
  extra: Record<string, unknown>,
): Promise<void> {
  const owner = await acquireMonitorMutationOwner(projectSlug, jobId, context)
  const after = afterProjection({
    ...context.current,
    phase,
    revision: context.current.revision + 1,
    transport_revision_sha256: '0'.repeat(64),
  })
  await appendCanonicalTransition(
    projectSlug, jobId, context.intentDir, context.chain, context.current, owner, event, after, extra,
  )
}

async function recordMonitorCancellation(
  projectSlug: string,
  jobId: string,
  context: MonitorContext,
): Promise<void> {
  const owner = await acquireMonitorMutationOwner(projectSlug, jobId, context)
  const intent = await appendRevision(
    context.intentDir, context.chain, context.current, owner.token, owner.epoch,
    'monitor_cancel_intent', {
      gateway_attempt_key: context.current.gateway_attempt_key,
      request_body_sha256: context.current.request_body_sha256,
      cancel_requested_at: context.current.cancel_requested_at,
    },
  )
  await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence, owner)
  let response: FinalRenderCancelView
  try {
    response = await cancelFinalRenderByKey(
      context.current.gateway_attempt_key,
      context.current.request_body_sha256,
      context.current.gateway_job_id ?? undefined,
    )
  } catch (error) {
    await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence, owner)
    await appendRevision(
      context.intentDir, context.chain, context.current, owner.token, owner.epoch,
      'monitor_cancel_unknown', {
        cancel_intent_sha256: intent.sha256,
        failure_class: error instanceof FinalRenderHttpError
          ? 'http'
          : error instanceof FinalRenderResponseValidationError ? 'invalid-response' : 'network',
      },
    )
    throw error
  }
  await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence, owner)
  if (response.state === 'cancelled_before_acceptance') {
    if (context.current.gateway_job_id !== null || response.gateway_job_id !== undefined) {
      throw new Error('Private final render bound job cannot become a pre-acceptance cancellation.')
    }
    const after = afterProjection({
      ...context.current,
      phase: 'recovery_hold',
      revision: context.current.revision + 1,
      transport_revision_sha256: '0'.repeat(64),
    })
    await appendCanonicalTransition(
      projectSlug, jobId, context.intentDir, context.chain, context.current, owner,
      'monitor_cancel_terminal', after, {
        cancel_intent_sha256: intent.sha256,
        response: structuredClone(response),
      },
    )
    return
  }
  const duplicate = [...context.chain.records].reverse().some(record => (
    record.value.event === 'monitor_cancel_observed'
      && isDeepStrictEqual(record.value.payload?.response, response)
  ))
  if (!duplicate) {
    await appendRevision(
      context.intentDir, context.chain, context.current, owner.token, owner.epoch,
      'monitor_cancel_observed', {
        cancel_intent_sha256: intent.sha256,
        response: structuredClone(response),
      },
    )
  }
}

function monitorLookupExpectation(current: FinalRenderTransportReceiptV3) {
  return {
    id: current.gateway_job_id ?? undefined,
    storyUuid: current.story_instance_id,
    intent: current.intent_id,
    attemptNo: current.story_attempt,
    inboundDigest: current.request_body_sha256,
    packetDigest: current.packet_sha256,
  }
}

/** One monitor-only observation. It never uploads, submits, imports, acknowledges or completes a job. */
export async function reconcileSealedPrivateFinalRenderOnce(
  projectSlug: string,
  jobId: string,
): Promise<void> {
  const initial = await canonicalReceipt(projectSlug, jobId)
  if (initial.version !== 3 || initial.phase === 'request_persisted') return
  if (initial.phase === 'output_ready' || initial.phase === 'recovery_hold' || initial.phase === 'refused'
    || initial.phase === 'remote_failed') return
  const computeKey = path.join(getUserDataDir(), 'private-render', 'locks', `${initial.intent_id}.compute`)
  await withCrossProcessLock(computeKey, async () => {
    const context = await monitorContext(projectSlug, jobId)
    if (!context || context.current.phase === 'request_persisted'
      || context.current.phase === 'output_ready' || context.current.phase === 'recovery_hold'
      || context.current.phase === 'refused' || context.current.phase === 'remote_failed') return
    const expected = monitorLookupExpectation(context.current)
    let view: FinalRenderJobView
    try {
      view = await lookupFinalRenderByKey(context.current.gateway_attempt_key, expected)
    } catch (error) {
      if (error instanceof FinalRenderResponseValidationError) {
        markFinalRenderMonitorTransientHold(projectSlug, jobId)
        return
      }
      if (!(error instanceof FinalRenderHttpError) || error.status !== 404) throw error
      await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence)
      if (context.current.cancel_requested_at !== null) {
        if (context.current.gateway_job_id !== null) {
          await appendMonitorJobTransition(projectSlug, jobId, context,
            'monitor_recovery_hold', 'recovery_hold', { reason: 'bound_key_not_found', status: 404 })
        } else {
          await recordMonitorCancellation(projectSlug, jobId, context)
        }
        return
      }
      if (context.current.gateway_job_id !== null) {
        await appendMonitorJobTransition(projectSlug, jobId, context,
          'monitor_recovery_hold', 'recovery_hold', { reason: 'bound_key_not_found', status: 404 })
      } else if (context.current.phase !== 'lookup_not_found'
        || canRefuseAbsentLookup(context.chain, context.current, error.code)) {
        const owner = await acquireMonitorMutationOwner(projectSlug, jobId, context)
        await recordAbsentLookup(projectSlug, jobId, context.intentDir, context.chain,
          context.current, owner, error.code)
      }
      return
    }

    await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence)
    const originalKeyTerminal = view.remote_state === 'cancelled'
      && view.terminal_proof?.kind === 'launched_stopped'
    if (originalKeyTerminal && context.current.gateway_job_id !== null) {
      await appendMonitorJobTransition(projectSlug, jobId, context,
        'monitor_recovery_hold', 'recovery_hold', {
          reason: 'remote_cancelled', response: structuredClone(view),
        })
      return
    }
    if (context.current.gateway_job_id !== null) {
      try {
        const status = await getFinalRenderStatus(context.current.gateway_job_id, expected)
        if (!sameGatewayJobIdentity(view, status)) {
          throw new FinalRenderResponseValidationError('job status does not match its original-key observation')
        }
        view = status
      } catch (error) {
        if (error instanceof FinalRenderResponseValidationError) {
          markFinalRenderMonitorTransientHold(projectSlug, jobId)
          return
        }
        throw error
      }
      await assertMonitorAuthority(projectSlug, jobId, context.current, context.access, context.evidence)
    }

    if (context.current.gateway_job_id === null) {
      const owner = await acquireMonitorMutationOwner(projectSlug, jobId, context)
      context.current = await acceptRemoteResult({
        projectSlug, jobId, intentDir: context.intentDir, chain: context.chain,
        before: context.current, owner, event: 'lookup_accepted', response: view,
      })
    }

    if (view.state === 'acknowledged') {
      await appendMonitorJobTransition(projectSlug, jobId, context,
        'monitor_recovery_hold', 'recovery_hold', {
          reason: 'acknowledged_without_story_import', response: structuredClone(view),
        })
      return
    }
    if (view.state === 'output_ready' && view.output_ready && view.output) {
      await appendMonitorJobTransition(projectSlug, jobId, context,
        'monitor_output_ready', 'output_ready', { response: structuredClone(view) })
      return
    }
    if (view.remote_state === 'failed') {
      // The Gateway settles a render it can never accept as `failed` and will poll it no further
      // (`render_service.py _status_answer_refused`), so no output can ever arrive. A hold here has
      // no exit — the reconciler skips holds, the monitor returns early for holds, and the local
      // lane only resumes a receipt it may render locally — so the episode waited for ever. Record
      // the Gateway's own verdict as its own phase, which the local lane resumes from.
      await appendMonitorJobTransition(projectSlug, jobId, context,
        'monitor_recovery_hold', 'remote_failed', {
          reason: 'remote_failed', response: structuredClone(view),
        })
      return
    }
    if (view.remote_state === 'cancelled' && view.terminal_proof?.kind === 'launched_stopped') {
      await appendMonitorJobTransition(projectSlug, jobId, context,
        'monitor_recovery_hold', 'recovery_hold', {
          reason: 'remote_cancelled', response: structuredClone(view),
        })
      return
    }
    const cancellableNonterminal = (
      (view.state === 'staging'
        || view.state === 'hub_prepared'
        || view.state === 'send_may_start'
        || view.state === 'send_unknown'
        || view.state === 'accepted')
      && (view.remote_state === undefined
        || view.remote_state === 'accepted'
        || view.remote_state === 'launch_pending'
        || view.remote_state === 'rendering'
        || view.remote_state === 'cancel_requested'
        || view.remote_state === 'uncertain'
        || view.remote_state === 'stopped')
      && (view.cancel_state === undefined || view.cancel_state === 'requested')
      && view.terminal_proof === undefined
    )
    if (!cancellableNonterminal) {
      markFinalRenderMonitorTransientHold(projectSlug, jobId)
      return
    }
    if (!await clearFinalRenderMonitorTransientHold(projectSlug, jobId, context.current)) {
      throw new Error('Private final render monitor transient hold could not be cleared safely.')
    }
    if (context.current.cancel_requested_at !== null) {
      await recordMonitorCancellation(projectSlug, jobId, context)
    }
  })
}

function canRefuseAbsentLookup(chain: Chain, current: FinalRenderTransportReceiptV3, code: string | null): boolean {
  const unknown = chain.records.find(item => item.value.event === 'post_unknown')
  const first = chain.records.find(item => item.value.event === 'lookup_not_found')
  return current.phase === 'lookup_not_found' && current.gateway_job_id === null
    && current.cancel_requested_at === null && unknown?.value.payload.failure_class === 'http'
    && code === 'RENDER_NOT_FOUND' && first !== undefined
    && Date.parse(first.value.recorded_at) >= Date.parse(unknown.value.recorded_at)
    && Date.now() - Date.parse(first.value.recorded_at) >= FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS
}

async function recordAbsentLookup(
  projectSlug: string, jobId: string, intentDir: string, chain: Chain,
  current: FinalRenderTransportReceiptV3, owner: { token: string; epoch: number }, code: string | null,
): Promise<boolean> {
  const canRefuse = canRefuseAbsentLookup(chain, current, code)
  if (current.phase === 'lookup_not_found' && !canRefuse) return false
  const after = afterProjection({
    ...current, phase: canRefuse ? 'refused' : 'lookup_not_found', revision: current.revision + 1,
    gateway_job_id: null, transport_revision_sha256: '0'.repeat(64),
  })
  await appendCanonicalTransition(projectSlug, jobId, intentDir, chain, current, owner,
    canRefuse ? 'lookup_refused' : 'lookup_not_found', after,
    canRefuse ? { status: 404, code: 'RENDER_NOT_FOUND' } : { status: 404 })
  return canRefuse
}

/** One bounded upload/seal/send advance. It is intentionally not scheduled by this slice. */
export async function advanceSealedPrivateFinalRenderTransport(
  projectSlug: string,
  jobId: string,
): Promise<{ kind: 'video-assembly-remote-wait' } | { kind: 'video-assembly-local' }> {
  const initial = await canonicalReceipt(projectSlug, jobId)
  if (initial.version === 1) throw new Error('Private final render transport lineage is incompatible.')
  const staged = v2Projection(initial)
  const computeKey = path.join(getUserDataDir(), 'private-render', 'locks', `${staged.intent_id}.compute`)
  return withCrossProcessLock(computeKey, async () => {
    const access = await readPrivateRenderAccess()
    const setting = await getPrivateFinalRenderSetting()
    if (!setting.enabled) throw new Error('Private final render setting is not enabled.')
    let current = await canonicalReceipt(projectSlug, jobId)
    if (current.cancel_requested_at !== null) throw new Error('Private final render was cancelled and is recovery-blocked.')
    const reopened = await reopenFinalRenderStagedIntent(projectSlug, jobId, v2Projection(current))
    if (!sameAccess(access, await readPrivateRenderAccess())
      || reopened.manifest.scope?.origin !== access.origin
      || reopened.manifest.scope?.owner_scope !== access.owner_scope
      || reopened.manifest.scope?.gateway_instance_id !== access.gateway_instance_id
      || reopened.manifest.scope?.story_instance_id !== access.story_instance_id) {
      throw new Error('Private final render pairing does not match the staged authority.')
    }
    const pairingIdentitySha256 = digest(JSON.stringify(nonSecretAccess(access)))
    const evidence: AuthorityEvidence = {
      intentDir: reopened.intent_dir,
      staged,
      manifestBytes: reopened.manifest_bytes,
      pairingIdentitySha256,
    }
    const chain = await loadChain(
      reopened.intent_dir, staged, current, reopened.manifest_bytes, pairingIdentitySha256,
    )
    const reconciled = await reconcilePrivateTransition(projectSlug, jobId, chain, current)
    current = reconciled.receipt
    let sendGranted = reconciled.sendGranted
    // Every compute-lock holder records its own current owner, including the
    // invocation that just reconciled a predecessor's fresh send CAS.
    const owner = await acquireOwner(reopened.intent_dir, chain, current)

    if (current.version === 2) {
      await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
      const assets = await uploadAssets({
        projectSlug, jobId, canonical: current, access, intentDir: reopened.intent_dir,
        manifest: reopened.manifest, sourceIdentities: reopened.source_identities,
        evidence, chain, owner,
      })
      const body = {
        format: 'studio.render.gateway-request.v1', story_uuid: staged.story_instance_id,
        intent_id: staged.intent_id, attempt_no: staged.story_attempt,
        packet: reopened.manifest.packet, assets,
      }
      const request = Buffer.from(JSON.stringify(body), 'utf8')
      validateSubmitBytes(request)
      const transportDir = path.join(reopened.intent_dir, 'transport')
      const requestPath = path.join(transportDir, 'request.json')
      const submissionPath = path.join(transportDir, 'submission.json')
      const sources = (reopened.manifest.sources as any[]).map(source => ({
        logical_id: source.logical_id, safe_name: source.safe_name,
        source_sha256: source.sha256, size_bytes: source.size_bytes,
        gateway_asset_handle: assets[source.logical_id],
      }))
      const submission = {
        format: 'studio.render.story-submission.v1', job_id: staged.job_id, intent_id: staged.intent_id,
        story_instance_id: staged.story_instance_id, story_attempt: staged.story_attempt,
        gateway_attempt_key: staged.gateway_attempt_key,
        request_body_sha256: digest(request), request_body_bytes: request.byteLength,
        packet_sha256: staged.packet_sha256, staging_manifest_sha256: staged.staging_manifest_sha256,
        pairing_identity_sha256: pairingIdentitySha256,
        profile_sha256: reopened.manifest.descriptors.profile.sha256,
        tools_sha256: reopened.manifest.descriptors.tools.sha256,
        compiler_sha256: reopened.manifest.descriptors.compiler.sha256,
        sources,
      }
      await publishImmutable(requestPath, request)
      await publishImmutable(submissionPath, Buffer.from(JSON.stringify(submission), 'utf8'))
      await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
      if (!(await readStable(requestPath, 1024 * 1024)).equals(request)
        || !(await readStable(submissionPath, 1024 * 1024)).equals(Buffer.from(JSON.stringify(submission), 'utf8'))) {
        throw new Error('Private final render sealed request readback changed.')
      }
      const requestAfter = v3Base(staged, digest(request), request.byteLength)
      const promoted = await appendCanonicalTransition(projectSlug, jobId, reopened.intent_dir, chain,
        current, owner, 'request_sealed', requestAfter)
      current = promoted.receipt
    }

    if (current.version !== 3) throw new Error('Private final render V3 promotion failed.')
    const requestPath = path.join(reopened.intent_dir, 'transport', 'request.json')
    const request = await readStable(requestPath, 1024 * 1024)
    const context = validateSubmitBytes(request)
    if (request.byteLength !== current.request_body_bytes || digest(request) !== current.request_body_sha256) {
      throw new Error('Private final render immutable request hash changed.')
    }
    const submissionBytes = await readStable(path.join(reopened.intent_dir, 'transport', 'submission.json'), 1024 * 1024)
    let submissionValue: unknown
    try { submissionValue = JSON.parse(submissionBytes.toString('utf8')) } catch {
      throw new Error('Private final render submission record is invalid.')
    }
    validateSubmission(submissionValue, current, access)
    if (context.storyUuid !== current.story_instance_id || context.intent !== current.intent_id
      || context.attemptNo !== current.story_attempt || context.packetDigest !== current.packet_sha256) {
      throw new Error('Private final render request lineage is invalid.')
    }

    if (current.phase === 'request_persisted') {
      await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
      const after = afterProjection({
        ...current, phase: 'send_may_start', revision: current.revision + 1,
        transport_revision_sha256: '0'.repeat(64),
      })
      const promoted = await appendCanonicalTransition(projectSlug, jobId, reopened.intent_dir, chain,
        current, owner, 'send_may_start', after)
      current = promoted.receipt
      sendGranted = promoted.kind === 'fresh_transition'
    }

    if (current.phase === 'refused') return { kind: 'video-assembly-local' }
    if (current.phase === 'remote_wait') return { kind: 'video-assembly-remote-wait' }
    await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
    if (current.phase === 'send_may_start' && sendGranted) {
      try {
        const accepted = await submitFinalRender(request, current.gateway_attempt_key)
        await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
        await acceptRemoteResult({
          projectSlug, jobId, intentDir: reopened.intent_dir, chain, before: current, owner,
          event: 'post_accepted', response: accepted,
        })
        return { kind: 'video-assembly-remote-wait' }
      } catch (error) {
        const latest = await canonicalReceipt(projectSlug, jobId)
        if (!sameReceipt(latest, current)) throw error
        if (error instanceof FinalRenderHttpError && isDefiniteFinalRenderRefusal(error.status, error.code)) {
          await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
          const after = afterProjection({
            ...current, phase: 'refused', revision: current.revision + 1,
            gateway_job_id: null, transport_revision_sha256: '0'.repeat(64),
          })
          await appendCanonicalTransition(projectSlug, jobId, reopened.intent_dir, chain, current, owner,
            'post_refused', after, { status: error.status, code: error.code })
          return { kind: 'video-assembly-local' }
        }
        const after = afterProjection({
          ...current, phase: 'send_unknown', revision: current.revision + 1,
          gateway_job_id: null, transport_revision_sha256: '0'.repeat(64),
        })
        await appendCanonicalTransition(projectSlug, jobId, reopened.intent_dir, chain, current, owner,
          'post_unknown', after, { failure_class: error instanceof FinalRenderHttpError ? 'http' : 'network' })
        throw new Error('Private final render unknown POST outcome requires original-key lookup.', { cause: error })
      }
    }

    if (!['send_may_start', 'send_unknown', 'lookup_not_found'].includes(current.phase)) {
      throw new Error('Private final render phase requires recovery.')
    }
    try {
      const found = await lookupFinalRenderByKey(current.gateway_attempt_key, {
        storyUuid: current.story_instance_id, intent: current.intent_id, attemptNo: current.story_attempt,
      })
      await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
      await acceptRemoteResult({
        projectSlug, jobId, intentDir: reopened.intent_dir, chain, before: current, owner,
        event: 'lookup_accepted', response: found,
      })
      return { kind: 'video-assembly-remote-wait' }
    } catch (error) {
      if (error instanceof FinalRenderHttpError && error.status === 404) {
        await assertAuthority(projectSlug, jobId, current, access, evidence, owner)
        if (await recordAbsentLookup(projectSlug, jobId, reopened.intent_dir, chain, current, owner, error.code)) {
          return { kind: 'video-assembly-local' }
        }
      }
      throw error
    }
  })
}
