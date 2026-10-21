import { constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { createHash, type Hash } from 'node:crypto'
import path from 'node:path'

import { samePinnedOutput } from '../lib/final-render-transport-evidence.js'
import {
  FinalRenderHttpError,
  FinalRenderResponseValidationError,
  ackFinalRender,
  downloadFinalRenderOutputRange,
  encodeFinalRenderAckBody,
  lookupFinalRenderByKey,
  type FinalRenderJobView,
} from '../lib/final-render-gateway-client.js'
import { assertValidMedia, type MediaInfo } from '../lib/ffmpeg-validation.js'
import { finalLoudnessIssue, type LoudnessTarget } from '../lib/final-loudness.js'
import {
  storeFinalCheck, type FinalCheckExpectation, type FinalCheckResult,
} from '../lib/final-video-check.js'
import { measureLoudness } from '../generators/music-episode-build.js'
import { parseFinalRenderRemoteWaitReceipt } from '../lib/final-render-remote-wait.js'
import type { FinalRenderTransportReceiptV3, Job } from '../models/types.js'
import {
  getValidVideoAssemblyCheckpoint, isOwnedVideoAssemblyWorkDir, setVideoAssemblyCheckpoint,
} from '../lib/video-assembly-checkpoint.js'
import { withFinalVideoPathLock } from './final-video-lock.js'
import { getProjectDir, getUserDataDir } from './project-manager.js'
import { exportsAnchorFor } from './external-video-store.js'
import { ensureTrashMoveIndexedSync, moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import {
  appendFinalRenderImportRevision,
  refreshFinalRenderImportSession,
  transitionFinalRenderImportSession,
  withFinalRenderImportSession,
  type FinalRenderImportSession,
} from './final-render-transport.js'
import {
  commitFinalRenderImportTransitionMutation,
  consumeFinalRenderTerminal,
  drainFinalRenderTerminalHandoff,
  loadAuthoritativeJob,
  markFinalRenderMonitorTransientHold,
  mutateAuthoritativeJob,
  withFinalRenderImportJournalMutation,
  type FinalRenderTerminalArtifact,
} from './job-queue.js'

const MAX_RANGE_BYTES = 8 * 1024 * 1024
const FILE_HASH_BUFFER_BYTES = 1024 * 1024
const MAX_PRIVATE_JSON_BYTES = 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/

export type MediaObservation = {
  durationSec: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string
  audioCodec: string
  width: number
  height: number
  frameRate: number
  containerNames: string[]
  containerBrand: string | null
  container: 'mp4' | 'mov' | 'webm' | 'unknown'
  loudness: { lufs: number; true_peak_db: number }
}

export interface FinalRenderImportProbe {
  phase: 'after-output-owner-acquired' | 'after-output-download-prefix' | 'before-output-publication'
    | 'before-output-ack' | 'after-output-ack-unknown' | 'after-output-ack-observed'
  candidate_path?: string
  destination_path?: string
  project_slug: string
  job_id: string
}

/** The shared final checks this import must pass, with the file they describe. */
export type SharedFinalCheckRequest = {
  code: string
  format: string
  finalPath: string
  plannedSec: number
  expected: FinalCheckExpectation
  loudness: LoudnessTarget
  /** The downloaded candidate still carries its `.output-import.partial` name. */
  stagedCandidate: boolean
}

export type ImportHooks = {
  inspectMedia?: (pathname: string) => Promise<MediaObservation>
  probe?: (value: FinalRenderImportProbe) => void | Promise<void>
  /** Test-only substitution for the shared checks; unset in the app, which runs the real ones. */
  verifyFinal?: (job: Job, request: SharedFinalCheckRequest) => Promise<FinalCheckResult | null>
}

/**
 * A recoverable, deterministic hold: this import cannot prove its output is the render that was
 * asked for, so nothing is promoted, acknowledged, or completed. It is not a transient monitor
 * condition — the frozen plan is either on the row or it is not.
 */
export class FinalRenderCheckHold extends Error {
  readonly recoverable = true
  constructor(readonly reason: 'staged-without-plan', message: string) {
    super(message)
    this.name = 'FinalRenderCheckHold'
  }
}

const NO_PLAN_HOLD_MESSAGE = 'Final render check hold: this remote final was staged without its render '
  + 'plan, so it cannot be verified before publication. The downloaded candidate and its evidence were '
  + 'kept; the existing final and the Gateway row were left untouched.'
const NO_PLAN_HOLD_LINE = 'Final check hold: this remote final was staged without its render plan; '
  + 'nothing was promoted or acknowledged.'

/**
 * Record the hold where a frozen row can still keep it. While the remote-wait receipt exists,
 * `mergeDurableJobEvidence` pins `result` to the durable row, so a `result.final_render_check_hold`
 * written here would be dropped; `output_lines` and `error` are not pinned. The condition is derived
 * again on every recovery pass, so the line is written once and the row keeps its cause.
 */
async function holdWithoutRenderPlan(projectSlug: string, jobId: string): Promise<never> {
  await mutateAuthoritativeJob(projectSlug, jobId, job => {
    if (job.type !== 'video_assembly') return null
    if (!job.output_lines.includes(NO_PLAN_HOLD_LINE)) job.output_lines.push(NO_PLAN_HOLD_LINE)
    job.error = NO_PLAN_HOLD_MESSAGE
    return job
  })
  markFinalRenderMonitorTransientHold(projectSlug, jobId)
  throw new FinalRenderCheckHold('staged-without-plan', NO_PLAN_HOLD_MESSAGE)
}

let testHooks: ImportHooks = {}

/** Inert test-only observation seam; it grants no writer or authority handle. */
export function _setFinalRenderImportHooksForTesting(hooks: ImportHooks): () => void {
  const previous = testHooks
  testHooks = { ...hooks }
  return () => { testHooks = previous }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

async function stableMediaFile(pathname: string, expectedSize?: number): Promise<{
  sha256: string
  dev: string
  ino: string
  size: number
}> {
  const handle = await fs.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (expectedSize !== undefined && before.size !== BigInt(expectedSize))) {
      throw new Error('Final render import file is not a bounded regular file.')
    }
    const digest = createHash('sha256')
    const bytes = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES)
    let offset = 0
    while (offset < Number(before.size)) {
      const requested = Math.min(bytes.length, Number(before.size) - offset)
      const result = await handle.read(bytes, 0, requested, offset)
      if (!result.bytesRead) throw new Error('Final render import file ended early.')
      digest.update(bytes.subarray(0, result.bytesRead))
      offset += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const visible = await fs.lstat(pathname, { bigint: true })
    if (!visible.isFile() || visible.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || visible.dev !== after.dev || visible.ino !== after.ino || visible.size !== after.size
      || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs) {
      throw new Error('Final render import file identity changed during readback.')
    }
    return {
      sha256: digest.digest('hex'), dev: String(after.dev), ino: String(after.ino), size: Number(after.size),
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function stableBytes(pathname: string, expectedSize?: number): Promise<Buffer> {
  const handle = await fs.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_PRIVATE_JSON_BYTES)
      || (expectedSize !== undefined && before.size !== BigInt(expectedSize))) {
      throw new Error('Final render private artifact is not a bounded regular file.')
    }
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) throw new Error('Final render private artifact ended early.')
      offset += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const visible = await fs.lstat(pathname, { bigint: true })
    if (!visible.isFile() || visible.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || visible.dev !== after.dev || visible.ino !== after.ino || visible.size !== after.size
      || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs) {
      throw new Error('Final render private artifact identity changed during readback.')
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!result.bytesWritten) throw new Error('Final render output range write made no progress.')
    offset += result.bytesWritten
  }
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Final render ${label} is invalid.`)
  }
  return value as Record<string, any>
}

function outputDetails(view: FinalRenderJobView): NonNullable<FinalRenderJobView['output']> {
  if (view.state !== 'output_ready' || !view.output_ready || !view.output
    || !SHA256.test(view.output.sha256) || !SHA256.test(view.output.receipt_digest)) {
    throw new Error('Final render authenticated output-ready evidence is invalid.')
  }
  return view.output
}

function lookupExpectation(session: FinalRenderImportSession) {
  return {
    id: session.current.gateway_job_id ?? undefined,
    storyUuid: session.current.story_instance_id,
    intent: session.current.intent_id,
    attemptNo: session.current.story_attempt,
    inboundDigest: session.current.request_body_sha256,
    packetDigest: session.current.packet_sha256,
  }
}

async function strictOriginalKeyView(
  session: FinalRenderImportSession,
  requireOutputReady: boolean,
): Promise<FinalRenderJobView | null> {
  let view: FinalRenderJobView
  try {
    view = await lookupFinalRenderByKey(session.current.gateway_attempt_key, lookupExpectation(session))
  } catch (error) {
    if (error instanceof FinalRenderResponseValidationError
      || (error instanceof FinalRenderHttpError && error.status === 404)) {
      markFinalRenderMonitorTransientHold(session.projectSlug, session.jobId)
      return null
    }
    throw error
  }
  await refreshFinalRenderImportSession(session)
  if (requireOutputReady && (!samePinnedOutput(session.outputView, view) || view.state !== 'output_ready')) {
    markFinalRenderMonitorTransientHold(session.projectSlug, session.jobId)
    return null
  }
  if (!requireOutputReady && !samePinnedOutput(session.outputView, view)) {
    markFinalRenderMonitorTransientHold(session.projectSlug, session.jobId)
    return null
  }
  return view
}

function latestRevision(session: FinalRenderImportSession, event: string) {
  return [...session.chain.records].reverse().find(record => record.value.event === event)
}

function candidatePath(session: FinalRenderImportSession): string {
  const destination = record(session.reopened.manifest.destination, 'staged destination').pathname
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw new Error('Final render staged destination is invalid.')
  }
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${session.current.intent_id}.output-import.partial`,
  )
}

