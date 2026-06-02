/**
 * Portable asset paths — the expand / collapse pair that lets presets
 * sync between computers without baking in host-specific `/Users/<name>`
 * prefixes.
 *
 * Two shapes we round-trip:
 *   portable      — "${PROJECT}/00 Assets/logo.png" or "${TERRANASH}/logo.png"
 *   absolute      — "/Users/alice/.../logo.png"  (whatever the OS sees)
 *
 * All resolvers are pure string ops — no filesystem calls — so they stay
 * cheap enough to run inside hot paths (every preset field touches them).
 *
 *   resolveAssetPath(portable, outputRoot) → absolute
 *   toPortablePath(absolute, outputRoot)   → portable when possible, else absolute
 *
 * Back-compat guarantee: an absolute path passed to `resolveAssetPath`
 * returns unchanged. Existing presets keep working even before the user
 * migrates them. Ditto a portable path passed to `toPortablePath` — it
 * returns unchanged rather than re-resolving and re-collapsing.
 */

import path from 'path'
import { listNamedRoots } from './named-roots.js'

const VAR_RE = /^\$\{([A-Z][A-Z0-9_]*)\}(?:\/(.*))?$/

/**
 * True if `p` is already in portable form (`${NAME}` or `${NAME}/rel`).
 * Never hits the filesystem.
 */
export function isPortablePath(p: string): boolean {
  return typeof p === 'string' && VAR_RE.test(p)
}

/**
 * Expand a portable path to an absolute path on the current machine.
 *
 * Returns the original string unchanged if:
 *   - it's already absolute (legacy path, or external asset the user hasn't
 *     migrated yet)
 *   - it's relative but doesn't start with `${...}` (caller passes us
 *     "foo.png" — we leave that to path.resolve semantics elsewhere)
 *
 * Throws if the variable name is used but not defined locally. This is
 * intentional — we want the render to fail loudly with a clear "define
 * ${NAME} in Settings → Named Roots" message, rather than silently
 * searching for a file that can't exist.
 */
export function resolveAssetPath(p: string, projectOutputRoot?: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  const m = p.match(VAR_RE)
  if (!m) return p
  const [, name, rel] = m
  let base: string
  if (name === 'PROJECT') {
    if (!projectOutputRoot) {
      throw new Error(`Cannot resolve ${p}: PROJECT variable requires an output_root context.`)
    }
    base = projectOutputRoot
  } else {
    const roots = listNamedRoots()
    const hit = roots[name]
    if (!hit) {
      throw new Error(`Named root ${name} is not defined on this machine. Define it in Settings → Named Roots.`)
    }
    base = hit
  }
  return rel ? path.join(base, rel) : base
}

/**
 * Collapse an absolute path to a portable form when possible.
 *
 * Preference order (most specific wins):
 *   1. If the path is inside projectOutputRoot → `${PROJECT}/rel`
 *   2. If it's inside any named root             → `${NAME}/rel`
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

  // Choose the longest matching root so nested mappings (e.g.
  // SHARED_ASSETS → /foo and CHANNEL_ASSETS → /foo/channel) pick the
  // most specific one.
  const roots = Object.entries(listNamedRoots())
    .filter(([, v]) => path.isAbsolute(v))
    .sort(([, a], [, b]) => b.length - a.length)

  for (const [name, rootPath] of roots) {
    const rel = relativeIfInside(normAbs, path.normalize(rootPath))
    if (rel !== null) return rel ? `\${${name}}/${rel}` : `\${${name}}`
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
