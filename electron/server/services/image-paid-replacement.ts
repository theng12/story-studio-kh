/**
 * Durable, fail-closed facts for a later paid image replacement decision.
 * This module deliberately does not schedule, settle, or submit provider work.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { GenStudioImageTerminalFailureError, holdsUnknownOutcome, listImageModelsForceLive, type GenStudioImageModel } from '../lib/genstudio-client.js'
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
  | { action: 'safe-zero-settlement-retry' }
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
    && decision?.action === 'safe-zero-settlement-retry'
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
  getSetting(): Promise<{ enabled: boolean }>
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
  const policy = job.paid_image_replacement
  return policy?.enabled === true && policy.wait_minutes === 30 && policy.max_replacements_per_asset === 1
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
    getSetting: settings.getPaidImageReplacementSetting,
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
  if (holdsUnknownOutcome(control)) return blocked('the gateway could not confirm the original outcome, so resubmitting could duplicate work', 'original_failure_not_eligible')
  if (EXPLICIT_BLOCKED_FAILURE.test(String(control.failure_code || ''))) return blocked('the original task has an explicit refusal or uncertain submission result', 'original_failure_not_eligible')
  if (control.state !== 'failed') return { action: 'recover-original' }
  const failureCode = String(control.failure_code || '')
  if (!isRetryableZeroSettlementImageFailureCode(failureCode)) return blocked('the original failure is not an allow-listed transient infrastructure result', 'original_failure_not_eligible')
  if (!FLEET_FAILURE_CODES.has(failureCode) && typeof control.settled_credits === 'number' && control.settled_credits > 0) {
    return blocked('the original failure was charged and cannot be retried or replaced', 'original_failure_not_eligible')
  }
  const initialArtifact = await dependencies.artifactExists(asset.outputPath).catch(() => null)
  if (initialArtifact === null) return blocked('the original artifact could not be audited')
  if (initialArtifact) return { action: 'recover-original' }
  const initialSetting = await dependencies.getSetting().catch(() => null)
  if (!initialSetting?.enabled) return blocked('paid image replacement is currently off on this machine', 'replacement_disabled')

  const alreadyRetried = typeof entry.request_scope === 'string' && entry.request_scope.includes(':retry:')
  const hasSettlement = typeof control.settled_credits === 'number' && control.settled_credits > 0
  if (!FLEET_FAILURE_CODES.has(failureCode) || (!alreadyRetried && !hasSettlement)) {
    let zeroReason: string | null = null
    try {
      const authorized = await withCommitLock(input.job.job_id, async () => {
        if (!persistence.inspectAuthoritativeJob) {
          zeroReason = 'the authoritative job cannot be inspected atomically'
          return null
        }
        return persistence.inspectAuthoritativeJob(input.job.project_slug, input.job.job_id, (job) => {
          if (!validPolicy(job)) { zeroReason = 'the authoritative job has no valid paid image replacement policy'; return false }
          const matches = (job.paid_image_replacement_attempts || []).filter(candidate => candidate.asset_key === asset.assetKey)
          if (matches.length > 1) { zeroReason = 'the authoritative job has multiple replacement attempts for this asset'; return false }
          if (matches[0]) {
            zeroReason = sameAttemptFacts(matches[0], asset, entry!) && validWaitClock(matches[0]) && sameTerminalFacts(matches[0], control)
              ? 'the asset already has a paid replacement attempt'
              : 'the terminal failure or settlement changed during the paid wait'
            return false
          }
          return true
        })
      })
      if (authorized !== true) return blocked(zeroReason || 'the authoritative job is unavailable')
    } catch (error: any) {
      return blocked(error?.message || 'the free retry could not be verified')
    }
    return { action: 'safe-zero-settlement-retry' }
  }

  if (!FLEET_FAILURE_CODES.has(failureCode)) {
    return blocked('exhausted failover is eligible only after a fully released zero settlement', 'original_failure_not_eligible')
  }

  let attempt: PaidImageReplacementAttempt | undefined
  let waitingReason: string | null = null
  try {
    const waiting = await withCommitLock(input.job.job_id, () => mutateAuthoritativeJob(
      persistence, input.job.project_slug, input.job.job_id, (authoritative) => {
        if (!validPolicy(authoritative)) { waitingReason = 'the authoritative job has no valid paid image replacement policy'; return null }
        const attempts = authoritative.paid_image_replacement_attempts || []
        const current = attempts.filter(candidate => candidate.asset_key === asset.assetKey)
        if (current.length > 1) { waitingReason = 'the authoritative job has multiple replacement attempts for this asset'; return null }
        if (current[0]) {
          if (!sameAttemptFacts(current[0], asset, entry!) || !validWaitClock(current[0])) {
            waitingReason = 'the durable replacement attempt does not match the original identity'; return null
          }
          if (current[0].state !== 'waiting') { waitingReason = 'the asset already has a paid replacement attempt'; return null }
          attempt = current[0]
          return authoritative
        }
        const observed = now()
        if (!Number.isFinite(observed.getTime())) { waitingReason = 'the terminal observation clock is invalid'; return null }
        attempt = {
          asset_key: asset.assetKey, manifest_dir: asset.manifestDir, manifest_key: asset.manifestKey,
          output_path: asset.outputPath, state: 'waiting', original_task_id: entry!.task_id,
          original_idempotency_key: entry!.idempotency_key!, input_hash: entry!.input_hash!, output_selector: original.selector,
          reference_inputs: original.references, reference_identity_hash: original.referenceIdentityHash,
          failure_code: String(control.failure_code),
          terminal_observed_at: observed.toISOString(), eligible_at: new Date(observed.getTime() + PAID_WAIT_MS).toISOString(),
        }
        authoritative.paid_image_replacement_attempts = [...attempts, attempt]
        return authoritative
      },
    ))
    if (!waiting || !attempt) return blocked(waitingReason || 'the authoritative job is unavailable')
    overwriteJob(input.job, waiting)
  } catch (error: any) {
    return blocked(error?.message || 'the paid wait could not be written')
  }

  if (now().getTime() < Date.parse(attempt.eligible_at)) return { action: 'wait', attempt }
  if (!sameTerminalFacts(attempt, control)) return blocked('the terminal failure or settlement changed during the paid wait')
  const dueArtifact = await dependencies.artifactExists(asset.outputPath).catch(() => null)
  if (dueArtifact === null) return blocked('the original artifact could not be audited')
  if (dueArtifact) return { action: 'recover-original' }
  const setting = await dependencies.getSetting().catch(() => null)
  if (!setting?.enabled) return blocked('paid image replacement is currently off on this machine', 'replacement_disabled')
  let rate: PaidImagePublishedRate
  let admission: GenStudioAdmissionSnapshot
  try {
    rate = await dependencies.resolveRate({ modelId: asset.modelId, original, request: original })
    admission = await dependencies.refreshAdmission()
  } catch (error: any) {
    return blocked(error?.message || 'the current price or account capacity could not be verified')
  }
  const queue = await import('./job-queue.js')
  // Capacity is the Gateway's answer, not a balance Story keeps. A price it did
  // not publish is still a reason to stop: the attempt records that figure.
  if (!rate.priceVersion || !queue.hasVerifiedGenStudioAdmission(admission)) {
    return blocked('the current account capacity cannot authorize this replacement')
  }

  return withCommitLock(input.job.job_id, async () => {
    let committed: PaidImageReplacementAttempt | undefined
    let scope: string | undefined
    let refusal: string | undefined
    let notDue = false
    let durable: Job | null
    try {
      durable = await mutateAuthoritativeJob(persistence, input.job.project_slug, input.job.job_id, (authoritative) => {
        if (!validPolicy(authoritative)) { refusal = 'the authoritative job is unavailable'; return null }
        const authoritativeAttempts = authoritative.paid_image_replacement_attempts || []
        const matches = authoritativeAttempts.filter(candidate => candidate.asset_key === asset.assetKey)
        const latest = matches[0]
        if (matches.length !== 1 || !latest || latest.state !== 'waiting'
          || !sameAttemptFacts(latest, asset, entry!) || !validWaitClock(latest)) {
          refusal = 'the authoritative job no longer permits this asset replacement'; return null
        }
        if (now().getTime() < Date.parse(latest.eligible_at)) {
          notDue = true
          committed = latest
          return authoritative
        }
        scope = replacementScope(asset, latest)
        committed = {
          ...latest, state: 'committed', quoted_credits: rate.credits, price_version: rate.priceVersion,
          replacement_scope: scope, replacement_committed_at: now().toISOString(),
        }
        authoritative.paid_image_replacement_attempts = authoritativeAttempts.map(candidate => candidate === latest ? committed! : candidate)
        return authoritative
      })
    } catch (error: any) {
      return blocked(error?.message || 'the authoritative job commitment could not be written')
    }
    if (!durable || !committed || !scope && !notDue) return blocked(refusal || 'the authoritative job commitment could not be written')
    overwriteJob(input.job, durable)
    if (notDue) return { action: 'wait', attempt: committed }
    try {
      await persistence.writeManifestStrict(asset.manifestDir, asset.manifestKey, {
        ...entry!, replacement_of_task_id: committed.original_task_id, replacement_scope: scope!,
        replacement_quoted_credits: committed.quoted_credits, replacement_price_version: committed.price_version,
        replacement_committed_at: committed.replacement_committed_at,
      })
    } catch (error: any) {
      return blocked(error?.message || 'the manifest commitment could not be written')
    }
    let reloaded: Job | null
    let rereadManifest: Manifest
    try {
      [reloaded, rereadManifest] = await Promise.all([
        persistence.loadAuthoritativeJob(input.job.project_slug, input.job.job_id),
        persistence.readManifest(asset.manifestDir),
      ])
    } catch (error: any) {
      return blocked(error?.message || 'the durable commitment could not be reread')
    }
    const persisted = reloaded?.paid_image_replacement_attempts?.find(candidate => candidate.asset_key === asset.assetKey)
    const persistedManifest = rereadManifest.tasks[asset.manifestKey]
    if (!persisted || persisted.state !== 'committed' || persisted.replacement_scope !== scope
      || persisted.quoted_credits !== rate.credits || persisted.price_version !== rate.priceVersion
      || persisted.output_path !== asset.outputPath || persisted.replacement_committed_at !== committed.replacement_committed_at
      || persistedManifest?.original_output_path !== entry!.original_output_path || persistedManifest.input_hash !== entry!.input_hash
      || !sameJson(persistedManifest.original_output_selector, entry!.original_output_selector)
      || !sameJson(persistedManifest.original_reference_inputs, entry!.original_reference_inputs)
      || persistedManifest.original_reference_identity_hash !== entry!.original_reference_identity_hash
      || persistedManifest?.replacement_scope !== scope
      || persistedManifest.replacement_quoted_credits !== rate.credits || persistedManifest.replacement_price_version !== rate.priceVersion
      || persistedManifest.replacement_of_task_id !== committed.original_task_id
      || persistedManifest.replacement_committed_at !== committed.replacement_committed_at) {
      return blocked('the durable job and manifest commitment do not agree')
    }
    overwriteJob(input.job, reloaded!)
    return { action: 'commit', attempt: persisted, scope: scope! }
  })
}
