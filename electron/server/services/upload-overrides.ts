/**
 * Per-episode upload override sidecar (`upload_metadata_overrides.json`).
 *
 * Stores user choices that customise an upload without modifying the
 * generator output (which is regenerated routinely from the script
 * pipeline). Today's writers:
 *
 *   - **selected_thumbnail** (v1.0.41) — pinned thumbnail filename
 *     chosen by the user on the Images-page picker. The resolver in
 *     `lib/upload-metadata.ts` honours this over the auto-pick rule.
 *   - **title** / **description** (v1.4.347) — the owner's own text, typed
 *     in Upload Center's "What YouTube will receive" panel and saved here.
 *     The resolver merges them over the generator's output.
 *
 * The sidecar is platform-keyed at the top level so future writers
 * (TikTok caption override, Facebook description override) can land
 * without colliding with YouTube's block:
 *
 *   {
 *     "youtube": {
 *       "selected_thumbnail": "TN0008_Thumb02_v1.png",
 *       "title": "...",          // existing, optional
 *       "description": "...",    // existing, optional
 *       "tags": [...]            // existing, optional
 *     }
 *   }
 *
 * Path: `{episode_dir}/upload_metadata_overrides.json`. The file
 * follows episode_dir on renumber/compact; only its CONTENT may need
 * rewriting when filenames it references contain the old episode_code
 * (see `rewriteSelectedThumbnailOnRename`).
 *
 * Two rules every writer here obeys:
 *
 *   1. **The same folder the reader uses.** The resolver finds the episode
 *      BY CODE (a rename leaves the folder under the old title). A writer
 *      that resolved by title would create a SECOND folder beside the real
 *      one — the write would land where the reader never looks, and the
 *      owner's edit would silently do nothing. `resolveOverrideEpisodePaths`
 *      below is that resolver, shared with the reader.
 *   2. **One lock for one file.** Every writer here is a read-modify-write
 *      of the same JSON file, so they all take `withLock` on that file's
 *      path. Two writers racing (the Images picker pinning a thumbnail
 *      while the owner saves a title) used to be able to lose one's write.
 */

import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import {
  resolveEpisodePaths,
  resolveEpisodePathsByCodeWithSidecar,
  resolveEpisodePathsForRead,
  resolveSubfolderNames,
} from './utils.js'
import type { EpisodePaths } from './utils.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import type { UploadPlatform } from './upload-store.js'

const FILENAME = 'upload_metadata_overrides.json'

/**
 * The sidecar's filename, exported so the READER does not spell it a second
 * time. Two spellings are two answers to "which file holds the override",
 * and they drift.
 */
export const OVERRIDES_FILENAME = FILENAME

interface PlatformOverrides {
  title?: string
  description?: string
  tags?: string[]
  /** Filename within the episode's thumbnails dir (no path prefix). */
  selected_thumbnail?: string
}

type OverridesFile = Record<string, PlatformOverrides>

/**
 * An error a route can answer itself: a status, a code, and a message that
 * says what happened without blaming anyone for it.
 *
 * Every refusal in this file carries one, so a caller never has to guess
 * whether a thrown error was a refusal or a crash — and a refusal never
 * reaches the customer as a 500.
 *
 * `expose: true` is what makes the refusal SURVIVE the boundaries that
 * handle errors generically:
 *
 *   - `lib/error-boundary.ts` answers an exposed error with its real
 *     message and code; an unexposed one becomes `Internal server error`,
 *     so the owner would learn nothing about what to fix;
 *   - `lib/humanize-backend-error.ts` forwards the `code` to the client
 *     only for an exposed error with a string code — which is how the
 *     frontend matches on a stable code instead of parsing prose.
 *
 * Without it, a route that catches the refusal itself would answer with the
 * code, but the same refusal reaching the error boundary would answer with
 * a bare 500 and a generic sentence. The two paths must not disagree.
 */
export function overrideRefusal(
  statusCode: number,
  code: string,
  message: string,
): Error & { statusCode: number; code: string; expose: true } {
  const error = new Error(message) as Error & { statusCode: number; code: string; expose: true }
  error.statusCode = statusCode
  error.code = code
  error.expose = true
  return error
}

/**
 * The folders that CLAIM the episode: the resolved folder itself, and every
 * same-code folder beside it that holds this platform's upload sidecar.
 *
 * The candidate set is the one `resolveEpisodePathsByCodeWithSidecar` uses
 * (utils.ts): a folder named exactly the code, or the code followed by
 * " - ", compared case-insensitively. `listEpisodeDirsByCode` is a DIFFERENT
 * set — only the "{code} - " form, case-sensitive, "✅ "-tolerant — because
 * it answers the recovery's question. This one answers the claimant's, and
 * a folder that one counts and the other ignores is exactly how an ambiguous
 * episode gets written into the wrong folder.
 *
 * "Holds the sidecar" means the SAME two places the helper looks in: the
 * folder root, or the scene-prompts subfolder resolved for this episode
 * (`hasSidecar` in utils.ts). A sidecar parked in that subfolder is a claim
 * the helper honours, so it is a claim counted here too — otherwise the
 * guard would miss exactly the legacy layout it exists to catch.
 */
