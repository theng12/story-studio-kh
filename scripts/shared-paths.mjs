import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const TRASH_ROOT_ENV = 'STORY_STUDIO_TRASH_DIR'
export const DEFAULT_TRASH_ROOT = path.join(os.homedir(), 'Desktop', '_trash', 'story-studio-kh')

function rejection(target, detail) {
  return new Error(`${TRASH_ROOT_ENV} must name a real folder, not a link: ${target} (${detail})`)
}

function inspectTrashRoot(info, target) {
  if (info.isSymbolicLink()) throw rejection(target, 'it is a symbolic link')
  if (!info.isDirectory()) throw rejection(target, 'it is not a directory')
}

/** The default trash path, with no environment override. */
export function trashPath(...segments) {
  return path.join(DEFAULT_TRASH_ROOT, ...segments)
}

/**
 * Create and validate the trash root. An override must be an exact absolute
 * path to a real folder; links are refused rather than followed.
 */
export async function resolveTrashRoot(env = process.env) {
  const target = env[TRASH_ROOT_ENV] || DEFAULT_TRASH_ROOT
  if (!path.isAbsolute(target) || path.resolve(target) !== target) {
    throw new Error(`${TRASH_ROOT_ENV} must be an exact absolute path, not "${target}"`)
  }
  let info
  try {
    info = await fsp.lstat(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await fsp.mkdir(target, { recursive: true, mode: 0o700 })
    info = await fsp.lstat(target)
  }
  inspectTrashRoot(info, target)
  return target
}

/** Synchronous companion for release scripts that do not use promises. */
export function resolveTrashRootSync(env = process.env) {
  const target = env[TRASH_ROOT_ENV] || DEFAULT_TRASH_ROOT
  if (!path.isAbsolute(target) || path.resolve(target) !== target) {
    throw new Error(`${TRASH_ROOT_ENV} must be an exact absolute path, not "${target}"`)
  }
  let info
  try {
    info = fs.lstatSync(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    info = fs.lstatSync(target)
  }
  inspectTrashRoot(info, target)
  return target
}

/**
 * A test lane's trash must be unreachable from the owner's trash.
 *
 * The lane runs its children with a sandbox HOME, so the honest place for their trash is that
 * sandbox. This refuses, loudly and before anything is copied, any path that resolves under the real
 * `~/Desktop`, `~/.Trash` or the checkout: a test that installs a build must be unable to write into
 * the owner's trash by construction, not caught afterwards by an assertion.
 */
export function assertSandboxedTrash(target, { sandbox, home = os.homedir(), checkout } = {}) {
  if (!sandbox) throw new Error(`A test lane's trash needs its sandbox: ${target}`)
  const resolved = path.resolve(target)
  const inside = (base) => resolved === path.resolve(base) || resolved.startsWith(path.resolve(base) + path.sep)
  // The lane's own sandbox comes first: the harness relocates its TMPDIR into .test-work, inside the
  // checkout, so the checkout rule would otherwise refuse the very trash the lane hands its children.
  if (inside(sandbox)) return resolved
  const forbidden = [path.join(home, 'Desktop'), path.join(home, '.Trash'), checkout].filter(Boolean)
  const hit = forbidden.find(inside)
  if (hit) throw new Error(`A test lane must never use the owner's trash: ${resolved} is under ${hit}`)
  throw new Error(`A test lane's trash must live inside its sandbox: ${resolved} is outside ${sandbox}`)
}

/** The trash a lane's children get: inside their sandbox HOME, guarded. */
export function sandboxTrashRoot(sandbox, home = path.join(sandbox, 'home')) {
  return assertSandboxedTrash(path.join(home, 'Desktop', '_trash', 'story-studio-kh'), { sandbox, home: os.homedir() })
}
