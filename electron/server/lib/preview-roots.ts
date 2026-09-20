/**
 * Which files may a preview route read?
 *
 * WHY THIS EXISTS
 * ---------------
 * Four routes served a file named by `?path=` and one read a `source_path` from
 * a request body, passing it to `resolveAssetPath` — which returns a plain
 * absolute path UNCHANGED (`services/path-resolver.ts:68`) — and then checking
 * only the file extension:
 *
 *   GET /api/projects/<slug>/video-editor/preview-audio?path=/Users/any/private.mp3
 *   GET /api/projects/<slug>/video-editor/preview-media?path=/Users/any/private.mp4
 *   GET /api/projects/<slug>/video-editor/preview-image?path=/Users/any/private.png
 *   GET /api/projects/<slug>/audio-editor/preview-audio?path=/Users/any/private.mp3
 *   POST /api/projects/<slug>/thumbnail-reference/analyze { source_path: … }
 *
 * So any file on the machine with a matching extension could be streamed back,
 * and `analyze` would upload it to GenStudio. The in-code comment justifying
 * this ("this backend binds localhost, so the risk surface is the UI itself") is
 * false in server mode, which binds 0.0.0.0, and desktop mode has no auth while
 * a cross-site fetch to 127.0.0.1 passes the Host guard.
 *
 * THE RULE — the owner's decision, 2026-09-19
 * -------------------------------------------
 * A preview may read from the Library, or from a folder the owner deliberately
 * configured as a media location. Nothing else. Dialog-picked files that live
 * elsewhere are no longer previewable; that is the accepted cost of closing it.
 *
 * Paths are compared by `realpath`, so a symlink cannot be used to step outside
 * an allowed root. `fs.realpath` also resolves the case-insensitive filesystem,
 * which a plain string compare would get wrong on macOS.
 */

import path from 'path'

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Resolve `p`, preserving missing suffixes only below a canonical existing ancestor. */
async function realOrResolved(p: string): Promise<string> {
  const { lstat, realpath } = await import('fs/promises')
  const { resolve } = path
  const resolved = resolve(p)
  try {
    return await realpath(resolved)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }

  // A missing file still needs its existing ancestor's canonical spelling
  // (`/tmp` is `/private/tmp` on macOS). Walk lexical nodes with lstat so an
  // existing dangling symlink cannot disappear into the unresolved suffix.
  const suffix: string[] = []
  let cursor = resolved
  while (true) {
    try {
      await lstat(cursor)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(path.basename(cursor))
      cursor = parent
      continue
    }

    // If this existing node is a dangling or otherwise unresolvable symlink,
    // realpath fails and admission must fail closed.
    return path.join(await realpath(cursor), ...suffix)
  }
}

function isInside(child: string, root: string): boolean {
  if (child === root) return true
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * Every folder a preview may legitimately read from.
 *
 * The Library covers the project tree, each project's `music/` pool and the
 * `Exports` folder. On top of that the owner may have configured a media root
 * (an external SSD, per project) and one or more B-Roll pool folders — those are
 * deliberate choices about where media lives, so they count as allowed.
 */
export async function allowedPreviewRoots(slug?: string): Promise<string[]> {
  const pm = await import('../services/project-manager.js')
  const roots: string[] = []
  try {
    roots.push(await realOrResolved(pm.projectsRoot()))
  } catch { /* no Library configured yet — nothing is allowed */ }

  if (slug) {
    try {
      const meta = await pm.getProject(slug) as { media_root?: unknown } | null
      const mediaRoot = typeof meta?.media_root === 'string' ? meta.media_root.trim() : ''
      if (mediaRoot) {
        const { resolveAssetPath } = await import('../services/path-resolver.js')
        try {
          // `media_root` is stored as a portable token; an unresolvable one
          // simply adds nothing rather than throwing out of an allow-check.
          roots.push(await realOrResolved(resolveAssetPath(mediaRoot)))
        } catch { /* unresolvable on this machine */ }
      }
    } catch { /* project unreadable — the caller will 404 anyway */ }
  }

  try {
    const bp = await import('../services/broll-pool-manager.js')
    for (const pool of await bp.listPools()) {
      const folder = typeof (pool as { folder_path?: unknown })?.folder_path === 'string'
        ? (pool as { folder_path: string }).folder_path
        : ''
      if (folder) {
        try { roots.push(await realOrResolved(folder)) } catch { /* this pool is unavailable */ }
      }
    }
  } catch { /* no pools registered */ }

  return roots
}

/**
 * `true` when this exact file may be read. Resolves symlinks on both sides, so
 * a link planted inside an allowed folder cannot point out of it.
 */
export async function isPreviewablePath(filePath: string, slug?: string): Promise<boolean> {
  if (typeof filePath !== 'string' || !filePath.trim()) return false
  let target: string
  try {
    target = await realOrResolved(filePath)
  } catch {
    return false
  }
  for (const root of await allowedPreviewRoots(slug)) {
    if (isInside(target, root)) return true
  }
  return false
}