async function openCandidate(
  session: FinalRenderImportSession,
  pathname: string,
  outputSize: number,
): Promise<{ handle: FileHandle; offset: number; dev: string; ino: string; digest: Hash }> {
  const prefix = latestRevision(session, 'output_download_prefix')
  if (!prefix) {
    try {
      await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 })
      const handle = await fs.open(
        pathname,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      )
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size !== 0n) {
        await handle.close()
        throw new Error('Final render candidate creation was not exclusive and empty.')
      }
      return {
        handle, offset: 0, dev: String(stat.dev), ino: String(stat.ino), digest: createHash('sha256'),
      }
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        throw new Error('Final render candidate exists without durable prefix evidence; it was retained for recovery.')
      }
      throw error
    }
  }
  const payload = prefix.value.payload
  const identity = record(payload.candidate, 'candidate identity')
  const offset = payload.prefix_length
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > outputSize
    || identity.pathname !== pathname) throw new Error('Final render durable prefix identity is invalid.')
  const handle = await fs.open(pathname, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat({ bigint: true })
    const visible = await fs.lstat(pathname, { bigint: true })
    if (!stat.isFile() || !visible.isFile() || visible.isSymbolicLink()
      || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino
      || visible.dev !== stat.dev || visible.ino !== stat.ino || stat.size !== BigInt(offset)) {
      throw new Error('Final render candidate identity or prefix length changed; retained recovery is required.')
    }
    const digest = createHash('sha256')
    const bytes = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES)
    let read = 0
    while (read < offset) {
      const result = await handle.read(bytes, 0, Math.min(bytes.length, offset - read), read)
      if (!result.bytesRead) throw new Error('Final render candidate durable prefix ended early.')
      digest.update(bytes.subarray(0, result.bytesRead))
      read += result.bytesRead
    }
    if (digest.copy().digest('hex') !== payload.prefix_sha256) {
      throw new Error('Final render candidate durable prefix digest changed.')
    }
    return { handle, offset, dev: String(stat.dev), ino: String(stat.ino), digest }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function downloadOutput(
  session: FinalRenderImportSession,
  output: NonNullable<FinalRenderJobView['output']>,
): Promise<string> {
  const pathname = candidatePath(session)
  const opened = await openCandidate(session, pathname, output.size_bytes)
  try {
    let offset = opened.offset
    while (offset < output.size_bytes) {
      await refreshFinalRenderImportSession(session)
      if (session.current.cancel_requested_at !== null) break
      const end = Math.min(offset + MAX_RANGE_BYTES, output.size_bytes) - 1
      const chunk = await downloadFinalRenderOutputRange({
        gateway_job_id: session.current.gateway_job_id!, start: offset, end_inclusive: end,
        etag: `"${output.sha256}"`,
      })
      await refreshFinalRenderImportSession(session)
      if (session.current.cancel_requested_at !== null) break
      if (chunk.total_bytes !== output.size_bytes || chunk.sha256 !== output.sha256) {
        throw new Error('Final render output range changed from its authenticated receipt.')
      }
      if (chunk.bytes.byteLength !== end - offset + 1) {
        throw new Error('Final render output range length changed from its request.')
      }
      await writeAll(opened.handle, chunk.bytes, offset)
      opened.digest.update(chunk.bytes)
      await opened.handle.sync()
      const stat = await opened.handle.stat({ bigint: true })
      const visible = await fs.lstat(pathname, { bigint: true })
      if (!stat.isFile() || !visible.isFile() || visible.isSymbolicLink()
        || String(stat.dev) !== opened.dev || String(stat.ino) !== opened.ino
        || visible.dev !== stat.dev || visible.ino !== stat.ino || stat.size !== BigInt(end + 1)) {
        throw new Error('Final render candidate changed during range recovery.')
      }
      await appendFinalRenderImportRevision(session, 'output_download_prefix', {
        candidate: { pathname, dev: opened.dev, ino: opened.ino },
        start: offset, end_inclusive: end, total_bytes: output.size_bytes,
        etag: chunk.etag, response_sha256: chunk.sha256,
        prefix_length: end + 1, prefix_sha256: opened.digest.copy().digest('hex'),
      })
      offset = end + 1
      await testHooks.probe?.({
        phase: 'after-output-download-prefix', candidate_path: pathname,
        project_slug: session.projectSlug, job_id: session.jobId,
      })
      await refreshFinalRenderImportSession(session)
      if (session.current.cancel_requested_at !== null) break
    }
  } finally {
    await opened.handle.close().catch(() => undefined)
  }
  return pathname
}

