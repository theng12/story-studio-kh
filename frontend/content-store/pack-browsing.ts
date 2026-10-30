/**
 * Browsing the Gateway archive bank as PACKS rather than archives.
 *
 * The owner, 2026-10-30: "the studio library packs are all text and no images,
 * so it's hard to know which one is which. can we have it as a browse-able view
 * too?" The archive bank is one row per released VERSION, so the same pack
 * appeared once per version (Academic Classical Oil 1.0.0 and 1.0.1) and there
 * was no way to tell a Visual Style from a Topic Pack. One card per pack,
 * newest version only, older versions listed in its detail view.
 *
 * Everything here is a pure function of the three wire reads, so the rules can
 * be tested without a browser. Nothing is guessed: a cover is null unless the
 * catalogue really publishes one, and an unreadable size stays null rather than
 * becoming a zero.
 */
import type {
  ContentStoreInstalledPack,
  ContentStoreProduct,
  ContentStoreProductKind,
  GatewayContentArchive,
} from '../composables/useContentStore'
import { contentStoreKindLabel } from './catalog-presentation'

export type PackInstallState = 'unchecked' | 'not_installed' | 'installed_current' | 'update_available' | 'incomplete'
/**
 * 'on_mac' is the aggregate a person means by "installed": current, newer, or
 * needing repair. Counting only up-to-date packs as "Installed" read 0 beside a
 * tab that said 2.
 */
export type PackInstallFilter = 'all' | PackInstallState | 'on_mac'

export interface LibraryPackCover {
  /**
   * A Story-hosted path, never the Gateway's own URL: the renderer's CSP allows
   * `img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*`, so a
   * cover served by a LAN Gateway at `http://host:port` is blocked and fails
   * silently. `/api/content-store/covers/...` is same-origin, and Story's
   * server fetches the one Gateway address on the card's behalf.
   */
  src: string
  alt: string
}

export interface LibraryPackCard {
  /** A pack with no pack id cannot be merged with anything; each row is its own card. */
  key: string
  packId: string
  title: string
  kind: ContentStoreProductKind | 'unknown'
  kindLabel: string
  product: ContentStoreProduct | null
  /** The archive row this card installs. */
  newest: GatewayContentArchive
  /** Every archived version, newest first. Older ones live in the detail view only. */
  versions: readonly GatewayContentArchive[]
  sizeBytes: number | null
  /** null means "no preview yet" — the honest state, never a stand-in image. */
  cover: LibraryPackCover | null
  installState: PackInstallState
  installedVersion: string | null
}

export interface PackLibraryInput {
  archives: readonly GatewayContentArchive[]
  products: readonly ContentStoreProduct[]
  installed: readonly ContentStoreInstalledPack[]
  /**
   * False while the local install state has not been read. The cards still
   * list, but every install state is unknown and none is claimed.
   */
  installsResolved?: boolean
}

/** Kind order for a library, the same deliberate order the installed grid uses. */
const KIND_ORDER: readonly ContentStoreProductKind[] = [
  'series_formula',
  'topic_pack',
  'metadata_formula',
  'visual_style',
  'thumbnail_recipe',
  'font_pack',
  'niche_bundle',
]

/**
 * Numeric x.y.z comparison. Published pack versions are strict semver (the pack
 * schema enforces it), so a non-semver string compares equal and the sort falls
 * back to input order — every version is still listed in the detail view, so
 * nothing is hidden by that fallback.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] as const : null
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return 0
}

export function coverProxyPath(packId: string, version: string): string {
  return `/api/content-store/covers/${encodeURIComponent(packId)}/${encodeURIComponent(version)}`
}

function newestFirst(rows: readonly GatewayContentArchive[]): GatewayContentArchive[] {
  return [...rows].sort((left, right) => compareVersions(right.version, left.version))
}

/**
 * The catalogue's own record for a pack. The release's pack id is the exact
 * match; a product id is the same identifier on a product that has no current
 * release yet, so it is the fallback rather than a second guess.
 */
function productFor(packId: string, products: readonly ContentStoreProduct[]): ContentStoreProduct | null {
  return products.find(product => product.currentRelease?.packId === packId)
    ?? products.find(product => product.productId === packId)
    ?? null
}

function installFacts(
  packId: string,
  newestVersion: string,
  installed: readonly ContentStoreInstalledPack[],
  installsResolved: boolean,
): { installState: PackInstallState; installedVersion: string | null } {
  // Not checked yet is NOT "not installed": an unreadable local state must never
  // read as an empty one (AGENTS.md §6). The card says checking and claims nothing.
  if (!installsResolved) return { installState: 'unchecked', installedVersion: null }
  const rows = installed.filter(pack => pack.packId === packId)
  if (!rows.length) return { installState: 'not_installed', installedVersion: null }
  const active = rows.find(row => row.active) ?? null
  // Installed rows exist but none is active: the local state is inconsistent, so
  // it reports the repairable state rather than pretending the pack is current.
  if (!active) return { installState: 'incomplete', installedVersion: null }
  if (active.installState === 'incomplete') return { installState: 'incomplete', installedVersion: active.version }
  return compareVersions(newestVersion, active.version) > 0
    ? { installState: 'update_available', installedVersion: active.version }
    : { installState: 'installed_current', installedVersion: active.version }
}

