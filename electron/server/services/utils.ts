/**
 * Shared utilities — episode paths, credit checks, API key testing.
 */

import path from 'path'
import { existsSync } from 'fs'
import { projectsRoot, getProjectDir } from './project-manager.js'

/**
 * Resolve a project's directory regardless of whether it lives in the
 * default PROJECTS_ROOT or in a linked location (registered via
 * "Add existing project folder…"). Falls back to the default-location
 * path when the registry doesn't know the slug yet — that branch only
 * matters during fresh project creation, when the directory is about
 * to be created on disk.
 */
export function projectDirFor(slug: string, cache?: ProjectFactsCache): string {
  const scoped = usableFor(cache, slug)
  if (!scoped) return getProjectDir(slug) || path.join(projectsRoot(), slug)
  // `getProjectDir` is an `existsSync` against `<library>/<slug>`. Nothing
  // creates or removes a project directory while one response is being built,
  // and a status list asks for it ~38 times per episode.
  scoped.dir ??= getProjectDir(slug) || path.join(projectsRoot(), slug)
  return scoped.dir
}

// ── Episode path resolver ───────────────────────────────────────────────────

export function episodeNumber(code: string, prefix: string = 'EP'): number {
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`, 'i')
  const match = code.match(pattern)
  if (!match) throw new Error(`Invalid episode code: ${code} (expected prefix: ${prefix})`)
  return parseInt(match[1], 10)
}

export function formatEpisodeCode(num: number, prefix: string = 'EP', digits: number = 4): string {
  return `${prefix}${num.toString().padStart(digits, '0')}`
}

export interface EpisodePaths {
  /** ABSOLUTE — `<projectDir>/episodes`. Computed, never a stored setting. */
  output_root: string
  episode_dir: string
  script_dir: string
  scene_prompts_dir: string
  thumb_prompts_dir: string
  metadata_dir: string
  bg_dir: string
  thumb_dir: string
  audio_dir: string
  merged_audio_dir: string
  // New in the 07→08→09→10 contract; callers that predate it should
  // ignore this field rather than rely on it.
  subtitles_dir: string
  video_dir: string
  /** v1.0.469 — per-scene image-to-video clips ("11 Video Assets"). Heavy
   *  media: lives under mediaBase when media_root is set, else episode_dir. */
  video_assets_dir: string
  narration_docx: string
  scene_prompts_docx: string
  thumb_prompts_docx: string
  metadata_txt: string
  metadata_json: string
}

/**
 * One read of the project's unchanging facts, shared across a single request.
 *
 * MEASURED 2026-08-23 on a 302-episode project:
 * `/episodes` taking 7.4 s cold. The list resolves paths PER EPISODE, and each
 * resolution re-read the same two files:
 *
 *   resolveEpisodePathsByCodeWithSidecar
 *     -> resolveEpisodePathsByCode -> getIdeas()        (ideas.json, 227 KB)
 *                                  -> resolveEpisodePaths (project.json)
 *     -> resolveSubfolderNames                           (project.json again)
 *
 * and `computeEpisodeStatus` resolves again on its own. At 302 episodes that
 * is hundreds of reads and re-parses of two files that cannot change during
 * one response — roughly 68 MB of JSON parsed to answer one request.
 *
 * This holds the PROMISES, not the values, so concurrent rows share one read
 * rather than racing to start their own. It caches only the raw file contents;
 * every per-episode substitution and every folder decision still happens per
 * episode, exactly as before.
 *
 * REQUEST-SCOPED BY CONSTRUCTION. Callers create one and drop it. There is no
 * TTL to tune and no staleness window: a cache that outlives the response it
 * was made for is the bug this is careful not to be. The slug is recorded so a
 * cache accidentally reused for another project is ignored rather than wrong.
 */
export interface ProjectFactsCache {
  slug?: string
  meta?: Promise<Record<string, unknown>>
  ideas?: Promise<Array<Record<string, unknown>>>
  /**
   * The project's `config.json`, as returned by `project-manager.getConfig()`.
   *
   * A DIFFERENT file from `meta` (`project.json`) and a much more expensive
   * one: `getConfig` re-reads and re-parses config.json and then rebuilds the
   * image, audio and video model catalogues on every call. `computeEpisodeStatus`
   * called it once per episode purely to read two optional feature flags
   * (`contextual_cues`, `sound_design`), so a 302-episode list did that
   * catalogue merge 302 times — synchronous CPU that stalls the event loop and
   * makes the whole API unresponsive while a cold list is being built.
   */
  config?: Promise<unknown>
  /**
   * Every directory under the project's episodes root, in the exact order a
   * depth-first episode-folder search visits it.
   *
   * MEASURED 2026-08-28, cold `/episodes` on the 302-episode project:
   * 1,561,592 `readdir` calls, ~98% of them from two recursive searches that
   * each re-walked the whole tree ONCE PER EPISODE —
   * `asset-status.findEpisodeDir` (~53%) and
   * `generators/audio.findNarrationFile` (~44%). The tree holds ~3,050
   * directories, so every episode paid a near-full walk several times over to
   * answer a question whose answer is the same for every episode in the request.
   *
   * Walking it once per request turns each of those searches into an in-memory
   * scan. Ordered, NOT a Map: the match rule is a PREFIX test
   * (`name.startsWith(CODE)`) returning the FIRST hit in traversal order, so a
   * Map keyed on the exact code would silently pick a different folder
   * whenever two share a prefix (`EP0001` vs `EP00012`).
   */
  episodeDirs?: { root: string; index: Promise<Array<{ upper: string; path: string }>> }
  /**
   * The Library's Exports root, resolved once per request. Reading it means
   * parsing app-settings.json (570 KB on the owner's Mac, ~1.4 ms of main-thread
   * CPU); the Upload Center listing asked for it once per episode, 302 times.
   */
  externalFinalVideoRoot?: Promise<string>
  /**
   * The project's own directory, resolved once per request.
   *
   * MEASURED 2026-09-18, cold `/episodes` on the 302-episode project: 11,357
   * `existsSync` calls against `<library>/capi` — `getProjectDir` reached
   * through `projectDirFor`, `ideasPath` and `applyAutoHeal`. It is a pure
   * `existsSync` on a path that cannot move while one response is being built.
   */
  dir?: string
  /**
   * `<projectDir>/episodes`, resolved once per request. Same measurement, 907
   * `existsSync` calls: `getProjectOutputRoot` is asked once per episode and
   * only ever answers `resolveOutputRoot(projectDir)`.
   */
  outputRoot?: Promise<string | null>
  /**
   * The project's YouTube publishing state (`youtube/project-state.json`),
   * parsed once per request. 604 reads in the measurement above — twice per
   * episode, once from `readYouTubeRetentionStores` and once from the
   * publication-status reader.
   *
   * Typed loosely on purpose: the owning module is
   * `youtube-project-publishing-store.ts`, and importing its concrete type
   * here would pull the whole YouTube store into every path resolver.
   */
  publishingState?: Promise<unknown>
  /**
   * Every YouTube operation record for the project, read once per request.
   *
   * The single largest redundancy in a cold `/episodes`: the store holds 34
   * records on the owner's Mac, and `listYouTubeOperations` re-read, re-parsed
   * and re-validated all 34 for EVERY episode — 10,180 `readFile` calls to
   * answer a question whose answer is identical for all 302 rows.
   */
  youtubeOperations?: Promise<unknown>
  /**
   * The `{ records, state }` pair `readYouTubeRetentionStores` builds, resolved
   * once per request. Both halves are individually memoized above; this saves
   * the three `existsSync` probes (project dir, `youtube/operations`,
   * `youtube/project-state.json`) that wrapped them, which the status sweep
   * paid once per episode.
   */
  youtubeRetentionStores?: Promise<unknown>
}

export function createProjectFactsCache(slug?: string): ProjectFactsCache {
  return slug ? { slug } : {}
}

function usableFor(cache: ProjectFactsCache | undefined, slug: string): ProjectFactsCache | undefined {
  if (!cache) return undefined
  if (cache.slug === undefined) { cache.slug = slug; return cache }
  return cache.slug === slug ? cache : undefined
}

/**
 * The request-scoped facts cache, but only when it belongs to `slug`.
 *
 * Exported so the modules that own a memoized value (`youtube-operation-store`,
 * `youtube-project-publishing-store`) apply the same two guarantees this file
 * does: a cache accidentally reused for a different project is ignored rather
 * than wrong, and `undefined` means "read disk exactly as before".
 */
export function projectFactsFor(cache: ProjectFactsCache | undefined, slug: string): ProjectFactsCache | undefined {
  return usableFor(cache, slug)
}

/** The parsed `project.json`, read at most once per cache. */
export async function projectMetaOnce(slug: string, cache?: ProjectFactsCache): Promise<any> {
  return projectMeta(slug, cache)
}

/**
 * `<projectDir>/episodes`, resolved at most once per cache.
 *
 * Byte-for-byte `getProjectOutputRoot` without a cache; the only thing this
 * adds is not asking the same question 302 times. It returns `null` for the
 * same reason `getProjectOutputRoot` does — an absent project directory — so
 * callers keep their existing 404 / empty-status handling unchanged.
 */
export async function projectOutputRootOnce(slug: string, cache?: ProjectFactsCache): Promise<string | null> {
  const scoped = usableFor(cache, slug)
  const read = async (): Promise<string | null> => {
    const pm = await import('./project-manager.js')
    return pm.getProjectOutputRoot(slug)
  }
  if (!scoped) return read()
  scoped.outputRoot ??= read()
  try {
    return await scoped.outputRoot
  } catch (error) {
    // A failed read must not be remembered as the answer for the rest of the
    // request: drop it so the next caller genuinely retries.
    scoped.outputRoot = undefined
    throw error
  }
}

async function projectMeta(slug: string, cache?: ProjectFactsCache): Promise<any> {
  const scoped = usableFor(cache, slug)
  const read = async (): Promise<Record<string, unknown>> => {
    const { readFile } = await import('fs/promises')
    return JSON.parse(await readFile(path.join(projectDirFor(slug, cache), 'project.json'), 'utf-8'))
  }
  if (!scoped) return read()
  scoped.meta ??= read()
  try {
    return await scoped.meta
  } catch (error) {
    // A failed read must not be remembered as the answer for the rest of the
    // request: drop it so the next caller genuinely retries.
    scoped.meta = undefined
    throw error
  }
}

/**
 * The project's `config.json` (via `getConfig`), resolved at most once per cache.
 *
 * Exported because the callers that need it live in `asset-status.ts`, not here.
 * Without a cache this behaves exactly like calling `getConfig` directly.
 */
export async function projectConfigOnce(slug: string, cache?: ProjectFactsCache): Promise<any> {
  const scoped = usableFor(cache, slug)
  const read = async (): Promise<unknown> => {
    const pm = await import('./project-manager.js')
    return pm.getConfig(slug)
  }
  if (!scoped) return read()
  scoped.config ??= read()
  try {
    return await scoped.config
  } catch (error) {
    scoped.config = undefined
    throw error
  }
}

/** Every idea for the project, read and parsed at most once per cache. */
async function projectIdeas(slug: string, cache?: ProjectFactsCache): Promise<any[]> {
  const scoped = usableFor(cache, slug)
  const read = async (): Promise<Array<Record<string, unknown>>> => {
    const im = await import('./idea-manager.js')
    // The cache reaches idea-manager too: without it, this one call re-read
    // and re-parsed ideas.json (227 KB on a 302-episode project) AND
    // project.json through `applyAutoHeal`, once per episode.
    return await im.getIdeas(slug, undefined, cache) as unknown as Array<Record<string, unknown>>
  }
  if (!scoped) return read()
  scoped.ideas ??= read()
  try {
    return await scoped.ideas
  } catch (error) {
    scoped.ideas = undefined
    throw error
  }
}

export async function resolveEpisodePaths(
  slug: string,
  code: string,
  title: string,
  cache?: ProjectFactsCache,
): Promise<EpisodePaths> {
  const projectDir = projectDirFor(slug, cache)
  const meta = await projectMeta(slug, cache)

  const prefix = meta.episode_prefix || 'EP'
  const seasonSize = meta.season_size || 20
  const seasonPrefix = meta.season_prefix || 'Season'
  const folderTemplate = meta.folder_template || '{season_prefix} {season_num}/{code} - {title}/'
  const subfolder = meta.subfolder_names || {}

  const epNum = episodeNumber(code, prefix)
  const seasonNum = Math.floor((epNum - 1) / seasonSize) + 1

  // Episodes always live in the channel's own folder. Resolved against the
  // project's ACTUAL directory (wherever the Library sits) rather than
  // unconditionally against PROJECTS_ROOT, so an iCloud-synced project looks
  // in the right place. Kept in step with `resolveOutputRoot()` in
  // project-manager.ts — see there for why the folder is no longer a choice.
  const outputRoot = path.join(projectDir, 'episodes')

  const episodeRel = folderTemplate
    .replace('{season_prefix}', seasonPrefix)
    .replace('{season_num}', seasonNum.toString().padStart(3, '0'))
    .replace('{code}', code)
    .replace('{title}', title)

  const episodeDir = path.join(outputRoot, episodeRel)

  // ── CONTAINMENT ─────────────────────────────────────────────────────────
  //
  // `{code}` and `{title}` are substituted RAW into the folder template, and
  // both arrive straight from HTTP — a `:code` path segment (Express decodes
  // `%2F` and `%2e%2e` into `req.params`), a `?title=` query, or an idea title
  // in a request body. `path.join` normalises `..` away, so a title of
  // `../../../../tmp/pwn` resolved to a directory outside the Library and every
  // caller then wrote, renamed or RECURSIVELY DELETED there. The routes that
  // reach this function include several `fs.rm(dir, { recursive: true })`
  // calls, so the blast radius was the owner's whole machine.
  //
  // This is asserted here, at the one resolver ~40 callers share, rather than at
  // each route: a per-route guard is the arrangement that let this class exist
  // in the first place. A folder name cannot contain a path separator on any
  // platform this app ships for, so refusing one rejects nothing legitimate.
  const assertSafeSegment = (value: string, field: string): void => {
    const raw = String(value ?? '')
    if (/[/\\\u0000]/.test(raw) || raw === '..' || raw === '.') {
      throw new Error(
        `Refusing an episode ${field} that would resolve outside the episodes folder. ` +
        `A folder name cannot contain a path separator.`,
      )
    }
  }
  assertSafeSegment(code, 'code')
  assertSafeSegment(title, 'title')

  const containedRoot = path.resolve(outputRoot)
  const containedDir = path.resolve(episodeDir)
  if (containedDir !== containedRoot && !containedDir.startsWith(containedRoot + path.sep)) {
    throw new Error(
      `Refusing to resolve an episode folder outside the episodes root. ` +
      `Check the project's folder template in project.json.`,
    )
  }

  // Level B (opt-in): when `media_root` is set, HEAVY subfolders live under a
  // separate root (typically an external SSD, off iCloud) mirroring the same
  // episodeRel; light subfolders stay under the episodes folder. `mediaBase` falls back
  // to `episodeDir` when media_root is absent or unresolvable here, so the
  // default path is byte-for-byte unchanged. See services/media-root.ts.
  const { resolveMediaBase } = await import('./media-root.js')
  const mediaBase = resolveMediaBase(meta.media_root, episodeRel, outputRoot) ?? episodeDir

  const { DEFAULT_SUBFOLDER_NAMES } = await import('../models/types.js')
  const d = DEFAULT_SUBFOLDER_NAMES
  const scriptName = (subfolder.script || d.script).replace('{code}', code)
  const scenePromptsName = (subfolder.scene_prompts || d.scene_prompts).replace('{code}', code)
  const thumbPromptsName = (subfolder.thumb_prompts || d.thumb_prompts).replace('{code}', code)
  const metadataName = (subfolder.metadata || d.metadata).replace('{code}', code)
  const imagesName = (subfolder.images || d.images).replace('{code}', code)
  const thumbsName = (subfolder.thumbnails || d.thumbnails).replace('{code}', code)
  const audioName = (subfolder.audio || d.audio).replace('{code}', code)
  const mergedAudioName = (subfolder.merged_audio || d.merged_audio).replace('{code}', code)
  const subtitlesName = (subfolder.subtitles || d.subtitles).replace('{code}', code)
  const videoName = (subfolder.video || d.video).replace('{code}', code)
  const videoAssetsName = (subfolder.video_assets || d.video_assets).replace('{code}', code)

  // Light artifacts (always under the episodes folder / iCloud).
  const scriptDir = path.join(episodeDir, scriptName)
  const scenePromptsDir = path.join(episodeDir, scenePromptsName)
  const thumbPromptsDir = path.join(episodeDir, thumbPromptsName)
  const metadataDir = path.join(episodeDir, metadataName)
  const subtitlesDir = path.join(episodeDir, subtitlesName)
  // Heavy media (under mediaBase when media_root is set; == episodeDir otherwise).
  const bgDir = path.join(mediaBase, imagesName)
  const thumbDir = path.join(mediaBase, thumbsName)
  const audioDir = path.join(mediaBase, audioName)
  const mergedAudioDir = path.join(mediaBase, mergedAudioName)
  const videoDir = path.join(mediaBase, videoName)
  const videoAssetsDir = path.join(mediaBase, videoAssetsName)

  // Subfolder names come from `project.json` (`subfolder_names`), are written by
  // `PUT /settings/subfolder-config`, and are joined here with no check. That
  // route only asserted each value CONTAINS `{code}`, so
  // `{"subfolder_names":{"video":"../../../../tmp/escape/{code}"}}` was
  // persisted and every later resolution for that project — including the
  // generators' mkdir and several recursive removes — pointed outside the
  // Library. Containing the episode dir alone does not catch this: these escape
  // from INSIDE it. Anything that is not a plain child of its own root is
  // refused rather than silently relocated.
  const assertChildDir = (dir: string, root: string, field: string): void => {
    const resolvedRoot = path.resolve(root)
    const resolvedDir = path.resolve(dir)
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
      throw new Error(
        `Refusing a ${field} folder name that resolves outside the episode folder. ` +
        `Check this project's subfolder names in project settings.`,
      )
    }
  }
  assertChildDir(scriptDir, episodeDir, 'script')
  assertChildDir(scenePromptsDir, episodeDir, 'scene prompts')
  assertChildDir(thumbPromptsDir, episodeDir, 'thumbnail prompts')
  assertChildDir(metadataDir, episodeDir, 'metadata')
  assertChildDir(subtitlesDir, episodeDir, 'subtitles')
  assertChildDir(bgDir, mediaBase, 'scene images')
  assertChildDir(thumbDir, mediaBase, 'thumbnails')
  assertChildDir(audioDir, mediaBase, 'audio')
  assertChildDir(mergedAudioDir, mediaBase, 'merged audio')
  assertChildDir(videoDir, mediaBase, 'video')
  assertChildDir(videoAssetsDir, mediaBase, 'video assets')

  return {
    output_root: outputRoot,
    episode_dir: episodeDir,
    script_dir: scriptDir,
    scene_prompts_dir: scenePromptsDir,
    thumb_prompts_dir: thumbPromptsDir,
    metadata_dir: metadataDir,
    bg_dir: bgDir,
    thumb_dir: thumbDir,
    audio_dir: audioDir,
    merged_audio_dir: mergedAudioDir,
    subtitles_dir: subtitlesDir,
    video_dir: videoDir,
    video_assets_dir: videoAssetsDir,
    // v1.0.228 — artifacts are now Markdown (.md). The `*_docx` KEY names are
    // kept (referenced widely) but the values point at .md. Readers of these
    // constants must go through resolveReadPath()/readArtifactRawText() in
    // lib/episode-artifacts.ts so legacy `.docx`-only episodes still resolve.
    narration_docx: path.join(scriptDir, `${code}_Script_Narration.md`),
    scene_prompts_docx: path.join(scenePromptsDir, `${code}_Scene_Prompts.md`),
    thumb_prompts_docx: path.join(thumbPromptsDir, `${code}_Thumbnail_Prompts.md`),
    metadata_txt: path.join(metadataDir, `${code}_Metadata.txt`),
    metadata_json: path.join(metadataDir, `${code}_Metadata.json`),
  }
}

