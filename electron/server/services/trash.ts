/**
 * Story → Trash (1.4.289): the one place everything Story Studio removed waits.
 *
 * Roots: `<Library>/_trash` (every channel, `<slug>/…`), plus `<folder>/_trash` on any
 * other drive a channel keeps media or finished videos on (a move never crosses
 * drives, see lib/trash-move.ts). Restore puts an item back where it came from.
 * Owner, 2026-10-16 (the mini is managed remotely): items can also go to the Mac's
 * own Trash (`moveToMacTrash`, recoverable there) or be deleted for good
 * (`deletePermanently`, index entries of the Library `_trash` or the app's own
 * `<data>/_trash` only); both act only after a confirmation that matches what is
 * measured. Delete is the only permanent delete, since the old "Empty Trash" is
 * retired. The owner's manual actions are his alone (routes/trash.ts); the
 * automatic age handoff (`handoffOldTrash`, services/retention.ts) is app-initiated
 * and only ever moves items to the Mac's Trash, never deletes. Restore, move,
 * handoff and delete run one at a time (`serial`).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, appendFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as pm from './project-manager.js'
import { dataDir, trashDir } from './app-update.js'
import { dirSize } from './storage-audit.js'
import {
  APP_TRASH, libraryTrashDir, moveToTrashSync, TRASH_DIRNAME, TRASH_INDEX, trashRootFor, type TrashIndexEntry,
} from '../lib/trash-move.js'

export const MIGRATION_LOG = 'trash-migration.log'
/** Items listed per request; the per-channel and per-kind totals always cover everything. */
const MAX_ITEMS = 2000

interface TrashRoot {
  dir: string
  /** Set for an old per-channel `_trash` not yet moved: the whole folder is this channel's. */
  slug?: string
}

export interface TrashItem {
  id: string
  slug: string
  kind: string
  path: string
  /** Where it came from (null for items moved from an old per-channel trash). */
  from: string | null
  at: string | null
  bytes: number
  restorable: boolean
  /** Why Restore is not offered. */
  restore_note?: string
  /** Can go to the Mac's own Trash: a real path safely inside a trash root. */
  movable: boolean
  /** Can be deleted permanently: also recorded in the Library `_trash` index. */
  deletable: boolean
}

interface Totals { items: number; bytes: number }

export interface TrashListing {
  roots: string[]
  total_bytes: number
  channels: Array<{ slug: string; bytes: number; items: number }>
  kinds: Array<{ kind: string; bytes: number; items: number }>
  items: TrashItem[]
  items_total: number
  /** "Free up space": the oldest dated item, and what "all" means for each action. */
  oldest: { at: string; path: string; slug: string } | null
  movable: Totals
  deletable: Totals
}

/** The folders a channel keeps media in besides its own: its media drive, the finished-videos folders. */
async function anchorsOf(slug: string, projectDir: string): Promise<string[]> {
  const anchors: string[] = []
  const meta = await pm.getProject(slug).catch(() => null) as { media_root?: string } | null
  if (meta?.media_root) {
    try {
      const { resolveAssetPath } = await import('./path-resolver.js')
      const anchor = resolveAssetPath(String(meta.media_root), await pm.getProjectOutputRoot(slug) || projectDir)
      if (anchor) anchors.push(anchor)
    } catch { /* media drive not defined on this Mac */ }
  }
  const { exportsDir, previousExportsDirs } = await import('./library.js')
  anchors.push(...[await exportsDir().catch(() => ''), ...await previousExportsDirs().catch(() => [])].filter(Boolean))
  return anchors
}

export async function trashRoots(): Promise<TrashRoot[]> {
  const library = pm.projectsRoot()
  const roots = new Map<string, TrashRoot>()
  const add = (root: TrashRoot) => { if (!roots.has(path.resolve(root.dir))) roots.set(path.resolve(root.dir), root) }
  add({ dir: libraryTrashDir(library) })
  for (const { slug } of await pm.listProjects().catch(() => [] as Array<{ slug: string }>)) {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) continue
    const old = path.join(projectDir, TRASH_DIRNAME)
    if (existsSync(old)) add({ dir: old, slug })
    for (const anchor of await anchorsOf(slug, projectDir)) add({ dir: path.dirname(trashRootFor(anchor, projectDir, slug)) })
  }
  // The app's own `_trash` (`<bucket>/<item>`, indexed): where its leftovers go when the Library is on another drive.
  add({ dir: trashDir() })
  return [...roots.values()].filter(root => existsSync(root.dir))
}

