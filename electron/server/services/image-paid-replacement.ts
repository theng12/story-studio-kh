/**
 * Durable, fail-closed facts for a later paid image replacement decision.
 * This module deliberately does not schedule, settle, or submit provider work.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { GenStudioImageTerminalFailureError, holdsUnknownOutcome, listImageModelsForceLive, type GenStudioImageModel } from '../lib/genstudio-client.js'
import { resolveImageRetryScope } from '../lib/manifest-recovery.js'
import type { Job, PaidImageReplacementAttempt } from '../models/types.js'
import type { GenStudioAdmissionSnapshot } from '../lib/genstudio-admission.js'
import { hashInput, readManifest, recordPaidImageReplacementStrict, type Manifest, type PaidImageOutputSelector, type PaidImageReferenceInput, type TaskManifestEntry } from './task-manifest.js'

export type { PaidImageOutputSelector, PaidImageReferenceInput } from './task-manifest.js'

export interface PaidImageReferenceIdentity {
  inputs: PaidImageReferenceInput[]
  identity_hash: string
}

export interface PaidImageOriginalRequest {
  selector: PaidImageOutputSelector
  references: PaidImageReferenceInput[]
  referenceIdentityHash: string
  outputPath?: string
}

export interface PaidImagePublishedRate {
  credits: number
  priceVersion: string
  basis: 'published-rate'
}

function fail(message: string): never {
  throw new Error(`Paid image replacement blocked: ${message}`)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function isSelector(value: unknown): value is PaidImageOutputSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.resolution === 'string' && !!row.resolution
    && typeof row.aspect_ratio === 'string' && !!row.aspect_ratio
    && Number.isInteger(row.width) && (row.width as number) > 0
    && Number.isInteger(row.height) && (row.height as number) > 0
    && (row.reference_mode === 'normal' || row.reference_mode === 'reference-guided')
}

function isReferenceInput(value: unknown): value is PaidImageReferenceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.role === 'string' && !!row.role
    && typeof row.path === 'string' && !!row.path
    && isSha256(row.sha256)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalOwnedPath(owningRoot: string, candidate: string): string {
  if (!existsSync(owningRoot) || !statSync(owningRoot).isDirectory()) fail('owning reference root is unavailable')
  if (!existsSync(candidate)) fail('an original reference file is missing')
  const root = realpathSync(owningRoot)
  const resolved = realpathSync(candidate)
  const relative = path.relative(root, resolved)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('an original reference is outside its owning root')
  }
  if (!statSync(resolved).isFile()) fail('an original reference is not a file')
  return resolved
}

/** Resolve an output through its nearest existing parent before any future use. */
export function revalidatePaidImageOutputPath(owningRoot: string, candidate: string): string {
  if (!existsSync(owningRoot) || !statSync(owningRoot).isDirectory()) fail('owning output root is unavailable')
  const requested = path.resolve(candidate)
  let ancestor = requested
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) fail('the original output path has no existing ancestor')
    ancestor = parent
  }
  const root = realpathSync(owningRoot)
  const canonicalAncestor = realpathSync(ancestor)
  const relative = path.relative(root, canonicalAncestor)
  if ((relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)))
    || (!relative && canonicalAncestor !== root)) {
    fail('the original output path is outside its owning root')
  }
  const target = path.resolve(canonicalAncestor, path.relative(ancestor, requested))
  const targetRelative = path.relative(root, target)
  if (!targetRelative || targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) {
    fail('the original output path is outside its owning root')
  }
  return target
}