/**
 * Resolve an episode's paths from the CODE alone, looking up the canonical
 * title from the idea store.
 *
 * v1.0.188 bug fix: the folder template is `{code} - {title}`, so a caller
 * that only knows the code MUST pass the episode's real title or it resolves
 * to a phantom `{code} - ` folder and silently misses every sidecar
 * (research.json, scene_plan.json, audio_chapters.json, the stitched SRT…).
 * Several routes + jobs in the research / scene-plan / scene-review pipeline
 * were passing '' (or, for research, the topic), so saved files landed in the
 * real folder while reads looked in the empty one — research "saved" but never
 * surfaced. This helper does the idea lookup once, the same way the episode
 * folder was created (episode.ts resolves with idea.title), so reads + writes
 * always agree. Falls back to '' (legacy behaviour) if the idea isn't found —
 * never throws, since it's a path resolver.
 *
 * Uses a dynamic import of idea-manager to avoid a static import cycle
 * (idea-manager imports this module), matching resolveEpisodePaths's own
 * dynamic-import style.
 */
/**
 * The episode's own title, from the same idea record that named its folder.
 *
 * Exists because a caller with no title must not fall back to the episode code:
 * thumbnail prompts render the resolved title as display text inside the image,
 * so the fallback printed "EP0344" across five thumbnails. Returns '' when the
 * idea genuinely has no title, so the caller can refuse rather than invent one.
 */
