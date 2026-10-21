import { constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { finalizeFinalRenderPacket, type FinalRenderExportDescription, type FinalRenderInputMode } from '../lib/final-render-export.js'
import { canonicalRenderValue } from '../lib/render-hash-v1.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import type { FinalRenderIntentStagedReceiptV2, Job } from '../models/types.js'
import { getProjectDir, getUserDataDir } from './project-manager.js'
import { exportsAnchorFor, resolveExternalFinalVideoDir } from './external-video-store.js'
import { trashRootFor } from '../lib/trash-move.js'
import { withFinalVideoPathLock } from './final-video-lock.js'
import { commitFinalRenderRemoteWaitReceipt, loadKnownFinalRenderIntentStagedReceipt } from './job-queue.js'

const MAX_MANIFEST_BYTES = 1024 * 1024
const COPY_BUFFER_BYTES = 64 * 1024
const MANIFEST_KEYS = [
  'format', 'job_id', 'project_slug', 'episode_id', 'intent_id', 'story_instance_id',
  'story_attempt', 'gateway_attempt_key', 'committed_at', 'scope', 'packet', 'sources',
  'composition', 'destination', 'descriptors', 'loudness',
] as const

export interface FinalRenderResolvedLoudness {
  lufs: number
  true_peak_db: number
  tolerance_pct: number
  check: 'off' | 'warn' | 'block'
}

export interface FinalRenderStagingInput {
  job: Job
  description: FinalRenderExportDescription
  discovery: FinalRenderCapabilities
  scope: {
    origin: string
    owner_scope: string
    gateway_instance_id: string
    story_instance_id: string
  }
  destination: {
    code: string
    title: string
    format: string
    project_tree_video_dir: string
  }
  loudness?: FinalRenderResolvedLoudness
}

export interface FinalRenderStagingProbe {
  phase: 'after-source-open' | 'before-manifest-publish' | 'before-manifest-link' | 'after-manifest-publish' | 'before-private-readback'
  logical_id?: string
  source_path?: string
  intent_dir: string
  manifest_path?: string
}

type StagingHooks = {
  randomUUID?: () => string
  now?: () => Date
  resolveExternalFinalVideoDir?: typeof resolveExternalFinalVideoDir
  writeChunk?: (
    handle: FileHandle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesWritten: number }>
  fsyncDirectory?: (directory: string) => Promise<void>
  probe?: (event: FinalRenderStagingProbe) => void | Promise<void>
}

let testHooks: StagingHooks = {}

export function _setFinalRenderStagingHooksForTesting(hooks: StagingHooks): () => void {
  const previous = testHooks
  testHooks = { ...hooks }
  return () => { testHooks = previous }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function localFence(prefix: string, value: unknown): string {
  return sha256(Buffer.concat([Buffer.from(`${prefix}\0`), canonicalRenderValue(value)]))
}

function fail(): never {
  throw new Error(
    'Final render source identity, no-follow regular-file, asset/total size bound, destination, copy, '
    + 'exclusive collision, manifest publication, hash, or readback safety check failed; retained private evidence requires review.',
  )
}

function canonicalUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail()
  return value
}

function safeExtension(sourcePath: string, role: string): string {
  const raw = path.extname(sourcePath).slice(1).toLowerCase()
  const extension = raw === 'jpeg' ? 'jpg' : raw === 'tif' ? 'tiff' : raw
  const allowed = role === 'premixed_audio'
    ? new Set(['wav'])
    : role === 'base_video'
      ? new Set(['mp4', 'mov', 'webm'])
      : new Set(['mp4', 'mov', 'webm', 'png', 'jpg', 'webp', 'gif', 'bmp', 'tiff'])
  if (!allowed.has(extension)) fail()
  return extension
}

function descriptorBounds(discovery: FinalRenderCapabilities): { maxAsset: number; maxTotal: number } {
  const profileBytes = Buffer.from(discovery.profile_descriptor_utf8, 'utf8')
  const toolsBytes = Buffer.from(discovery.tools.descriptor_utf8, 'utf8')
  const compilerBytes = Buffer.from(discovery.compiler.descriptor_utf8, 'utf8')
  if (sha256(profileBytes) !== discovery.profile_digest
    || sha256(toolsBytes) !== discovery.tools.digest
    || sha256(compilerBytes) !== discovery.compiler.digest) fail()
  let profile: any
  try { profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(profileBytes)) } catch { fail() }
  const maxAsset = profile?.execution_bounds?.max_asset_bytes
  const maxTotal = profile?.execution_bounds?.max_total_input_bytes
  if (!Number.isSafeInteger(maxAsset) || maxAsset <= 0 || !Number.isSafeInteger(maxTotal) || maxTotal <= 0) fail()
  return { maxAsset, maxTotal }
}

