/**
 * The Library — the one place Story Studio keeps everything (v1.4.3).
 *
 * ── What this replaces ──
 *
 * Until now there were FOUR ideas about where things live: a default root under
 * the app's own userData folder, a `projects_root_override`, a list of
 * `linked_project_paths` pointing at folders anywhere on disk, and a
 * `named-roots.json` map for `${ASSET}`. Exports were a fifth, kept outside all
 * of them. Each existed for a good reason and together they meant nobody could
 * answer "where is my work?" without reading four files.
 *
 * The owner's instruction: *"i want to just copy and paste a folder and then
 * connect it. i don't want connection like in the past where i have to link and
 * stuff. i just want to point at the main folder and it's all already created
 * easily."*
 *
 * So there is one Library:
 *
 *     <Library>/
 *     ├── <channel>/          a folder containing project.json IS a project
 *     ├── _Project Assets/    ${ASSET} resolves here, always
 *     └── Exports/            finished videos
 *
 * Discovery is the folder scan and nothing else. Copy a channel folder in and it
 * appears; take it out and it is gone. There is no register, link, adopt or
 * import step, because those were the concepts he asked to be rid of.
 *
 * ── Why the Library is chosen, never assumed ──
 *
 * *"i don't want our app on a new computer to use the default location … so
 * that the user can save it anywhere they wanted as long as they have access.
 * this way, it also means that i don't have to hunt for the story studio folder
 * inside of /user sth."*
 *
 * A fresh install therefore has NO Library and asks for one, suggesting
 * `~/Documents/Story Studio KH` without imposing it. Nothing is created until
 * the choice is confirmed — a picker that silently makes folders while someone
 * is still browsing is how you end up with three empty Story Studio folders.
 *
 * ── Why "not configured" and "not there" are different ──
 *
 * A Library that has never been chosen means "ask". A Library that was chosen
 * and is not there right now — an external drive that is unplugged — means
 * "say so, and offer to look again", never an empty project list. That is the
 * same failure shape as 1.4.2's silent `output_root`: the app knows, so it must
 * say. `describeLibrary` reports the two states separately precisely so no
 * caller can collapse them.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { getAppSetting, setAppSetting } from './app-settings.js'

/** `${ASSET}` resolves here. Underscore-prefixed so it sorts above channels. */
export const ASSETS_DIR_NAME = '_Project Assets'
/** Finished videos land here. */
export const EXPORTS_DIR_NAME = 'Exports'
/** The app-settings key holding the Library path. The ONLY location setting. */
export const LIBRARY_ROOT_KEY = 'library_root'

/**
 * What a fresh install is offered. Documents rather than the app's own userData
 * folder, because the whole point is that he can find it without hunting
 * through `/Users/…/Library/Application Support`.
 */
export function suggestedLibraryPath(): string {
  return path.join(os.homedir(), 'Documents', 'Story Studio KH')
}

export interface LibraryStatus {
  /** Has a Library ever been chosen on this machine? */
  configured: boolean
  /** The chosen path. Empty string when nothing has been chosen. */
  path: string
  /** Is it there right now? False for an unplugged drive or a deleted folder. */
  exists: boolean
  /** Can we actually write into it? A read-only volume is not usable. */
  writable: boolean
  /** What to pre-fill a first-run picker with. */
  suggested: string
  assets_dir: string
  /** Where finished videos go now: the chosen folder, or `<Library>/Exports`. */
  exports_dir: string
  /** True when the owner picked a finished-videos folder of his own. */
  exports_custom: boolean
  /** Earlier finished-videos folders that are still searched for existing videos. */
  exports_previous: string[]
}

/** Read the configured Library without touching the filesystem. */
export async function getLibraryRoot(): Promise<string> {
  const raw = await getAppSetting(LIBRARY_ROOT_KEY)
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  // An install upgrading from before the Library had `projects_root_override`.
  // Honoured here as well as in `resolveProjectsRoot` so there is no window in
  // which an existing user is told they have no Library and sent to first run.
  const legacy = await getAppSetting('projects_root_override')
  return typeof legacy === 'string' && legacy.trim() ? legacy.trim() : ''
}

/**
 * Can we create files here?
 *
 * Actually writes and removes a probe file rather than reading permission bits:
 * a network volume, a read-only external disk and a folder owned by another
 * user all report plausible-looking permissions and then fail on write. The
 * only trustworthy check is the write itself.
 */
