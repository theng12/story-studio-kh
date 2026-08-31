/**
 * Durable, fail-closed facts for a later paid image replacement decision.
 * This module deliberately does not schedule, settle, or submit provider work.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { listImageModelsForceLive, type GenStudioImageModel } from '../lib/genstudio-client.js'
import type { Job, PaidImageReplacementAttempt } from '../models/types.js'
import { hashInput, readManifest, recordTaskStrict, type Manifest, type PaidImageOutputSelector, type PaidImageReferenceInput, type TaskManifestEntry } from './task-manifest.js'

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
  owningRoot: string,
  trustedOriginal: { prompt: string; baseScope: string },
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
  const outputPath = revalidatePaidImageOutputPath(owningRoot, entry.original_output_path)
  const verified = capturePaidImageReferenceIdentity(owningRoot, references)
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
  if (!model || !model.available || model.qualification_only || model.chargeable !== true) fail('the original image model is not currently chargeable')
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
  | { action: 'not-eligible'; reason: string }
  | { action: 'recover-original' }
  | { action: 'safe-zero-settlement-retry' }
  | { action: 'wait'; attempt: PaidImageReplacementAttempt }
  | { action: 'commit'; attempt: PaidImageReplacementAttempt; scope: string }
  | { action: 'blocked'; reason: string }

export interface PaidImageCommitPersistence {
  loadAuthoritativeJob(projectSlug: string, jobId: string): Promise<Job | null>
  writeAuthoritativeJob(job: Job): Promise<void>
  readManifest(assetDir: string): Promise<Manifest>
  writeManifestStrict(assetDir: string, key: string, entry: TaskManifestEntry): Promise<void>
}

type PaidImageControl = {
  id: string
  state: string
  failure_code?: string | null
  cancelled?: boolean | null
  reserved_credits?: number | null
  settled_credits?: number | null
  released_credits?: number | null
}

type PaidImageAdmission = {
  capacity_verified: boolean
  credit_balance?: number
  paid_concurrency_limit: number
  paid_active_jobs: number
  paid_queued_jobs: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
}

export interface PaidImageReplacementDependencies {
  readControl(): Promise<PaidImageControl>
  artifactExists(outputPath: string): Promise<boolean>
  getSetting(): Promise<{ enabled: boolean; additional_credit_ceiling: number | null }>
  resolveRate(input: Omit<Parameters<typeof resolvePaidImagePublishedRate>[0], 'models'>): Promise<PaidImagePublishedRate>
  refreshAdmission(): Promise<PaidImageAdmission>
}

export interface PaidImageReplacementDecisionInput {
  job: Job
  asset: {
    assetKey: string
    manifestDir: string
    manifestKey: string
    outputPath: string
    owningRoot: string
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
const commitLocks = new Map<string, Promise<void>>()

function isFiniteCredit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function blocked(reason: string): PaidImageReplacementDecision {
  return { action: 'blocked', reason }
}

function validPolicy(job: Job): number | null {
  const policy = job.paid_image_replacement
  return policy?.enabled === true && policy.wait_minutes === 30 && policy.max_replacements_per_asset === 1
    && Number.isSafeInteger(policy.additional_credit_ceiling) && (policy.additional_credit_ceiling as number) > 0
    ? policy.additional_credit_ceiling as number
    : null
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

function replacementScope(asset: PaidImageReplacementDecisionInput['asset'], attempt: PaidImageReplacementAttempt): string {
  return `paid-image-replacement:${sha256CanonicalJson({
    original_task_id: attempt.original_task_id,
    asset_key: asset.assetKey,
    selector: attempt.output_selector,
    reference_identity_hash: attempt.reference_identity_hash,
  })}`
}

function countedQuote(attempt: PaidImageReplacementAttempt): number | null {
  if (!['committed', 'submitted', 'succeeded', 'failed'].includes(attempt.state)) return 0
  return isFiniteCredit(attempt.quoted_credits) ? attempt.quoted_credits : null
}

async function defaultPersistence(): Promise<PaidImageCommitPersistence> {
  const queue = await import('./job-queue.js')
  return {
    loadAuthoritativeJob: queue.loadAuthoritativeJob,
    writeAuthoritativeJob: queue.writeAuthoritativeJob,
    readManifest,
    writeManifestStrict: recordTaskStrict,
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

function overwriteJob(target: Job, source: Job): void {
  for (const key of Object.keys(target) as Array<keyof Job>) delete target[key]
  Object.assign(target, structuredClone(source))
}

/**
 * Read-only until a verified due-time commitment. This boundary never POSTs;
 * Task 5 consumes only its `commit` permission after both records agree.
 */