function sameIdentity(left: any, right: any): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function openRegularNoFollow(filePath: string): Promise<{ handle: FileHandle; stat: any }> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) fail()
    return { handle, stat }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0
  while (offset < buffer.byteLength) {
    const writer = testHooks.writeChunk ?? ((target, value, start, length, at) => target.write(value, start, length, at))
    const { bytesWritten } = await writer(handle, buffer, offset, buffer.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.byteLength - offset) fail()
    offset += bytesWritten
  }
}

export interface FinalRenderStagedSourceIdentity {
  pathname: string
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

async function hashRegularFile(filePath: string, maximum: number): Promise<{
  size_bytes: number
  sha256: string
  identity: FinalRenderStagedSourceIdentity
}> {
  const { handle, stat: before } = await openRegularNoFollow(filePath)
  const digest = createHash('sha256')
  let position = 0
  try {
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      if (position > maximum) fail()
      digest.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    const visible = await fs.lstat(filePath, { bigint: true })
    if (!visible.isFile() || !sameIdentity(before, after)
      || visible.dev !== after.dev || visible.ino !== after.ino
      || visible.size !== after.size || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs
      || BigInt(position) !== after.size) fail()
    return {
      size_bytes: position,
      sha256: digest.digest('hex'),
      identity: {
        pathname: filePath,
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeNs: after.mtimeNs,
        ctimeNs: after.ctimeNs,
      },
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function copySource(
  requirement: FinalRenderExportDescription['source_requirements'][number],
  description: FinalRenderExportDescription,
  intentDir: string,
  maximum: number,
): Promise<{
  logical_id: string
  role: typeof requirement.role
  safe_name: string
  canonical_source_path: string
  size_bytes: number
  sha256: string
  input_mode: FinalRenderInputMode
}> {
  const extension = safeExtension(requirement.source_path, requirement.role)
  const safeName = `${requirement.logical_id}.${extension}`
  const destination = path.join(intentDir, safeName)
  const { handle: sourceHandle, stat: before } = await openRegularNoFollow(requirement.source_path)
  let canonicalSource = ''
  const digest = createHash('sha256')
  let position = 0
  try {
    canonicalSource = await fs.realpath(requirement.source_path)
    const canonicalStat = await fs.lstat(canonicalSource, { bigint: true })
    if (!canonicalStat.isFile() || canonicalStat.dev !== before.dev || canonicalStat.ino !== before.ino) fail()
    await testHooks.probe?.({
      phase: 'after-source-open', logical_id: requirement.logical_id,
      source_path: requirement.source_path, intent_dir: intentDir,
    })
    const output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      for (;;) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
        if (!bytesRead) break
        position += bytesRead
        if (position > maximum) fail()
        const bytes = buffer.subarray(0, bytesRead)
        digest.update(bytes)
        await writeAll(output, bytes, position - bytesRead)
      }
      await output.sync()
    } finally {
      await output.close().catch(() => undefined)
    }
    const after = await sourceHandle.stat({ bigint: true })
    const visible = await fs.lstat(requirement.source_path, { bigint: true })
    if (!visible.isFile() || !sameIdentity(before, after)
      || visible.dev !== after.dev || visible.ino !== after.ino
      || visible.size !== after.size || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs
      || BigInt(position) !== after.size) fail()
  } finally {
    await sourceHandle.close().catch(() => undefined)
  }
  const sourceDigest = digest.digest('hex')
  const readback = await hashRegularFile(destination, maximum)
  if (readback.size_bytes !== position || readback.sha256 !== sourceDigest) fail()

  let inputMode: FinalRenderInputMode = { kind: 'single' }
  if (requirement.role === 'overlay' || requirement.role === 'frame_background') {
    const provisional = findInputMode(requirement.logical_id, requirement.role, description)
    if (provisional.kind === 'loop_still') {
      const { stillDecoderArgs } = await import('../lib/ffmpeg-utils.js')
      const decoder = (await stillDecoderArgs(destination))[1]
      if (!decoder) fail()
      inputMode = { kind: 'loop_still', decoder }
    } else inputMode = provisional
  }
  return {
    logical_id: requirement.logical_id, role: requirement.role, safe_name: safeName,
    canonical_source_path: canonicalSource, size_bytes: position, sha256: sourceDigest, input_mode: inputMode,
  }
}

function findInputMode(logicalId: string, role: string, description: FinalRenderExportDescription): FinalRenderInputMode {
  for (const operation of description.recipe.operations as Array<Record<string, any>>) {
    if (operation.kind === 'overlay_layer' && operation.asset.logical_id === logicalId) return operation.input_mode
    if (role === 'frame_background' && operation.kind === 'presentation_frame'
      && operation.background.kind === 'asset' && operation.background.asset.logical_id === logicalId) {
      return operation.background.input_mode
    }
  }
  fail()
}

async function canonicalDirectory(candidate: string): Promise<string> {
  const suffix: string[] = []
  let cursor = path.resolve(candidate)
  for (;;) {
    try {
      const existing = await fs.realpath(cursor)
      return path.join(existing, ...suffix.reverse())
    } catch (error: any) {
      if (error?.code !== 'ENOENT') fail()
      const parent = path.dirname(cursor)
      if (parent === cursor) fail()
      const name = path.basename(cursor)
      if (!name || name === '.' || name === '..' || name.includes('\0')) fail()
      suffix.push(name)
      cursor = parent
    }
  }
}

async function canonicalDestinationPath(candidate: string): Promise<string> {
  const name = path.basename(candidate)
  if (!name || name === '.' || name === '..' || name.includes('\0')) fail()
  return path.join(await canonicalDirectory(path.dirname(candidate)), name)
}

async function captureDestination(input: FinalRenderStagingInput): Promise<Record<string, any>> {
  const resolver = testHooks.resolveExternalFinalVideoDir ?? resolveExternalFinalVideoDir
  const external = await resolver(
    input.job.project_slug, input.destination.code, input.destination.title, undefined, { forWrite: true },
  )
  const selectedDir = external === null ? input.destination.project_tree_video_dir : external
  const pathname = await canonicalDestinationPath(path.join(
    selectedDir, `${input.destination.code}_final_video.${input.destination.format}`,
  ))
  const state = await withFinalVideoPathLock(pathname, async () => {
    try {
      const value = await hashRegularFile(pathname, Number.MAX_SAFE_INTEGER)
      // The bigint identity is only an in-process stability proof. The durable
      // manifest is closed JSON and needs only the verified bytes it fences.
      return { kind: 'file' as const, size_bytes: value.size_bytes, sha256: value.sha256 }
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { kind: 'absent' as const }
      throw error
    }
  })
  let recoveryRoot: string | null = null
  if (state.kind === 'file') {
    const projectDir = getProjectDir(input.job.project_slug)
    const anchor = projectDir && external !== null
      ? await exportsAnchorFor(input.job.project_slug, selectedDir)
      : projectDir
    if (!projectDir || !anchor) fail()
    recoveryRoot = trashRootFor(anchor, projectDir, input.job.project_slug)
  }
  return {
    pathname,
    route: {
      code: input.destination.code, title: input.destination.title,
      format: input.destination.format, external: external !== null,
    },
    state,
    recovery_root: recoveryRoot,
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (testHooks.fsyncDirectory) return testHooks.fsyncDirectory(directory)
  const handle = await fs.open(directory, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) fail()
}

function canonicalManifestBytes(manifest: unknown): Buffer {
  canonicalRenderValue(manifest)
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail()
  return bytes
}

async function readManifest(pathname: string): Promise<{ value: any; bytes: Buffer }> {
  const { handle, stat: before } = await openRegularNoFollow(pathname)
  let bytes: Buffer
  try {
    if (before.size <= 0n || before.size > BigInt(MAX_MANIFEST_BYTES)) fail()
    bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) fail()
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const visible = await fs.lstat(pathname, { bigint: true })
    if (!visible.isFile() || !sameIdentity(before, after)
      || visible.dev !== after.dev || visible.ino !== after.ino
      || visible.size !== after.size || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs) fail()
  } finally {
    await handle.close().catch(() => undefined)
  }
  let text: string
  let value: any
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(text)
  } catch { fail() }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== MANIFEST_KEYS.length
    || MANIFEST_KEYS.some(key => !Object.hasOwn(value, key))) fail()
  if (!canonicalManifestBytes(value).equals(bytes)) fail()
  return { value, bytes }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}