async function sidecarClaimants(
  slug: string,
  resolvedDir: string,
  code: string,
  sidecarFilename: string,
): Promise<string[]> {
  let scenePromptsName = ''
  try {
    scenePromptsName = (await resolveSubfolderNames(slug, code)).scene_prompts || ''
  } catch {
    scenePromptsName = ''
  }
  // Imported lazily: folder-resolver pulls in asset-status, which imports
  // this file — a static import would close a cycle.
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  const holdsSidecar = async (dir: string): Promise<boolean> => {
    if (existsSync(path.join(dir, sidecarFilename))) return true
    if (!scenePromptsName) return false
    try {
      const sub = await findSubfolder(dir, scenePromptsName)
      return !!sub && existsSync(path.join(sub, sidecarFilename))
    } catch {
      return false
    }
  }

  const claimants: string[] = []
  if (await holdsSidecar(resolvedDir)) claimants.push(resolvedDir)
  const seasonDir = path.dirname(path.resolve(resolvedDir))
  const wanted = code.toLowerCase()
  let entries: Array<{ name: string; isDirectory: () => boolean }> = []
  try {
    entries = await fsp.readdir(seasonDir, { withFileTypes: true })
  } catch {
    return claimants
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name.toLowerCase()
    if (name !== wanted && !name.startsWith(`${wanted} - `)) continue
    const dir = path.join(seasonDir, entry.name)
    if (path.resolve(dir) === path.resolve(resolvedDir)) continue
    if (await holdsSidecar(dir)) claimants.push(dir)
  }
  return claimants
}

/**
 * The episode's own paths, resolved the way the READER resolves them.
 *
 * Mechanics, in order:
 *
 *   1. `resolveEpisodePathsByCodeWithSidecar` — the folder that claims the
 *      episode (it holds this platform's upload sidecar), or the idea-index
 *      folder named after the episode's current title.
 *   2. More than one folder may claim it. The helper picks the first one it
 *      finds; choosing between them would put the owner's edit in a folder
 *      the upload may never read, so that is refused.
 *   3. If the claimed folder, or the idea-index folder, is on disk, it is
 *      the answer.
 *   4. Otherwise the episode may sit under a name this resolver cannot reach
 *      — a rename. The same-code folders are counted first, because the
 *      recovery can only pick the FIRST match: more than one is a refusal,
 *      exactly one is safe.
 *   5. No candidate at all: the canonical path is returned so the caller
 *      answers "the folder is not there".
 *
 * Known limitation: the rename recovery looks one level up from the computed
 * episode folder — the level the read resolver looks at too, so writer and
 * reader always agree, including on what they cannot find. A project whose
 * folder template changed after its episodes were created keeps its episodes
 * elsewhere; neither resolver finds them, and the save is refused with the
 * neutral "could not find the folder that holds EPxxxx's files" rather than
 * landing in a folder nobody reads.
 */
export async function resolveOverrideEpisodePaths(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform = 'youtube',
): Promise<EpisodePaths> {
  const sidecarName = `${platform}_upload.json`
  const canonical = await resolveEpisodePathsByCodeWithSidecar(slug, episode_code, sidecarName)
    .catch(() => resolveEpisodePaths(slug, episode_code, fallback_title))

  // Two folders may claim the episode — each holds the upload sidecar. The
  // helper takes the first; the owner's edit must not land in the other one.
  const claimants = await sidecarClaimants(slug, canonical.episode_dir, episode_code, sidecarName)
  if (claimants.length > 1) {
    throw overrideRefusal(
      409,
      'EPISODE_FOLDER_AMBIGUOUS',
      `More than one folder claims ${episode_code} (`
      + `${claimants.map(dir => path.basename(dir)).join(', ')}), so Story Studio will not choose `
      + 'between them. Resolve the conflicting folders, then try again. Nothing was written.',
    )
  }

  if (existsSync(canonical.episode_dir)) return canonical

  // The recovery can only pick the FIRST same-code folder, so the candidates
  // are counted before it is allowed to run.
  const { listEpisodeDirsByCode } = await import('../lib/folder-resolver.js')
  const candidates = await listEpisodeDirsByCode(path.dirname(path.resolve(canonical.episode_dir)), episode_code)
  if (candidates.length > 1) {
    throw overrideRefusal(
      409,
      'EPISODE_FOLDER_AMBIGUOUS',
      `There is more than one folder for ${episode_code} on disk (`
      + `${candidates.map(dir => path.basename(dir)).join(', ')}), so Story Studio will not choose `
      + 'between them. Resolve the conflicting folders, then try again. Nothing was written.',
    )
  }
  if (candidates.length === 0) return canonical
  const recovered = await resolveEpisodePathsForRead(slug, episode_code, fallback_title)
  return existsSync(recovered.episode_dir) ? recovered : canonical
}