/** Hash submitted references in submission order; no sorting is permitted. */
export function capturePaidImageReferenceIdentity(
  owningRoot: string,
  references: Array<{ role: string; path: string }>,
): PaidImageReferenceIdentity {
  const inputs = references.map((reference) => {
    if (typeof reference.role !== 'string' || !reference.role.trim()) fail('a reference role is missing')
    const filePath = canonicalOwnedPath(owningRoot, reference.path)
    return {
      role: reference.role,
      path: filePath,
      sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    }
  })
  return { inputs, identity_hash: sha256CanonicalJson(inputs) }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

/** Build the durable hash and scope from the original prompt and frozen facts. */
export function buildPaidImageOriginalIdentity(input: {
  prompt: string
  selector: PaidImageOutputSelector
  references: PaidImageReferenceInput[]
  baseScope: string
}): { inputHash: string; requestScope: string; referenceIdentityHash: string } {
  if (!isSelector(input.selector)) fail('the original output selector is invalid')
  if (typeof input.prompt !== 'string' || typeof input.baseScope !== 'string' || !input.baseScope) fail('the original request is invalid')
  if (!Array.isArray(input.references) || !input.references.every(isReferenceInput)) fail('the original reference inputs are invalid')
  if (input.selector.reference_mode === 'normal' && input.references.length) fail('normal work cannot carry reference inputs')
  const referenceIdentityHash = sha256CanonicalJson(input.references)
  const selectorHash = sha256CanonicalJson(input.selector)
  const requestScope = `${input.baseScope}:selector:${selectorHash}:references:${referenceIdentityHash}`
  const inputHash = hashInput(canonicalJson({
    prompt: input.prompt,
    selector: input.selector,
    references: input.references,
    reference_identity_hash: referenceIdentityHash,
    request_scope: requestScope,
  }))
  return { inputHash, requestScope, referenceIdentityHash }
}

/** Read only the pre-POST facts and prove the original reference bytes remain intact. */
export function readPaidImageOriginalRequest(
  entry: TaskManifestEntry,
  referenceRoot: string,
  trustedOriginal: { prompt: string; baseScope: string },
  outputRoot: string = referenceRoot,
): PaidImageOriginalRequest {
  if (entry.last_state !== 'prepared' && entry.last_state !== 'accepted' && entry.last_state !== 'failed') {
    fail('the original manifest entry is not a prepared image request')
  }
  if (!isSelector(entry.original_output_selector) || !Array.isArray(entry.original_reference_inputs)
    || !entry.original_reference_inputs.every(isReferenceInput) || !isSha256(entry.original_reference_identity_hash)
    || typeof entry.original_output_path !== 'string' || !entry.original_output_path) {
    fail('the original manifest facts are incomplete')
  }
  const references = entry.original_reference_inputs
  if (entry.original_output_selector.reference_mode === 'normal' && references.length) fail('normal work has persisted references')
  const outputPath = revalidatePaidImageOutputPath(outputRoot, entry.original_output_path)
  const verified = capturePaidImageReferenceIdentity(referenceRoot, references)
  if (!sameJson(verified.inputs, references) || verified.identity_hash !== entry.original_reference_identity_hash) {
    fail('the original reference content hash does not match the persisted bytes')
  }
  const identity = buildPaidImageOriginalIdentity({
    prompt: trustedOriginal.prompt,
    baseScope: trustedOriginal.baseScope,
    selector: entry.original_output_selector,
    references,
  })
  if (entry.input_hash !== identity.inputHash) fail('the original input hash does not match trusted request facts')
  if (entry.request_scope !== identity.requestScope) fail('the original request scope does not match trusted request facts')
  return {
    selector: entry.original_output_selector,
    references,
    referenceIdentityHash: entry.original_reference_identity_hash,
    outputPath,
  }
}

/** Resolve a one-image published rate, never a provider quote or settlement. */
export function resolvePaidImagePublishedRate(input: {
  models: readonly GenStudioImageModel[]
  modelId: string
  original: PaidImageOriginalRequest
  request: PaidImageOriginalRequest
}): PaidImagePublishedRate {
  if (!sameJson(input.original.selector, input.request.selector)
    || !sameJson(input.original.references, input.request.references)
    || input.original.referenceIdentityHash !== input.request.referenceIdentityHash) {
    fail('the replacement request differs from the original persisted facts')
  }
  if (!isSelector(input.original.selector) || !isSha256(input.original.referenceIdentityHash)
    || !input.original.references.every(isReferenceInput)
    || sha256CanonicalJson(input.original.references) !== input.original.referenceIdentityHash) {
    fail('the original selector or reference identity is invalid')
  }
  if (input.original.selector.reference_mode === 'normal' && input.original.references.length) {
    fail('normal work cannot use reference identity')
  }
  const model = input.models.find(candidate => candidate.id === input.modelId)
  // Availability, not price: a free model on the owner's Macs (`chargeable: false`) can be replaced too.
  if (!model || !model.available || model.qualification_only) fail('the original image model is not currently available')
  const rows = (model.output_options || []).filter((row) => (
    row.resolution === input.original.selector.resolution
    && row.aspect_ratio === input.original.selector.aspect_ratio
    && row.width === input.original.selector.width
    && row.height === input.original.selector.height
  ))
  if (rows.length !== 1) fail('the original output selector is not exactly one current published row')
  const row = rows[0]!
  const pair = input.original.selector.reference_mode === 'normal'
    ? [row.credits_per_image, row.price_version]
    : [row.reference_generation_credits, row.reference_generation_price_version]
  const fallback = input.original.selector.reference_mode === 'reference-guided'
    ? [model.reference_generation_credits, model.reference_generation_price_version]
    : null
  const [credits, priceVersion] = pair[0] === undefined && pair[1] === undefined && fallback ? fallback : pair
  if (!Number.isFinite(credits) || (credits as number) < 0 || typeof priceVersion !== 'string' || !priceVersion.trim()) {
    fail('the exact current published price pair is incomplete')
  }
  return { credits: credits as number, priceVersion: priceVersion.trim(), basis: 'published-rate' }
}

/** Force and label the exact current published rate; settlement stays separate. */
export async function resolvePaidImageForceLivePublishedRate(
  apiKey: string,
  input: Omit<Parameters<typeof resolvePaidImagePublishedRate>[0], 'models'>,
): Promise<PaidImagePublishedRate> {
  const snapshot = await listImageModelsForceLive(apiKey)
  if (snapshot.freshness !== 'live' || snapshot.stale) fail('the image catalogue was not live')
  return resolvePaidImagePublishedRate({ ...input, models: snapshot.value })
}

export type PaidImageReplacementDecision =
  | { action: 'not-eligible'; reason: string; public_reason: PaidImageReplacementPublicReason }
  | { action: 'recover-original' }
  | { action: 'retry'; scope?: string; attempt_ordinal?: number; max_retries?: number }
  | { action: 'safe-zero-settlement-retry'; scope?: string }
  | { action: 'wait'; attempt: PaidImageReplacementAttempt }
  | { action: 'commit'; attempt: PaidImageReplacementAttempt; scope: string }
  | { action: 'blocked'; reason: string; public_reason: PaidImageReplacementPublicReason }

/** The image-only fully released terminal failure shape, after the policy accepted it. */
export function isReleasedZeroSettlementImageRetry(
  error: unknown,
  decision: PaidImageReplacementDecision | null,
): boolean {
  return error instanceof GenStudioImageTerminalFailureError
    && ZERO_SETTLEMENT_IMAGE_FAILURE_CODES.has(error.failureCode || '')
    && (decision?.action === 'safe-zero-settlement-retry' || (decision as any)?.action === 'retry')
}

/** Recheck the install-level opt-in at the final zero-settlement POST boundary. */
export async function assertReleasedZeroSettlementImageRetrySubmit(): Promise<void> {
  const queue = await import('./job-queue.js')
  await queue.withPaidImageWaitSettingMutation(async () => {
    const settings = await import('./app-settings.js')
    const setting = await settings.getPaidImageReplacementSetting().catch(() => null)
    if (!setting?.enabled) fail('paid image replacement is currently off on this machine')
  })
}

export type PaidImageReplacementPublicReason =
  | 'original_failure_not_eligible'
  | 'replacement_disabled'
  | 'not_verified'

export interface PaidImageCommitPersistence {
  loadAuthoritativeJob(projectSlug: string, jobId: string): Promise<Job | null>
  inspectAuthoritativeJob?(
    projectSlug: string,
    jobId: string,
    inspect: (job: Job) => boolean,
  ): Promise<boolean | null>
  writeAuthoritativeJob(job: Job): Promise<void>
  readManifest(assetDir: string): Promise<Manifest>
  writeManifestStrict(assetDir: string, key: string, entry: TaskManifestEntry): Promise<void>
  mutateAuthoritativeJob?(
    projectSlug: string,
    jobId: string,
    mutate: (job: Job) => Job | null,
  ): Promise<Job | null>
}

type PaidImageControl = {
  id: string
  state: string
  failure_code?: string | null
  cancelled?: boolean | null
  recovery_required?: boolean | null
  recovery_state?: string | null
  settled_credits?: number | null
}

export interface PaidImageReplacementDependencies {
  readControl(): Promise<PaidImageControl>
  artifactExists(outputPath: string): Promise<boolean>
  getSetting(): Promise<{ enabled: boolean; retries?: number }>
  resolveRate(input: Omit<Parameters<typeof resolvePaidImagePublishedRate>[0], 'models'>): Promise<PaidImagePublishedRate>
  refreshAdmission(): Promise<GenStudioAdmissionSnapshot>
}

export interface PaidImageReplacementDecisionInput {
  job: Job
  asset: {
    assetKey: string
    manifestDir: string
    manifestKey: string
    outputPath: string
    owningRoot: string
    referenceRoot?: string
    outputRoot?: string
    trustedOriginal: { prompt: string; baseScope: string }
    modelId: string
    apiKey: string
  }
  persistence?: PaidImageCommitPersistence
  dependencies?: Partial<PaidImageReplacementDependencies>
  now?: () => Date
}

const PAID_WAIT_MS = 30 * 60 * 1_000
const FLEET_FAILURE_CODES = new Set(['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE'])
// `UNKNOWN_OUTCOME` reaches here only once the gateway has CLOSED its hold
// (every caller checks `holdsUnknownOutcome` first): the Hub's own record said
// the batch ended without an image, e.g. a gateway restart mid-render followed
// by the Hub reporting the item `error`. Measured 2026-10-03 on a Z-Image
// thumbnail; without it that thumbnail could never be generated again.
const ZERO_SETTLEMENT_IMAGE_FAILURE_CODES = new Set([...FLEET_FAILURE_CODES, 'SITE_FAILOVER_EXHAUSTED', 'IMAGE_FAILED', 'UNKNOWN_OUTCOME'])
const commitLocks = new Map<string, Promise<void>>()
const EXPLICIT_BLOCKED_FAILURE = /(?:UNCERTAIN|REFUS|VALIDATION|AUTH|CREDIT|BILLING)/i

/** Infrastructure failures that may re-enter the ordinary image executor after a full refund. */
export function isRetryableZeroSettlementImageFailureCode(value: unknown): boolean {
  return typeof value === 'string' && ZERO_SETTLEMENT_IMAGE_FAILURE_CODES.has(value)
}

function isFiniteCredit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Accept only the terminal control's authoritative, nonnegative settlement. */
export function authoritativePaidImageSettledCredits(value: unknown): number | undefined {
  return isFiniteCredit(value) ? value : undefined
}

function blocked(
  reason: string,
  public_reason: PaidImageReplacementPublicReason = 'not_verified',
): PaidImageReplacementDecision {
  return { action: 'blocked', reason, public_reason }
}

/**
 * The switch alone is the policy. Gateway owns the charge, so there is no
 * budget beside `enabled` for this to compare against.
 */
function validPolicy(job: Job): boolean {
  return job.status !== 'cancelled'
}

function sameAttemptFacts(attempt: PaidImageReplacementAttempt, asset: PaidImageReplacementDecisionInput['asset'], entry: TaskManifestEntry): boolean {
  return attempt.asset_key === asset.assetKey
    && attempt.manifest_dir === asset.manifestDir
    && attempt.manifest_key === asset.manifestKey
    && attempt.output_path === asset.outputPath
    && attempt.original_task_id === entry.task_id
    && attempt.original_idempotency_key === entry.idempotency_key
    && attempt.input_hash === entry.input_hash
    && sameJson(attempt.output_selector, entry.original_output_selector)
    && sameJson(attempt.reference_inputs, entry.original_reference_inputs)
    && attempt.reference_identity_hash === entry.original_reference_identity_hash
}

function validWaitClock(attempt: PaidImageReplacementAttempt): boolean {
  const observed = Date.parse(attempt.terminal_observed_at)
  const eligible = Date.parse(attempt.eligible_at)
  return Number.isFinite(observed) && Number.isFinite(eligible) && eligible === observed + PAID_WAIT_MS
}

/**
 * The same eligible failure, still. What answers that is the job's own state —
 * terminal, not cancelled, not held — plus the failure code the attempt was
 * written under. There is no settlement to compare.
 */
function sameTerminalFacts(attempt: PaidImageReplacementAttempt, control: PaidImageControl): boolean {
  return attempt.failure_code === String(control.failure_code)
    && control.state === 'failed'
    && control.cancelled !== true
    && !holdsUnknownOutcome(control)
}

function replacementScope(asset: PaidImageReplacementDecisionInput['asset'], attempt: PaidImageReplacementAttempt): string {
  return `paid-image-replacement:${sha256CanonicalJson({
    original_task_id: attempt.original_task_id,
    asset_key: asset.assetKey,
    selector: attempt.output_selector,
    reference_identity_hash: attempt.reference_identity_hash,
  })}`
}

async function defaultPersistence(): Promise<PaidImageCommitPersistence> {
  const queue = await import('./job-queue.js')
  return {
    loadAuthoritativeJob: queue.loadAuthoritativeJob,
    inspectAuthoritativeJob: queue.inspectAuthoritativeJob,
    writeAuthoritativeJob: queue.writeAuthoritativeJob,
    readManifest,
    writeManifestStrict: recordPaidImageReplacementStrict,
    mutateAuthoritativeJob: queue.mutateAuthoritativeJob,
  }
}

async function defaultDependencies(input: PaidImageReplacementDecisionInput, taskId: string): Promise<PaidImageReplacementDependencies> {
  const client = await import('../lib/genstudio-client.js')
  const settings = await import('./app-settings.js')
  return {
    readControl: async () => client.getGenStudioCancellationStatus(
      'image.generation', await settings.getGenStudioUrl(), input.asset.apiKey, taskId,
      {}, Date.now() + 30_000,
    ),
    artifactExists: async (outputPath) => {
      try {
        const { assertDecodableImage } = await import('../lib/image-validation.js')
        await assertDecodableImage(outputPath, 'Expected paid-image output')
        return true
      } catch { return false }
    },
    getSetting: settings.getImageRetrySetting,
    resolveRate: (rateInput) => resolvePaidImageForceLivePublishedRate(input.asset.apiKey, rateInput),
    refreshAdmission: () => client.refreshGenStudioAdmission(input.asset.apiKey),
  }
}

async function withCommitLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = commitLocks.get(key) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  commitLocks.set(key, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (commitLocks.get(key) === current) commitLocks.delete(key)
  }
}