function validResolvedLoudness(value: unknown): value is FinalRenderResolvedLoudness {
  return hasExactKeys(value, ['lufs', 'true_peak_db', 'tolerance_pct', 'check'])
    && typeof value.lufs === 'number' && Number.isFinite(value.lufs) && value.lufs >= -30 && value.lufs <= -5
    && typeof value.true_peak_db === 'number' && Number.isFinite(value.true_peak_db)
    && value.true_peak_db >= -9 && value.true_peak_db <= 0
    && typeof value.tolerance_pct === 'number' && Number.isFinite(value.tolerance_pct)
    && value.tolerance_pct >= 1 && value.tolerance_pct <= 50
    && (value.check === 'off' || value.check === 'warn' || value.check === 'block')
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  try { return canonicalRenderValue(left).equals(canonicalRenderValue(right)) } catch { return false }
}

function storedDescriptorBounds(descriptors: unknown): { maxAsset: number; maxTotal: number } {
  if (!hasExactKeys(descriptors, ['profile', 'tools', 'compiler'])) fail()
  const parts = [descriptors.profile, descriptors.tools, descriptors.compiler]
  if (parts.some(part => !hasExactKeys(part, ['utf8', 'sha256'])
    || typeof part.utf8 !== 'string' || typeof part.sha256 !== 'string'
    || sha256(Buffer.from(part.utf8, 'utf8')) !== part.sha256)) fail()
  let profile: any
  try {
    profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(descriptors.profile.utf8, 'utf8')))
  } catch { fail() }
  const maxAsset = profile?.execution_bounds?.max_asset_bytes
  const maxTotal = profile?.execution_bounds?.max_total_input_bytes
  if (!Number.isSafeInteger(maxAsset) || maxAsset <= 0 || !Number.isSafeInteger(maxTotal) || maxTotal <= 0) fail()
  return { maxAsset, maxTotal }
}

