/**
 * One published GenStudio product may answer to more than one identifier.
 *
 * GenStudio's products carry both a raw `public_model_id` (`genstudio-image-studio-v1`)
 * and an owner-defined `customer_handle` (`gpt-image-2`). The customer API is
 * moving its image and video listings to publish the handle, and it accepts
 * EITHER form on submit. Story Studio holds saved presets full of the old raw
 * ids, so it has to be able to look at a listing entry and a saved string and
 * answer one question: "is this the product he picked?"
 *
 * That question used to be asked as `item.id === modelId` at a dozen call
 * sites. A single equality test cannot survive a rename — the moment the
 * listing publishes `gpt-image-2`, a preset holding `genstudio-image-studio-v1`
 * matches nothing and the generation fails AFTER the owner has waited for a
 * batch. So identity here is a SET of aliases, not one string, and every call
 * site asks through this module rather than re-deriving the comparison.
 *
 * This lives in `contracts/` because both sides need the same answer: the
 * electron server resolves before it submits a charged request, and the
 * frontend resolves to keep a picker pointed at the owner's saved choice.
 * Frontend reaches it as `@shared/genstudio-product-identity`.
 *
 * Deliberately dependency-free (no zod, no imports) so renderer code can
 * import the values, per the convention documented in nuxt.config.ts.
 */

/**
 * The identifier-bearing fields of a listing entry.
 *
 * Every field except `id` is optional because the API does not publish them
 * all today — and that is the point. Story Studio reads whichever of these
 * GenStudio sends, so the day the listing starts carrying `customer_handle`
 * the client already understands it without another release.
 */
export interface GenStudioProductIdentity {
  id: string
  /** Owner-defined public handle, e.g. `gpt-image-2`. */
  customer_handle?: string | null
  /** Raw product id, when the listing publishes the handle as `id`. */
  public_model_id?: string | null
  /** Superseded identifiers this product still answers to. */
  legacy_ids?: readonly string[] | null
}

/** Trim and case-fold, so a saved id never misses on whitespace or casing. */
function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Every identifier this product answers to, de-duplicated, `id` first.
 *
 * Returns them in the CASING GenStudio published, because callers use these as
 * display-label keys as well as for matching; lowercasing here would silently
 * change those keys. De-duplication is still case-insensitive. Matching is
 * done by `isGenStudioProduct`, which case-folds both sides.
 */
export function genStudioProductAliases(model: GenStudioProductIdentity): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) return
    seen.add(key)
    aliases.push(trimmed)
  }
  push(model?.id)
  push(model?.customer_handle)
  push(model?.public_model_id)
  for (const legacy of model?.legacy_ids || []) push(legacy)
  return aliases
}

/**
 * Does `savedModelId` name this product — by id, handle, raw product id, or a
 * published legacy id?
 */
export function isGenStudioProduct(
  model: GenStudioProductIdentity,
  savedModelId: unknown,
): boolean {
  const saved = normalize(savedModelId)
  if (!saved) return false
  return genStudioProductAliases(model).some(alias => alias.toLowerCase() === saved)
}

/**
 * Find the product `savedModelId` names, by any identifier it publishes.
 *
 * Replaces `catalog.find(item => item.id === modelId)`. An exact `id` hit wins
 * over an alias hit, so a handle that happens to collide with another
 * product's legacy id can never shadow the product that actually owns it.
 */
export function findGenStudioProduct<T extends GenStudioProductIdentity>(
  catalog: readonly T[],
  savedModelId: unknown,
): T | undefined {
  const saved = normalize(savedModelId)
  if (!saved || !Array.isArray(catalog)) return undefined
  return catalog.find(item => normalize(item?.id) === saved)
    || catalog.find(item => isGenStudioProduct(item, saved))
}

/*
 * Deliberately NOT provided: a "canonical id to submit" helper.
 *
 * It is tempting to echo the catalog's own `id` back on submit, but the
 * identifier Story Studio sends is folded into the GenStudio idempotency key.
 * Rewriting a saved preset's id on the wire would change that key, so an
 * accepted-but-unfinished job would stop being recognised as a replay and the
 * owner could be billed twice for one image. GenStudio accepts either form, so
 * the saved value travels UNCHANGED; only local resolution is alias-aware.
 */