/**
 * An index line; `removed` marks an item that left the Trash (Mac Trash, deleted): no Restore.
 * `partial` marks what a delete that stopped partway left: still listed, deletable, never restored.
 */
type IndexLine = TrashIndexEntry & { removed?: 'macos-trash' | 'deleted'; partial?: true }

function readIndex(dir: string): IndexLine[] {
  let text: string
  try { text = readFileSync(path.join(dir, TRASH_INDEX), 'utf8') } catch { return [] }
  const byTarget = new Map<string, IndexLine>()
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line) as IndexLine
      if (entry?.id && entry.to && entry.from) byTarget.set(entry.to, entry) // the latest line for a path wins
    } catch { /* a torn line */ }
  }
  return [...byTarget.values()].filter(entry => !entry.removed)
}

/** Append-only, like every move: a later line for the same path overrides an earlier one. */
function appendLine(dir: string, entry: TrashIndexEntry, mark: Pick<IndexLine, 'removed' | 'partial'>): void {
  const line: IndexLine = { ...entry, removed: undefined, partial: undefined, ...mark, at: new Date().toISOString() }
  appendFileSync(path.join(dir, TRASH_INDEX), `${JSON.stringify(line)}\n`)
}

// ponytail: one chain for every Restore, Mac-Trash move and delete; they are rare owner clicks.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/**
 * `p` lies strictly inside `root` (at least `depth` names below it), no folder on the way is a
 * symlink leading out, and `p` itself is not a symlink. Anything else is never moved or deleted.
 */
function safelyInside(root: string, p: string, depth: number): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length < depth) return false
  try {
    const realRoot = realpathSync(root)
    const realParent = realpathSync(path.dirname(path.resolve(p)))
    return (realParent === realRoot || realParent.startsWith(realRoot + path.sep)) && !lstatSync(p).isSymbolicLink()
  } catch { return false }
}

const isLegacy = (kind: string) => kind === 'legacy'

async function sizeOf(p: string): Promise<number> {
  try {
    const stat = lstatSync(p)
    return stat.isDirectory() ? await dirSize(p) : stat.isFile() ? stat.size : 0
  } catch { return 0 }
}

/** Every item, with the root it sits in and its index line (for the actions that need them). */
interface Scanned { item: TrashItem; root: TrashRoot; entry?: IndexLine }