async function inspectMedia(pathname: string): Promise<MediaObservation> {
  if (testHooks.inspectMedia) return testHooks.inspectMedia(pathname)
  const info: MediaInfo = await assertValidMedia(pathname, {
    label: 'private final render output', requireVideo: true, requireAudio: true,
  })
  const loudness = await measureLoudness(pathname)
  if (loudness.lufs === null || loudness.true_peak_db === null) {
    throw new Error('Final render output loudness is not measurable.')
  }
  return {
    durationSec: info.durationSec,
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio,
    videoCodec: info.videoCodec ?? '', audioCodec: info.audioCodec ?? '',
    width: info.width ?? 0, height: info.height ?? 0, frameRate: info.frameRate ?? 0,
    containerNames: [...info.containerNames], containerBrand: info.containerBrand,
    container: info.container,
    loudness: { lufs: loudness.lufs, true_peak_db: loudness.true_peak_db },
  }
}

function validateMedia(session: FinalRenderImportSession, observation: MediaObservation): void {
  const manifest = session.reopened.manifest
  const recipe = record(manifest.packet?.recipe, 'staged recipe')
  const canvas = record(recipe.canvas, 'staged canvas')
  const encode = record(recipe.encode, 'staged encode')
  const target = record(manifest.loudness, 'staged loudness')
  const expectedCodec = encode.requested_codec === 'h265' ? 'hevc' : 'h264'
  const durationTolerance = Math.max(0.25, Number(recipe.target_duration_sec) * 0.01)
  if (!observation.hasVideo || !observation.hasAudio || observation.container !== 'mp4'
    || observation.videoCodec !== expectedCodec || observation.audioCodec !== 'aac'
    || observation.width !== canvas.width || observation.height !== canvas.height
    || Math.abs(observation.frameRate - Number(canvas.working_fps)) > 0.01
    || Math.abs(observation.durationSec - Number(recipe.target_duration_sec)) > durationTolerance) {
    throw new Error('Final render output media validation does not match the staged MP4 recipe.')
  }
  const issue = finalLoudnessIssue(observation.loudness, {
    lufs: target.lufs, true_peak_db: target.true_peak_db,
    tolerance_pct: target.tolerance_pct, check: target.check,
  })
  if (issue && target.check === 'block') {
    throw new Error(`Final render output loudness validation failed: ${issue}`)
  }
}

async function validateCandidate(
  session: FinalRenderImportSession,
  pathname: string,
  output: NonNullable<FinalRenderJobView['output']>,
): Promise<{ file: Awaited<ReturnType<typeof stableMediaFile>>; media: MediaObservation; revisionSha256: string }> {
  const file = await stableMediaFile(pathname, output.size_bytes)
  if (file.sha256 !== output.sha256) throw new Error('Final render candidate output digest changed.')
  const media = await inspectMedia(pathname)
  await refreshFinalRenderImportSession(session)
  validateMedia(session, media)
  const target = record(session.reopened.manifest.loudness, 'staged loudness')
  const revision = await appendFinalRenderImportRevision(session, 'output_validation_observed', {
    candidate_sha256: output.sha256, size_bytes: output.size_bytes,
    candidate: { pathname, dev: file.dev, ino: file.ino },
    media: structuredClone(media), loudness: structuredClone(media.loudness),
    target: structuredClone(target), verdict: 'pass',
  })
  return { file, media, revisionSha256: revision.sha256 }
}

function sameStableFile(
  left: Awaited<ReturnType<typeof stableMediaFile>>,
  right: Awaited<ReturnType<typeof stableMediaFile>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.sha256 === right.sha256
}

async function registeredRecoveryPath(
  session: FinalRenderImportSession,
  destinationPath: string,
): Promise<string> {
  const destination = record(session.reopened.manifest.destination, 'staged destination')
  const projectDir = getProjectDir(session.projectSlug)
  if (!projectDir) throw new Error('Final render project Trash root is unavailable.')
  const resolvedProject = path.resolve(projectDir)
  const resolvedDestination = path.resolve(destinationPath)
  const inProject = resolvedDestination.startsWith(`${resolvedProject}${path.sep}`)
  const anchor = inProject
    ? resolvedProject
    : await exportsAnchorFor(session.projectSlug, path.dirname(resolvedDestination))
  if (!anchor) throw new Error('Final render destination has no registered Story Trash root.')
  const recoveryRoot = trashRootFor(anchor, resolvedProject, session.projectSlug)
  if (destination.recovery_root !== recoveryRoot) {
    throw new Error('Final render registered Story Trash root changed after staging.')
  }
  return path.join(
    recoveryRoot,
    'final-render-recovery', session.current.intent_id, path.basename(resolvedDestination),
  )
}