async function validateKnownStagedIntent(
  input: Readonly<FinalRenderStagingInput>,
  receipt: FinalRenderIntentStagedReceiptV2,
): Promise<void> {
  const intentDir = path.join(getUserDataDir(), 'private-render', 'intents', receipt.intent_id)
  const readback = await readManifest(path.join(intentDir, 'manifest.json'))
  const manifest = readback.value
  const scope = {
    origin: input.scope.origin,
    owner_scope: input.scope.owner_scope,
    gateway_instance_id: input.scope.gateway_instance_id,
    story_instance_id: input.scope.story_instance_id,
  }
  if (sha256(readback.bytes) !== receipt.staging_manifest_sha256
    || manifest.format !== 'studio.render.story-intent.v1'
    || manifest.job_id !== input.job.job_id
    || manifest.project_slug !== input.job.project_slug
    || manifest.episode_id !== input.job.episode_id
    || manifest.intent_id !== receipt.intent_id
    || manifest.story_instance_id !== receipt.story_instance_id
    || manifest.story_attempt !== receipt.story_attempt
    || manifest.gateway_attempt_key !== receipt.gateway_attempt_key
    || manifest.committed_at !== receipt.committed_at
    || !validResolvedLoudness(manifest.loudness)
    || !sameCanonicalValue(manifest.loudness, input.loudness)
    || !sameCanonicalValue(manifest.scope, scope)
    || manifest.packet?.packet_digest !== receipt.packet_sha256
    || localFence('studio.render.story.scope.v1', manifest.scope) !== receipt.submission_scope_sha256
    || localFence('studio.render.story.destination.v1', manifest.destination) !== receipt.destination_fence_sha256
    || localFence('studio.render.story.sources.v1', {
      sources: manifest.sources,
      composition: manifest.composition,
    }) !== receipt.source_generation_fence_sha256) fail()

  const bounds = storedDescriptorBounds(manifest.descriptors)
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0 || manifest.sources.length > 32) fail()
  const names = new Set<string>()
  let total = 0
  for (const source of manifest.sources) {
    if (!hasExactKeys(source, ['logical_id', 'role', 'safe_name', 'canonical_source_path', 'size_bytes', 'sha256'])
      || typeof source.logical_id !== 'string' || !source.logical_id
      || typeof source.role !== 'string' || !source.role
      || typeof source.safe_name !== 'string' || !source.safe_name
      || path.basename(source.safe_name) !== source.safe_name || source.safe_name === '.' || source.safe_name === '..'
      || names.has(source.safe_name)
      || typeof source.canonical_source_path !== 'string' || !source.canonical_source_path
      || !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 0
      || typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) fail()
    names.add(source.safe_name)
    const remaining = bounds.maxTotal - total
    if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
    const verified = await hashRegularFile(path.join(intentDir, source.safe_name), Math.min(bounds.maxAsset, remaining))
    if (verified.size_bytes !== source.size_bytes || verified.sha256 !== source.sha256) fail()
    total += verified.size_bytes
    if (!Number.isSafeInteger(total) || total > bounds.maxTotal) fail()
  }
}

