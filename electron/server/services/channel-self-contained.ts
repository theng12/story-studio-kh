/**
 * Self-contained channels (2026-10-07).
 *
 * The owner runs two Story Macs, each with its own bundle of channels, and
 * moves a channel by copying its folder: *"each channel to have its own
 * assets, so moving a channel folder moves everything it needs."*
 *
 * Until now a channel reached outside its folder in two ways:
 *
 *   1. File references in `config.json` / `project.json` (presets, bundles,
 *      the last-used Video Assembly snapshot, `channel_logo_path`, …) written
 *      as `${ASSET}/…` (the Library's shared `_Project Assets`) or as absolute
 *      paths — some into the Library, some into old iCloud folders.
 *   2. Finished videos in `<Library>/Exports/<slug>/…`.
 *
 * This module plans and applies the one-time move, owner-triggered:
 *
 *   - every referenced shared/outside file is COPIED into `<channel>/assets/`
 *     (verified by sha256) and its reference rewritten to `${CHANNEL}/assets/…`;
 *     `_Project Assets/` and every original stay exactly where they are;
 *   - an absolute path already inside the channel becomes `${CHANNEL}/…` or
 *     `${PROJECT}/…` with no copy; a missing file is reported and left alone;
 *   - finals move from `<Library>/Exports/<slug>` to `<channel>/Exports`
 *     (a rename on the same volume; copy + verify + original to `_trash`
 *     across volumes) — only when the channel uses channel-local exports.
 *
 * `planChannel` is the dry run (list + sizes); `applyChannel` does it. Both are
 * idempotent: a second plan after an apply is empty.
 */

import { createHash } from 'crypto'
import { createReadStream, existsSync, realpathSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as pm from './project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { CHANNEL_ASSETS_DIR, assetsRoot, isPortablePath } from './path-resolver.js'

/** File kinds a reference may point at. Anything else is not an asset and is never touched. */
const ASSET_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|svg|mp4|m4v|mov|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac|aiff?|srt|ass|vtt|ttf|otf|ttc|woff2?|cube|lut)$/i

/** Keys whose absolute value is a location setting, not a file reference. */
const SKIP_KEYS = new Set(['media_root', 'output_root', 'output_root_resolved'])

/** Job types that read or write finished videos; while one is active, exports stay put. */
const EXPORT_JOB_TYPES = ['video_assembly', 'broll_assemble', 'youtube_upload', 'youtube_thumbnail_refresh', 'music_video', 'music_episode_build']
const ACTIVE = new Set(['queued', 'running', 'paused'])

export interface RefChange {
  file: 'config.json' | 'project.json'
  /** JSON path, e.g. `effects_presets[2].data.logo.image_path`. */
  field: string
  from: string
  /** The new stored value; equals `from` for a `missing` row. */
  to: string
  action: 'copy' | 'rewrite' | 'missing'
  /** Absolute file the value points at today. */
  source: string
  bytes: number
}

export interface FileCopy { source: string; target: string; bytes: number }

export interface ExportMove { from: string; to: string; bytes: number }

export interface ChannelPlan {
  slug: string
  channel_dir: string
  refs: RefChange[]
  copies: FileCopy[]
  exports: {
    /** True when this channel's finals belong in `<channel>/Exports`. */
    channel_local: boolean
    from: string
    to: string
    moves: ExportMove[]
    /** Files already at the destination under the same name: left where they are. */
    conflicts: Array<{ from: string; to: string }>
    /** Why the exports part will not run now (active render/upload). */
    blocked: string
  }
  /** Content-pack versions this channel pins — install these on another Mac. */
  content_packs: Array<{ pack_id: string; version: string; installed: boolean }>
  totals: {
    refs_to_rewrite: number
    files_to_copy: number
    bytes_to_copy: number
    missing: number
    exports_to_move: number
    export_bytes: number
  }
  /** Nothing left to do. */
  done: boolean
}

export interface ChannelApplyResult {
  slug: string
  copied: FileCopy[]
  rewritten: number
  exports_moved: number
  missing: RefChange[]
  errors: string[]
  plan_after: ChannelPlan
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk)
  return hash.digest('hex')
}