export function buildLibraryCards(input: PackLibraryInput): LibraryPackCard[] {
  const installsResolved = input.installsResolved !== false
  const groups = new Map<string, GatewayContentArchive[]>()
  for (const archive of input.archives) {
    // An archive with no pack id is still installable, so it gets its own card
    // keyed by its digest rather than being dropped from the browser.
    const key = archive.packId || ('sha:' + archive.archiveSha256)
    const rows = groups.get(key)
    if (rows) rows.push(archive)
    else groups.set(key, [archive])
  }

  const cards: LibraryPackCard[] = []
  for (const [key, rows] of groups) {
    const versions = newestFirst(rows)
    const newest = versions[0]!
    const product = newest.packId ? productFor(newest.packId, input.products) : null
    const facts = installFacts(newest.packId, newest.version, input.installed, installsResolved)
    const publishedCover = product?.presentation.cover ?? null
    cards.push({
      key,
      packId: newest.packId,
      title: product?.title || newest.title || newest.packId || 'Unnamed pack',
      kind: product?.kind ?? 'unknown',
      kindLabel: product ? contentStoreKindLabel(product.kind) : 'Pack',
      product,
      newest,
      versions,
      sizeBytes: newest.bytes,
      cover: publishedCover && newest.packId && newest.version
        ? { src: coverProxyPath(newest.packId, newest.version), alt: publishedCover.alt }
        : null,
      ...facts,
    })
  }
  return cards
}

function kindRank(kind: LibraryPackCard['kind']): number {
  const index = KIND_ORDER.indexOf(kind as ContentStoreProductKind)
  return index === -1 ? KIND_ORDER.length : index
}

export function orderLibraryCards(cards: readonly LibraryPackCard[]): LibraryPackCard[] {
  return [...cards].sort((left, right) =>
    kindRank(left.kind) - kindRank(right.kind)
    || left.title.localeCompare(right.title)
    || left.key.localeCompare(right.key))
}

export interface LibraryFilter {
  query?: string
  kind?: LibraryPackCard['kind'] | 'all'
  install?: PackInstallFilter
}

export function cardSearchText(card: LibraryPackCard): string[] {
  return [
    card.title,
    card.packId,
    card.kindLabel,
    card.product?.summary ?? '',
    card.product?.description ?? '',
    ...card.product?.presentation.tags ?? [],
    // What the archive itself says it contains — real data for a pack the
    // catalogue does not describe.
    ...card.newest.itemKinds,
  ]
}

export function filterLibraryCards(
  cards: readonly LibraryPackCard[],
  filter: LibraryFilter,
): LibraryPackCard[] {
  const query = (filter.query ?? '').trim().toLocaleLowerCase()
  const kind = filter.kind ?? 'all'
  const install = filter.install ?? 'all'
  return cards.filter(card => {
    if (kind !== 'all' && card.kind !== kind) return false
    if (install === 'on_mac' && !['installed_current', 'update_available', 'incomplete'].includes(card.installState)) return false
    if (install !== 'all' && install !== 'on_mac' && card.installState !== install) return false
    if (!query) return true
    return cardSearchText(card).some(text => text.toLocaleLowerCase().includes(query))
  })
}

export interface LibraryKindOption {
  id: LibraryPackCard['kind'] | 'all'
  label: string
  count: number
}

/** Only the kinds actually present, in library order, so no chip counts 0. */
export function libraryKindOptions(cards: readonly LibraryPackCard[]): LibraryKindOption[] {
  const counts = new Map<LibraryPackCard['kind'], number>()
  for (const card of cards) counts.set(card.kind, (counts.get(card.kind) ?? 0) + 1)
  const options: LibraryKindOption[] = [{ id: 'all', label: 'All kinds', count: cards.length }]
  for (const kind of KIND_ORDER) {
    if (counts.has(kind)) options.push({ id: kind, label: contentStoreKindLabel(kind), count: counts.get(kind)! })
  }
  if (counts.has('unknown')) options.push({ id: 'unknown', label: 'Other packs', count: counts.get('unknown')! })
  return options
}

export interface LibraryInstallOption {
  id: PackInstallFilter
  label: string
  count: number
}

export function libraryInstallOptions(cards: readonly LibraryPackCard[]): LibraryInstallOption[] {
  const count = (state: PackInstallState) => cards.filter(card => card.installState === state).length
  const unchecked = count('unchecked')
  return [
    { id: 'all', label: 'All', count: cards.length },
    { id: 'not_installed', label: 'Not installed', count: count('not_installed') },
    { id: 'update_available', label: 'Update available', count: count('update_available') },
    { id: 'on_mac', label: 'On this Mac', count: count('installed_current') + count('update_available') + count('incomplete') },
    // Only offered when it can happen: a chip that always reads 0 is a promise
    // that something is wrong here when it is not.
    ...(count('incomplete') ? [{ id: 'incomplete' as const, label: 'Needs repair', count: count('incomplete') }] : []),
    // While the local read is unresolved, say so beside the chips rather than
    // folding those packs into "Not installed".
    ...(unchecked ? [{ id: 'unchecked' as const, label: 'Checking…', count: unchecked }] : []),
  ]
}