export interface ReopenedFinalRenderStagedIntent {
  intent_dir: string
  manifest: Record<string, any>
  manifest_bytes: Buffer
  source_identities: Record<string, FinalRenderStagedSourceIdentity>
}

/** Reopen the immutable S2A snapshot without accepting any live source replacement. */
export async function reopenFinalRenderStagedIntent(
  projectSlug: string,
  jobId: string,
  receipt: FinalRenderIntentStagedReceiptV2,
): Promise<ReopenedFinalRenderStagedIntent> {
  const intentDir = path.join(getUserDataDir(), 'private-render', 'intents', receipt.intent_id)
  const readback = await readManifest(path.join(intentDir, 'manifest.json'))
  const manifest = readback.value
  if (sha256(readback.bytes) !== receipt.staging_manifest_sha256
    || manifest.format !== 'studio.render.story-intent.v1'
    || manifest.job_id !== jobId
    || manifest.project_slug !== projectSlug
    || manifest.intent_id !== receipt.intent_id
    || manifest.story_instance_id !== receipt.story_instance_id
    || manifest.story_attempt !== receipt.story_attempt
    || manifest.gateway_attempt_key !== receipt.gateway_attempt_key
    || manifest.committed_at !== receipt.committed_at
    || !validResolvedLoudness(manifest.loudness)
    || manifest.packet?.packet_digest !== receipt.packet_sha256
    || localFence('studio.render.story.scope.v1', manifest.scope) !== receipt.submission_scope_sha256
    || localFence('studio.render.story.destination.v1', manifest.destination) !== receipt.destination_fence_sha256
    || localFence('studio.render.story.sources.v1', {
      sources: manifest.sources,
      composition: manifest.composition,
    }) !== receipt.source_generation_fence_sha256) fail()
  const bounds = storedDescriptorBounds(manifest.descriptors)
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0 || manifest.sources.length > 32) fail()
  const names = new Set<string>()
  const sourceIdentities: Record<string, FinalRenderStagedSourceIdentity> = {}
  let total = 0
  for (const source of manifest.sources) {
    if (!hasExactKeys(source, ['logical_id', 'role', 'safe_name', 'canonical_source_path', 'size_bytes', 'sha256'])
      || typeof source.logical_id !== 'string' || !source.logical_id
      || typeof source.safe_name !== 'string' || path.basename(source.safe_name) !== source.safe_name
      || names.has(source.safe_name)
      || !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 0
      || typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) fail()
    names.add(source.safe_name)
    const remaining = bounds.maxTotal - total
    if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
    const verified = await hashRegularFile(path.join(intentDir, source.safe_name), Math.min(bounds.maxAsset, remaining))
    if (verified.size_bytes !== source.size_bytes || verified.sha256 !== source.sha256) fail()
    sourceIdentities[source.logical_id] = verified.identity
    total += verified.size_bytes
  }
  return {
    intent_dir: intentDir,
    manifest: structuredClone(manifest),
    manifest_bytes: Buffer.from(readback.bytes),
    source_identities: sourceIdentities,
  }
}