export async function resolveEpisodeTitleByCode(
  slug: string,
  code: string,
  cache?: ProjectFactsCache,
): Promise<string> {
  try {
    const ideas = await projectIdeas(slug, cache)
    return String(ideas.find(idea => idea.episode_code === code)?.title || '').trim()
  } catch {
    return ''
  }
}

export async function resolveEpisodePathsByCode(
  slug: string,
  code: string,
  cache?: ProjectFactsCache,
): Promise<EpisodePaths> {
  let title = ''
  try {
    const ideas = await projectIdeas(slug, cache)
    title = String(ideas.find(i => i.episode_code === code)?.title || '')
  } catch { /* fall back to '' — better than throwing from a path resolver */ }
  return resolveEpisodePaths(slug, code, title, cache)
}

/**
 * Path resolver for READ routes that accept an optional `?title=`.
 *
 * An episode's folder name embeds its title (`{code} - {title}`), so a
 * caller that omits the title resolves to `.../DK0061 - /` — a directory
 * that does not exist. Every reader built on that path then finds no
 * artifacts and answers "nothing here", which is indistinguishable from
 * an episode that genuinely has none. That is not hypothetical: the
 * Introduction page (v1.4.73+) tracks only an episode CODE, so its
 * preview asked for script-content without a title and reported "No
 * introduction generated yet" over three finished introductions.
 *
 * The write side already refuses to trust a caller-supplied title — see
 * the comment on `/generate/introduction-only` in routes/scripts.ts,
 * "The title is still resolved here rather than asked for, because the
 * app already knows an accepted episode's title". Readers now agree:
 * when the titled folder is not on disk, fall back to the title the
 * idea index holds for that code.
 *
 * A correct `?title=` is unaffected — the titled folder exists, so it is
 * returned before the fallback is even considered. When neither folder
 * exists the titled path is returned unchanged, so a genuinely absent
 * episode still reads as absent.
 */