type PublishedDestination = {
  pathname: string
  sha256: string
  size_bytes: number
  dev: string
  ino: string
}

async function publishDestination(
  session: FinalRenderImportSession,
  pathname: string,
  output: NonNullable<FinalRenderJobView['output']>,
  validationSha256: string,
  validatedCandidate: Awaited<ReturnType<typeof stableMediaFile>>,
): Promise<PublishedDestination> {
  const destination = record(session.reopened.manifest.destination, 'staged destination')
  const destinationPath = destination.pathname
  if (typeof destinationPath !== 'string' || !path.isAbsolute(destinationPath)) {
    throw new Error('Final render staged destination is invalid.')
  }
  const expectedState = record(destination.state, 'staged destination state')
  const recoveryPath = expectedState.kind === 'file'
    ? await registeredRecoveryPath(session, destinationPath)
    : null
  const priorPublishIntent = latestRevision(session, 'output_publish_intent')
  const publishIntent = await appendFinalRenderImportRevision(session, 'output_publish_intent', {
    candidate_sha256: output.sha256, size_bytes: output.size_bytes,
    candidate: {
      pathname, dev: validatedCandidate.dev, ino: validatedCandidate.ino,
      sha256: validatedCandidate.sha256, size_bytes: validatedCandidate.size,
    },
    destination: destinationPath, expected_state: structuredClone(destination.state),
    recovery_path: recoveryPath,
  })
  await testHooks.probe?.({
    phase: 'before-output-publication', candidate_path: pathname, destination_path: destinationPath,
    project_slug: session.projectSlug, job_id: session.jobId,
  })
  await refreshFinalRenderImportSession(session)
  if (session.current.cancel_requested_at !== null) {
    throw new Error('Final render import was cancelled before publication.')
  }
  const expected = session.current
  const committed = await commitFinalRenderImportTransitionMutation(
    session.projectSlug, session.jobId, expected, async () => {
      await refreshFinalRenderImportSession(session)
      if (session.current.cancel_requested_at !== null) {
        throw new Error('Final render import was cancelled before publication.')
      }
      const imported = await withFinalVideoPathLock(destinationPath, async () => {
        await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
        const reopenedCandidate = await stableMediaFile(pathname, output.size_bytes)
        if (!sameStableFile(reopenedCandidate, validatedCandidate) || reopenedCandidate.sha256 !== output.sha256) {
          throw new Error('Final render validated candidate changed before publication.')
        }
        let destinationMatchesOutput = false
        try {
          const present = await stableMediaFile(destinationPath)
          destinationMatchesOutput = present.size === output.size_bytes && present.sha256 === output.sha256
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error
        }
        if (destinationMatchesOutput && !priorPublishIntent) {
          throw new Error('Final render destination was written by an unowned competing writer.')
        }
        if (expectedState.kind === 'file') {
          const recoveryDir = path.dirname(recoveryPath!)
          await fs.mkdir(recoveryDir, { recursive: true, mode: 0o700 })
          let displacedMatches = false
          let recoveryPathExists = false
          try {
            const displaced = await stableMediaFile(recoveryPath!, expectedState.size_bytes)
            recoveryPathExists = true
            displacedMatches = displaced.sha256 === expectedState.sha256
          } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error
          }
          if (!displacedMatches) {
            if (recoveryPathExists) {
              throw new Error('Final render recovery path conflicted with retained evidence.')
            }
            if (destinationMatchesOutput) {
              throw new Error('Final render recovery destination is missing after publication.')
            }
            const current = await stableMediaFile(destinationPath, expectedState.size_bytes)
            if (current.sha256 !== expectedState.sha256) {
              throw new Error('Final render destination changed before publication.')
            }
            const moved = moveToTrashSync(destinationPath, recoveryPath!, 'final-video', true)
            if (moved !== recoveryPath) {
              throw new Error('Final render recovery path conflicted with retained evidence.')
            }
          } else {
            if (!priorPublishIntent) throw new Error('Final render recovery file lacks a prior publication intent.')
            ensureTrashMoveIndexedSync(destinationPath, recoveryPath!, 'final-video')
          }
          // Repeat directory durability on replay too: index or directory sync may have failed after rename.
          await syncDirectory(recoveryDir)
          await syncDirectory(path.dirname(recoveryDir))
          await syncDirectory(path.dirname(path.dirname(recoveryDir)))
          await syncDirectory(path.dirname(path.dirname(path.dirname(recoveryDir))))
          await syncDirectory(path.dirname(destinationPath))
        } else if (expectedState.kind !== 'absent') {
          throw new Error('Final render staged destination state is invalid.')
        }
        if (!destinationMatchesOutput) {
          try {
            await fs.link(pathname, destinationPath)
          } catch (error: any) {
            if (error?.code === 'EEXIST') {
              throw new Error('Final render destination exists because another writer won.')
            }
            throw error
          }
        }
        await syncDirectory(path.dirname(destinationPath))
        const readback = await stableMediaFile(destinationPath, output.size_bytes)
        if (!sameStableFile(readback, reopenedCandidate) || readback.sha256 !== output.sha256) {
          throw new Error('Final render published destination readback changed.')
        }
        return {
          pathname: destinationPath, sha256: output.sha256, size_bytes: output.size_bytes,
          dev: readback.dev, ino: readback.ino,
        }
      })
      const { transport_revision_sha256: _backlink, ...after } = {
        ...expected, phase: 'imported' as const, revision: expected.revision + 1,
      }
      const revision = await appendFinalRenderImportRevision(session, 'output_imported', {
        after,
        destination: {
          pathname: imported.pathname, sha256: imported.sha256, size_bytes: imported.size_bytes,
        },
        destination_identity: { dev: imported.dev, ino: imported.ino },
        publish_intent_sha256: publishIntent.sha256,
        validation_sha256: validationSha256,
      })
      return { ...after, transport_revision_sha256: revision.sha256 }
    },
  )
  session.current = committed
  await refreshFinalRenderImportSession(session)
  const imported = latestRevision(session, 'output_imported')
  const identity = record(imported?.value.payload?.destination_identity, 'imported destination identity')
  return {
    pathname: destinationPath, sha256: output.sha256, size_bytes: output.size_bytes,
    dev: identity.dev, ino: identity.ino,
  }
}