async function stageFinalRenderIntentUnsafe(
  input: Readonly<FinalRenderStagingInput>,
): Promise<{ kind: 'video-assembly-remote-wait' }> {
  if (input.job.type !== 'video_assembly' || input.job.status !== 'running'
    || input.description.kind !== 'exportable'
    || input.description.recipe.profile_digest !== input.discovery.profile_digest
    || input.destination.format !== input.description.recipe.encode?.container
    || !validResolvedLoudness(input.loudness)
    || input.scope.owner_scope !== input.discovery.owner_scope
    || input.scope.gateway_instance_id !== input.discovery.gateway_instance_id
    || input.scope.story_instance_id !== input.discovery.story_instance_id) fail()
  const known = await loadKnownFinalRenderIntentStagedReceipt(input.job.project_slug, input.job.job_id)
  if (known) {
    await validateKnownStagedIntent(input, known)
    let receipt = known
    if (known.revision === 1) {
      const canonicalJob = structuredClone(input.job)
      canonicalJob.final_render_remote_wait = structuredClone(known)
      const committed = await commitFinalRenderRemoteWaitReceipt(canonicalJob, known)
      if (committed.receipt.version !== 2) fail()
      receipt = committed.receipt
    }
    input.job.final_render_remote_wait = structuredClone(receipt)
    input.job.status = 'running'
    input.job.finished_at = null
    return { kind: 'video-assembly-remote-wait' }
  }
  const bounds = descriptorBounds(input.discovery)
  const destination = await captureDestination(input as FinalRenderStagingInput)
  const uuid = testHooks.randomUUID ?? randomUUID
  const intentUuid = canonicalUuid(uuid())
  const gatewayAttemptKey = canonicalUuid(uuid())
  const intentId = `render_${intentUuid.replaceAll('-', '')}`
  const committedAt = (testHooks.now?.() ?? new Date()).toISOString()
  const privateRoot = path.join(getUserDataDir(), 'private-render')
  const parent = path.join(privateRoot, 'intents')
  const intentDir = path.join(parent, intentId)
  await ensurePrivateDirectory(privateRoot)
  await ensurePrivateDirectory(parent)
  await fs.mkdir(intentDir, { recursive: false, mode: 0o700 })
  await ensurePrivateDirectory(intentDir)

  const copied: Awaited<ReturnType<typeof copySource>>[] = []
  let total = 0
  for (const requirement of input.description.source_requirements) {
    const remaining = bounds.maxTotal - total
    if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
    const item = await copySource(requirement, input.description, intentDir, Math.min(bounds.maxAsset, remaining))
    total += item.size_bytes
    if (!Number.isSafeInteger(total) || total > bounds.maxTotal) fail()
    copied.push(item)
  }
  const finalized = finalizeFinalRenderPacket(input.description, copied)
  const sources = copied.map(({ input_mode: _mode, ...item }) => item)
  const scope = {
    origin: input.scope.origin,
    owner_scope: input.scope.owner_scope,
    gateway_instance_id: input.scope.gateway_instance_id,
    story_instance_id: input.scope.story_instance_id,
  }
  const descriptors = {
    profile: { utf8: input.discovery.profile_descriptor_utf8, sha256: input.discovery.profile_digest },
    tools: { utf8: input.discovery.tools.descriptor_utf8, sha256: input.discovery.tools.digest },
    compiler: { utf8: input.discovery.compiler.descriptor_utf8, sha256: input.discovery.compiler.digest },
  }
  const manifest = {
    format: 'studio.render.story-intent.v1',
    job_id: input.job.job_id,
    project_slug: input.job.project_slug,
    episode_id: input.job.episode_id,
    intent_id: intentId,
    story_instance_id: input.scope.story_instance_id,
    story_attempt: 1,
    gateway_attempt_key: gatewayAttemptKey,
    committed_at: committedAt,
    scope,
    packet: finalized.packet,
    sources,
    composition: finalized.composition,
    destination,
    descriptors,
    loudness: structuredClone(input.loudness),
  }
  const manifestBytes = canonicalManifestBytes(manifest)
  const manifestPath = path.join(intentDir, 'manifest.json')
  const scratchPath = path.join(intentDir, `manifest.partial-${intentUuid.replaceAll('-', '')}`)
  await testHooks.probe?.({ phase: 'before-manifest-publish', intent_dir: intentDir, manifest_path: manifestPath })
  const scratch = await fs.open(scratchPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await writeAll(scratch, manifestBytes, 0)
    await scratch.sync()
  } finally {
    await scratch.close()
  }
  await testHooks.probe?.({ phase: 'before-manifest-link', intent_dir: intentDir, manifest_path: manifestPath })
  await fs.link(scratchPath, manifestPath)
  await fsyncDirectory(intentDir)
  await testHooks.probe?.({ phase: 'after-manifest-publish', intent_dir: intentDir, manifest_path: manifestPath })
  await testHooks.probe?.({ phase: 'before-private-readback', intent_dir: intentDir, manifest_path: manifestPath })

  const readback = await readManifest(manifestPath)
  if (sha256(readback.bytes) !== sha256(manifestBytes)) fail()
  for (const item of copied) {
    const verified = await hashRegularFile(path.join(intentDir, item.safe_name), bounds.maxAsset)
    if (verified.size_bytes !== item.size_bytes || verified.sha256 !== item.sha256) fail()
  }
  // Make every newly introduced directory entry durable before the queue can
  // cite this private snapshot. Any uncertainty retains all evidence and never
  // reaches the canonical commitment below.
  await fsyncDirectory(path.dirname(privateRoot))
  await fsyncDirectory(privateRoot)
  await fsyncDirectory(parent)
  const receipt: FinalRenderIntentStagedReceiptV2 = {
    version: 2,
    phase: 'intent_staged',
    revision: 1,
    job_id: input.job.job_id,
    intent_id: intentId,
    story_instance_id: input.scope.story_instance_id,
    story_attempt: 1,
    gateway_attempt_key: gatewayAttemptKey,
    packet_sha256: finalized.packet.packet_digest,
    staging_manifest_sha256: sha256(readback.bytes),
    submission_scope_sha256: localFence('studio.render.story.scope.v1', scope),
    destination_fence_sha256: localFence('studio.render.story.destination.v1', destination),
    source_generation_fence_sha256: localFence('studio.render.story.sources.v1', {
      sources,
      composition: finalized.composition,
    }),
    committed_at: committedAt,
    cancel_requested_at: null,
  }
  const committed = await commitFinalRenderRemoteWaitReceipt(input.job, receipt)
  if (committed.receipt.version !== 2
    || committed.receipt.intent_id !== receipt.intent_id
    || committed.receipt.staging_manifest_sha256 !== receipt.staging_manifest_sha256) fail()
  return { kind: 'video-assembly-remote-wait' }
}

export async function stageFinalRenderIntent(
  input: Readonly<FinalRenderStagingInput>,
): Promise<{ kind: 'video-assembly-remote-wait' }> {
  try {
    return await stageFinalRenderIntentUnsafe(input)
  } catch {
    fail()
  }
}