/** Real path; for a path that does not exist yet, its nearest existing ancestor's real path + the rest. */
function real(p: string): string {
  const abs = path.resolve(p)
  try { return realpathSync.native(abs) } catch {
    const parent = path.dirname(abs)
    return parent === abs ? abs : path.join(real(parent), path.basename(abs))
  }
}

/** `rel` of `abs` inside `base`, or null. Both are compared as real paths (macOS folders are case-insensitive). */
function relInside(abs: string, base: string): string | null {
  const a = real(abs)
  const b = real(base)
  if (a === b) return ''
  return a.startsWith(b + path.sep) ? a.slice(b.length + 1) : null
}

async function fileSize(p: string): Promise<number | null> {
  const st = await fs.stat(p).catch(() => null)
  return st?.isFile() ? st.size : null
}

/** Visit every string leaf, with a JSON path. */
function walkStrings(node: unknown, at: string, visit: (value: string, at: string, key: string) => void, key = ''): void {
  if (typeof node === 'string') { visit(node, at, key); return }
  if (Array.isArray(node)) { node.forEach((v, i) => walkStrings(v, `${at}[${i}]`, visit, key)); return }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkStrings(v, at ? `${at}.${k}` : k, visit, k)
  }
}

/** Set the string at a JSON path produced by `walkStrings`, only if it still holds `expected`. */
function setAt(root: any, at: string, expected: string, next: string): boolean {
  const parts = at.match(/[^.[\]]+/g) || []
  let node = root
  for (let i = 0; i < parts.length - 1; i++) {
    node = node?.[parts[i]!]
    if (node == null || typeof node !== 'object') return false
  }
  const last = parts[parts.length - 1]!
  if (node?.[last] !== expected) return false
  node[last] = next
  return true
}

/**
 * Where a copy of `source` should live inside `<channel>/assets`, given the
 * relative name we would like. Same name + same bytes → reuse (idempotent);
 * same name + different bytes → ` (2)`, ` (3)`, …
 */
async function assetTargetFor(channelDir: string, source: string, preferredRel: string, reserved: Map<string, string>): Promise<string> {
  const dir = path.join(channelDir, CHANNEL_ASSETS_DIR, path.dirname(preferredRel))
  const { name, ext } = path.parse(preferredRel)
  let hashOfSource: string | undefined
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? `${name}${ext}` : `${name} (${n})${ext}`)
    const claimed = reserved.get(candidate)
    if (claimed !== undefined) {
      if (claimed === real(source)) return candidate
      continue
    }
    if (!existsSync(candidate)) return candidate
    hashOfSource ??= await sha256(source)
    if (await sha256(candidate).catch(() => '') === hashOfSource) return candidate
  }
}

/** Copy, verify by sha256, then move into place. The source is never touched. */
async function copyVerified(source: string, target: string, channelDir: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const partial = `${target}.partial-${process.pid}`
  await fs.copyFile(source, partial)
  const [a, b] = await Promise.all([sha256(source), sha256(partial)])
  if (a !== b) {
    moveToTrashSync(partial, path.join(trashRootFor(channelDir, channelDir, path.basename(channelDir)), 'unverified-copies', path.basename(partial)), 'unverified-copy')
    throw new Error(`Copy of ${source} did not verify (sha256 differs); nothing was changed.`)
  }
  await fs.rename(partial, target)
}

// ── Adopting one file (used by pickers) ──────────────────────────────────

/**
 * Make `abs` part of the channel and return how to store it: a file already
 * inside the channel is written `${CHANNEL}/…` / `${PROJECT}/…`; a file
 * outside is copied into `<channel>/assets/` first. Returns null when the
 * path is not a readable asset file (the caller keeps today's behaviour).
 */
export async function adoptIntoChannel(channelDir: string, abs: string, reserved = new Map<string, string>()): Promise<{ stored: string; copied: FileCopy | null } | null> {
  if (!path.isAbsolute(abs) || !ASSET_EXT.test(abs)) return null
  const bytes = await fileSize(abs)
  if (bytes === null) return null
  const stored = channelRelative(channelDir, abs)
  if (stored) return { stored, copied: null }
  const target = await assetTargetFor(channelDir, abs, path.basename(abs), reserved)
  if (!existsSync(target)) await copyVerified(abs, target, channelDir)
  return { stored: channelRelative(channelDir, target)!, copied: { source: abs, target, bytes } }
}

