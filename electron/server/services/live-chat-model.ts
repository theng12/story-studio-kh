/**
 * "Is this saved chat model still a product the Gateway publishes today?"
 *
 * A saved reference is written once and can outlive the product: the pipeline
 * preset, a queued chain or an episode recovery plan keeps the id it was
 * admitted with, and the catalogue renames or retires products underneath it.
 * The run then failed at that step — for a recovery plan, after Audio Assembly
 * and transcription had already spent hours.
 *
 * Two answers, deliberately kept apart:
 *
 *   - The catalogue publishes the product under ANY identifier it answers to
 *     (id, customer handle, raw product id, a published legacy id). That is the
 *     same product, so the saved id keeps working. The caller keeps sending the
 *     SAVED id — it is part of the chat idempotency key, so rewriting it would
 *     make a retry a second charge — and says which id the catalogue publishes
 *     when they differ. This is resolution, not substitution.
 *
 *   - The catalogue publishes it under nothing. There is no replacement to
 *     pick: silently choosing a different product would change the writing
 *     quality the owner chose, which AGENTS.md forbids. The caller refuses, by
 *     name, before any work starts.
 *
 * `undefined` means "the Gateway could not be read" — an outage, not a missing
 * model. Callers must let the run proceed on `undefined`; the step's own refusal
 * is the answer to an outage, and blocking every run because the catalogue was
 * briefly unreachable would be worse than the failure this guards.
 */
import { getApiKey } from './app-secrets-store.js'
import { listChatModels, type GenStudioChatModel } from '../lib/genstudio-client.js'
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from './genstudio-model-migration.js'

export interface LiveChatModel {
  /** The catalogue row that answered. */
  product: GenStudioChatModel
  /** The id the live catalogue publishes for this product. */
  id: string
  /** The saved string, when the catalogue answered under a different identifier. */
  saved_as: string | null
}

export async function findLiveChatModel(savedModel: unknown): Promise<LiveChatModel | null | undefined> {
  const saved = resolveGenStudioModelId('chat', typeof savedModel === 'string' ? savedModel : '')
  if (!saved) return null
  // A timeline-only run names no model at all. This is Story's own value, not a
  // catalogue product, so there is nothing to resolve and nothing to refuse —
  // two real recovery plans (EP0001, EP0083) carry it in their Scene Plan node.
  if (saved === 'deterministic-timeline') return undefined
  let catalog: GenStudioChatModel[]
  try {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) return undefined
    catalog = await listChatModels(apiKey)
  } catch {
    return undefined
  }
  const product = findGenStudioProduct(catalog, saved)
  // Published but switched off is "unavailable" in the sentence the caller
  // gives: the same dead end as a retired id, and no request can be served.
  if (!product || !product.available) return null
  return {
    product,
    id: product.id,
    saved_as: product.id.trim().toLowerCase() === saved.trim().toLowerCase() ? null : saved,
  }
}

/** The one sentence a saved chat model the live catalogue does not publish gets. */
export function savedChatModelGoneMessage(savedModel: string): string {
  return unavailableLegacyModelMessage('chat', savedModel)
}
