/**
 * Live-catalogue default LLM resolution.
 *
 * The audit (v1.0.669+ GenStudio-only pipeline) found several call sites
 * that fell back to a hardcoded external product id (e.g.
 * 'deepseek-v4-flash') whenever the caller didn't specify a model. Those
 * literals were treated as EXECUTION AUTHORITY — submitted straight to
 * GenStudio for generation — even though `lib/ai-client.ts` only
 * length-validates the model string and never checks catalogue membership.
 * A retired/renamed product id would then be submitted blind.
 *
 * GenStudio owns the product catalogue. Story Studio must never invent a
 * product id; it may only submit ids that the live `/v1/chat/models`
 * catalogue currently reports as usable. This module is the single place
 * that makes that decision for chat/text generation.
 */

import { listChatModels } from '../lib/genstudio-client.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'

export interface ResolvedDefaultChatModel {
  /** The GenStudio product id to submit. Always a live, usable catalogue id. */
  modelId: string
  /** True when a saved selection was removed, retired, or qualification-only,
   *  so this result healed to a different live product. Account-locked
   *  selections fail closed instead of healing. Callers that hold a saved
   *  preference should persist `modelId` back so the heal becomes durable
   *  and should surface this to the operator instead of healing silently. */
  healed: boolean
  /** The saved selection that was requested (trimmed), or null if none was
   *  given. Present even when healing occurred, so callers can log/report
   *  what was replaced. */
  requestedModelId: string | null
}

/** A product is selectable when GenStudio marks it available, unlocked, and
 *  not qualification-gated. Never infer usability from the product's name. */
function isUsableChatModel(model: GenStudioChatModel): boolean {
  return model.available === true && model.qualification_only !== true && model.locked !== true
}

/**
 * Resolve the model id that should actually be submitted for a chat/text
 * generation request.
 *
 *  - If `savedModelId` is set and still present + usable in the live
 *    catalogue, it wins (explicit user selections are preserved).
 *  - If `savedModelId` is set but is no longer usable (removed, retired,
 *    now qualification-only), this heals to the first usable live product
 *    and reports `healed: true` so the caller can persist/surface the change
 *    — it never heals silently to a value the caller can't see.
 *  - If `savedModelId` names an account-locked product, resolution fails
 *    closed. A lock is an explicit access boundary, not a retired preference.
 *  - If `savedModelId` is absent, the first usable live product is chosen.
 *  - If the catalogue can't be reached, or reports no usable product at
 *    all, this throws with an actionable message. It never substitutes a
 *    literal product id — GenStudio being offline is not a reason to guess.
 */
export async function resolveDefaultChatModel(
  apiKey: string,
  savedModelId?: string | null,
): Promise<ResolvedDefaultChatModel> {
  const requestedModelId = savedModelId?.trim() || null

  let catalog: GenStudioChatModel[]
  try {
    catalog = await listChatModels(apiKey)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not resolve a default GenStudio language model: the live catalog is unreachable (${message}). ` +
      'Check the GenStudio API key in Settings → This Mac, or choose a model explicitly, then try again.',
    )
  }

  const usable = catalog.filter(isUsableChatModel)

  if (requestedModelId) {
    const requested = catalog.find(model => model.id === requestedModelId)
    if (requested?.locked === true) {
      const accessDetail = requested.lock_reason === 'requires_paid_account'
        ? ' It requires a paid GenStudio account.'
        : ''
      throw new Error(
        `The selected GenStudio language model "${requestedModelId}" is locked for this account.${accessDetail} ` +
        'Story Studio did not substitute another model. Choose an unlocked model, then try again.',
      )
    }
    const match = usable.find(model => model.id === requestedModelId)
    if (match) return { modelId: match.id, healed: false, requestedModelId }
  }

  const fullyTiered = usable.length > 0 && usable.every(model => model.cost_tier !== undefined)
  const fallback = fullyTiered
    ? usable.find(model => model.cost_tier === 'economy')
    : usable[0]
  if (!fallback) {
    if (fullyTiered) {
      throw new Error(
        'No published Economy GenStudio language model is currently available. ' +
        'Choose an Economy model explicitly after GenStudio publishes one; Story Studio will not substitute Balanced or Premium automatically.',
      )
    }
    throw new Error(
      'No published GenStudio language model is currently available. ' +
      'Open GenStudio KH, publish/enable a chat model, then try again.',
    )
  }

  return { modelId: fallback.id, healed: !!requestedModelId, requestedModelId }
}
