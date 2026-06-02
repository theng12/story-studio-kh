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

/**
 * One file the inspector found in a classified subfolder, with the
 * canonical destination it would land at if `auto_rename_assets` is on.
 *
 * `dest_relative` is relative to the imported episode dir (NOT the source).
 * `bucket` says which canonical asset folder it maps into.
 */
export interface DiscoveredFile {
  source_relative: string         // e.g. "MyOldAudio/1.mp3" (relative to source_path)
  dest_relative: string           // e.g. "EP0001 - 07 Audio Assets/EP0001_Chapter_01.mp3"
  bucket: keyof InspectedAssets
}

export interface InspectResult {
  ok: boolean
  source_path: string
  parsed_code: string | null
  parsed_title: string | null
  final_code: string    // the code that would actually be assigned (auto-bumps on conflict)
  final_title: string
  /**
   * Whether the parsed_code is already in use by an accepted idea. When
   * true, the UI hides the "keep original" choice — the only sane path
   * is to bump. When false, the UI shows both options so the user can
   * choose between "TN0002 (original)" and "TN0007 (next available)".
   */
  parsed_code_taken: boolean
  /**
   * The code we'd assign if the user opts to bump rather than reuse the
   * parsed one. Always populated (even when parsed_code is free) so the
   * UI can offer it as a one-click alternative without a second
   * round-trip. Equals final_code when parsed_code_taken is true.
   */
  next_available_code: string
  conflicts: string[]   // e.g. "EP0009 already accepted — will be renamed to EP0012"
  assets: InspectedAssets
  file_counts: Partial<Record<keyof InspectedAssets, number>>
  missing_subfolders: string[]
  has_episode_info: boolean
  warnings: string[]
  /**
   * Per-file rename plan. Populated whenever the source has at least one
   * classifiable file. The Ideas-page import dialog renders this in a
   * preview so the user sees exactly what will move where; passing
   * `auto_rename_assets: true` to importEpisodeFolder applies these
   * exact destinations.
   */
  discovered_files: DiscoveredFile[]
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
  script: /\.(docx|md)$/i,
  scene_prompts: /\.(docx|md|json)$/i,
  thumb_prompts: /\.(docx|md|json)$/i,
  images: /\.(png|jpe?g|webp)$/i,
  thumbnails: /\.(png|jpe?g|webp)$/i,
  audio: /\.(mp3|wav|m4a)$/i,
  merged_audio: /\.(mp3|wav|m4a)$/i,
  subtitles: /\.(srt|vtt|ass)$/i,
  metadata: /\.(txt|json|md)$/i,
  video: /\.(mp4|mov|mkv|webm)$/i,
}

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n) }

/**
 * Sort files in a way that respects natural numeric order embedded in the
 * filename — `2.mp3` comes before `10.mp3`, `Scene01` before `Scene10`,
 * etc. Used so auto-numbering follows what a user would expect from
 * looking at their source folder.
 */
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Turn a list of source-relative file paths in one classified bucket into
 * canonical destinations. The mapping per bucket:
 *   - audio:        → {audio_dir}/{code}_Chapter_NN.mp3 (numbered by sort
 *                    order; intro detection stays out of scope here — the
 *                    Pipeline kebab importer handles that case interactively)
 *   - merged_audio: → {merged_audio_dir}/{code}_merged_audio.mp3 (single
 *                    file; if multiple, only first is auto-mapped, rest go
 *                    to other-files leftover bucket)
 *   - images:       → {bg_dir}/{code}_SceneNN_v1.{ext}
 *   - thumbnails:   → {thumb_dir}/{code}_ThumbNN_v1.{ext}
 *   - video:        → {video_dir}/{code}_VideoNN_v1.{ext}
 *   - script:       → {script_dir}/{originalFilename}  (preserve; user runs
 *                    the Normalize dialog later if format needs fixing)
 *   - scene_prompts / thumb_prompts / metadata / subtitles → preserve
 *                    filename, just route into the canonical subfolder
 *
 * `subfolderName` is the canonical subfolder name template already filled
 * with the episode code (e.g. "EP0001 - 07 Audio Assets").
 */