async function readPublishedDestination(
  session: FinalRenderImportSession,
  output: NonNullable<FinalRenderJobView['output']>,
): Promise<PublishedDestination | null> {
  const pathname = record(session.reopened.manifest.destination, 'staged destination').pathname
  if (typeof pathname !== 'string' || !path.isAbsolute(pathname)) throw new Error('Final render destination is invalid.')
  try {
    const file = await stableMediaFile(pathname, output.size_bytes)
    if (file.sha256 !== output.sha256) throw new Error('Final render imported destination changed.')
    const imported = latestRevision(session, 'output_imported')
    const identity = record(imported?.value.payload?.destination_identity, 'imported destination identity')
    if (identity.dev !== file.dev || identity.ino !== file.ino) {
      throw new Error('Final render imported destination identity changed.')
    }
    const before = record(session.reopened.manifest.destination.state, 'staged destination state')
    if (before.kind === 'file') {
      const recoveryPath = await registeredRecoveryPath(session, pathname)
      const displaced = await stableMediaFile(recoveryPath, before.size_bytes)
      if (displaced.sha256 !== before.sha256) throw new Error('Final render retained recovery bytes changed.')
      ensureTrashMoveIndexedSync(pathname, recoveryPath, 'final-video')
    }
    return {
      pathname, sha256: output.sha256, size_bytes: output.size_bytes, dev: file.dev, ino: file.ino,
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function terminalArtifact(
  session: FinalRenderImportSession,
  outcome: 'acknowledged' | 'cancelled',
  output: NonNullable<FinalRenderJobView['output']>,
  destination: PublishedDestination | null,
  candidate: string | null,
): Promise<FinalRenderTerminalArtifact> {
  await refreshFinalRenderImportSession(session)
  return {
    format: 'studio.render.story-terminal.v1', outcome,
    project_slug: session.projectSlug, job_id: session.jobId,
    intent_id: session.current.intent_id, gateway_attempt_key: session.current.gateway_attempt_key,
    canonical: structuredClone(session.current), chain_head_sha256: session.current.transport_revision_sha256,
    destination: destination ? {
      pathname: destination.pathname, sha256: destination.sha256, size_bytes: destination.size_bytes,
    } : null,
    cancel_requested_at: session.current.cancel_requested_at,
    evidence: {
      output_sha256: output.sha256, output_size_bytes: output.size_bytes,
      receipt_sha256: output.receipt_digest, candidate_path: candidate,
      destination_mutated: destination !== null,
    },
  }
}

async function writeTerminal(
  session: FinalRenderImportSession,
  terminal: FinalRenderTerminalArtifact,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(terminal), 'utf8')
  const terminalPath = path.join(session.reopened.intent_dir, 'final-render-terminal.json')
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(
      terminalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await syncDirectory(session.reopened.intent_dir)
  } catch (error: any) {
    await handle?.close().catch(() => undefined)
    if (error?.code !== 'EEXIST') throw error
    const existing = await stableBytes(terminalPath)
    if (!existing.equals(bytes)) throw new Error('Final render terminal artifact conflicts with retained evidence.')
  }
  const readback = await stableBytes(terminalPath, bytes.byteLength)
  if (!readback.equals(bytes)) throw new Error('Final render terminal artifact readback changed.')
}

async function finishCancelled(
  session: FinalRenderImportSession,
  output: NonNullable<FinalRenderJobView['output']>,
  candidate: string | null,
): Promise<void> {
  await refreshFinalRenderImportSession(session)
  if (session.current.cancel_requested_at === null) throw new Error('Final render cancellation terminal lacks authority.')
  // The queue's private-snapshot audit checks the captured before-state when no import was committed.
  const published = latestRevision(session, 'output_imported')
  const destination = published ? await readPublishedDestination(session, output) : null
  if (published && !destination) throw new Error('Final render cancelled imported destination is missing.')
  const retainedCandidate = latestRevision(session, 'output_download_prefix') ? candidate : null
  const terminal = await terminalArtifact(session, 'cancelled', output, destination, retainedCandidate)
  await consumeFinalRenderTerminal(
    session.projectSlug, session.jobId, session.current, terminal,
    () => writeTerminal(session, terminal),
  )
}

function outstandingAck(session: FinalRenderImportSession) {
  const consumed = new Set<string>()
  for (const record of session.chain.records) {
    if ((record.value.event === 'output_ack_observed' || record.value.event === 'output_ack_reconciled')
      && typeof record.value.payload?.ack_intent_sha256 === 'string') {
      consumed.add(record.value.payload.ack_intent_sha256)
    }
  }
  return [...session.chain.records].reverse().find(record => (
    record.value.event === 'output_ack_intent' && !consumed.has(record.sha256)
  ))
}

async function acknowledge(
  session: FinalRenderImportSession,
  output: NonNullable<FinalRenderJobView['output']>,
  destination: PublishedDestination,
  candidate: string,
  carried?: CarriedFinalCheck,
): Promise<boolean> {
  await refreshFinalRenderImportSession(session)
  // Nothing is acknowledged until these exact published bytes have a verdict. The check runs just
  // before the ACK intent (and only for an import that is still live), so a recorded cancellation
  // ends as a cancellation instead of waiting on a check it no longer needs. A restart after
  // publication re-verifies here, and a row without its frozen plan holds before any Gateway call.
  let verified: CarriedFinalCheck | undefined = carried
  let outstanding = outstandingAck(session)
  if (outstanding) {
    const view = await strictOriginalKeyView(session, false)
    if (!view) return false
    if (view.state === 'acknowledged') {
      await transitionFinalRenderImportSession(session, 'output_ack_reconciled', 'acknowledged', {
        ack_intent_sha256: outstanding.sha256, result: 'acknowledged', response: structuredClone(view),
      })
    } else if (view.state === 'output_ready' && view.output_ready && view.output) {
      await appendFinalRenderImportRevision(session, 'output_ack_reconciled', {
        ack_intent_sha256: outstanding.sha256, result: 'not_acknowledged', response: structuredClone(view),
      })
      outstanding = undefined
    } else {
      markFinalRenderMonitorTransientHold(session.projectSlug, session.jobId)
      return false
    }
  }

  if (session.current.phase === 'imported') {
    await testHooks.probe?.({
      phase: 'before-output-ack', candidate_path: candidate, destination_path: destination.pathname,
      project_slug: session.projectSlug, job_id: session.jobId,
    })
    await refreshFinalRenderImportSession(session)
    if (session.current.cancel_requested_at !== null) {
      await finishCancelled(session, output, candidate)
      return false
    }
    verified = await verifiedPublishedBeforeAcknowledge(session, destination, verified)
    const body = Buffer.from(encodeFinalRenderAckBody(output.receipt_digest))
    const expected = session.current
    const intent = await withFinalRenderImportJournalMutation(
      session.projectSlug, session.jobId, expected,
      () => withFinalVideoPathLock(destination.pathname, async () => {
        await refreshFinalRenderImportSession(session)
        if (session.current.cancel_requested_at !== null) {
          throw new Error('Final render import was cancelled before ACK intent.')
        }
        const current = await stableMediaFile(destination.pathname, destination.size_bytes)
        if (current.sha256 !== destination.sha256
          || current.dev !== destination.dev || current.ino !== destination.ino) {
          throw new Error('Final render destination changed before ACK intent.')
        }
        return appendFinalRenderImportRevision(session, 'output_ack_intent', {
          gateway_job_id: expected.gateway_job_id!, body_sha256: sha256(body),
          body_utf8: body.toString('utf8'), receipt_digest: output.receipt_digest,
          destination: {
            pathname: destination.pathname, sha256: destination.sha256,
            size_bytes: destination.size_bytes, dev: destination.dev, ino: destination.ino,
          },
        })
      }),
    )
    await refreshFinalRenderImportSession(session)
    if (session.current.cancel_requested_at !== null) {
      await finishCancelled(session, output, candidate)
      return false
    }
    // Only the ACK exchange itself is uncertain. A failure after the observed outcome is recorded
    // must not append ack-unknown for a consumed intent: revisions are immutable, so that would
    // permanently invalidate the chain. A missing outcome reconciles by the original key instead.
    let response: Awaited<ReturnType<typeof ackFinalRender>>
    try {
      response = await ackFinalRender(expected.gateway_job_id!, output.receipt_digest)
    } catch (error) {
      await refreshFinalRenderImportSession(session)
      if (session.current.cancel_requested_at !== null) {
        await finishCancelled(session, output, candidate)
        return false
      }
      await appendFinalRenderImportRevision(session, 'output_ack_unknown', {
        ack_intent_sha256: intent.sha256,
        failure_class: error instanceof FinalRenderHttpError
          ? 'http' : error instanceof FinalRenderResponseValidationError ? 'invalid-response' : 'network',
      })
      await testHooks.probe?.({
        phase: 'after-output-ack-unknown', candidate_path: candidate, destination_path: destination.pathname,
        project_slug: session.projectSlug, job_id: session.jobId,
      })
      await refreshFinalRenderImportSession(session)
      if (session.current.cancel_requested_at !== null) await finishCancelled(session, output, candidate)
      return false
    }
    await refreshFinalRenderImportSession(session)
    if (session.current.cancel_requested_at !== null) {
      await finishCancelled(session, output, candidate)
      return false
    }
    await transitionFinalRenderImportSession(session, 'output_ack_observed', 'acknowledged', {
      ack_intent_sha256: intent.sha256, response: structuredClone(response),
    })
    await testHooks.probe?.({
      phase: 'after-output-ack-observed', candidate_path: candidate, destination_path: destination.pathname,
      project_slug: session.projectSlug, job_id: session.jobId,
    })
    await refreshFinalRenderImportSession(session)
    if (session.current.cancel_requested_at !== null) {
      await finishCancelled(session, output, candidate)
      return false
    }
  }

  if (session.current.phase === 'acknowledged') {
    // A restart can reach this phase with no in-memory verdict; the published hardlink is checked
    // again before the row is completed, so terminal consumption never outruns its plan.
    const checked = verified ?? await verifiedPublishedBeforeAcknowledge(session, destination)
    const terminal = await terminalArtifact(session, 'acknowledged', output, destination, candidate)
    let keptWorkDirs: string[] = []
    await consumeFinalRenderTerminal(
      session.projectSlug, session.jobId, session.current, terminal,
      () => writeTerminal(session, terminal),
      async job => { keptWorkDirs = await finishImported(job, destination.pathname, checked) },
    )
    // Only now that done is on disk: a completion that failed above leaves the row running with its folder.
    for (const dir of keptWorkDirs) discardFinishedWorkDir(session.projectSlug, dir)
    return true
  }
  return false
}

/**
 * The owner's cleanup rule: scratch data is never deleted. A finished render's own work folder moves
 * into the project's Story Trash, where it stays recoverable. Best-effort like the local finish tail:
 * a failed move keeps the folder where it is instead of failing a row that is already done.
 */
function discardFinishedWorkDir(projectSlug: string, workDir: string): void {
  try {
    const projectDir = getProjectDir(projectSlug)
    if (!projectDir) throw new Error('project directory is unavailable')
    const root = trashRootFor(projectDir, path.resolve(projectDir), projectSlug)
    moveToTrashSync(workDir, path.join(root, 'final-render-work', path.basename(workDir)), 'final-render-work')
  } catch (error: any) {
    console.warn(`[final-render-import] finished work folder was not moved to Trash: ${error?.message || error}`)
  }
}

/**
 * What the shared checks saw, carried to the row that is completed after the candidate becomes
 * canonical. Not durable: a restart after publication re-verifies the published hardlink before
 * acknowledgement and completion.
 */
type CarriedFinalCheck = {
  finalName: string
  result: FinalCheckResult | null
  resultFields: Record<string, unknown>
  outputLines: string[]
}

/** The frozen plan a fleet final must be checked against; absent means the import cannot be proven. */
type FrozenPlan = {
  code: string
  format: string
  finalName: string
  plannedSec: number
  expected: FinalCheckExpectation
  loudness: LoudnessTarget
}

function frozenPlan(value: unknown): FrozenPlan | null {
  const facts = value as Record<string, any> | undefined
  if (!facts || typeof facts.format !== 'string' || !(Number(facts.total_render_duration) > 0)
    || !facts.final_check_expected || !facts.loudness
    || typeof facts.code !== 'string' || !facts.code) return null
  return {
    code: facts.code,
    format: facts.format,
    finalName: `${facts.code}_final_video.${facts.format}`,
    plannedSec: Number(facts.total_render_duration),
    expected: facts.final_check_expected,
    loudness: facts.loudness,
  }
}

function carriedEvidence(job: Job, outputLineStart: number): Pick<CarriedFinalCheck, 'resultFields' | 'outputLines'> {
  const resultFields: Record<string, unknown> = {}
  for (const key of ['final_check', 'final_loudness', 'safety_warnings']) {
    if (job.result && Object.hasOwn(job.result, key)) resultFields[key] = job.result[key]
  }
  return { resultFields, outputLines: job.output_lines.slice(outputLineStart) }
}

async function runSharedFinalCheck(
  job: Job, plan: FrozenPlan, finalPath: string, stagedCandidate: boolean,
): Promise<FinalCheckResult | null> {
  if (testHooks.verifyFinal) {
    return testHooks.verifyFinal(job, {
      code: plan.code, format: plan.format, finalPath, plannedSec: plan.plannedSec,
      expected: plan.expected, loudness: plan.loudness, stagedCandidate,
    })
  }
  const video = await import('../generators/video.js')
  return stagedCandidate
    ? video.verifyStagedCandidateFinalVideo(
        job, plan.code, plan.format, finalPath, plan.plannedSec, plan.expected, plan.loudness,
      )
    : video.verifyImportedFinalVideo(
        job, plan.code, plan.format, finalPath, plan.plannedSec, plan.expected, plan.loudness,
      )
}

/**
 * The shared final checks, run on the downloaded candidate before it displaces anything.
 *
 * The candidate is the exact file validated just above and the one publishDestination will hardlink
 * to the staged destination, so a verdict here describes the bytes that will be canonical. The prior
 * final's Trash move, publication and the Gateway ACK all happen only after this returns. A failure
 * leaves the candidate and its evidence in place, the destination untouched, and no ACK intent.
 *
 * A row without its frozen plan cannot be verified, and guessing today's settings is exactly what the
 * plan exists to prevent. That is a recoverable hold: nothing is promoted, acknowledged or completed.
 */
async function verifyCandidateBeforePublication(
  session: FinalRenderImportSession,
  candidate: string,
  validatedCandidate: Awaited<ReturnType<typeof stableMediaFile>>,
  output: NonNullable<FinalRenderJobView['output']>,
): Promise<CarriedFinalCheck> {
  const job = await loadAuthoritativeJob(session.projectSlug, session.jobId)
  if (!job || job.type !== 'video_assembly') {
    throw new Error('Final render candidate check has no authoritative queue row.')
  }
  const plan = frozenPlan(job.result?.final_render_finish)
  if (!plan) return holdWithoutRenderPlan(session.projectSlug, session.jobId)
  const destination = record(session.reopened.manifest.destination, 'staged destination').pathname
  if (typeof destination !== 'string' || path.basename(destination) !== plan.finalName) {
    throw new Error('Final render staged destination does not name this render\'s final video.')
  }
  const before = job.output_lines.length
  const result = await runSharedFinalCheck(job, plan, candidate, true)
  // The async checks read the file for minutes. Hold the verdict to the exact identity that was
  // validated before them, and to the authenticated output digest, before anything is promoted.
  const after = await stableMediaFile(candidate, output.size_bytes)
  if (after.sha256 !== output.sha256 || !sameStableFile(after, validatedCandidate)) {
    throw new Error('Final render checked candidate changed before publication.')
  }
  return { finalName: plan.finalName, result, ...carriedEvidence(job, before) }
}

/**
 * A restart after publication has no in-memory carry. The published hardlink is bound by its recorded
 * identity and digest before and after the same checks, so acknowledgement and completion only follow
 * a verdict on the file that was actually published. Missing plan facts hold every path.
 */
async function verifiedPublishedBeforeAcknowledge(
  session: FinalRenderImportSession,
  destination: PublishedDestination,
  carried?: CarriedFinalCheck,
): Promise<CarriedFinalCheck> {
  if (carried) return carried
  const job = await loadAuthoritativeJob(session.projectSlug, session.jobId)
  if (!job || job.type !== 'video_assembly') {
    throw new Error('Final render published check has no authoritative queue row.')
  }
  const plan = frozenPlan(job.result?.final_render_finish)
  if (!plan) return holdWithoutRenderPlan(session.projectSlug, session.jobId)
  if (path.basename(destination.pathname) !== plan.finalName) {
    throw new Error('Final render published destination does not name this render\'s final video.')
  }
  const before = job.output_lines.length
  const beforeFile = await stableMediaFile(destination.pathname, destination.size_bytes)
  if (beforeFile.sha256 !== destination.sha256
    || beforeFile.dev !== destination.dev || beforeFile.ino !== destination.ino) {
    throw new Error('Final render published destination changed before its final check.')
  }
  const result = await runSharedFinalCheck(job, plan, destination.pathname, false)
  const afterFile = await stableMediaFile(destination.pathname, destination.size_bytes)
  if (afterFile.sha256 !== destination.sha256 || !sameStableFile(afterFile, beforeFile)) {
    throw new Error('Final render checked destination changed before acknowledgement.')
  }
  return { finalName: plan.finalName, result, ...carriedEvidence(job, before) }
}

/**
 * The finish tail, once, for the published file. The caller has already run the shared checks on
 * these exact bytes (the downloaded candidate before publication, or the published hardlink on a
 * restart) and hands their verdict in; nothing here guesses or re-measures under the consume lock.
 */
async function finishImported(
  job: Job, finalPath: string, carried: CarriedFinalCheck,
): Promise<string[]> {
  const video = await import('../generators/video.js')
  const facts = job.result?.final_render_finish
  const plan = frozenPlan(facts)
  // Unreachable while acknowledgement verifies the same plan, and deliberately loud if it is not:
  // a completion must never outrun the plan it was checked against.
  if (!plan) throw new FinalRenderCheckHold('staged-without-plan', NO_PLAN_HOLD_MESSAGE)
  if (carried.finalName !== plan.finalName) {
    throw new Error('Final render checked a different final name than the one being completed.')
  }
  // A row that was held before its plan arrived keeps its history in the log, but the hold's
  // attention message must not survive a verified completion.
  if (job.error === NO_PLAN_HOLD_MESSAGE) job.error = null
  if (carried.result) await storeFinalCheck(finalPath, carried.result)
  job.result = { ...(job.result || {}), ...carried.resultFields }
  job.output_lines.push(...carried.outputLines)
  await video.finishImportedFinalVideo(job, facts.code, finalPath, facts.visual_source, facts.image_pool)
  const kept: string[] = []
  const checkpoint = await getValidVideoAssemblyCheckpoint(job)
  if (checkpoint) kept.push(checkpoint.work_dir)
  if (facts?.work_dir && !kept.includes(facts.work_dir)
    && await isOwnedVideoAssemblyWorkDir(job.project_slug, facts.code, facts.work_dir)) kept.push(facts.work_dir)
  setVideoAssemblyCheckpoint(job, null)
  return videoDebugMode() ? [] : kept
}

/** STORY_STUDIO_VIDEO_DEBUG keeps work folders, as on local renders. */
function videoDebugMode(): boolean {
  return !!process.env.STORY_STUDIO_VIDEO_DEBUG && process.env.STORY_STUDIO_VIDEO_DEBUG !== '0'
}

async function recoverConsumedTerminal(projectSlug: string, jobId: string): Promise<boolean> {
  const job = await loadAuthoritativeJob(projectSlug, jobId)
  const parsed = parseFinalRenderRemoteWaitReceipt(job?.final_render_remote_wait, jobId)
  if (!job || !parsed.ok || parsed.receipt.version !== 3
    || (job.status !== 'done' && job.status !== 'cancelled')) return false
  const intentDir = path.join(
    getUserDataDir(), 'private-render', 'intents', parsed.receipt.intent_id,
  )
  const bytes = await stableBytes(path.join(intentDir, 'final-render-terminal.json'))
  const terminal = JSON.parse(bytes.toString('utf8')) as FinalRenderTerminalArtifact
  await consumeFinalRenderTerminal(projectSlug, jobId, parsed.receipt, terminal)
  // Power lost between done and the folder cleanup: the done row still names its own scratch folder.
  const facts = job.result?.final_render_finish
  if (terminal.outcome === 'acknowledged' && job.status === 'done' && facts?.work_dir && !videoDebugMode()
    && await isOwnedVideoAssemblyWorkDir(projectSlug, facts.code, facts.work_dir)) {
    discardFinishedWorkDir(projectSlug, facts.work_dir)
  }
  if (terminal.outcome === 'acknowledged') await drainFinalRenderTerminalHandoff(jobId)
  return true
}

/** One bounded importer recovery pass; no caller or scheduler is installed by this slice. */
export async function recoverFinalRenderImport(projectSlug: string, jobId: string): Promise<void> {
  if (await recoverConsumedTerminal(projectSlug, jobId)) return
  const shouldDrain = await withFinalRenderImportSession(projectSlug, jobId, async session => {
    await testHooks.probe?.({
      phase: 'after-output-owner-acquired', project_slug: projectSlug, job_id: jobId,
    })
    await refreshFinalRenderImportSession(session)
    const output = outputDetails(session.outputView)
    let candidate = candidatePath(session)
    let carried: CarriedFinalCheck | undefined
    if (session.current.cancel_requested_at !== null) {
      await finishCancelled(session, output, candidate)
      return false
    }

    if (session.current.phase === 'output_ready' || session.current.phase === 'importing') {
      const view = await strictOriginalKeyView(session, true)
      if (!view) return false
      if (session.current.phase === 'output_ready') {
        const destination = record(session.reopened.manifest.destination, 'staged destination').pathname
        await transitionFinalRenderImportSession(session, 'output_import_intent', 'importing', {
          response: structuredClone(view), receipt_utf8: output.receipt_utf8,
          receipt_sha256: output.receipt_digest, output_sha256: output.sha256,
          output_size_bytes: output.size_bytes, destination,
        })
      }
      candidate = await downloadOutput(session, output)
      await refreshFinalRenderImportSession(session)
      if (session.current.cancel_requested_at !== null) {
        await finishCancelled(session, output, candidate)
        return false
      }
      const validated = await validateCandidate(session, candidate, output)
      // Shared final checks on the exact validated candidate, before the prior final is displaced or
      // anything is published or acknowledged. A row without its frozen plan throws a recoverable
      // hold here: nothing is promoted, acknowledged or completed.
      carried = await verifyCandidateBeforePublication(session, candidate, validated.file, output)
        .catch(async error => {
          await refreshFinalRenderImportSession(session)
          if (session.current.cancel_requested_at !== null) {
            await finishCancelled(session, output, candidate)
            return null
          }
          throw error
        }) ?? undefined
      if (!carried) return false
      const destination = await publishDestination(
        session, candidate, output, validated.revisionSha256, validated.file,
      ).catch(async error => {
        await refreshFinalRenderImportSession(session)
        if (session.current.cancel_requested_at !== null) {
          await finishCancelled(session, output, candidate)
          return null
        }
        throw error
      })
      if (!destination) return false
    }

    await refreshFinalRenderImportSession(session)
    if (session.current.cancel_requested_at !== null) {
      await finishCancelled(session, output, candidate)
      return false
    }
    const destination = await readPublishedDestination(session, output)
    if (!destination) throw new Error('Final render imported destination is missing.')
    return acknowledge(session, output, destination, candidate, carried)
  })
  if (shouldDrain) await drainFinalRenderTerminalHandoff(jobId)
}
