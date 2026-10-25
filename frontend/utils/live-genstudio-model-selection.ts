import {
  isCompleteTierCatalog,
  type GenStudioCostTier,
  type GenStudioLlmCostTier,
} from './genstudio-cost-tier.js'
import { isGenStudioProduct } from '../../electron/server/contracts/genstudio-product-identity'

/**
 * Resolve a saved text-model preference against GenStudio's live catalog.
 *
 * A saved id is a preference, never authority. In particular, historic direct
 * provider ids such as `gpt-4o` must not leave a generator stuck after Story
 * Studio moved all text execution behind GenStudio.
 */
export interface LiveGenStudioModel {
  id: string
  available: boolean
  locked?: boolean
  lock_reason?: string | null
  disabled_reason?: string | null
  supports_vision?: boolean
  /**
   * Owner-defined public handle, e.g. `gpt-image-2`.
   *
   * GenStudio is republishing image and video products under their handle
   * rather than their raw id. A saved preset holds the raw id, so both have to
   * be treated as names for the same product — see
   * `@shared/genstudio-product-identity`.
   */
  customer_handle?: string | null
  public_model_id?: string | null
  legacy_ids?: readonly string[]
  cost_tier?: GenStudioCostTier | GenStudioLlmCostTier
  /** Gateway 0.2.82+: where the row's price comes from; `local` = the owner's own Macs (free). */
  price_source?: string
}

export function isUsableLiveGenStudioModel(
  model: LiveGenStudioModel,
  requireVision = false,
): boolean {
  return model.available
    && model.locked !== true
    && !model.disabled_reason
    && (!requireVision || model.supports_vision === true)
}

/**
 * The sentence to show beside a locked catalogue row, or '' when it is open.
 *
 * The gateway publishes its own `lock_reason`, and that sentence is the only
 * honest source for WHY a product is locked: a fleet outage ("every Mac
 * offering this model is offline") is not an account problem, and substituting
 * a billing sentence here sends the owner to the wrong remedy. So anything the
 * gateway states is passed through verbatim; only the known
 * `requires_paid_account` code gets Story's own sentence, and only a locked row
 * that states no reason at all gets the generic one.
 */
export function genStudioModelLockReason(model: Pick<LiveGenStudioModel, 'locked' | 'lock_reason'>): string {
  if (model.locked !== true) return ''
  if (model.lock_reason === 'requires_paid_account') return 'Requires a paid GenStudio account.'
  const published = typeof model.lock_reason === 'string' ? model.lock_reason : ''
  return published.trim() ? published : 'Temporarily unavailable.'
}

/**
 * Keep a valid explicit choice. A saved retired or unavailable product must
 * stay visible for the user to replace; silently switching named products can
 * change quality and price. Only an empty preference may take the first usable
 * live entry. Explicit owner-published aliases remain safe migrations.
 */
export function selectLiveGenStudioModel<T extends LiveGenStudioModel>(
  savedModelId: unknown,
  models: readonly T[],
  requireVision = false,
  tierProfile: 'auto' | 'llm' | 'non-llm' = 'auto',
): T | null {
  const saved = typeof savedModelId === 'string' ? savedModelId.trim() : ''
  const usable = (model: T): boolean => isUsableLiveGenStudioModel(model, requireVision)

  const exact = models.find(model => model.id === saved)
  if (exact && usable(exact)) return exact

  const migrated = saved
    ? models.find(model => usable(model) && isGenStudioProduct(model, saved))
    : undefined
  if (migrated) return migrated

  if (saved) return null
  const tieredModels = models.map(model => ({ costTier: model.cost_tier }))
  const hasLanguageTier = tierProfile === 'llm'
    || (tierProfile === 'auto' && models.some(model => model.cost_tier === 'promotional' || model.cost_tier === 'value'))
  // A writing model is never picked for the owner (2026-10-03): the gateway labels every chat
  // model economy / free, so "the first usable one" could be a paid provider. The picker stays
  // empty and says so; the owner's choice is then remembered as usual.
  if (hasLanguageTier) return null
  // The same rule for images, voices and music: the gateway lists paid cloud
  // models first and tags them "economy", so "first usable" filled the
  // Thumbnail Generator with an OpenAI model (Dreamlands E2E, 2026-10-03).
  // When rows say where their price comes from, only a free fleet model may be
  // chosen for the owner; otherwise the picker stays empty.
  const priced = models.some(model => typeof model.price_source === 'string')
  const defaultable = (model: T): boolean => usable(model) && (!priced || model.price_source === 'local')
  if (!isCompleteTierCatalog(tieredModels)) {
    return models.find(defaultable) || null
  }
  return models.find(model => model.cost_tier === 'economy' && defaultable(model)) || null
}

