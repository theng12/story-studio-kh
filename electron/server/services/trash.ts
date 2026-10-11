/**
 * Story → Trash (1.4.289): the one place everything Story Studio removed waits.
 *
 * Roots: `<Library>/_trash` (every channel, `<slug>/…`), plus `<folder>/_trash` on any
 * other drive a channel keeps media or finished videos on (a move never crosses
 * drives, see lib/trash-move.ts). Restore puts an item back where it came from;
 * Empty is the owner's alone (routes/trash.ts refuses automation keys) and is the
 * only permanent delete of anything in it.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, appendFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as pm from './project-manager.js'
import { dataDir } from './app-update.js'
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
}

export interface TrashListing {
  roots: string[]
  total_bytes: number
  channels: Array<{ slug: string; bytes: number; items: number }>
  kinds: Array<{ kind: string; bytes: number; items: number }>
  items: TrashItem[]
  items_total: number
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
  return [...roots.values()].filter(root => existsSync(root.dir))
}

function readIndex(dir: string): TrashIndexEntry[] {
  let text: string
  try { text = readFileSync(path.join(dir, TRASH_INDEX), 'utf8') } catch { return [] }
  const byTarget = new Map<string, TrashIndexEntry>()
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line) as TrashIndexEntry
      if (entry?.id && entry.to && entry.from) byTarget.set(entry.to, entry) // the latest move to a path wins
    } catch { /* a torn line */ }
  }
  return [...byTarget.values()]
}

const isLegacy = (kind: string) => kind === 'legacy'

async function sizeOf(p: string): Promise<number> {
  try {
    const stat = lstatSync(p)
    return stat.isDirectory() ? await dirSize(p) : stat.isFile() ? stat.size : 0
  } catch { return 0 }
}

export async function listTrash(): Promise<TrashListing> {
  const roots = await trashRoots()
  const items: TrashItem[] = []
  const channels = new Map<string, { slug: string; bytes: number; items: number }>()
  for (const root of roots) {
    // Channel folders: every folder at the top of a shared root, or the whole of an old per-channel one.
    const groups: Array<{ slug: string; dir: string }> = root.slug
      ? [{ slug: root.slug, dir: root.dir }]
      : readdirSync(root.dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => ({ slug: entry.name, dir: path.join(root.dir, entry.name) }))
    for (const group of groups) {
      const row = channels.get(group.slug) ?? { slug: group.slug, bytes: 0, items: 0 }
      row.bytes += await dirSize(group.dir)
      channels.set(group.slug, row)
    }
    const listed = new Set<string>()
    for (const entry of readIndex(root.dir)) {
      if (!existsSync(entry.to) && !isSymlink(entry.to)) continue
      const slug = root.slug ?? path.relative(root.dir, entry.to).split(path.sep)[0]!
      const legacy = isLegacy(entry.kind)
      const taken = !legacy && (existsSync(entry.from) || isSymlink(entry.from))
      items.push({
        id: entry.id, slug, kind: entry.kind, path: entry.to, from: legacy ? null : entry.from, at: entry.at,
        bytes: await sizeOf(entry.to),
        restorable: !legacy && !taken,
        ...(legacy ? { restore_note: 'Moved here from an old channel trash; drag it back in Finder if you need it.' }
          : taken ? { restore_note: 'Something new is at its old place.' } : {}),
      })
      listed.add(path.resolve(entry.to))
    }
    // What an old per-channel trash held (moved to `<slug>/legacy`, or still in place): one row per top-level item.
    for (const group of groups) {
      const dir = root.slug ? group.dir : path.join(group.dir, 'legacy')
      for (const name of readdirNames(dir)) {
        const p = path.join(dir, name)
        if (listed.has(path.resolve(p))) continue
        items.push(legacyItem(group.slug, p, await sizeOf(p), root.slug
          ? 'Still in the channel folder\'s own _trash; drag it back in Finder if you need it.'
          : 'Moved here from the channel\'s old _trash; drag it back in Finder if you need it.'))
      }
    }
  }
  // Whatever no index line describes (moved before 1.4.289): one "older" row per channel.
  for (const row of channels.values()) {
    const itemized = items.filter(item => item.slug === row.slug)
    row.items = itemized.length
    const rest = row.bytes - itemized.reduce((n, item) => n + item.bytes, 0)
    if (rest > 0) {
      items.push(legacyItem(row.slug, '', rest, 'Moved to the trash before items were recorded; open the channel folder in the Trash in Finder.'))
      row.items += 1
    }
  }
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
  }
}

function legacyItem(slug: string, p: string, bytes: number, note: string): TrashItem {
  return { id: `legacy:${slug}:${p}`, slug, kind: 'legacy', path: p, from: null, at: null, bytes, restorable: false, restore_note: note }
}

function readdirNames(dir: string): string[] {
  try { return readdirSync(dir).filter(name => !name.startsWith('.')) } catch { return [] }
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

/** Put one item back where it came from. Refuses when something is already there. */
export async function restoreTrashItem(id: unknown): Promise<{ restored_to: string }> {
  if (typeof id !== 'string' || !id || id.startsWith('legacy:')) throw fail('Choose an item that can be restored.', 400)
  for (const root of await trashRoots()) {
    const entry = readIndex(root.dir).find(candidate => candidate.id === id)
    if (!entry) continue
    if (isLegacy(entry.kind)) throw fail('This item came from an old channel trash; move it back in Finder.', 409)
    if (!existsSync(entry.to) && !isSymlink(entry.to)) throw fail('It is no longer in the Trash.', 404)
    if (existsSync(entry.from) || isSymlink(entry.from)) throw fail(`Something is already at ${entry.from}; nothing was moved.`, 409)
    mkdirSync(path.dirname(entry.from), { recursive: true })
    renameSync(entry.to, entry.from)
    return { restored_to: entry.from }
  }
  throw fail('That Trash item was not found. Refresh the Trash and try again.', 404)
}

/**
 * The owner's "Empty Trash": the one permanent delete of what Story Studio moved
 * aside. Only ever called from routes/trash.ts after the typed confirmation.
 * The migration log stays (it is the record of what moved where).
 */
export async function emptyTrash(): Promise<{ bytes_freed: number; removed: number; errors: string[] }> {
  let bytes = 0
  let removed = 0
  const errors: string[] = []
  for (const root of await trashRoots()) {
    for (const name of await fs.readdir(root.dir).catch(() => [] as string[])) {
      if (name === MIGRATION_LOG) continue
      const p = path.join(root.dir, name)
      const size = await sizeOf(p)
      try {
        await fs.rm(p, { recursive: true, force: true })
        bytes += size; removed += 1
      } catch (error: any) { errors.push(`${p}: ${error?.message || error}`) }
    }
    if (root.slug) { try { rmdirSync(root.dir) } catch { /* not empty */ } }
  }
  return { bytes_freed: bytes, removed, errors }
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