export async function isWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.story-studio-write-test-${process.pid}`)
  try {
    await fs.writeFile(probe, 'ok')
    await fs.rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export async function describeLibrary(): Promise<LibraryStatus> {
  const root = await getLibraryRoot()
  const exists = !!root && existsSync(root)
  return {
    configured: !!root,
    path: root,
    exists,
    writable: exists ? await isWritable(root) : false,
    suggested: suggestedLibraryPath(),
    assets_dir: root ? path.join(root, ASSETS_DIR_NAME) : '',
    exports_dir: await exportsDir(),
    exports_custom: !!(await getCustomExportsRoot()),
    exports_previous: await previousExportsDirs(),
  }
}

export type LibraryCheck =
  | { ok: true; path: string; will_create: boolean; caution?: string }
  | { ok: false; reason: string }

/**
 * Folders where dropping three Story Studio folders loose would be legal and
 * messy. He explicitly named Downloads and Desktop as places he likes, so this
 * WARNS rather than refuses — telling him it is a bad idea and letting him do
 * it anyway is the right balance for somebody's own machine.
 */
function untidyRoot(target: string): string {
  const home = os.homedir()
  const named: Record<string, string> = {
    [home]: 'your home folder',
    [path.join(home, 'Downloads')]: 'your Downloads folder',
    [path.join(home, 'Desktop')]: 'your Desktop',
    [path.join(home, 'Documents')]: 'your Documents folder',
  }
  return named[path.resolve(target)] || ''
}

/**
 * Judge a candidate Library BEFORE anything is created.
 *
 * Every refusal names the folder and says what is wrong with it, because the
 * one thing a person cannot do at this point is inspect the app's reasoning —
 * they have not got in yet.
 */
export async function checkLibraryTarget(candidate: string): Promise<LibraryCheck> {
  const raw = String(candidate || '').trim()
  if (!raw) return { ok: false, reason: 'Choose a folder for your Library.' }

  const expanded = raw.startsWith('~')
    ? path.join(os.homedir(), raw.slice(1))
    : raw
  if (!path.isAbsolute(expanded)) {
    return { ok: false, reason: `"${raw}" is not a full path. Pick a folder rather than typing a partial one.` }
  }
  const target = path.resolve(expanded)

  if (existsSync(target)) {
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isDirectory()) {
      return { ok: false, reason: `"${target}" is a file, not a folder.` }
    }
    if (!await isWritable(target)) {
      return {
        ok: false,
        reason: `Story Studio cannot write into "${target}". `
          + 'Pick somewhere you own — your Documents, Desktop or Downloads folder, or a drive that is not read-only.',
      }
    }
    const untidy = untidyRoot(target)
    return {
      ok: true,
      path: target,
      will_create: false,
      caution: untidy
        ? `This is ${untidy} itself, so Story Studio's folders would sit loose among everything else `
          + 'already in there. A folder inside it — "Story Studio KH", say — is usually tidier.'
        : undefined,
    }
  }

  // Not there yet: it can still be a fine choice, as long as its parent exists
  // and we may write into it. Creating a whole tree of missing folders from a
  // typed path is how a typo becomes a Library nobody can find again.
  const parent = path.dirname(target)
  if (!existsSync(parent)) {
    return { ok: false, reason: `"${parent}" does not exist, so "${path.basename(target)}" cannot be created inside it.` }
  }
  if (!await isWritable(parent)) {
    return { ok: false, reason: `Story Studio cannot create a folder inside "${parent}".` }
  }
  return { ok: true, path: target, will_create: true }
}

/**
 * Adopt a Library: create it and its two fixed subfolders, then record it.
 *
 * Creation happens HERE and nowhere earlier, so browsing around in the picker
 * leaves nothing behind. Existing channel folders inside a chosen folder are
 * left exactly as they are and simply appear — that is the entire "connect an
 * existing folder" story now.
 */
export async function setLibraryRoot(candidate: string): Promise<LibraryStatus> {
  const check = await checkLibraryTarget(candidate)
  if (!check.ok) throw Object.assign(new Error(check.reason), { status: 400, expose: true })
  await ensureLibraryLayout(check.path)
  await setAppSetting(LIBRARY_ROOT_KEY, check.path)
  return describeLibrary()
}