/** `${PROJECT}/…` or `${CHANNEL}/…` for a path inside the channel, else null. */
/**
 * `/…/Old iCloud/<slug>/episodes/00 Assets/logo.png` → `<channel>/episodes/00 Assets/logo.png`:
 * the part after the LAST path segment naming this channel (case-insensitively).
 */
function reRootedInChannel(channelDir: string, slug: string, abs: string): string {
  const names = new Set([slug.toLowerCase(), path.basename(channelDir).toLowerCase()])
  const parts = abs.split('/')
  for (let i = parts.length - 2; i > 0; i--) {
    if (names.has(parts[i]!.toLowerCase())) return path.join(channelDir, ...parts.slice(i + 1))
  }
  return ''
}

function channelRelative(channelDir: string, abs: string): string | null {
  const rel = relInside(abs, channelDir)
  if (rel === null || rel === '') return null
  const parts = rel.split(path.sep)
  if (parts[0] === 'episodes' && parts.length > 1) return `\${PROJECT}/${parts.slice(1).join('/')}`
  return `\${CHANNEL}/${parts.join('/')}`
}

/**
 * Resolve the channel behind an ABSOLUTE episodes folder sent by a client.
 * Only a real channel folder directly inside the Library qualifies — a picker
 * must never be able to copy files into an arbitrary folder.
 */
export function channelDirForEpisodesRoot(episodesRoot: string): string | null {
  if (!episodesRoot || !path.isAbsolute(episodesRoot)) return null
  const channelDir = path.dirname(path.resolve(episodesRoot))
  const slug = path.basename(channelDir)
  const known = pm.getProjectDir(slug)
  if (!known || real(known) !== real(channelDir)) return null
  if (path.resolve(pm.resolveOutputRoot(known).path) !== path.resolve(episodesRoot)) return null
  return known
}

// ── Plan ─────────────────────────────────────────────────────────────────

export async function planChannel(slug: string): Promise<ChannelPlan> {
  const channelDir = pm.getProjectDir(slug)
  if (!channelDir) throw Object.assign(new Error(`Channel "${slug}" was not found in this Library.`), { status: 404, expose: true })
  const shared = assetsRoot()
  const refs: RefChange[] = []
  const copies = new Map<string, FileCopy>()
  const reserved = new Map<string, string>()

  for (const file of ['config.json', 'project.json'] as const) {
    const json = await readJsonFile(path.join(channelDir, file))
    if (!json) continue
    const leaves: Array<{ value: string; at: string }> = []
    walkStrings(json, '', (value, at, key) => {
      if (!SKIP_KEYS.has(key) && value.length < 4096) leaves.push({ value, at })
    })
    for (const { value, at } of leaves) {
      let source = ''
      let preferredRel = ''
      if (value.startsWith('${ASSET}/')) {
        preferredRel = value.slice('${ASSET}/'.length)
        source = path.join(shared, preferredRel)
      } else if (!isPortablePath(value) && path.isAbsolute(value) && ASSET_EXT.test(value)) {
        source = value
        preferredRel = path.basename(value)
      } else continue

      const inside = channelRelative(channelDir, source)
      const bytes = await fileSize(source)
      if (inside && bytes !== null) {
        refs.push({ file, field: at, from: value, to: inside, action: 'rewrite', source, bytes: 0 })
        continue
      }
      if (bytes === null) {
        // `${ASSET}/x` copied by an earlier run whose shared original is gone since,
        // or an old absolute path (an iCloud folder on another Mac) whose file this
        // very channel folder still holds under the same channel-relative path.
        const already = value.startsWith('${ASSET}/')
          ? path.join(channelDir, CHANNEL_ASSETS_DIR, preferredRel)
          : reRootedInChannel(channelDir, slug, value)
        if (already && existsSync(already)) {
          refs.push({ file, field: at, from: value, to: channelRelative(channelDir, already)!, action: 'rewrite', source: already, bytes: 0 })
        } else {
          refs.push({ file, field: at, from: value, to: value, action: 'missing', source, bytes: 0 })
        }
        continue
      }
      const target = await assetTargetFor(channelDir, source, preferredRel, reserved)
      reserved.set(target, real(source))
      const exists = existsSync(target)
      if (!exists && !copies.has(target)) copies.set(target, { source, target, bytes })
      refs.push({ file, field: at, from: value, to: channelRelative(channelDir, target)!, action: exists ? 'rewrite' : 'copy', source, bytes: exists ? 0 : bytes })
    }
  }

  const exportsPlan = await planExports(slug, channelDir)
  const content_packs = await contentPackPins(slug)
  const rewrite = refs.filter(r => r.action !== 'missing')
  const copyList = [...copies.values()]
  const totals = {
    refs_to_rewrite: rewrite.length,
    files_to_copy: copyList.length,
    bytes_to_copy: copyList.reduce((n, c) => n + c.bytes, 0),
    missing: refs.length - rewrite.length,
    exports_to_move: exportsPlan.moves.length,
    export_bytes: exportsPlan.moves.reduce((n, m) => n + m.bytes, 0),
  }
  return {
    slug,
    channel_dir: channelDir,
    refs,
    copies: copyList,
    exports: exportsPlan,
    content_packs,
    totals,
    done: totals.refs_to_rewrite === 0 && totals.exports_to_move === 0,
  }
}

