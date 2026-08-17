/**
 * Where a library entry came from.
 *
 * ZERO RUNTIME DEPENDENCIES ON PURPOSE, like its siblings
 * `contracts/subtitle-style.ts` and `contracts/scene-effects.ts`: the pickers
 * import `BUILT_IN_ORIGIN` as a VALUE, so this module must not drag zod into
 * the browser bundle.
 *
 * v1.2.1. Caption looks and scene effects can now arrive from an installed
 * content pack as well as from the app itself, and the customer is entitled to
 * know which. A style that came with Story Studio and a style that came from a
 * pack behave identically at render time but do NOT behave identically when the
 * pack is uninstalled, so "where is this from" is load-bearing information
 * rather than decoration.
 *
 * The pack id is carried, not inferred. An item id is namespaced to its
 * PUBLISHER (`com.storystudio.overlay.foo`), not to its pack
 * (`com.storystudio.pack.overlay.foo`), so the owning pack cannot be recovered
 * from the id alone — it comes from the verified manifest that delivered it.
 */

export interface ContentOrigin {
  origin: 'built-in' | 'content-pack'
  /** Present only for `content-pack`. The verified pack that delivered the item. */
  pack_id?: string
  pack_version?: string
}

/** Everything shipped with the app carries this. Frozen so it can be shared. */
export const BUILT_IN_ORIGIN: ContentOrigin = Object.freeze({ origin: 'built-in' })

/** True when an id is a qualified reverse-DNS content-pack item id. */
const QUALIFIED_ID = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/**
 * Whether an id could only have come from a content pack.
 *
 * Built-in ids are bare slugs (`clean-broadcast`, `ken-burns`, `vignette-soft`)
 * and pack item ids are always qualified, so the two namespaces cannot collide.
 * That is an invariant rather than a coincidence, and `content-pack-style-effects
 * .test.ts` pins it — the merge in `services/style-effect-loader.ts` refuses a
 * collision loudly rather than letting a pack shadow a built-in, but this
 * predicate is what lets a render explain an id it can no longer resolve.
 */
export function isContentPackItemId(id: string): boolean {
  return QUALIFIED_ID.test(id)
}