async function mutateAuthoritativeJob(
  persistence: PaidImageCommitPersistence,
  projectSlug: string,
  jobId: string,
  mutate: (job: Job) => Job | null,
): Promise<Job | null> {
  if (persistence.mutateAuthoritativeJob) return persistence.mutateAuthoritativeJob(projectSlug, jobId, mutate)
  const current = await persistence.loadAuthoritativeJob(projectSlug, jobId)
  if (!current) return null
  const next = mutate(current)
  if (!next) return null
  await persistence.writeAuthoritativeJob(next)
  return next
}

function overwriteJob(target: Job, source: Job): void {
  for (const key of Object.keys(target) as Array<keyof Job>) delete target[key]
  Object.assign(target, structuredClone(source))
}

/**
 * Read-only until a verified due-time commitment. This boundary never POSTs;
 * Task 5 consumes only its `commit` permission after both records agree.
 */
export async function decidePaidImageReplacement(input: PaidImageReplacementDecisionInput): Promise<PaidImageReplacementDecision> {
  if (!validPolicy(input.job)) return {
    action: 'not-eligible', reason: 'the job has no valid paid image replacement policy', public_reason: 'replacement_disabled',
  }
  const persistence = input.persistence || await defaultPersistence()
  const now = input.now || (() => new Date())
  let manifest: Manifest
  let entry: TaskManifestEntry | undefined
  let original: PaidImageOriginalRequest
  try {
    manifest = await persistence.readManifest(input.asset.manifestDir)
    entry = manifest.tasks[input.asset.manifestKey]
    if (!entry || !entry.task_id?.trim() || !entry.idempotency_key?.trim() || !entry.input_hash?.trim()) return blocked('the original task identity is incomplete')
    const referenceRoot = input.asset.referenceRoot || input.asset.owningRoot
    const outputRoot = input.asset.outputRoot || input.asset.owningRoot
    original = readPaidImageOriginalRequest(entry, referenceRoot, input.asset.trustedOriginal, outputRoot)
    if (original.outputPath !== revalidatePaidImageOutputPath(outputRoot, input.asset.outputPath)) {
      return blocked('the persisted output path differs from the asset identity')
    }
  } catch (error: any) {
    return blocked(error?.message || 'the original image identity cannot be verified')
  }
  const defaults = await defaultDependencies(input, entry.task_id)
  const dependencies = { ...defaults, ...input.dependencies }
  const asset = { ...input.asset, outputPath: original.outputPath! }

  let control: PaidImageControl
  try {
    control = await dependencies.readControl()
  } catch {
    return { action: 'recover-original' }
  }
  if (control.id !== entry.task_id) return blocked('the terminal control task does not match the durable original task')
  if (control.cancelled === true) return blocked('the original task was cancelled', 'original_failure_not_eligible')
  if (holdsUnknownOutcome(control) || (control.failure_code === 'UNKNOWN_OUTCOME' && control.recovery_required !== false)) {
    return blocked('the gateway could not confirm the original outcome, so resubmitting could duplicate work', 'original_failure_not_eligible')
  }
  if (EXPLICIT_BLOCKED_FAILURE.test(String(control.failure_code || ''))) return blocked('the original task has an explicit refusal or uncertain submission result', 'original_failure_not_eligible')
  if (control.state !== 'failed') return { action: 'recover-original' }
  const failureCode = String(control.failure_code || '')
  if (!isRetryableZeroSettlementImageFailureCode(failureCode)) return blocked('the original failure is not an allow-listed transient infrastructure result', 'original_failure_not_eligible')
  const initialArtifact = await dependencies.artifactExists(asset.outputPath).catch(() => null)
  if (initialArtifact === null) return blocked('the original artifact could not be audited')
  if (initialArtifact) return { action: 'recover-original' }
  const initialSetting = await dependencies.getSetting().catch(() => null)
  if (!initialSetting?.enabled) return blocked('paid image replacement is currently off on this machine', 'replacement_disabled')

  const maxRetries = typeof initialSetting?.retries === 'number' && Number.isInteger(initialSetting.retries)
    ? Math.min(Math.max(initialSetting.retries, 1), 10)
    : 3

  let retryReason: string | null = null
  let grantedScope = ''
  let attemptOrdinal = 1
  try {
    const authorized = await withCommitLock(input.job.job_id, async () => {
      const inspectFn = persistence.inspectAuthoritativeJob
      const validate = (job: Job): boolean => {
        if (!validPolicy(job)) {
          retryReason = 'the authoritative job was cancelled'
          return false
        }
        const matches = (job.paid_image_replacement_attempts || []).filter(candidate => candidate.asset_key === asset.assetKey)

        // Check if this exact terminal task was already granted a retry (restart replay):
        const existingForTask = matches.find(candidate => candidate.original_task_id === entry!.task_id)
        if (existingForTask) {
          if (!sameAttemptFacts(existingForTask, asset, entry!) || !sameTerminalFacts(existingForTask, control)) {
            retryReason = 'the terminal failure changed during retry'
            return false
          }
          grantedScope = existingForTask.replacement_scope || resolveImageRetryScope({ ...entry!, last_state: 'failed' }, asset.trustedOriginal.baseScope).scope
          return true
        }

        const scopeOrdinal = typeof entry!.request_scope === 'string'
          ? (entry!.request_scope.match(/:retry:(\d+):/) ? parseInt(entry!.request_scope.match(/:retry:(\d+):/)![1], 10) : (entry!.request_scope.includes(':retry:') ? 1 : 0))
          : 0
        const retriesUsed = Math.max(matches.length, scopeOrdinal)
        if (retriesUsed >= maxRetries) {
          retryReason = `the asset has exhausted all configured retry attempts (${maxRetries})`
          return false
        }

        attemptOrdinal = retriesUsed + 1
        const resolved = resolveImageRetryScope({ ...entry!, last_state: 'failed' }, asset.trustedOriginal.baseScope, attemptOrdinal)
        grantedScope = resolved.scope
        return true
      }

      if (inspectFn) {
        return inspectFn(input.job.project_slug, input.job.job_id, validate)
      }
      return validate(input.job)
    })
    if (authorized !== true) return blocked(retryReason || 'the authoritative job is unavailable', 'original_failure_not_eligible')
  } catch (error: any) {
    return blocked(error?.message || 'the retry could not be verified')
  }

  return { action: 'retry', scope: grantedScope, attempt_ordinal: attemptOrdinal, max_retries: maxRetries }
}