async function readJsonFile(p: string): Promise<any | null> {
  const text = await fs.readFile(p, 'utf-8').catch(() => null)
  if (text === null) return null
  try { return JSON.parse(text) } catch { throw Object.assign(new Error(`${p} is not valid JSON; fix it before making this channel self-contained.`), { status: 409, expose: true }) }
}

async function planExports(slug: string, channelDir: string): Promise<ChannelPlan['exports']> {
  const { usesChannelExports, CHANNEL_EXPORTS_DIR_NAME } = await import('./external-video-store.js')
  const { getLibraryRoot, EXPORTS_DIR_NAME } = await import('./library.js')
  const library = await getLibraryRoot()
  const to = path.join(channelDir, CHANNEL_EXPORTS_DIR_NAME)
  const from = library ? path.join(library, EXPORTS_DIR_NAME, slug) : ''
  const out: ChannelPlan['exports'] = { channel_local: await usesChannelExports(slug), from, to, moves: [], conflicts: [], blocked: '' }
  if (!out.channel_local || !from || !existsSync(from) || real(from) === real(to)) return out

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== '_trash') await walk(full); continue }
      if (!entry.isFile() || entry.name === '.DS_Store') continue
      const dest = path.join(to, path.relative(from, full))
      if (existsSync(dest)) out.conflicts.push({ from: full, to: dest })
      else out.moves.push({ from: full, to: dest, bytes: (await fileSize(full)) ?? 0 })
    }
  }
  await walk(from)

  if (out.moves.length) {
    const jq = await import('./job-queue.js')
    const active = (await jq.getJobs(slug, { type: EXPORT_JOB_TYPES })).filter(j => ACTIVE.has(j.status))
    if (active.length) {
      out.blocked = `${active.length} render/upload job${active.length === 1 ? ' is' : 's are'} queued or running for this channel `
        + `(${[...new Set(active.map(j => j.type))].join(', ')}). Finished videos move once they are done; assets can be copied now.`
    }
  }
  return out
}

async function contentPackPins(slug: string): Promise<ChannelPlan['content_packs']> {
  const meta: any = await pm.getProject(slug)
  const pins = Object.entries((meta?.content_pack_versions ?? {}) as Record<string, string>)
  if (!pins.length) return []
  const { resolveCatalogPackVersion } = await import('../content-packs/registry.js')
  return Promise.all(pins.sort(([a], [b]) => a.localeCompare(b)).map(async ([pack_id, version]) => ({
    pack_id,
    version,
    installed: !!await resolveCatalogPackVersion(pack_id, version).catch(() => null),
  })))
}

// ── Apply ────────────────────────────────────────────────────────────────

