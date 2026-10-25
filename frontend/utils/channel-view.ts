/**
 * The start page's view of a channel list: what the search box matches, which
 * channels a set of labels keeps, how the list is ordered — plus the small
 * local memory of which sort and which label filter were last used.
 *
 * ── Why the logic lives here and not in the page ──
 *
 * `pages/index.vue` is one long template with a dozen loaders in it, and none of
 * this needs the DOM: it is a pure function of a channel list and a few strings.
 * Keeping it here is what makes it testable without mounting anything. The page
 * keeps only what is genuinely the page's: the inputs, the chips and when to
 * re-read the list.
 *
 * ── What search matches ──
 *
 * The channel's NAME, its LABELS, its episode prefix and its audience language
 * — the things the card actually shows. Deliberately not the slug, the stored
 * Formula id or anything else the card does not name: a channel that appears in
 * the results with no visible reason for it reads as a bug, and this app has
 * been bitten before by a value nobody could see deciding what someone got.
 *
 * ── What is remembered ──
 *
 * The last sort and the last label filter, per Mac, the way the app remembers
 * other local view preferences. The SEARCH TEXT is deliberately NOT remembered:
 * a remembered search is the classic "where did my channels go" — you open the
 * page and the list is not the list you expect, with no obvious cause.
 */

import {
  MAX_PROJECT_LABELS,
  MAX_PROJECT_LABEL_LENGTH,
  normalizeProjectLabels,
} from '@shared/project-labels'

export { MAX_PROJECT_LABELS, MAX_PROJECT_LABEL_LENGTH, normalizeProjectLabels }

/** Anything shaped like a row from `GET /projects` (plus the fields added for
 *  labels and recency). Fields are read defensively — a row from an older
 *  build is missing them, and a missing label list is not a broken one. */
export interface ChannelRow {
  name?: unknown
  slug?: unknown
  episode_prefix?: unknown
  created_at?: unknown
  labels?: unknown
  content_language?: unknown
  last_worked_at?: unknown
}

// ── sorting ─────────────────────────────────────────────────────────────────

export const CHANNEL_SORTS = ['recent', 'name', 'newest', 'oldest'] as const
export type ChannelSort = typeof CHANNEL_SORTS[number]

/** What the sort select says. `recent` is first because it is the default. */
export const CHANNEL_SORT_LABELS: Readonly<Record<ChannelSort, string>> = {
  recent: 'Recently worked on',
  name: 'Name A–Z',
  newest: 'Newest',
  oldest: 'Oldest',
}
export const DEFAULT_CHANNEL_SORT: ChannelSort = 'recent'

export function isChannelSort(value: unknown): value is ChannelSort {
  return typeof value === 'string' && (CHANNEL_SORTS as readonly string[]).includes(value)
}

function channelName(row: ChannelRow | null | undefined): string {
  return String(row?.name || row?.slug || '').trim()
}

/** A stored timestamp, or null when there is nothing usable there. A value that
 *  cannot be parsed is UNKNOWN, never a zero that would sort as the oldest. */