async function scanTrash(): Promise<{
  roots: TrashRoot[]; channels: Map<string, { slug: string; bytes: number; items: number }>; items: TrashItem[]; scanned: Scanned[]
}> {
  const roots = await trashRoots()
  const libraryRoot = path.resolve(libraryTrashDir(pm.projectsRoot()))
  // The app's own `<data>/_trash` (unless it is the Library one): all of it is Story Studio's, by bucket.
  const appRoot = path.resolve(trashDir()) === libraryRoot ? '' : path.resolve(trashDir())
  const scanned: Scanned[] = []
  const items: TrashItem[] = []
  const push = (item: Omit<TrashItem, 'movable' | 'deletable'>, root: TrashRoot, entry?: IndexLine) => {
    const movable = !!item.path && safelyInside(root.dir, item.path, root.slug ? 1 : 2)
    const indexedRoot = !root.slug && [libraryRoot, appRoot].includes(path.resolve(root.dir))
    const full = { ...item, movable, deletable: movable && !!entry && indexedRoot }
    items.push(full)
    scanned.push({ item: full, root, entry })
  }
  const channels = new Map<string, { slug: string; bytes: number; items: number }>()
  for (const root of roots) {
    const isApp = path.resolve(root.dir) === appRoot
    // Channel folders: every folder at the top of a shared root (a bucket of the app's), or the whole of an old per-channel one.
    const groups: Array<{ slug: string; dir: string }> = root.slug
      ? [{ slug: root.slug, dir: root.dir }]
      : readdirSync(root.dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => ({ slug: isApp ? APP_TRASH : entry.name, dir: path.join(root.dir, entry.name) }))
    for (const group of groups) {
      const row = channels.get(group.slug) ?? { slug: group.slug, bytes: 0, items: 0 }
      row.bytes += await dirSize(group.dir)
      channels.set(group.slug, row)
    }
    const listed = new Set<string>()
    for (const entry of readIndex(root.dir)) {
      if (!existsSync(entry.to) && !isSymlink(entry.to)) continue
      const slug = root.slug ?? (isApp ? APP_TRASH : path.relative(root.dir, entry.to).split(path.sep)[0]!)
      const legacy = isLegacy(entry.kind)
      const taken = !legacy && (existsSync(entry.from) || isSymlink(entry.from))
      push({
        id: entry.id, slug, kind: entry.kind, path: entry.to, from: legacy ? null : entry.from, at: entry.at,
        bytes: await sizeOf(entry.to),
        restorable: !legacy && !taken && !entry.partial,
        ...(legacy ? { restore_note: 'Moved here from an old channel trash; drag it back in Finder if you need it.' }
          : entry.partial ? { restore_note: 'A delete stopped partway through it; delete it again.' }
            : taken ? { restore_note: 'Something new is at its old place.' } : {}),
      }, root, entry)
      listed.add(path.resolve(entry.to))
    }
    // What an old per-channel trash held (moved to `<slug>/legacy`, or still in place), or what an app bucket
    // holds unrecorded: one row per item.
    for (const group of groups) {
      const dir = root.slug || isApp ? group.dir : path.join(group.dir, 'legacy')
      for (const name of readdirNames(dir)) {
        const p = path.join(dir, name)
        if (listed.has(path.resolve(p))) continue
        push(legacyItem(group.slug, p, await sizeOf(p), root.slug
          ? 'Still in the channel folder\'s own _trash; drag it back in Finder if you need it.'
          : isApp ? 'In the app\'s own _trash from before items were recorded; drag it back in Finder if you need it.'
            : 'Moved here from the channel\'s old _trash; drag it back in Finder if you need it.'), root)
      }
    }
  }
  // Whatever no index line describes (moved before 1.4.289): one "older" row per channel.
  for (const row of channels.values()) {
    const itemized = items.filter(item => item.slug === row.slug)
    row.items = itemized.length
    const rest = row.bytes - itemized.reduce((n, item) => n + item.bytes, 0)
    if (rest > 0) {
      items.push({ ...legacyItem(row.slug, '', rest, 'Moved to the trash before items were recorded; open the channel folder in the Trash in Finder.'), movable: false, deletable: false })
      row.items += 1
    }
  }
  return { roots, channels, items, scanned }
}

export async function listTrash(): Promise<TrashListing> {
  const { roots, channels, items } = await scanTrash()
  const totals = (pick: (item: TrashItem) => boolean): Totals =>
    items.filter(pick).reduce((t, item) => ({ items: t.items + 1, bytes: t.bytes + item.bytes }), { items: 0, bytes: 0 })
  const oldest = items.filter(item => item.at).sort((a, b) => a.at!.localeCompare(b.at!))[0]
  const kinds = new Map<string, { kind: string; bytes: number; items: number }>()
  for (const item of items) {
    const row = kinds.get(item.kind) ?? { kind: item.kind, bytes: 0, items: 0 }
    row.bytes += item.bytes; row.items += 1
    kinds.set(item.kind, row)
  }
  items.sort((a, b) => (b.at || '').localeCompare(a.at || '') || b.bytes - a.bytes)
  return {
    roots: roots.map(root => root.dir),
    total_bytes: [...channels.values()].reduce((n, row) => n + row.bytes, 0),
    channels: [...channels.values()].sort((a, b) => b.bytes - a.bytes),
    kinds: [...kinds.values()].sort((a, b) => b.bytes - a.bytes),
    items: items.slice(0, MAX_ITEMS),
    items_total: items.length,
    oldest: oldest ? { at: oldest.at!, path: oldest.path, slug: oldest.slug } : null,
    movable: totals(item => item.movable),
    deletable: totals(item => item.deletable),
  }
}