function planDestinations(
  bucket: keyof InspectedAssets,
  subfolderName: string,
  code: string,
  files: Array<{ source_relative: string; basename: string; ext: string }>,
): DiscoveredFile[] {
  // Stable, deterministic order so auto-numbering is reproducible.
  files.sort((a, b) => naturalSort(a.basename, b.basename))

  const out: DiscoveredFile[] = []
  switch (bucket) {
    case 'audio': {
      // Sequential Chapter_NN by sort order. Users can re-map via the
      // Pipeline kebab → Import existing assets dialog if order is wrong.
      files.forEach((f, i) => {
        const slug = `Chapter_${pad2(i + 1)}`
        out.push({
          source_relative: f.source_relative,
          dest_relative: path.join(subfolderName, `${code}_${slug}.mp3`),
          bucket,
        })
      })
      return out
    }
    case 'merged_audio': {
      // Canonical name is fixed; only the first audio file in this bucket
      // gets it. Extra files (rare) get suffixed _v2/_v3 so nothing's lost.
      files.forEach((f, i) => {
        const name = i === 0
          ? `${code}_merged_audio.mp3`
          : `${code}_merged_audio_v${i + 1}.mp3`
        out.push({
          source_relative: f.source_relative,
          dest_relative: path.join(subfolderName, name),
          bucket,
        })
      })
      return out
    }
    case 'images': {
      files.forEach((f, i) => {
        out.push({
          source_relative: f.source_relative,
          dest_relative: path.join(subfolderName, `${code}_Scene${pad2(i + 1)}_v1${f.ext}`),
          bucket,
        })
      })
      return out
    }
    case 'thumbnails': {
      files.forEach((f, i) => {
        out.push({
          source_relative: f.source_relative,
          dest_relative: path.join(subfolderName, `${code}_Thumb${pad2(i + 1)}_v1${f.ext}`),
          bucket,
        })
      })
      return out
    }
    case 'video': {
      // Differentiate per-scene clips from the assembled final video.
      // Heuristic: if there's exactly ONE video file in this bucket, it's
      // most likely the final assembly — name it accordingly. Multiple
      // files → per-scene clips.
      if (files.length === 1) {
        const f = files[0]
        out.push({
          source_relative: f.source_relative,
          dest_relative: path.join(subfolderName, `${code}_final_video${f.ext}`),
          bucket,
        })
      } else {
        files.forEach((f, i) => {
          out.push({
            source_relative: f.source_relative,
            dest_relative: path.join(subfolderName, `${code}_Video${pad2(i + 1)}_v1${f.ext}`),
            bucket,
          })
        })
      }
      return out
    }
    case 'script':
    case 'scene_prompts':
    case 'thumb_prompts':
    case 'metadata':
    case 'subtitles': {
      // Preserve the original filename — these formats are heterogeneous
      // (script docx may need normalising, prompts docx is already in our
      // format, metadata txt/json/md varies). Route into the canonical
      // subfolder so the next pipeline step finds it.
      files.forEach(f => {
        out.push({
          source_relative: f.source_relative,
          dest_relative: path.join(subfolderName, f.basename),
          bucket,
        })
      })
      return out
    }
  }
}