export async function decidePaidImageReplacement(input: PaidImageReplacementDecisionInput): Promise<PaidImageReplacementDecision> {
  const ceiling = validPolicy(input.job)
  if (ceiling === null) return { action: 'not-eligible', reason: 'the job has no valid paid image replacement policy' }
  const persistence = input.persistence || await defaultPersistence()
  const now = input.now || (() => new Date())
  let manifest: Manifest
  let entry: TaskManifestEntry | undefined
  let original: PaidImageOriginalRequest
  try {
    manifest = await persistence.readManifest(input.asset.manifestDir)
    entry = manifest.tasks[input.asset.manifestKey]
    if (!entry || !entry.task_id?.trim() || !entry.idempotency_key?.trim() || !entry.input_hash?.trim()) return blocked('the original task identity is incomplete')
    original = readPaidImageOriginalRequest(entry, input.asset.owningRoot, input.asset.trustedOriginal)
    if (original.outputPath !== revalidatePaidImageOutputPath(input.asset.owningRoot, input.asset.outputPath)) {
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
  if (control.state !== 'failed') return { action: 'recover-original' }
  if (control.cancelled === true) return blocked('the original task was cancelled')
  if (!FLEET_FAILURE_CODES.has(String(control.failure_code || ''))) return blocked('the original failure is not an allow-listed transient infrastructure result')
  if (!isFiniteCredit(control.reserved_credits) || !isFiniteCredit(control.settled_credits) || !isFiniteCredit(control.released_credits)
    || control.reserved_credits !== control.settled_credits + control.released_credits) {
    return blocked('the original settlement is incomplete or imbalanced')
  }
  if (await dependencies.artifactExists(asset.outputPath)) return { action: 'recover-original' }
  if (control.settled_credits === 0) {
    return control.released_credits === control.reserved_credits
      ? { action: 'safe-zero-settlement-retry' }
      : blocked('the zero settlement was not fully released')
  }

  const attempts = input.job.paid_image_replacement_attempts || []
  const current = attempts.filter(attempt => attempt.asset_key === asset.assetKey)
  if (current.length > 1) return blocked('the asset has multiple replacement attempts')
  let attempt = current[0]
  if (attempt) {
    if (!sameAttemptFacts(attempt, asset, entry) || !validWaitClock(attempt)) return blocked('the durable replacement attempt does not match the original identity')
    if (attempt.state !== 'waiting') return blocked('the asset already has a paid replacement attempt')
  } else {
    const observed = now()
    if (!Number.isFinite(observed.getTime())) return blocked('the terminal observation clock is invalid')
    attempt = {
      asset_key: asset.assetKey, manifest_dir: asset.manifestDir, manifest_key: asset.manifestKey,
      output_path: asset.outputPath, state: 'waiting', original_task_id: entry.task_id,
      original_idempotency_key: entry.idempotency_key, input_hash: entry.input_hash, output_selector: original.selector,
      reference_inputs: original.references, reference_identity_hash: original.referenceIdentityHash,
      failure_code: String(control.failure_code), reserved_credits: control.reserved_credits,
      settled_credits: control.settled_credits, released_credits: control.released_credits,
      terminal_observed_at: observed.toISOString(), eligible_at: new Date(observed.getTime() + PAID_WAIT_MS).toISOString(),
    }
    const waiting = structuredClone(input.job)
    waiting.paid_image_replacement_attempts = [...attempts, attempt]
    try {
      await persistence.writeAuthoritativeJob(waiting)
      overwriteJob(input.job, waiting)
    } catch (error: any) {
      return blocked(error?.message || 'the paid wait could not be written')
    }
  }

  if (now().getTime() < Date.parse(attempt.eligible_at)) return { action: 'wait', attempt }
  if (await dependencies.artifactExists(asset.outputPath)) return { action: 'recover-original' }
  const setting = await dependencies.getSetting().catch(() => null)
  if (!setting?.enabled) return blocked('paid image replacement is currently off on this machine')
  let rate: PaidImagePublishedRate
  let admission: PaidImageAdmission
  try {
    rate = await dependencies.resolveRate({ modelId: asset.modelId, original, request: original })
    admission = await dependencies.refreshAdmission()
  } catch (error: any) {
    return blocked(error?.message || 'the current price or account capacity could not be verified')
  }
  if (!isFiniteCredit(rate.credits) || !rate.priceVersion || !admission.capacity_verified
    || !Number.isSafeInteger(admission.credit_balance) || (admission.credit_balance as number) < rate.credits) {
    return blocked('the current account balance or capacity cannot authorize this replacement')
  }

  return withCommitLock(input.job.job_id, async () => {
    const authoritative = await persistence.loadAuthoritativeJob(input.job.project_slug, input.job.job_id).catch(() => null)
    if (!authoritative || validPolicy(authoritative) === null) return blocked('the authoritative job is unavailable')
    const authoritativeAttempts = authoritative.paid_image_replacement_attempts || []
    const matches = authoritativeAttempts.filter(candidate => candidate.asset_key === asset.assetKey)
    if (matches.length !== 1 || matches[0]!.state !== 'waiting' || !sameAttemptFacts(matches[0]!, asset, entry!)) {
      return blocked('the authoritative job no longer permits this asset replacement')
    }
    const authoritativeCeiling = validPolicy(authoritative)!
    let committedQuotes = 0
    for (const candidate of authoritativeAttempts) {
      const quote = countedQuote(candidate)
      if (quote === null) return blocked('an existing paid replacement quote is incomplete')
      committedQuotes += quote
    }
    if (committedQuotes + rate.credits > authoritativeCeiling) {
      return blocked('the replacement exceeds the job additional-credit ceiling')
    }
    const scope = replacementScope(asset, matches[0]!)
    const committed: PaidImageReplacementAttempt = {
      ...matches[0]!, state: 'committed', quoted_credits: rate.credits, price_version: rate.priceVersion,
      replacement_scope: scope, replacement_committed_at: now().toISOString(),
    }
    authoritative.paid_image_replacement_attempts = authoritativeAttempts.map(candidate => candidate === matches[0] ? committed : candidate)
    try {
      await persistence.writeAuthoritativeJob(authoritative)
      overwriteJob(input.job, authoritative)
    } catch (error: any) {
      return blocked(error?.message || 'the authoritative job commitment could not be written')
    }
    try {
      await persistence.writeManifestStrict(asset.manifestDir, asset.manifestKey, {
        ...entry!, replacement_of_task_id: committed.original_task_id, replacement_scope: scope,
        replacement_quoted_credits: committed.quoted_credits, replacement_price_version: committed.price_version,
        replacement_committed_at: committed.replacement_committed_at,
      })
    } catch (error: any) {
      return blocked(error?.message || 'the manifest commitment could not be written')
    }
    const [reloaded, rereadManifest] = await Promise.all([
      persistence.loadAuthoritativeJob(input.job.project_slug, input.job.job_id),
      persistence.readManifest(asset.manifestDir),
    ])
    const persisted = reloaded?.paid_image_replacement_attempts?.find(candidate => candidate.asset_key === asset.assetKey)
    const persistedManifest = rereadManifest.tasks[asset.manifestKey]
    if (!persisted || persisted.state !== 'committed' || persisted.replacement_scope !== scope
      || persisted.quoted_credits !== rate.credits || persisted.price_version !== rate.priceVersion
      || persisted.output_path !== asset.outputPath || persistedManifest?.replacement_scope !== scope
      || persistedManifest.replacement_quoted_credits !== rate.credits || persistedManifest.replacement_price_version !== rate.priceVersion
      || persistedManifest.replacement_of_task_id !== committed.original_task_id) {
      return blocked('the durable job and manifest commitment do not agree')
    }
    overwriteJob(input.job, reloaded!)
    return { action: 'commit', attempt: persisted, scope }
  })
}