function legacyItem(slug: string, p: string, bytes: number, note: string): Omit<TrashItem, 'movable' | 'deletable'> {
  return { id: `legacy:${slug}:${p}`, slug, kind: 'legacy', path: p, from: null, at: null, bytes, restorable: false, restore_note: note }
}

function readdirNames(dir: string): string[] {
  try { return readdirSync(dir).filter(name => !name.startsWith('.')) } catch { return [] }
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

/** Put one item back where it came from. Refuses when something is already there. */
export function restoreTrashItem(id: unknown): Promise<{ restored_to: string }> {
  return serial(() => restoreNow(id))
}

async function restoreNow(id: unknown): Promise<{ restored_to: string }> {
  if (typeof id !== 'string' || !id || id.startsWith('legacy:')) throw fail('Choose an item that can be restored.', 400)
  for (const root of await trashRoots()) {
    const entry = readIndex(root.dir).find(candidate => candidate.id === id)
    if (!entry) continue
    if (isLegacy(entry.kind)) throw fail('This item came from an old channel trash; move it back in Finder.', 409)
    if (entry.partial) throw fail('A delete stopped partway through this item, so it is not put back; delete it again.', 409)
    if (!existsSync(entry.to) && !isSymlink(entry.to)) throw fail('It is no longer in the Trash.', 404)
    if (existsSync(entry.from) || isSymlink(entry.from)) throw fail(`Something is already at ${entry.from}; nothing was moved.`, 409)
    mkdirSync(path.dirname(entry.from), { recursive: true })
    renameSync(entry.to, entry.from)
    return { restored_to: entry.from }
  }
  throw fail('That Trash item was not found. Refresh the Trash and try again.', 404)
}

/** `'all'` or a list of item ids, narrowed to the items the action may touch. */
function pick(scanned: Scanned[], ids: unknown, allowed: (item: TrashItem) => boolean): Scanned[] {
  if (ids === 'all') return scanned.filter(s => allowed(s.item))
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string')) throw fail('Choose the items first.', 400)
  const wanted = new Set(ids)
  return scanned.filter(s => wanted.has(s.item.id) && allowed(s.item))
}

/** What the owner confirmed must still be what is measured now; otherwise nothing happens. */
function confirmed(scanned: Scanned[], ids: unknown, allowed: (item: TrashItem) => boolean, expected: { count: number; bytes: number }, nothing: string): Scanned[] {
  const picked = pick(scanned, ids, allowed)
  const bytes = picked.reduce((n, s) => n + s.item.bytes, 0)
  if (picked.length !== expected.count || bytes !== expected.bytes) {
    throw fail(`The Trash changed since you looked: this choice is now ${picked.length} item(s), ${bytes} bytes (you confirmed ${expected.count}, ${expected.bytes} bytes). ${nothing} refresh and confirm again.`, 409)
  }
  return picked
}

/**
 * Hand items to the Mac's own Trash (Electron's `shell.trashItem`, passed in by the route).
 * Recoverable there; Restore here is no longer offered. A failed hand-over leaves the item
 * exactly where it was: there is no fallback, least of all a delete.
 */
// A hung Finder move (an unresponsive external SSD) must not hold every later Trash action forever.
const TRASH_ITEM_TIMEOUT_MS = 120_000
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('the Mac did not finish moving it in time')), ms) })])
    .finally(() => clearTimeout(timer))
}

/**
 * Electron's `shell.trashItem`, or null where the Mac's Trash is unreachable
 * (a bare node server, a test): the server runs in the app's main process on
 * the Mac itself in both app modes.
 */
export async function electronTrashItem(): Promise<((p: string) => Promise<void>) | null> {
  try {
    const { shell } = await import('electron') as any
    return typeof shell?.trashItem === 'function' ? (p: string) => shell.trashItem(p) : null
  } catch { return null }
}

