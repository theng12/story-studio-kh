/**
 * Portable asset paths — the expand / collapse pair that lets presets
 * sync between computers without baking in host-specific `/Users/<name>`
 * prefixes.
 *
 * Two shapes we round-trip:
 *   portable      — "${PROJECT}/00 Assets/logo.png" or "${MY_FOLDER}/logo.png"
 *   absolute      — "/Users/alice/.../logo.png"  (whatever the OS sees)
 *
 * All resolvers are pure string ops — no filesystem calls — so they stay
 * cheap enough to run inside hot paths (every preset field touches them).
 *
 *   resolveAssetPath(portable, episodesDirAbs) → absolute
 *   toPortablePath(absolute, episodesDirAbs) → portable when possible, else absolute
 *
 * Back-compat guarantee: an absolute path passed to `resolveAssetPath`
 * returns unchanged. Existing presets keep working even before the user
 * migrates them. Ditto a portable path passed to `toPortablePath` — it
 * returns unchanged rather than re-resolving and re-collapsing.
 */

import path from 'path'
import { projectsRoot } from './project-manager.js'
import { ASSETS_DIR_NAME } from './library.js'

const VAR_RE = /^\$\{([A-Z][A-Z0-9_]*)\}(?:\/(.*))?$/

/**
 * True if `p` is already in portable form (`${NAME}` or `${NAME}/rel`).
 * Never hits the filesystem.
 */
export function isPortablePath(p: string): boolean {
  return typeof p === 'string' && VAR_RE.test(p)
}

/**
 * The shared-assets folder, resolved synchronously.
 *
 * `${ASSET}` is always `<Library>/_Project Assets` (v1.4.3). It used to be
 * whatever a per-machine `named-roots.json` said, which meant the same preset
 * resolved to different folders on two Macs and neither one could be checked
 * from the other. Sync because `resolveAssetPath` is sync and is called from
 * dozens of render paths.
 */
export function assetsRoot(): string {
  return path.join(projectsRoot(), ASSETS_DIR_NAME)
}

/**
 * Expand a portable path to an absolute path on this machine.
 *
 * Two tokens exist, and only two:
 *   `${PROJECT}` — this episode's own project output root.
 *   `${ASSET}`   — the Library's shared assets folder.
 *
 * v1.4.3 removed arbitrary `${NAME}` tokens backed by a per-machine map. They
 * were the fourth location concept, and the one that made a project
 * non-portable in the exact situation portability was for: carry the project to
 * another Mac and `${MY_FOLDER}` meant nothing there until someone re-declared
 * it by hand.
 *
 * An unknown token still throws rather than resolving to something plausible —
 * silently searching for a file that cannot exist is how a render half-succeeds.
 */
export function resolveAssetPath(p: string, projectOutputRoot?: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  const m = p.match(VAR_RE)
  if (!m) return p
  const [, name, rel] = m
  let base: string
  if (name === 'PROJECT') {
    if (!projectOutputRoot) {
      throw new Error(`Cannot resolve ${p}: PROJECT variable requires an episodes-folder context.`)
    }
    // The base must be ABSOLUTE, and saying so out loud is the point.
    // Every caller used to hand this the stored `project.output_root`, which
    // was the relative string './episodes'; `path.join('./episodes', rel)`
    // returns another relative path, resolved against whatever the process
    // cwd happens to be. Nothing threw, so a `${PROJECT}/…` preset simply
    // pointed at a file that was not there — while `toPortablePath()` below,
    // which DOES gate on isAbsolute, quietly declined to produce portable
    // paths at all. A check on one side and not the other is how a feature
    // manages to be broken in both directions without a single error.
    if (!path.isAbsolute(projectOutputRoot)) {
      throw new Error(
        `Cannot resolve ${p}: the episodes folder must be an absolute path, got "${projectOutputRoot}".`,
      )
    }
    base = projectOutputRoot
  } else if (name === 'ASSET') {
    base = assetsRoot()
  } else {
    throw new Error(
      `Cannot resolve ${p}: "${name}" is not a folder Story Studio knows about. `
      + 'Custom folder labels were retired in 1.4.3 — shared files now live in your Library\'s '
      + '"_Project Assets" folder and are written as ${ASSET}/…. '
      + `Move the files this preset needs into _Project Assets and point it at \${ASSET}/ instead.`,
    )
  }
  return rel ? path.join(base, rel) : base
}

/**
 * Collapse an absolute path to a portable form when possible.
 *
 * Preference order (most specific wins):
 *   1. If the path is inside projectOutputRoot → `${PROJECT}/rel`
 *   2. If it's inside the Library's assets folder → `${ASSET}/rel`
 *   3. Otherwise                                 → return absolute unchanged
 *
 * Comparison is done on normalised absolute paths with a trailing
 * separator so `/Users/a/foo` doesn't falsely match `/Users/a/foobar`.
 */
export function toPortablePath(abs: string, projectOutputRoot?: string): string {
  if (typeof abs !== 'string' || abs.length === 0) return abs
  if (isPortablePath(abs)) return abs
  if (!path.isAbsolute(abs)) return abs

  const normAbs = path.normalize(abs)

  if (projectOutputRoot && path.isAbsolute(projectOutputRoot)) {
    const rel = relativeIfInside(normAbs, path.normalize(projectOutputRoot))
    if (rel !== null) return rel ? `\${PROJECT}/${rel}` : '${PROJECT}'
  }

  // v1.4.3 — one shared folder instead of a map of user-declared ones.
  const assets = assetsRoot()
  if (path.isAbsolute(assets)) {
    const rel = relativeIfInside(normAbs, path.normalize(assets))
    if (rel !== null) return rel ? `\${ASSET}/${rel}` : '${ASSET}'
  }

  return abs
}

/**
 * Return the path of `abs` relative to `base` when `abs` is inside `base`.
 * Returns null when it isn't. Uses a trailing-separator check to avoid
 * `/foo/bar` being considered inside `/foo/ba`.
 */
function relativeIfInside(abs: string, base: string): string | null {
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep
  if (abs === base) return ''
  if (abs.startsWith(baseWithSep)) return abs.slice(baseWithSep.length)
  return null
}

/**
 * Collect every `${NAME}` variable referenced by a portable path so the
 * import flow can warn the user if a required root isn't defined locally.
 * Pass any mix of portable / absolute / undefined values — non-portable
 * ones contribute nothing.
 */
export function collectRequiredRoots(paths: Array<string | undefined | null>): string[] {
  const names = new Set<string>()
  for (const p of paths) {
    if (!p) continue
    const m = typeof p === 'string' ? p.match(VAR_RE) : null
    if (m && m[1] !== 'PROJECT') names.add(m[1])
  }
  return [...names].sort()
}
