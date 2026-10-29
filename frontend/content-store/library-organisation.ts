/**
 * Organising an owned library that has outgrown a flat grid.
 *
 * The owner's Studio Library reached sixty-five packs and read as "everywhere":
 * a Visual Style, a Topic Pack and a Thumbnail Recipe sat side by side with
 * nothing but a small tag to tell them apart, and there was no way to see what
 * was still missing from this Mac. Grouping and the install filter are the two
 * answers, and both are pure functions here so they can be tested without a
 * browser.
 */
import type { ContentStoreProduct, ContentStoreProductKind } from '../composables/useContentStore'
import { contentStoreKindLabel } from './catalog-presentation'

/** Formula first, then what a channel needs after it. Kits last: they contain
 *  the others, so they read as a summary rather than an item. */
const KIND_ORDER: readonly ContentStoreProductKind[] = [
  'series_formula',
  'topic_pack',
  'metadata_formula',
  'visual_style',
  'thumbnail_recipe',
  'font_pack',
  'niche_bundle',
]

export type InstallStateFilter = 'all' | 'installed' | 'not_installed'

export interface OwnedInstallFacts {
  installState: string
  currentReleaseId: string | null
}

/** What a caller must be able to answer about one product to sort it. */
export type OwnershipLookup = (product: ContentStoreProduct) => OwnedInstallFacts | null

export interface ProductGroup {
  kind: ContentStoreProductKind
  label: string
  products: readonly ContentStoreProduct[]
}

/**
 * Group by kind in a fixed order, dropping empty groups.
 *
 * Order is deliberate and not alphabetical: a channel is built formula first,
 * and a grid whose sections move about as the library changes is harder to
 * learn than one whose sections are always in the same place.
 */
export function groupProductsByKind(products: readonly ContentStoreProduct[]): ProductGroup[] {
  const groups: ProductGroup[] = []
  for (const kind of KIND_ORDER) {
    const matching = products.filter(product => product.kind === kind)
    if (matching.length) groups.push({ kind, label: contentStoreKindLabel(kind), products: matching })
  }
  // A kind this build does not know about must still be reachable rather than
  // silently vanishing from a library the customer paid for.
  const known = new Set(KIND_ORDER)
  const others = products.filter(product => !known.has(product.kind))
  if (others.length) groups.push({ kind: others[0]!.kind, label: 'Other', products: others })
  return groups
}

/**
 * Split a usage answer into real channel names and channels the check could not
 * read. "Could not check" is never dropped: an unread channel is why a removal
 * was refused, not evidence that it is unused (AGENTS.md 6).
 */
export function splitPackUsage(labels: readonly string[]): { channels: string[]; unchecked: string[] } {
  const unchecked: string[] = []
  const channels: string[] = []
  for (const label of labels) {
    if (label.startsWith('could not check ')) unchecked.push(label.slice('could not check '.length))
    else channels.push(label)
  }
  return { channels, unchecked }
}

/** Whether this product's newest owned release is on this Mac right now. */
export function isInstalledHere(product: ContentStoreProduct, ownership: OwnershipLookup): boolean {
  return ownership(product)?.installState === 'installed_current'
}

/**
 * Products that are owned, installable, and not currently installed.
 *
 * `installed_other_version` and `update_available` both count as missing: the
 * bytes on this Mac are not the release the account owns, which is the whole
 * question "what still needs installing" is asking.
 */
export function missingInstalls(
  products: readonly ContentStoreProduct[],
  ownership: OwnershipLookup,
): ContentStoreProduct[] {
  return products.filter((product) => {
    if (!product.owned || !product.compatible || !product.currentRelease) return false
    const facts = ownership(product)
    if (!facts) return false
    return facts.installState !== 'installed_current' && facts.installState !== 'unavailable'
  })
}

/** The exact releases "Install all missing" would install, in listed order. */
export function missingInstallReleaseIds(
  products: readonly ContentStoreProduct[],
  ownership: OwnershipLookup,
): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const product of missingInstalls(products, ownership)) {
    const releaseId = product.currentRelease!.releaseId
    if (seen.has(releaseId)) continue
    seen.add(releaseId)
    ids.push(releaseId)
  }
  return ids
}

export function filterByInstallState(
  products: readonly ContentStoreProduct[],
  ownership: OwnershipLookup,
  filter: InstallStateFilter,
): ContentStoreProduct[] {
  if (filter === 'all') return [...products]
  if (filter === 'installed') return products.filter(product => isInstalledHere(product, ownership))
  return products.filter(product => !isInstalledHere(product, ownership))
}

/**
 * One plain sentence when an install failed for a reason that will hit EVERY pack
 * (Keychain unavailable, Gateway API Key refused or missing, Gateway not answering,
 * disk full), or null for a failure of that one pack. A batch stops at the first
 * such failure: the other 167 would only fail the same way.
 */
export function systematicInstallFailure(
  error: { status?: number | null; code?: string; detail?: string } | null | undefined,
): string | null {
  if (!error) return null
  const code = error.code ?? ''
  if (code === 'CONTENT_STORE_KEYCHAIN_UNAVAILABLE') {
    return 'This Mac’s Keychain is not available, so Content Packs cannot be installed. Sign in to macOS and unlock the Keychain, restart Story Studio, then try again.'
  }
  if (code === 'CONTENT_STORE_SCOPE_REQUIRED' || code === 'CONTENT_STORE_KEY_REQUIRED' || error.status === 401 || error.status === 403) {
    return 'The Gateway did not accept this Mac’s key. Open Settings, check the Gateway API Key, then try again.'
  }
  if (code === 'GATEWAY_UNREACHABLE') {
    return 'The Gateway is not answering. Open the Gateway app, then try again.'
  }
  if (code === 'CONTENT_PACK_DISK_UNAVAILABLE' || /ENOSPC|no space left/i.test(error.detail ?? '')) {
    return 'This Mac is out of disk space. Free up some space, then try again.'
  }
  return null
}