function timestampOf(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Ordered rows. Unknown times always sort LAST, in both `recent` and the two
 * created-at orders: a channel whose folder could not be read is not evidence
 * that it is the oldest, and saying so would be a number invented from an
 * absence (AGENTS §6). Ties fall back to the name, so the list never reorders
 * itself between two renders.
 */
export function sortChannels<T extends ChannelRow>(rows: readonly T[], sort: ChannelSort): T[] {
  const out = [...rows]
  const byName = (a: T, b: T) => channelName(a).localeCompare(channelName(b), undefined, { numeric: true })
  if (sort === 'name') return out.sort(byName)
  const field = sort === 'recent' ? 'last_worked_at' : 'created_at'
  const direction = sort === 'oldest' ? 1 : -1
  return out.sort((a, b) => {
    const at = timestampOf(a[field])
    const bt = timestampOf(b[field])
    if (at === null && bt === null) return byName(a, b)
    if (at === null) return 1
    if (bt === null) return -1
    return at === bt ? byName(a, b) : (at - bt) * direction
  })
}

// ── language ────────────────────────────────────────────────────────────────

/**
 * The audience language as the card shows it. The catalogue is the two values
 * `content_language` can hold (project contract), and an unset or unknown code
 * shows NOTHING rather than a guessed name — a channel with no language is not
 * an English channel.
 */
export function languageLabel(code: unknown): string {
  if (code === 'km') return 'Khmer'
  if (code === 'en') return 'English'
  return ''
}

// ── search ──────────────────────────────────────────────────────────────────

/**
 * Fold text for matching: normalise, lowercase, and drop the zero-width
 * characters Khmer text picks up from copy-paste (U+200B–U+200D, U+FEFF).
 * Without that last step a Khmer channel name typed by hand does not match the
 * same name pasted from a document, and the customer sees "no channels match"
 * for a search that looks identical on screen.
 */
function fold(text: unknown): string {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
}

/** Every visible thing about a channel that the search box matches. */
export function channelSearchText(row: ChannelRow | null | undefined): string {
  const labels = channelLabels(row)
  const language = languageLabel(row?.content_language)
  return fold([
    channelName(row),
    row?.episode_prefix,
    language,
    row?.content_language,
    ...labels,
  ].filter(Boolean).join(' '))
}

export function matchesChannelSearch(row: ChannelRow | null | undefined, query: string): boolean {
  const needle = fold(query).trim()
  if (!needle) return true
  return channelSearchText(row).includes(needle)
}

// ── labels ──────────────────────────────────────────────────────────────────

/** A row's labels, read defensively and in the stored order. */
export function channelLabels(row: ChannelRow | null | undefined): string[] {
  return normalizeProjectLabels(row?.labels)
}

/**
 * Are these the same label? One rule for every comparison in the UI: case does
 * not matter and the zero-width characters a Khmer paste carries do not matter,
 * so a label chosen from a chip matches the one on the card it came from.
 */
export function sameLabel(a: unknown, b: unknown): boolean {
  const left = fold(a).trim()
  const right = fold(b).trim()
  return !!left && left === right
}

export function hasLabel(row: ChannelRow | null | undefined, label: string): boolean {
  return channelLabels(row).some(own => sameLabel(own, label))
}

/** Rows carrying EVERY one of the selected labels. An empty selection keeps
 *  everything, which is what "no filter" means — not "nothing matches". */
export function filterChannelsByLabels<T extends ChannelRow>(rows: readonly T[], labels: readonly string[]): T[] {
  const wanted = labels.map(label => fold(label).trim()).filter(Boolean)
  if (!wanted.length) return [...rows]
  return rows.filter(row => wanted.every(label => channelLabels(row).some(own => fold(own) === label)))
}

/**
 * The distinct labels in a list, with how many channels carry each, ordered
 * for display. Grouping is case-insensitive and the FIRST spelling seen is the
 * one shown: a label is the owner's own word, and the filter chips must not
 * invent a third spelling of it.
 */
export function labelCounts(rows: readonly ChannelRow[]): Array<{ label: string; count: number }> {
  const byKey = new Map<string, { label: string; count: number }>()
  for (const row of rows) {
    for (const label of channelLabels(row)) {
      const key = fold(label)
      const entry = byKey.get(key)
      if (entry) entry.count++
      else byKey.set(key, { label, count: 1 })
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
}

/** Labels a suggestion list should offer for a channel that already has some:
 *  everything in the Library except what this channel already carries, matched
 *  case-insensitively so "Sleep" is not offered beside "sleep". */
export function labelSuggestions(all: readonly string[], current: readonly string[]): string[] {
  const taken = new Set(current.map(label => fold(label)))
  return all.filter(label => !taken.has(fold(label)))
}

// ── filters as one question ─────────────────────────────────────────────────

export interface ChannelFilters {
  search: string
  labels: readonly string[]
}

export function filtersAreActive(filters: ChannelFilters): boolean {
  return !!filters.search.trim() || filters.labels.length > 0
}

/** The rows a search and a label selection leave, before sorting. */
export function applyChannelFilters<T extends ChannelRow>(rows: readonly T[], filters: ChannelFilters): T[] {
  return filterChannelsByLabels(rows.filter(row => matchesChannelSearch(row, filters.search)), filters.labels)
}

// ── the remembered view ─────────────────────────────────────────────────────

const PREF_KEY = 'story_studio_channel_view'

/**
 * The store, or null where there isn't one — a capability check rather than
 * `import.meta.client`, for the same reason `last-known-list.ts` uses one: what
 * this code needs to know is whether a storage exists, and private windows and
 * blocked site data answer that question the same way as a server render.
 */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export interface ChannelViewPrefs {
  sort: ChannelSort
  labels: string[]
}

export const DEFAULT_CHANNEL_VIEW: ChannelViewPrefs = { sort: DEFAULT_CHANNEL_SORT, labels: [] }

/**
 * The remembered sort and label filter, or the defaults.
 *
 * Anything unusable degrades to the default rather than throwing: a sort name
 * from a newer build, a label list that is not a list, unparseable JSON. The
 * label list goes through the same normaliser the project save path uses, so a
 * remembered filter can never reintroduce a spelling the backend would refuse.
 */
export function readChannelViewPrefs(): ChannelViewPrefs {
  const storage = store()
  if (!storage) return { ...DEFAULT_CHANNEL_VIEW }
  try {
    const raw = storage.getItem(PREF_KEY)
    if (!raw) return { ...DEFAULT_CHANNEL_VIEW }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_CHANNEL_VIEW }
    const view = parsed as Record<string, unknown>
    return {
      sort: isChannelSort(view.sort) ? view.sort : DEFAULT_CHANNEL_SORT,
      labels: normalizeProjectLabels(view.labels),
    }
  } catch {
    return { ...DEFAULT_CHANNEL_VIEW }
  }
}

/** Best effort: a full, blocked or absent store must never break the page. */
export function writeChannelViewPrefs(prefs: ChannelViewPrefs): void {
  const storage = store()
  if (!storage) return
  try {
    storage.setItem(PREF_KEY, JSON.stringify({
      sort: isChannelSort(prefs.sort) ? prefs.sort : DEFAULT_CHANNEL_SORT,
      labels: normalizeProjectLabels(prefs.labels),
    }))
  } catch { /* best effort — the view is a convenience, never a requirement */ }
}

// ── keyboard ────────────────────────────────────────────────────────────────

/**
 * True when the event is coming from somewhere the person is typing, where `/`
 * is a character and not a shortcut. Covers the editable elements as well as
 * `contenteditable` hosts, because half this app's text fields are rich ones.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element !== 'object') return false
  if (element.isContentEditable) return true
  const tag = String(element.tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION'
}
