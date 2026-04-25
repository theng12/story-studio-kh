/**
 * Episode folder import.
 *
 * Users often have pre-existing episode folders from other tools (e.g. a
 * manual video project) that follow our "{CODE} - {Title}" naming. We let
 * them drop that folder into a project so our pipeline can fill whatever is
 * missing (prompts, images, audio, etc.).
 *
 * Two entry points:
 *   inspectEpisodeFolder(slug, sourcePath)  → preview (no changes)
 *   importEpisodeFolder(slug, sourcePath, opts) → commit
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { formatEpisodeCode } from './utils.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

export interface InspectedAssets {
  script: boolean
  scene_prompts: boolean
  thumb_prompts: boolean
  images: boolean
  thumbnails: boolean
  audio: boolean
  merged_audio: boolean
  subtitles: boolean
  metadata: boolean
  video: boolean
}

export interface InspectResult {
  ok: boolean
  source_path: string
  parsed_code: string | null
  parsed_title: string | null
  final_code: string    // the code that would actually be assigned (auto-bumps on conflict)
  final_title: string
  conflicts: string[]   // e.g. "EP0009 already accepted — will be renamed to EP0012"
  assets: InspectedAssets
  file_counts: Partial<Record<keyof InspectedAssets, number>>
  missing_subfolders: string[]
  has_episode_info: boolean
  warnings: string[]
  error?: string
}

// Match "{CODE} - {Title}" or "{CODE}" alone. Code = 2+ letters then 2+ digits.
// Exported so the project-inference scanner can reuse the exact same regex —
// otherwise "EP0001 recognized here" and "EP0001 recognized at project import"
// could silently diverge.
export const FOLDER_PATTERN = /^([A-Z]{2,}\d{2,})(?:\s*[-—]\s*(.+))?$/

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir) } catch { return [] }
}

/**
 * Classify a subfolder by its lowercased name. Returns a key in InspectedAssets
 * or null if the folder doesn't look like one of the 9 asset buckets.
 *
 * Exported so `project-inference.ts` can reuse the same bucket → folder-name
 * mapping when reverse-engineering `subfolder_names` from a user-supplied
 * project folder. Keeping one implementation avoids drift between per-episode
 * import and whole-project import.
 */
export function classifySubfolder(name: string): keyof InspectedAssets | null {
  const clean = name.replace(/^✅\s*/, '').toLowerCase()
  if (clean.includes('script') && !clean.includes('prompt')) return 'script'
  if (clean.includes('scene prompt')) return 'scene_prompts'
  if (clean.includes('thumbnail prompt') || clean.includes('thumb prompt')) return 'thumb_prompts'
  if (clean.includes('scene image') || clean.includes('background image')) return 'images'
  if ((clean.includes('thumbnail image') || clean.includes('thumbnails')) && !clean.includes('prompt')) return 'thumbnails'
  // Merged audio — accept both the legacy "Merged Audio" wording and the
  // new 08 contract wording "Audio Merge Output".
  if (clean.includes('merged audio') || clean.includes('audio merge')) return 'merged_audio'
  // Subtitles — new bucket introduced with the 09 contract. Keyword is
  // broad on purpose so "09 Subtitles", "09 Subtitles Output", or just
  // "Subtitles" all classify correctly.
  if (clean.includes('subtitle')) return 'subtitles'
  if (clean.includes('audio')) return 'audio'
  if (clean.includes('metadata') || clean.includes('description')) return 'metadata'
  if (clean.includes('video')) return 'video'
  return null
}

const ASSET_EXT: Record<keyof InspectedAssets, RegExp> = {
  script: /\.docx$/i,
  scene_prompts: /\.(docx|json)$/i,
  thumb_prompts: /\.(docx|json)$/i,
  images: /\.(png|jpe?g|webp)$/i,
  thumbnails: /\.(png|jpe?g|webp)$/i,
  audio: /\.(mp3|wav|m4a)$/i,
  merged_audio: /\.(mp3|wav|m4a)$/i,
  subtitles: /\.(srt|vtt|ass)$/i,
  metadata: /\.(txt|json|md)$/i,
  video: /\.(mp4|mov|mkv|webm)$/i,
}