/** Move each picked item to the Mac's Trash, recording every success in its root's index. */
async function handOver(
  picked: Scanned[], trashItem: (p: string) => Promise<void>, result: { moved: number; bytes: number; errors: string[] },
): Promise<void> {
  for (const s of picked) {
    if (!safelyInside(s.root.dir, s.item.path, s.root.slug ? 1 : 2)) { result.errors.push(`${s.item.path}: not inside Story's Trash; left alone.`); continue }
    try { await withTimeout(trashItem(s.item.path), TRASH_ITEM_TIMEOUT_MS) } catch (error: any) { result.errors.push(`${s.item.path}: ${error?.message || error}`); continue }
    result.moved += 1; result.bytes += s.item.bytes
    if (s.entry) { try { appendLine(s.root.dir, s.entry, { removed: 'macos-trash' }) } catch { /* it is gone from here either way */ } }
  }
}

export function moveToMacTrash(
  ids: unknown, expected: { count: number; bytes: number }, trashItem: (p: string) => Promise<void>,
): Promise<{ moved: number; bytes: number; errors: string[] }> {
  return serial(async () => {
    const { scanned } = await scanTrash()
    const result = { moved: 0, bytes: 0, errors: [] as string[] }
    await handOver(confirmed(scanned, ids, item => item.movable, expected, 'Nothing was moved;'), trashItem, result)
    return result
  })
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When the item arrived in Story's Trash: the index line's `at`, or — for what
 * was moved before the index existed — its on-disk mtime. No evidence means it
 * is NOT old: it stays.
 */
async function arrivedBy(s: Scanned, cutoff: number): Promise<boolean> {
  if (s.item.at) {
    const at = Date.parse(s.item.at)
    if (Number.isFinite(at)) return at <= cutoff
  }
  try { return lstatSync(s.item.path).mtimeMs <= cutoff } catch { return false }
}

/**
 * The owner's automatic age handoff (2026-10-18): every item that can go to the
 * Mac's Trash and has waited `olderThanDays` in Story's Trash is handed over.
 * App-initiated, never a delete; the manual buttons stay. Serialised with every
 * other Trash action, so a handoff can never race an owner's click.
 */
export function handoffOldTrash(
  input: { olderThanDays: number; now?: number }, trashItem: (p: string) => Promise<void>,
): Promise<{ eligible: number; moved: number; bytes: number; errors: string[] }> {
  return serial(async () => {
    const { scanned } = await scanTrash()
    const now = input.now ?? Date.now()
    const cutoff = now - Math.max(1, Math.floor(input.olderThanDays)) * DAY_MS
    const aged: Scanned[] = []
    for (const s of scanned) {
      if (s.item.movable && await arrivedBy(s, cutoff)) aged.push(s)
    }
    const result = { eligible: aged.length, moved: 0, bytes: 0, errors: [] as string[] }
    await handOver(aged, trashItem, result)
    return result
  })
}

/**
 * The owner's "Delete permanently" (routes/trash.ts: confirmed, never an automation key, never a
 * timer). Only items recorded in the Library `_trash` index, re-measured now: if the count or
 * bytes differ from what the owner confirmed, nothing is deleted. Never touches the Mac's Trash.
 */
export function deletePermanently(ids: unknown, expected: { count: number; bytes: number }): Promise<{ deleted: number; bytes_freed: number; errors: string[] }> {
  return serial(async () => {
    const { scanned } = await scanTrash()
    const picked = confirmed(scanned, ids, item => item.deletable, expected, 'Nothing was deleted;')
    const result = { deleted: 0, bytes_freed: 0, errors: [] as string[] }
    for (const s of picked) {
      if (!safelyInside(s.root.dir, s.item.path, 2)) { result.errors.push(`${s.item.path}: not inside Story's Trash; left alone.`); continue }
      // Recorded first: whatever happens next, Restore is no longer offered for it.
      try { appendLine(s.root.dir, s.entry!, { removed: 'deleted' }) } catch (error: any) { result.errors.push(`${s.item.path}: ${error?.message || error}`); continue }
      try { await fs.rm(s.item.path, { recursive: true }) } catch (error: any) {
        result.errors.push(`${s.item.path}: ${error?.message || error}`)
        // What is left stays listed so it can be deleted again, never restored half-empty.
        if (existsSync(s.item.path)) { try { appendLine(s.root.dir, s.entry!, { partial: true }) } catch { /* the removed line stands */ } }
        continue
      }
      result.deleted += 1; result.bytes_freed += s.item.bytes
    }
    return result
  })
}

function fail(message: string, statusCode: number): Error & { statusCode: number; expose: true } {
  return Object.assign(new Error(message), { statusCode, expose: true as const })
}

// ── One-time move of the old per-channel trashes (idempotent, every boot) ──

export interface TrashMigrationReport { moved: Array<{ from: string; to: string }>; left: Array<{ from: string; reason: string }> }

/**
 * Move every old `_trash` into `<Library>/_trash/<channel>/legacy/…`, keeping its
 * structure: the channel folder's own `_trash`, `<folder>/_trash/<slug>` in the
 * finished-videos folders and a media folder on the Library's drive, and the app's
 * `<data>/_trash` (→ `_story-studio/legacy`). Renames only: a folder on another
 * drive stays where it is (the Trash page still lists it). Nothing is deleted;
 * an emptied old `_trash` folder is removed only when it is empty. Logged to
 * `<Library>/_trash/trash-migration.log`. Running it again finds nothing to move.
 */
export async function migrateLegacyTrash(): Promise<TrashMigrationReport> {
  const report: TrashMigrationReport = { moved: [], left: [] }
  const library = pm.projectsRoot()
  if (!existsSync(library)) return report
  const trash = libraryTrashDir(library)
  const log = (line: string) => {
    console.log(`[trash] ${line}`)
    try { appendFileSync(path.join(trash, MIGRATION_LOG), `${new Date().toISOString()} ${line}\n`) } catch { /* console has it */ }
  }
  const move = (from: string, to: string) => {
    let names: string[]
    try { names = readdirSync(from).filter(name => name !== '.DS_Store') } catch { return }
    if (names.length) {
      mkdirSync(trash, { recursive: true })
      if (statSync(from).dev !== statSync(trash).dev) {
        report.left.push({ from, reason: 'another drive' })
        return
      }
      if (!existsSync(to)) {
        mkdirSync(path.dirname(to), { recursive: true })
        renameSync(from, to) // the whole folder in one rename
        report.moved.push({ from, to })
        log(`moved ${from} -> ${to}`)
        return
      }
      for (const name of names) {
        try {
          const landed = moveToTrashSync(path.join(from, name), path.join(to, name), 'legacy')
          report.moved.push({ from: path.join(from, name), to: landed })
          log(`moved ${path.join(from, name)} -> ${landed}`)
        } catch (error: any) {
          report.left.push({ from: path.join(from, name), reason: error?.message || String(error) })
          log(`left ${path.join(from, name)} (${error?.message || error})`)
        }
      }
    }
    try { rmdirSync(from) } catch { /* not empty: something stayed */ }
  }

  for (const { slug } of await pm.listProjects().catch(() => [] as Array<{ slug: string }>)) {
    const projectDir = pm.getProjectDir(slug)
    if (!projectDir) continue
    move(path.join(projectDir, TRASH_DIRNAME), path.join(trash, slug, 'legacy'))
    for (const anchor of await anchorsOf(slug, projectDir)) {
      // A folder on another drive keeps its own `<folder>/_trash/<slug>` (the current rule too).
      if (path.resolve(path.dirname(trashRootFor(anchor, projectDir, slug))) !== path.resolve(trash)) continue
      const old = path.join(anchor, TRASH_DIRNAME)
      if (path.resolve(old) === path.resolve(trash)) continue
      move(path.join(old, slug), path.join(trash, slug, 'legacy', `from-${path.basename(anchor)}`))
      try { rmdirSync(old) } catch { /* not empty, or not there */ }
    }
  }
  const appTrash = path.join(dataDir(), TRASH_DIRNAME)
  if (path.resolve(appTrash) !== path.resolve(trash)) move(appTrash, path.join(trash, APP_TRASH, 'legacy'))
  for (const left of report.left) if (left.reason === 'another drive') log(`left ${left.from} in place: it is on another drive`)
  return report
}
