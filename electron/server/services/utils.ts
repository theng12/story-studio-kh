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
function projectDirFor(slug: string): string {
  return getProjectDir(slug) || path.join(projectsRoot(), slug)
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

export async function resolveEpisodePaths(slug: string, code: string, title: string): Promise<EpisodePaths> {
  const { readFile } = await import('fs/promises')

  const projectDir = projectDirFor(slug)
  const metaRaw = await readFile(path.join(projectDir, 'project.json'), 'utf-8')
  const meta = JSON.parse(metaRaw)

  const prefix = meta.episode_prefix || 'EP'
  const seasonSize = meta.season_size || 20
  const seasonPrefix = meta.season_prefix || 'Season'
  const folderTemplate = meta.folder_template || '{season_prefix} {season_num}/{code} - {title}/'
  const subfolder = meta.subfolder_names || {}

  const epNum = episodeNumber(code, prefix)
  const seasonNum = Math.floor((epNum - 1) / seasonSize) + 1

  let outputRoot = meta.output_root || './episodes'
  if (!path.isAbsolute(outputRoot)) {
    // Relative output_root resolves against the project's actual
    // directory (linked or default) — not unconditionally against
    // PROJECTS_ROOT — so iCloud-synced projects with output_root:
    // './episodes' look in the right place.
    outputRoot = path.join(projectDir, outputRoot)
  }

  const episodeRel = folderTemplate
    .replace('{season_prefix}', seasonPrefix)
    .replace('{season_num}', seasonNum.toString().padStart(3, '0'))
    .replace('{code}', code)
    .replace('{title}', title)

  const episodeDir = path.join(outputRoot, episodeRel)

  // Level B (opt-in): when `media_root` is set, HEAVY subfolders live under a
  // separate root (typically an external SSD, off iCloud) mirroring the same
  // episodeRel; light subfolders stay under output_root. `mediaBase` falls back
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

  // Light artifacts (always under output_root / iCloud).
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
export async function resolveEpisodePathsByCode(slug: string, code: string): Promise<EpisodePaths> {
  let title = ''
  try {
    const im = await import('./idea-manager.js')
    const ideas = await im.getIdeas(slug)
    title = ideas.find(i => i.episode_code === code)?.title || ''
  } catch { /* fall back to '' — better than throwing from a path resolver */ }
  return resolveEpisodePaths(slug, code, title)
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
): Promise<EpisodePaths> {
  const paths = await resolveEpisodePathsByCode(slug, code)

  // v1.0.467 — scene_plan.json moved INTO the "03 Scene Prompts" subfolder.
  // The sidecar may sit at the episode root (legacy episodes) OR inside that
  // subfolder (post-migration / fresh). Check both when deciding which
  // same-code sibling folder actually owns the episode's data. Checking the
  // scene_prompts subfolder for any sidecar is harmless — only scene_plan.json
  // is ever passed here, and other sidecars simply won't be found there.
  const names = await resolveSubfolderNames(slug, code)
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

export async function resolveScenePlanPath(slug: string, code: string, episodeDir: string): Promise<string> {
  const names = await resolveSubfolderNames(slug, code)
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
export async function resolveSubfolderNames(slug: string, code: string): Promise<ResolvedSubfolderNames> {
  const { readFile } = await import('fs/promises')
  const { DEFAULT_SUBFOLDER_NAMES } = await import('../models/types.js')

  let subfolder: Record<string, string> = {}
  try {
    const metaRaw = await readFile(path.join(projectDirFor(slug), 'project.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
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