export async function applyChannel(slug: string): Promise<ChannelApplyResult> {
  const plan = await planChannel(slug)
  const errors: string[] = []
  const copied: FileCopy[] = []
  const failed = new Set<string>()

  for (const c of plan.copies) {
    try {
      if (!existsSync(c.target)) await copyVerified(c.source, c.target, plan.channel_dir)
      copied.push(c)
    } catch (e: any) {
      failed.add(channelRelative(plan.channel_dir, c.target)!)
      errors.push(e?.message || `Could not copy ${c.source}`)
    }
  }

  // Rewrite only refs whose file is now in place, and only where the stored
  // value is still what we planned against (an edit made meanwhile wins).
  let rewritten = 0
  for (const file of ['config.json', 'project.json'] as const) {
    const changes = plan.refs.filter(r => r.file === file && r.action !== 'missing' && !failed.has(r.to))
    if (!changes.length) continue
    const p = path.join(plan.channel_dir, file)
    await withLock(p, async () => {
      const json = await readJsonFile(p)
      if (!json) return
      let n = 0
      for (const r of changes) if (setAt(json, r.field, r.from, r.to)) n++
      if (n) await writeJsonAtomic(p, json)
      rewritten += n
    })
  }

  let exportsMoved = 0
  if (plan.exports.moves.length && !plan.exports.blocked) {
    const trashDir = trashRootFor(path.dirname(plan.exports.from), plan.channel_dir, slug)
    for (const m of plan.exports.moves) {
      try {
        await moveFinal(m.from, m.to, path.join(trashDir, 'moved-to-channel', path.relative(plan.exports.from, m.from)), plan.channel_dir)
        exportsMoved++
      } catch (e: any) {
        errors.push(`Could not move ${m.from}: ${e?.message || e}`)
      }
    }
    await pruneEmptyDirs(plan.exports.from)
  } else if (plan.exports.blocked) {
    errors.push(plan.exports.blocked)
  }

  if (rewritten || exportsMoved) {
    const { episodeStatusCache } = await import('./episode-status-cache.js')
    episodeStatusCache.invalidateProject(slug)
  }

  return {
    slug,
    copied,
    rewritten,
    exports_moved: exportsMoved,
    missing: plan.refs.filter(r => r.action === 'missing'),
    errors,
    plan_after: await planChannel(slug),
  }
}

/**
 * Move one finished-video file. Same volume: a rename (instant). Another
 * volume: copy, verify by sha256, then the original goes to the Trash on its
 * own volume — never deleted.
 */
async function moveFinal(from: string, to: string, trashTarget: string, channelDir: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  if (existsSync(to)) throw new Error(`${to} already exists`)
  try {
    await fs.rename(from, to)
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e
    await copyVerified(from, to, channelDir)
    moveToTrashSync(from, trashTarget, 'moved-source')
  }
}

/** Remove now-empty folders left behind by moved finals (never a folder with anything in it). */
async function pruneEmptyDirs(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return
  for (const e of entries) if (e.isDirectory() && e.name !== '_trash') await pruneEmptyDirs(path.join(dir, e.name))
  const left = (await fs.readdir(dir).catch(() => ['?'])).filter(n => n !== '.DS_Store')
  if (left.length === 0) {
    const ds = path.join(dir, '.DS_Store')
    if (existsSync(ds)) return
    await fs.rmdir(dir).catch(() => {})
  }
}

// ── Whole Library ────────────────────────────────────────────────────────

export interface LibraryPlan {
  channels: ChannelPlan[]
  totals: ChannelPlan['totals']
  done: boolean
}

function sumTotals(plans: ChannelPlan[]): ChannelPlan['totals'] {
  const t = { refs_to_rewrite: 0, files_to_copy: 0, bytes_to_copy: 0, missing: 0, exports_to_move: 0, export_bytes: 0 }
  for (const p of plans) for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] += p.totals[k]
  return t
}

export async function planLibrary(): Promise<LibraryPlan> {
  const channels: ChannelPlan[] = []
  for (const project of await pm.listProjects()) channels.push(await planChannel((project as any).slug))
  return { channels, totals: sumTotals(channels), done: channels.every(c => c.done) }
}

export async function applyLibrary(): Promise<{ channels: ChannelApplyResult[]; totals_after: ChannelPlan['totals'] }> {
  const channels: ChannelApplyResult[] = []
  for (const project of await pm.listProjects()) channels.push(await applyChannel((project as any).slug))
  return { channels, totals_after: sumTotals(channels.map(c => c.plan_after)) }
}
