/**
 * Durable, fail-closed facts for a later paid image replacement decision.
 * This module deliberately does not schedule, settle, or submit provider work.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { listImageModelsForceLive, type GenStudioImageModel } from '../lib/genstudio-client.js'
import { hashInput, type PaidImageOutputSelector, type PaidImageReferenceInput, type TaskManifestEntry } from './task-manifest.js'

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