export async function resolveEpisodePathsForRead(
  slug: string,
  code: string,
  title: string,
  cache?: ProjectFactsCache,
): Promise<EpisodePaths> {
  const titled = await resolveEpisodePaths(slug, code, title, cache)
  if (existsSync(titled.episode_dir)) return titled

  // 1. The title the idea index holds for this code.
  const byCode = await resolveEpisodePathsByCode(slug, code, cache)
  if (existsSync(byCode.episode_dir)) return byCode

  // 2. The folder on disk that starts with this code, whatever it is now
  //    called. Covers an episode renamed on disk after its idea was
  //    written — the same recovery `getMetadataDir` already performs.
  const { resolveEpisodeDir } = await import('../lib/folder-resolver.js')
  const found = await resolveEpisodeDir(path.dirname(titled.episode_dir.replace(/[/\\]$/, '')), code)
  return found ? rebaseEpisodePaths(titled, found) : titled
}

function rebaseEpisodePaths(paths: EpisodePaths, episodeDir: string): EpisodePaths {
  const from = path.resolve(paths.episode_dir)
  const to = path.resolve(episodeDir)
  const rebase = (p: string) => {
    const rel = path.relative(from, path.resolve(p))
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      ? path.join(to, rel)
      : p
  }

  return {
    ...paths,
    episode_dir: to,
    script_dir: rebase(paths.script_dir),
    scene_prompts_dir: rebase(paths.scene_prompts_dir),
    thumb_prompts_dir: rebase(paths.thumb_prompts_dir),
    metadata_dir: rebase(paths.metadata_dir),
    bg_dir: rebase(paths.bg_dir),
    thumb_dir: rebase(paths.thumb_dir),
    audio_dir: rebase(paths.audio_dir),
    merged_audio_dir: rebase(paths.merged_audio_dir),
    subtitles_dir: rebase(paths.subtitles_dir),
    video_dir: rebase(paths.video_dir),
    video_assets_dir: rebase(paths.video_assets_dir),
    narration_docx: rebase(paths.narration_docx),
    scene_prompts_docx: rebase(paths.scene_prompts_docx),
    thumb_prompts_docx: rebase(paths.thumb_prompts_docx),
    metadata_txt: rebase(paths.metadata_txt),
    metadata_json: rebase(paths.metadata_json),
  }
}