/**
 * The live id a saved model id should move to when the Gateway republished the
 * same product under a newer identifier — or `null` when it already names the
 * live row, or names nothing this catalogue resolves.
 *
 * A row's own availability may be published as `available` (chat/image/video)
 * or `generation_enabled` (TTS), so both are accepted here rather than making
 * every caller re-map one onto the other.
 *
 * WHY THIS EXISTS. Callers used to inline the alias step and then throw the
 * customer's other choices away with it (`form.voice = null`). A migrated id is
 * the SAME product under a new name, not a different one: the saved voice is
 * still the right selection and must survive the rename (AGENTS.md §1 — persist
 * the selection; §4 — re-resolve when the new value is derivable, and losing
 * the customer's selection on every switch is its own defect). Returning only
 * the id keeps that decision at the call site: it moves the model, and leaves
 * every other field standing.
 */
export type AliasedModelCandidate = Omit<LiveGenStudioModel, 'available'> & {
  available?: boolean
  generation_enabled?: boolean
}

export function resolveAliasedModelId(
  savedModelId: unknown,
  models: readonly AliasedModelCandidate[],
): string | null {
  const saved = typeof savedModelId === 'string' ? savedModelId.trim() : ''
  if (!saved) return null
  const mapped = models.map(model => ({
    ...model,
    available: model.available ?? model.generation_enabled === true,
  }))
  const selected = selectLiveGenStudioModel(saved, mapped as readonly LiveGenStudioModel[])
  return selected && selected.id !== saved ? selected.id : null
}

/**
 * Explains *why* `selectLiveGenStudioModel` returned what it did, so a
 * consuming picker can show the user something more honest than silence
 * when their saved product is gone.
 *
 * `migrated` is an explicit, owner-published alias — quietly following it
 * is the one case that stays a "safe" auto-swap by design (the comment
 * above `selectLiveGenStudioModel` covers why). Everything else where the
 * saved id doesn't resolve is surfaced distinctly:
 *   - `unavailable`: the product still exists in the catalog (temporarily
 *     disabled, paused, etc.) — the saved choice is kept, not healed.
 *   - `vanished`: the product is gone from the catalog entirely, with no
 *     legacy-id trail pointing anywhere. This is the "genuinely disappeared"
 *     case the release-hardening pass called out — a picker must tell the
 *     user their selection needs to be replaced rather than leave a dead id
 *     sitting silently in a form field.
 */
export type GenStudioSelectionGap =
  | { kind: 'empty' }
  | { kind: 'resolved' }
  | { kind: 'migrated'; from: string; to: string }
  | { kind: 'unavailable'; savedModelId: string; reason?: string }
  | { kind: 'vanished'; savedModelId: string }

export function describeGenStudioSelectionGap<T extends LiveGenStudioModel>(
  savedModelId: unknown,
  models: readonly T[],
  requireVision = false,
): GenStudioSelectionGap {
  const saved = typeof savedModelId === 'string' ? savedModelId.trim() : ''
  if (!saved) return { kind: 'empty' }

  const usable = (model: T): boolean => isUsableLiveGenStudioModel(model, requireVision)
  const exact = models.find(model => model.id === saved)
  if (exact && usable(exact)) return { kind: 'resolved' }

  const migrated = models.find(model => usable(model) && isGenStudioProduct(model, saved))
  if (migrated) return { kind: 'migrated', from: saved, to: migrated.id }

  if (exact) return { kind: 'unavailable', savedModelId: saved, reason: exact.disabled_reason || undefined }
  return { kind: 'vanished', savedModelId: saved }
}

/** A ready-to-render sentence for `GenStudioSelectionGap`, or null when there's nothing to tell the user. */
export function genStudioSelectionGapMessage(gap: GenStudioSelectionGap): string | null {
  switch (gap.kind) {
    case 'empty':
    case 'resolved':
    case 'migrated':
      return null
    case 'unavailable':
      return `Your saved Gateway model "${gap.savedModelId}" is currently unavailable${gap.reason ? ` (${gap.reason})` : ''}. It stays selected until you pick a replacement — nothing was swapped automatically.`
    case 'vanished':
      return `"${gap.savedModelId}" was retired — choose a replacement. Story Studio did not swap in another model.`
  }
}