export async function inspectEpisodeFolder(slug: string, sourcePath: string): Promise<InspectResult> {
  const base: InspectResult = {
    ok: false,
    source_path: sourcePath,
    parsed_code: null, parsed_title: null,
    final_code: '', final_title: '',
    parsed_code_taken: false,
    next_available_code: '',
    conflicts: [], assets: {
      script: false, scene_prompts: false, thumb_prompts: false,
      images: false, thumbnails: false, audio: false, merged_audio: false,
      subtitles: false, metadata: false, video: false,
    },
    file_counts: {},
    missing_subfolders: [],
    has_episode_info: false,
    warnings: [],
    discovered_files: [],
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

  // Decide the final code. We always compute BOTH:
  //   - parsed_code (from the source folder name)
  //   - next_available_code (the project's next sequential code)
  // …so the UI can let the user choose. If the parsed code conflicts
  // with an existing accepted idea, the choice is forced to next.
  const ideas = await im.getIdeas(slug)
  const parsedCode = base.parsed_code!
  const existing = ideas.find(i => i.status === 'accepted' && i.episode_code === parsedCode)
  const nextNum = await im.getNextEpisodeNumber(slug)
  const bumped = formatEpisodeCode(nextNum, meta.episode_prefix, meta.episode_digits)
  base.next_available_code = bumped
  base.parsed_code_taken = !!existing
  if (existing) {
    base.final_code = bumped
    base.conflicts.push(`${parsedCode} is already accepted — will be imported as ${bumped}`)
  } else {
    // Default to the parsed code when it's free; the import route can
    // still override via override_code if the user picked "next" in the
    // dialog. Keeps the inspector preview honest about the no-override
    // outcome.
    base.final_code = parsedCode
  }

  // Walk immediate children to classify subfolders + discover files
  const entries = await fs.readdir(sourcePath, { withFileTypes: true })
  const seenBuckets = new Set<keyof InspectedAssets>()
  // Collect files per bucket BEFORE planning destinations — we need the
  // full set so the auto-numbering is contiguous (a bucket split across
  // two oddly-named source subfolders still produces Scene01..SceneNN
  // not Scene01,02 + Scene01,02 again).
  const filesPerBucket = new Map<keyof InspectedAssets, Array<{ source_relative: string; basename: string; ext: string }>>()
  const subfolderTemplates: Record<keyof InspectedAssets, string> = {
    script:        DEFAULT_SUBFOLDER_NAMES.script,
    metadata:      DEFAULT_SUBFOLDER_NAMES.metadata,
    scene_prompts: DEFAULT_SUBFOLDER_NAMES.scene_prompts,
    thumb_prompts: DEFAULT_SUBFOLDER_NAMES.thumb_prompts,
    images:        DEFAULT_SUBFOLDER_NAMES.images,
    thumbnails:    DEFAULT_SUBFOLDER_NAMES.thumbnails,
    audio:         DEFAULT_SUBFOLDER_NAMES.audio,
    merged_audio:  DEFAULT_SUBFOLDER_NAMES.merged_audio,
    subtitles:     DEFAULT_SUBFOLDER_NAMES.subtitles,
    video:         DEFAULT_SUBFOLDER_NAMES.video,
  }
  // Project-level overrides take precedence over the defaults so
  // user-customised subfolder names round-trip correctly.
  const subfolderOverrides = (meta as any).subfolder_names || {}
  for (const k of Object.keys(subfolderTemplates) as Array<keyof InspectedAssets>) {
    if (typeof subfolderOverrides[k] === 'string') subfolderTemplates[k] = subfolderOverrides[k]
  }

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
      const list = filesPerBucket.get(bucket) || []
      for (const f of matching) {
        list.push({
          source_relative: path.join(entry.name, f),
          basename: f,
          ext: path.extname(f).toLowerCase(),
        })
      }
      filesPerBucket.set(bucket, list)
    }
    base.file_counts[bucket] = (base.file_counts[bucket] || 0) + matching.length
  }

  // Build the canonical-rename plan once we know every file in every
  // bucket. The plan is what the import operation applies when the
  // user opts in to auto-renaming.
  for (const [bucket, files] of filesPerBucket.entries()) {
    const subfolderName = subfolderTemplates[bucket].replace('{code}', base.final_code)
    const planned = planDestinations(bucket, subfolderName, base.final_code, files)
    base.discovered_files.push(...planned)
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
  /**
   * Optional explicit episode code override. When set, this code is used
   * instead of the inspector's `final_code`. Two valid choices the UI
   * passes through:
   *   - `parsed_code`: keep the original code from the source folder
   *     name (when it's not already taken)
   *   - `next_available_code`: bump to the project's next sequential
   *     code (always safe; default when parsed conflicts)
   * Anything else is rejected so the user can't fat-finger a code that
   * doesn't conform to the project's prefix/digits format.
   */
  override_code?: string
}