/**
 * Resolve by episode code, but when the caller is trying to read or update an
 * existing sidecar, prefer the sibling episode-code folder that actually has
 * that file. This protects Scene Plan / Scene Review from duplicate or renamed
 * episode folders such as:
 *
 *   EP0011 - Old Title/
 *   EP0011 - Current Title/scene_plan.json
 *
 * The normal resolver still owns new writes. This helper only intervenes when
 * the canonical path is missing the sidecar and a same-code sibling has it.
 */
export async function resolveEpisodePathsByCodeWithSidecar(
  slug: string,
  code: string,
  sidecarFilename: string,
  cache?: ProjectFactsCache,
): Promise<EpisodePaths> {
  const paths = await resolveEpisodePathsByCode(slug, code, cache)

  // v1.0.467 — scene_plan.json moved INTO the "03 Scene Prompts" subfolder.
  // The sidecar may sit at the episode root (legacy episodes) OR inside that
  // subfolder (post-migration / fresh). Check both when deciding which
  // same-code sibling folder actually owns the episode's data. Checking the
  // scene_prompts subfolder for any sidecar is harmless — only scene_plan.json
  // is ever passed here, and other sidecars simply won't be found there.
  const names = await resolveSubfolderNames(slug, code, cache)
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  const hasSidecar = async (dir: string): Promise<boolean> => {
    if (existsSync(path.join(dir, sidecarFilename))) return true
    const sp = await findSubfolder(dir, names.scene_prompts)
    return !!sp && existsSync(path.join(sp, sidecarFilename))
  }

  if (await hasSidecar(paths.episode_dir)) return paths

  const seasonDir = path.dirname(path.resolve(paths.episode_dir))
  let entries: import('fs').Dirent[]
  try {
    const fs = await import('fs/promises')
    entries = await fs.readdir(seasonDir, { withFileTypes: true })
  } catch {
    return paths
  }

  const wanted = code.toLowerCase()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name.toLowerCase()
    if (name !== wanted && !name.startsWith(`${wanted} - `)) continue
    const candidateDir = path.join(seasonDir, entry.name)
    if (path.resolve(candidateDir) === path.resolve(paths.episode_dir)) continue
    if (await hasSidecar(candidateDir)) {
      return rebaseEpisodePaths(paths, candidateDir)
    }
  }

  return paths
}