export async function inspectEpisodeFolder(slug: string, sourcePath: string): Promise<InspectResult> {
  const base: InspectResult = {
    ok: false,
    source_path: sourcePath,
    parsed_code: null, parsed_title: null,
    final_code: '', final_title: '',
    conflicts: [], assets: {
      script: false, scene_prompts: false, thumb_prompts: false,
      images: false, thumbnails: false, audio: false, merged_audio: false,
      subtitles: false, metadata: false, video: false,
    },
    file_counts: {},
    missing_subfolders: [],
    has_episode_info: false,
    warnings: [],
  }

  if (!existsSync(sourcePath)) {
    return { ...base, error: 'Source folder does not exist' }
  }
  let stat
  try { stat = await fs.stat(sourcePath) } catch (e: any) {
    return { ...base, error: e.message }
  }
  if (!stat.isDirectory()) {
    return { ...base, error: 'Source path is not a directory' }
  }

  const folderName = path.basename(sourcePath)
  const match = folderName.match(FOLDER_PATTERN)
  if (!match) {
    return {
      ...base,
      error: `Folder name '${folderName}' does not match the {CODE} - {Title} pattern (e.g. EP0009 - Your Title)`,
    }
  }
  base.parsed_code = match[1]!
  base.parsed_title = (match[2] || '').trim()

  const meta = await pm.getProject(slug)
  if (!meta) return { ...base, error: 'Project not found' }

  // Look for existing episode_info.json for richer metadata
  let title = base.parsed_title || ''
  const infoPath = path.join(sourcePath, 'episode_info.json')
  if (existsSync(infoPath)) {
    base.has_episode_info = true
    try {
      const info = JSON.parse(await fs.readFile(infoPath, 'utf-8'))
      if (info.title && typeof info.title === 'string') title = info.title
    } catch { base.warnings.push('episode_info.json is present but could not be parsed.') }
  }
  base.final_title = title

  // Decide the final code. If the parsed code conflicts with an existing accepted
  // idea, bump to the project's next available number.
  const ideas = await im.getIdeas(slug)
  const parsedCode = base.parsed_code!
  const existing = ideas.find(i => i.status === 'accepted' && i.episode_code === parsedCode)
  if (existing) {
    const nextNum = await im.getNextEpisodeNumber(slug)
    const bumped = formatEpisodeCode(nextNum, meta.episode_prefix, meta.episode_digits)
    base.final_code = bumped
    base.conflicts.push(`${parsedCode} is already accepted — will be imported as ${bumped}`)
  } else {
    base.final_code = parsedCode
  }

  // Walk immediate children to classify subfolders
  const entries = await fs.readdir(sourcePath, { withFileTypes: true })
  const seenBuckets = new Set<keyof InspectedAssets>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const bucket = classifySubfolder(entry.name)
    if (!bucket) continue
    const sub = path.join(sourcePath, entry.name)
    const files = await safeReaddir(sub)
    const matching = files.filter(f => ASSET_EXT[bucket].test(f))
    if (matching.length > 0) {
      base.assets[bucket] = true
      seenBuckets.add(bucket)
    }
    base.file_counts[bucket] = matching.length
  }

  // Which subfolders are missing vs. our 9-bucket default layout?
  const SUBFOLDER_KEYS: Array<{ key: keyof InspectedAssets; template: string }> = [
    { key: 'script', template: DEFAULT_SUBFOLDER_NAMES.script },
    { key: 'metadata', template: DEFAULT_SUBFOLDER_NAMES.metadata },
    { key: 'scene_prompts', template: DEFAULT_SUBFOLDER_NAMES.scene_prompts },
    { key: 'thumb_prompts', template: DEFAULT_SUBFOLDER_NAMES.thumb_prompts },
    { key: 'images', template: DEFAULT_SUBFOLDER_NAMES.images },
    { key: 'thumbnails', template: DEFAULT_SUBFOLDER_NAMES.thumbnails },
    { key: 'audio', template: DEFAULT_SUBFOLDER_NAMES.audio },
    { key: 'merged_audio', template: DEFAULT_SUBFOLDER_NAMES.merged_audio },
    { key: 'subtitles', template: DEFAULT_SUBFOLDER_NAMES.subtitles },
    { key: 'video', template: DEFAULT_SUBFOLDER_NAMES.video },
  ]
  for (const s of SUBFOLDER_KEYS) {
    const expected = s.template.replace('{code}', base.final_code)
    const hits = entries.filter(e => e.isDirectory() && classifySubfolder(e.name) === s.key)
    if (hits.length === 0) base.missing_subfolders.push(expected)
  }

  if (!title) base.warnings.push('No title detected. Folder uses only the code prefix.')

  base.ok = true
  return base
}

