import { lstatSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

/**
 * Where an app-initiated removal goes. Nothing the app removes is hard-deleted:
 * the original moves under a `_trash` folder on the SAME volume as the file
 * (the project folder, or `<media_root>/_trash/<slug>` when heavy media lives
 * on another drive) and the owner empties it himself. This never touches what
 * is already inside `_trash`.
 */
export function trashRootFor(anchor: string, projectDir: string, slug: string): string {
  return path.resolve(anchor) === path.resolve(projectDir)
    ? path.join(projectDir, '_trash')
    : path.join(anchor, '_trash', slug)
}

/**
 * Rename `file` to `target`, creating parents (mkdir -p on every call, so a
 * missing `_trash` never blocks a run). An existing item at `target` is never
 * replaced: the name gets a timestamp suffix instead. A failed rename throws
 * and leaves the file where it was: there is deliberately no copy-then-delete
 * fallback (a cross-device failure must skip the file, not destroy it).
 */
export function moveToTrashSync(file: string, target: string): string {
  mkdirSync(path.dirname(target), { recursive: true })
  const { dir, name, ext } = path.parse(target)
  let candidate = target
  for (let n = 0; exists(candidate); n += 1) {
    candidate = path.join(dir, `${name}.${Date.now()}${n ? `-${n}` : ''}${ext}`)
  }
  renameSync(file, candidate)
  return candidate
}

function exists(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}