/**
 * v1.0.467 — canonical location of an episode's `scene_plan.json`.
 *
 * The scene plan carries every scene's `visual_prompt`, so it now lives inside
 * the "03 Scene Prompts" folder alongside the human-readable prompts doc — the
 * whole prompt pipeline in one place. Episodes created before this change keep
 * the file at the episode root; this resolver returns whichever location
 * actually holds it, falling back to the new location for fresh writes. The
 * Resolution order (same path for reads AND writes, so in-place edits like
 * approve / regenerate-prompt never split state across the two locations):
 *   1. <scene_prompts_dir>/scene_plan.json exists → use it (new, preferred)
 *   2. <episode_dir>/scene_plan.json     exists → use it (legacy, in place)
 *   3. neither (fresh plan)                       → new location
 *
 * Mirrors resolveSceneImagesDir's "✅ "-prefix-tolerant findSubfolder lookup.
 * Callers that WRITE must `mkdir(path.dirname(result))` first (the folder may
 * not exist yet when Scene Plan runs before Image Prompts).
 */
export const SCENE_PLAN_SIDECAR = 'scene_plan.json'

export async function resolveScenePlanPath(
  slug: string,
  code: string,
  episodeDir: string,
  cache?: ProjectFactsCache,
): Promise<string> {
  const names = await resolveSubfolderNames(slug, code, cache)
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  const scenePromptsDir =
    (await findSubfolder(episodeDir, names.scene_prompts)) || path.join(episodeDir, names.scene_prompts)
  const newPath = path.join(scenePromptsDir, SCENE_PLAN_SIDECAR)
  if (existsSync(newPath)) return newPath
  const legacyPath = path.join(episodeDir, SCENE_PLAN_SIDECAR)
  if (existsSync(legacyPath)) return legacyPath
  return newPath
}