/** Create the Library and its fixed subfolders. Safe to call repeatedly. */
export async function ensureLibraryLayout(root: string): Promise<void> {
  const { assertWriteIsolatedInTests } = await import('../lib/test-isolation.js')
  assertWriteIsolatedInTests(root, 'library-root')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(root, ASSETS_DIR_NAME), { recursive: true })
  await fs.mkdir(path.join(root, EXPORTS_DIR_NAME), { recursive: true })
}

/**
 * Where `${ASSET}` points. Always inside the Library, by the owner's decision —
 * it used to be a per-machine map in `named-roots.json`, which meant the same
 * project resolved differently on two Macs and nobody could tell why.
 */
export async function assetsDir(): Promise<string> {
  const root = await getLibraryRoot()
  return root ? path.join(root, ASSETS_DIR_NAME) : ''
}

/**
 * The finished-videos folder the owner chose, or '' for the default
 * `<Library>/Exports` (v1.4.249).
 *
 * The owner: *"where finished videos go — no pick, it's a long text path to
 * type."* So the folder is choosable again, but only through
 * `setExportsRoot`, which records the folder it replaces in
 * `EXPORTS_HISTORY_KEY`. Videos already rendered stay where they are and are
 * still found there (see `resolveExternalFinalVideoDir`), so changing the
 * folder never makes a finished episode look unfinished.
 */
export const EXPORTS_ROOT_KEY = 'exports_root'
export const EXPORTS_HISTORY_KEY = 'exports_root_previous'
const EXPORTS_HISTORY_LIMIT = 8

export async function getCustomExportsRoot(): Promise<string> {
  const raw = await getAppSetting(EXPORTS_ROOT_KEY)
  return typeof raw === 'string' && raw.trim() ? raw.trim() : ''
}

/** Where finished videos go: the chosen folder, else `<Library>/Exports`. */
export async function exportsDir(): Promise<string> {
  const custom = await getCustomExportsRoot()
  if (custom) return custom
  const root = await getLibraryRoot()
  return root ? path.join(root, EXPORTS_DIR_NAME) : ''
}

/** Earlier finished-videos folders, newest first. Read-only history. */
export async function previousExportsDirs(): Promise<string[]> {
  const raw = await getAppSetting(EXPORTS_HISTORY_KEY)
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && !!v.trim()) : []
}

/**
 * Choose where NEW finished videos go. `''` (or null) means the Library's own
 * `Exports` folder again. Nothing on disk is moved: the folder being replaced
 * is remembered so its videos keep being found.
 */
export async function setExportsRoot(candidate: string | null): Promise<LibraryStatus> {
  const before = await exportsDir()
  const raw = String(candidate ?? '').trim()
  let next = ''
  if (raw) {
    const check = await checkLibraryTarget(raw)
    if (!check.ok) throw Object.assign(new Error(check.reason), { status: 400, expose: true })
    const library = await getLibraryRoot()
    if (library) {
      const lib = path.resolve(library)
      const rel = path.relative(check.path, lib)
      // The Library itself, or a folder that contains it, would put
      // `<folder>/<channel>/…` exactly where the channel's own project folder is.
      if (check.path === lib || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        throw Object.assign(new Error(
          `"${check.path}" holds your Library, so finished videos would land inside your channel folders. `
          + 'Choose a separate folder, such as one called "Finished videos".',
        ), { status: 400, expose: true })
      }
      if (check.path === path.join(lib, EXPORTS_DIR_NAME)) next = ''
      else next = check.path
    } else {
      next = check.path
    }
    if (next) {
      const { assertWriteIsolatedInTests } = await import('../lib/test-isolation.js')
      assertWriteIsolatedInTests(next, 'exports-root')
      await fs.mkdir(next, { recursive: true })
    }
  }
  await setAppSetting(EXPORTS_ROOT_KEY, next)
  const after = await exportsDir()
  if (before && path.resolve(before) !== path.resolve(after || '.')) {
    const history = (await previousExportsDirs()).filter(p => path.resolve(p) !== path.resolve(before)
      && (!after || path.resolve(p) !== path.resolve(after)))
    await setAppSetting(EXPORTS_HISTORY_KEY, [before, ...history].slice(0, EXPORTS_HISTORY_LIMIT))
  } else if (after) {
    const history = await previousExportsDirs()
    const pruned = history.filter(p => path.resolve(p) !== path.resolve(after))
    if (pruned.length !== history.length) await setAppSetting(EXPORTS_HISTORY_KEY, pruned)
  }
  return describeLibrary()
}