/** The override file's path inside the episode that owns it. */
export async function overridesPath(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform = 'youtube',
): Promise<string> {
  const paths = await resolveOverrideEpisodePaths(slug, episode_code, fallback_title, platform)
  return path.join(paths.episode_dir, FILENAME)
}

/**
 * Run `fn` while holding the override sidecar's lock.
 *
 * Every read-modify-write of that one file takes this lock, and so does the
 * upload admission that builds and compares a package against it. That is
 * what makes "the owner saved a title" and "the upload was admitted with the
 * title the owner reviewed" one thing rather than two that can interleave.
 */
export async function withOverrideLock<T>(
  slug: string,
  episode_code: string,
  fallback_title: string,
  fn: (sidecarPath: string) => Promise<T>,
  platform: UploadPlatform = 'youtube',
): Promise<T> {
  const p = await overridesPath(slug, episode_code, fallback_title, platform)
  return withLock(p, () => fn(p))
}

/**
 * Refuse to write into a folder that does not exist.
 *
 * `writeJsonAtomic` creates the directory it writes into. Without this check
 * a save for an episode code that is not in this project would CREATE an
 * empty episode folder for it — a stray `Season 001/EP9999 - /` that nothing
 * else in the app knows about.
 *
 * The message is NEUTRAL and TRUE, and it is shared by every writer of this
 * sidecar — the metadata pair AND the thumbnail pin. So it cannot talk about
 * "metadata edits" (the thumbnail caller writes none), and it cannot claim
 * the episode "is not in this project": a renamed episode's folder can be
 * unreachable while the episode is very much here. What is certainly true is
 * that the folder was not found, and that nothing was written.
 *
 * It carries a status and a code so the route answers it as a refusal
 * instead of a 500.
 */
function assertEpisodeFolderExists(sidecarPath: string, episode_code: string): void {
  if (existsSync(path.dirname(sidecarPath))) return
  throw overrideRefusal(
    400,
    'EPISODE_FOLDER_NOT_FOUND',
    `Story Studio could not find the folder that holds ${episode_code}'s files, so nothing was written.`,
  )
}

/**
 * Read the sidecar.
 *
 * `strict` is for a WRITER that is about to replace the file's contents: a
 * corrupt sidecar must not be quietly overwritten with a fresh partial one,
 * because that discards the owner's other overrides — the pinned thumbnail,
 * the tags — without a word. The resolver refuses to upload with a corrupt
 * sidecar too (2026-10-07), so a reader stays lenient and simply sees no
 * override.
 */
async function readOverridesFile(p: string, options: { strict?: boolean } = {}): Promise<OverridesFile> {
  if (!existsSync(p)) return {}
  let raw: string
  try {
    raw = await fsp.readFile(p, 'utf-8')
  } catch {
    return {}
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error: any) {
    if (!options.strict) return {}
    throw new Error(
      `${p} could not be read (${error?.message || error}). Fix or remove that file, then try again. `
      + 'Nothing was changed.',
    )
  }
  if (!data || typeof data !== 'object') {
    if (!options.strict) return {}
    throw new Error(`${p} is not a JSON object. Fix or remove that file, then try again. Nothing was changed.`)
  }
  return data as OverridesFile
}

/**
 * Read the pinned thumbnail filename for a platform, or null when
 * unset. Doesn't validate that the file exists on disk — callers do
 * that to decide whether to honour the pin or fall back.
 */
export async function readSelectedThumbnail(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform,
): Promise<string | null> {
  const p = await overridesPath(slug, episode_code, fallback_title, platform)
  const data = await readOverridesFile(p)
  const block = data[platform]
  if (!block || typeof block.selected_thumbnail !== 'string') return null
  return block.selected_thumbnail.trim() || null
}

/**
 * Set or clear the pinned thumbnail filename for a platform. Pass
 * `filename = null` to clear. When the platform block becomes empty
 * after the write, it's pruned; when the whole file becomes empty,
 * the file is deleted — keeps the episode dir tidy when the user
 * unpicks every override.
 */