// ── Resolve subfolder names from project config ────────────────────────────

export interface ResolvedSubfolderNames {
  script: string
  metadata: string
  scene_prompts: string
  thumb_prompts: string
  images: string
  thumbnails: string
  audio: string
  merged_audio: string
  subtitles: string
  video: string
  video_assets: string
}

/**
 * Resolve the actual subfolder names for a given project + episode code.
 * Reads from project config; falls back to defaults.
 * Returns names with {code} already replaced.
 */
export async function resolveSubfolderNames(
  slug: string,
  code: string,
  cache?: ProjectFactsCache,
): Promise<ResolvedSubfolderNames> {
  const { DEFAULT_SUBFOLDER_NAMES } = await import('../models/types.js')

  let subfolder: Record<string, string> = {}
  try {
    const meta = await projectMeta(slug, cache)
    subfolder = meta.subfolder_names || {}
  } catch { /* use defaults */ }

  const d = DEFAULT_SUBFOLDER_NAMES
  return {
    script:        (subfolder.script || d.script).replace('{code}', code),
    metadata:      (subfolder.metadata || d.metadata).replace('{code}', code),
    scene_prompts: (subfolder.scene_prompts || d.scene_prompts).replace('{code}', code),
    thumb_prompts: (subfolder.thumb_prompts || d.thumb_prompts).replace('{code}', code),
    images:        (subfolder.images || d.images).replace('{code}', code),
    thumbnails:    (subfolder.thumbnails || d.thumbnails).replace('{code}', code),
    audio:         (subfolder.audio || d.audio).replace('{code}', code),
    merged_audio:  (subfolder.merged_audio || d.merged_audio).replace('{code}', code),
    subtitles:     (subfolder.subtitles || d.subtitles).replace('{code}', code),
    video:         (subfolder.video || d.video).replace('{code}', code),
    video_assets:  (subfolder.video_assets || d.video_assets).replace('{code}', code),
  }
}