export interface ImportResult {
  episode_code: string
  title: string
  idea_id: string
  episode_dir: string
  folders_created: string[]
  wrote_episode_info: boolean
  /**
   * Absolute paths of files the inspector classified into known asset
   * buckets, with the canonical destination they SHOULD live at. The
   * Ideas-page import flow uses this to auto-launch the Pipeline-style
   * AssetImportDialog with these items pre-loaded so the user can review
   * + adjust the mapping before files actually move into place.
   *
   * Each entry is an absolute source_path inside the imported episode
   * dir paired with the type-specific mapping fields the dialog needs
   * (e.g. `{ type: 'audio', source_path, section_slug }`).
   */
  prefilled_import_items: PrefilledImportItem[]
}

/**
 * One pre-mapped file the post-import dialog can ingest directly. The
 * shape mirrors `AssetImportDialog`'s ImportItem discriminated union so
 * the dialog can pass these to /import-assets without remapping.
 */
export type PrefilledImportItem =
  | { type: 'audio',  source_path: string, section_slug: string }
  | { type: 'scene',  source_path: string, scene_number: number }
  | { type: 'thumb',  source_path: string, thumb_number: number }
  | { type: 'video',  source_path: string, scene_number: number }
  | { type: 'final',  source_path: string }
  | { type: 'merged', source_path: string }
  | { type: 'other',  source_path: string, dest_subpath: string }

export async function importEpisodeFolder(slug: string, opts: ImportOptions): Promise<ImportResult> {
  const inspect = await inspectEpisodeFolder(slug, opts.source_path)
  if (!inspect.ok) throw new Error(inspect.error || 'Folder inspection failed')

  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project output directory not found')

  // Honour an explicit user choice if one was passed. The UI offers two
  // legal values: parsed_code (when not taken) or next_available_code.
  // Anything else is treated as a 400 — rather than silently fall back,
  // so a typo doesn't quietly land the episode at an unexpected number.
  let finalCode = inspect.final_code
  if (typeof opts.override_code === 'string' && opts.override_code) {
    const choice = opts.override_code.toUpperCase()
    const parsedCode = (inspect.parsed_code || '').toUpperCase()
    const nextCode = (inspect.next_available_code || '').toUpperCase()
    if (choice === parsedCode && !inspect.parsed_code_taken) {
      finalCode = inspect.parsed_code!
    } else if (choice === nextCode) {
      finalCode = inspect.next_available_code
    } else {
      throw new Error(
        `override_code must equal the parsed code (when free) or the next-available code. Got: ${opts.override_code}`,
      )
    }
  }
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

  // 2. Resolve the canonical destination path, including the season
  //    folder. Mirrors the math in services/utils.ts resolveEpisodePaths
  //    so the imported episode lands at the same place every other
  //    consumer of resolveEpisodePaths (asset-status, audio-reconciler,
  //    video-assembly, …) is going to look. Previously this code joined
  //    the bare folder name onto outputRoot, dropping the season
  //    segment — which made imported episodes invisible to detection.
  const seasonSize = (meta as any).season_size || 20
  const seasonPrefix = (meta as any).season_prefix || 'Season'
  const folderTemplate = (meta as any).folder_template
    || '{season_prefix} {season_num}/{code} - {title}/'
  const epNum = parseInt(finalCode.replace(/^[A-Za-z]+/, ''), 10) || 1
  const seasonNum = Math.floor((epNum - 1) / seasonSize) + 1
  const episodeRel = folderTemplate
    .replace('{season_prefix}', seasonPrefix)
    .replace('{season_num}', seasonNum.toString().padStart(3, '0'))
    .replace('{code}', finalCode)
    .replace('{title}', title)
  const episodeDir = path.join(outputRoot, episodeRel)

  // We DO NOT copy the source folder verbatim anymore. The previous
  // behaviour duplicated every weirdly-named file into the project
  // tree alongside fresh empty canonical folders — leaving two copies
  // of every asset in different naming conventions inside one episode
  // dir. Now we create just the canonical skeleton and let the
  // post-import asset-mapping dialog move/copy each classified file
  // from its ORIGINAL location to its canonical destination. The user
  // chose copy-vs-move via the inspector toggle (importCopy → 'copy'
  // mode in the dialog; unchecked → 'move' mode that removes originals
  // after a successful import).
  if (existsSync(episodeDir)) {
    // Defensive: if the canonical path already exists for this code,
    // surface a clear error rather than silently overwriting. Common
    // when the user re-imports an episode they already imported once.
    throw new Error(`Destination already exists: ${episodeDir}. Delete it first or import to a different code.`)
  }
  await fs.mkdir(episodeDir, { recursive: true })

  // 3. Create the 9 canonical subfolders inside the empty episode dir.
  //    These are the destinations the asset-mapping dialog writes into,
  //    and they're what every detection helper expects to find.
  const subfolderNames = meta.subfolder_names || DEFAULT_SUBFOLDER_NAMES
  const needed = [
    subfolderNames.script, subfolderNames.metadata,
    subfolderNames.scene_prompts, subfolderNames.thumb_prompts,
    subfolderNames.images, subfolderNames.thumbnails,
    subfolderNames.audio, subfolderNames.merged_audio, subfolderNames.video,
  ].map(t => t.replace('{code}', finalCode))

  const foldersCreated: string[] = []
  for (const name of needed) {
    await fs.mkdir(path.join(episodeDir, name), { recursive: true })
    foldersCreated.push(name)
  }

  // 4. Build the pre-filled mapping plan. Source paths are absolute
  //    paths to the ORIGINAL files (NOT inside episodeDir) — the
  //    dialog will copy/move them into the canonical destinations
  //    we just created.
  const prefilledImportItems: PrefilledImportItem[] = []
  for (const plan of inspect.discovered_files) {
    const absSource = path.join(opts.source_path, plan.source_relative)
    if (!existsSync(absSource)) continue
    const item = derivePrefilledItem(absSource, plan)
    if (item) prefilledImportItems.push(item)
  }

  // 5. Write episode_info.json if missing
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
    prefilled_import_items: prefilledImportItems,
  }
}