export interface ImportOptions {
  source_path: string
  // If true, copy the folder into output_root (safer — leaves original).
  // If false and the folder is already inside output_root, adopt in place.
  copy_into_project?: boolean
}

export interface ImportResult {
  episode_code: string
  title: string
  idea_id: string
  episode_dir: string
  folders_created: string[]
  wrote_episode_info: boolean
}

export async function importEpisodeFolder(slug: string, opts: ImportOptions): Promise<ImportResult> {
  const inspect = await inspectEpisodeFolder(slug, opts.source_path)
  if (!inspect.ok) throw new Error(inspect.error || 'Folder inspection failed')

  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project output directory not found')

  const finalCode = inspect.final_code
  const title = inspect.final_title || inspect.parsed_title || finalCode

  // 1. Register an accepted idea so the episode appears in selectors.
  const [storedIdea] = await im.addIdeas(slug, [{
    title,
    logline: '',
    themes: [],
    suggested_chapters: 10,
    suggested_length: '45 min',
    mood: '',
  }], 'imported')

  // Flip it straight to accepted with the resolved episode_code. We can't use
  // acceptIdea() because that function assigns its own code and creates its
  // own folders — we already have both. promoteToAccepted goes through the
  // same locked, atomic write path as every other ideas.json mutation, so
  // this no longer races with concurrent mutators or risks truncating the
  // file on SIGKILL.
  await im.promoteToAccepted(slug, storedIdea.id, { episode_code: finalCode })

  // 2. Resolve destination path inside output_root
  const sourceName = path.basename(opts.source_path)
  // If final_code differs from parsed_code, rename the folder accordingly
  const desiredFolderName = `${finalCode} - ${title}`
  const sourceIsInOutput = opts.source_path.startsWith(outputRoot)

  let episodeDir: string
  if (sourceIsInOutput && sourceName === desiredFolderName) {
    episodeDir = opts.source_path
  } else {
    const dst = path.join(outputRoot, desiredFolderName)
    if (existsSync(dst)) throw new Error(`Destination already exists: ${dst}`)
    if (opts.copy_into_project === false && sourceIsInOutput) {
      // Move/rename in place
      await fs.rename(opts.source_path, dst)
    } else {
      // Copy (safer default)
      await fs.cp(opts.source_path, dst, { recursive: true })
    }
    episodeDir = dst
  }

  // 3. Ensure the 9 subfolders exist (do not move files; just create empty ones)
  const subfolderNames = meta.subfolder_names || DEFAULT_SUBFOLDER_NAMES
  const needed = [
    subfolderNames.script, subfolderNames.metadata,
    subfolderNames.scene_prompts, subfolderNames.thumb_prompts,
    subfolderNames.images, subfolderNames.thumbnails,
    subfolderNames.audio, subfolderNames.merged_audio, subfolderNames.video,
  ].map(t => t.replace('{code}', finalCode))

  const existingSubs = new Set(
    (await fs.readdir(episodeDir)).filter(n => !n.startsWith('.')),
  )
  const foldersCreated: string[] = []
  for (const name of needed) {
    if (!existingSubs.has(name)) {
      await fs.mkdir(path.join(episodeDir, name), { recursive: true })
      foldersCreated.push(name)
    }
  }

  // 4. Write episode_info.json if missing
  let wroteEpisodeInfo = false
  const infoPath = path.join(episodeDir, 'episode_info.json')
  if (!existsSync(infoPath)) {
    const episodeInfo = {
      episode_code: finalCode,
      title,
      logline: '',
      themes: [] as string[],
      suggested_chapters: 10,
      suggested_length: '45 min',
      mood: '',
      model_used: 'imported',
      accepted_at: new Date().toISOString(),
      created_from_idea: storedIdea.id,
      project: meta.name,
      imported: true,
      imported_from: opts.source_path,
    }
    await writeJsonAtomic(infoPath, episodeInfo)
    wroteEpisodeInfo = true
  }

  return {
    episode_code: finalCode,
    title,
    idea_id: storedIdea.id,
    episode_dir: episodeDir,
    folders_created: foldersCreated,
    wrote_episode_info: wroteEpisodeInfo,
  }
}