export async function writeSelectedThumbnail(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform,
  filename: string | null,
): Promise<void> {
  const p = await overridesPath(slug, episode_code, fallback_title, platform)
  await withLock(p, async () => {
    assertEpisodeFolderExists(p, episode_code)
    const data = await readOverridesFile(p)
    const existing = data[platform] || {}
    if (filename === null || filename === '') {
      delete existing.selected_thumbnail
    } else {
      existing.selected_thumbnail = filename
    }
    // Prune empty platform block.
    if (Object.keys(existing).length === 0) {
      delete data[platform]
    } else {
      data[platform] = existing
    }
    // Prune empty file.
    if (Object.keys(data).length === 0) {
      if (existsSync(p)) {
        try { await fsp.rm(p, { force: true }) } catch { /* non-fatal */ }
      }
      return
    }
    await writeJsonAtomic(p, data)
  })
}

/**
 * Rewrite any `selected_thumbnail` filenames inside the override file
 * when an episode is renamed (Renumber / Compact). Pinned filenames
 * follow the `{code}_Thumb...` convention, so a string-replace of the
 * code prefix keeps the pin pointing at the same on-disk file after
 * the rename cascade has updated its actual name. No-op when the
 * file doesn't exist or no `selected_thumbnail` is set.
 */
export async function rewriteSelectedThumbnailOnRename(
  slug: string,
  /** New episode_code (the file is at the new path post-rename). */
  newCode: string,
  /** New fallback title (typically unchanged across rename). */
  fallback_title: string,
  oldCode: string,
): Promise<void> {
  const p = await overridesPath(slug, newCode, fallback_title)
  if (!existsSync(p)) return
  await withLock(p, async () => {
    const data = await readOverridesFile(p)
    let dirty = false
    for (const platform of Object.keys(data)) {
      const block = data[platform]
      if (!block) continue
      const sel = block.selected_thumbnail
      if (!sel || !sel.includes(oldCode)) continue
      block.selected_thumbnail = sel.replaceAll(oldCode, newCode)
      dirty = true
    }
    if (dirty) {
      await writeJsonAtomic(p, data)
    }
  })
}

/**
 * Set or clear the title and description overrides for a platform in one
 * atomic write. Both fields travel together so the save boundary cannot
 * leave a description from one edit beside a title from another, and
 * unrelated fields (`selected_thumbnail`, `tags`) are preserved.
 *
 * The two fields have DIFFERENT blank semantics, and neither of them is a
 * silent reversion:
 *
 *   - **description** — an empty string is STORED. The resolver honours an
 *     empty description (`typeof override.description === 'string'`), so an
 *     owner who clears the description gets an empty description, not the
 *     generated one back. `null` is the explicit reset, and only an explicit
 *     reset removes it: the generated description returns then, and only
 *     because the caller asked for it.
 *   - **title** — an empty title is DELETED, because YouTube refuses an
 *     empty title and the resolver ignores an empty title override anyway.
 *     Storing one would be a lie. `null` means the same thing.
 *
 * The platform block is pruned when it becomes empty, and the whole file is
 * deleted when nothing remains — same tidy rule as `writeSelectedThumbnail`.
 *
 * `guard` runs inside the same lock as the write, immediately before it. The
 * Upload Center's save uses it to refuse when the episode has an upload in
 * flight: that check and the write then happen as one thing, so a save cannot
 * land beside a package that is being sent. A guard that throws aborts the
 * write.
 */
export async function writeTitleAndDescription(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform,
  patch: { title?: string | null; description?: string | null },
  guard?: () => Promise<void>,
): Promise<void> {
  const p = await overridesPath(slug, episode_code, fallback_title, platform)
  await withLock(p, async () => {
    assertEpisodeFolderExists(p, episode_code)
    if (guard) await guard()
    const data = await readOverridesFile(p, { strict: true })
    const existing = data[platform] || {}
    if ('title' in patch) {
      if (patch.title === null || patch.title === '') {
        delete existing.title
      } else {
        existing.title = patch.title
      }
    }
    if ('description' in patch) {
      if (patch.description === null) {
        delete existing.description
      } else {
        existing.description = patch.description
      }
    }
    // Prune empty platform block.
    if (Object.keys(existing).length === 0) {
      delete data[platform]
    } else {
      data[platform] = existing
    }
    // Prune empty file.
    if (Object.keys(data).length === 0) {
      if (existsSync(p)) {
        try { await fsp.rm(p, { force: true }) } catch { /* non-fatal */ }
      }
      return
    }
    await writeJsonAtomic(p, data)
  })
}

/**
 * Read the title and description overrides for a platform, or null when
 * neither is set. Distinguishes "not set" from "set to empty string" so
 * the caller can tell the difference between no override and an override
 * that clears a field.
 */
export async function readTitleAndDescription(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform,
): Promise<{ title: string | null; description: string | null } | null> {
  const p = await overridesPath(slug, episode_code, fallback_title, platform)
  const data = await readOverridesFile(p)
  const block = data[platform]
  if (!block) return null
  const title = typeof block.title === 'string' ? block.title : null
  const description = typeof block.description === 'string' ? block.description : null
  if (title === null && description === null) return null
  return { title, description }
}