/**
 * Translate one DiscoveredFile (from inspectEpisodeFolder's plan) into
 * the type-specific shape the AssetImportDialog ingests. Re-derives
 * scene_number / thumb_number / section_slug from the dest_relative
 * basename so the dialog's per-row controls land on sensible defaults
 * — the user can still re-map any row before submitting.
 */
function derivePrefilledItem(absSource: string, plan: DiscoveredFile): PrefilledImportItem | null {
  const code = plan.dest_relative.split(path.sep).pop()?.split('_')[0] || ''
  const destBase = path.basename(plan.dest_relative)
  switch (plan.bucket) {
    case 'audio': {
      // Canonical filename is `{code}_{slug}.mp3`. Slug examples:
      // Introduction, Chapter_01, Chapter_02. Strip the code prefix +
      // .mp3 suffix to recover the slug exactly.
      const slug = destBase
        .replace(new RegExp(`^${code}_`), '')
        .replace(/\.mp3$/i, '')
      return { type: 'audio', source_path: absSource, section_slug: slug || 'Chapter_01' }
    }
    case 'merged_audio':
      return { type: 'merged', source_path: absSource }
    case 'images': {
      // {code}_Scene{NN}_v1.{ext} → NN
      const m = destBase.match(/_Scene(\d+)/i)
      const n = m ? parseInt(m[1], 10) : 1
      return { type: 'scene', source_path: absSource, scene_number: n }
    }
    case 'thumbnails': {
      const m = destBase.match(/_Thumb(\d+)/i)
      const n = m ? parseInt(m[1], 10) : 1
      return { type: 'thumb', source_path: absSource, thumb_number: n }
    }
    case 'video': {
      // Two shapes: {code}_final_video.{ext} OR {code}_VideoNN_v1.{ext}.
      // The inspector picks final when there's exactly one video file in
      // the bucket; respect that here.
      if (/_final_video\./i.test(destBase)) return { type: 'final', source_path: absSource }
      const m = destBase.match(/_Video(\d+)/i)
      const n = m ? parseInt(m[1], 10) : 1
      return { type: 'video', source_path: absSource, scene_number: n }
    }
    case 'script':
    case 'scene_prompts':
    case 'thumb_prompts':
    case 'metadata':
    case 'subtitles':
      // These map to the importer's "other" bucket — the user supplies
      // the destination subpath in the dialog, defaulting to the
      // canonical layout the inspector planned.
      return { type: 'other', source_path: absSource, dest_subpath: plan.dest_relative }
  }
  return null
}
