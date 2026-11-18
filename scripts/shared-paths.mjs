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
