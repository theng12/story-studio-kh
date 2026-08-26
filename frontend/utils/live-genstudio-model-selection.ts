import { isCompleteTierCatalog, type GenStudioCostTier } from './genstudio-cost-tier.js'
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
  cost_tier?: GenStudioCostTier
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

export function genStudioModelLockReason(model: Pick<LiveGenStudioModel, 'locked' | 'lock_reason'>): string {
  if (model.locked !== true) return ''
  return model.lock_reason === 'requires_paid_account'
    ? 'Requires a paid GenStudio account.'
    : 'Locked for this GenStudio account.'
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
  if (!isCompleteTierCatalog(models.map(model => ({ costTier: model.cost_tier })))) {
    return models.find(usable) || null
  }
  return models.find(model => model.cost_tier === 'economy' && usable(model)) || null
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
      return `Your saved GenStudio model "${gap.savedModelId}" is currently unavailable${gap.reason ? ` (${gap.reason})` : ''}. It stays selected until you pick a replacement — nothing was swapped automatically.`
    case 'vanished':
      return `Your saved GenStudio model "${gap.savedModelId}" is no longer offered. Choose a replacement — nothing was swapped automatically.`
  }
}
