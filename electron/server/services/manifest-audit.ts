/**
 * Per-project asset audit.
 *
 * Walks every accepted episode and, for each generation stage, reports
 * what SHOULD exist on disk vs what actually does. The portability audit
 * (Session 05 §14) called this out: `manifest.ts::getManifestStatus` only
 * compares mtimes, so a project synced from another machine with a partial
 * rsync silently claims "in sync" even when 1-of-60 scene images is
 * absent. The missing file only blows up minutes into video-assembly.
 *
 * This module is the "look before you render" check — no provider calls,
 * no regeneration, no credit spend. Just directory listings + size checks.
 *
 * Scope per stage:
 *   - audio:        expected filenames derived from the narration docx
 *                   (same chunker the generator uses — see
 *                   audio-reconciler.ts).
 *   - scenes/thumb: expected stems derived from the prompts docx; "present"
 *                   means at least one `_v*` variant with content.
 *   - video:        expected filenames come from the clip task-manifest
 *                   (AI video prompts may
 *                   have been revised after submit, so the manifest is the
 *                   source of truth for "what we asked for").
 *   - merged_audio: single output per episode; expected iff either the
 *                   file or a task-manifest entry exists.
 *
 * "Not started" rule per §14's false-positive concern:
 *   A stage whose task-manifest is empty AND whose disk folder has no
 *   expected file is classified as `started: false`. Callers should
 *   display these as "pending" rather than "missing" so fresh projects
 *   don't show 60 scary red warnings before the user has clicked a
 *   single generate button.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { parseImagePromptsDocx } from '../lib/docx-parser.js'
import { findNarrationFile, resolveAudioDir } from '../generators/audio.js'
import {
  findScenePromptsFile, findThumbPromptsFile, resolveImageDirs,
} from '../generators/images.js'
import { resolveSubfolderNames } from './utils.js'
import { resolveEpisodeSubfolderDir } from './media-root.js'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { readManifest as readTaskManifest } from './task-manifest.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { episodeDirNameMatchesCode, stripDecorativePrefix } from './asset-status.js'

export type AuditStage =
  | 'audio'
  | 'scenes'
  | 'thumbnails'
  | 'video'
  | 'merged_audio'

export interface StageAudit {
  stage: AuditStage
  /**
   * False when the stage has never been started for this episode (no
   * task-manifest entries AND no expected file on disk). Callers should
   * render these as neutral/pending rather than red.
   */
  started: boolean
  /** Absolute directory that was scanned; undefined when not resolvable. */
  dir?: string
  expected: number
  present: number
  /** Filenames (or glob-ish stems for multi-variant image outputs). */
  missing: string[]
  /**
   * Files present in the directory that weren't in the expected set. Noise
   * rather than alarm — we surface them so the user can tell whether a
   * stray copy/rename is confusing the audit.
   */
  extra: string[]
}

export interface EpisodeAudit {
  episode_code: string
  title: string
  stages: StageAudit[]
}

export interface ProjectAudit {
  project_slug: string
  generated_at: string
  episodes: EpisodeAudit[]
  /** Total missing filenames across every started stage. */
  total_missing: number
  /** Count of episodes with at least one started-stage gap. */
  episodes_with_missing: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function fileNonEmpty(p: string): Promise<boolean> {
  try {
    if (!existsSync(p)) return false
    const st = await fs.stat(p)
    return st.size > 0
  } catch {
    return false
  }
}

async function listDir(p: string): Promise<string[]> {
  try { return await fs.readdir(p) } catch { return [] }
}

function notStarted(stage: AuditStage, dir?: string): StageAudit {
  return { stage, started: false, dir, expected: 0, present: 0, missing: [], extra: [] }
}

async function findEpisodeDir(root: string, code: string): Promise<string | null> {
  const CODE = code.toUpperCase()
  async function search(d: string, depth: number): Promise<string | null> {
    if (depth > 4) return null
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fs.readdir(d, { withFileTypes: true }) as any
    } catch { return null }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (episodeDirNameMatchesCode(e.name, CODE)) return path.join(d, e.name)
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const found = await search(path.join(d, e.name), depth + 1)
      if (found) return found
    }
    return null
  }
  return search(root, 0)
}

// ── Per-stage audits ───────────────────────────────────────────────────────

async function auditAudio(slug: string, code: string): Promise<StageAudit> {
  let narration: string
  try { narration = await findNarrationFile(slug, code) }
  catch { return notStarted('audio') }

  let audioDir: string
  try { audioDir = await resolveAudioDir(slug, narration, code) }
  catch { return notStarted('audio') }

  // Ask the reconciler what SHOULD exist rather than predicting it again here.
  // This used to re-derive the filenames itself, calling the character chunker
  // with no normalization and no boundary at all, so it silently inherited the
  // retired 4,800-character default and reported a `_part1`/`_part2` split for
  // any section the generator submits whole. There is one planner now, driven
  // by the selected model's published boundary, and this audit reads its
  // answer instead of holding a second opinion.
  const CODE = code.toUpperCase()
  let expected: string[]
  let present: string[]
  let missing: string[]
  try {
    const { getAudioStatus } = await import('./audio-reconciler.js')
    const status = await getAudioStatus(slug, code)
    expected = status.expected.map(e => e.filename)
    present = status.present
    missing = status.missing
  } catch { return notStarted('audio', audioDir) }
  if (!expected.length) return notStarted('audio', audioDir)

  const taskManifest = await readTaskManifest(audioDir)
  const manifestEmpty = Object.keys(taskManifest.tasks).length === 0
  if (manifestEmpty && present.length === 0) {
    return notStarted('audio', audioDir)
  }

  const expectedSet = new Set(expected)
  const onDisk = await listDir(audioDir)
  const extra = onDisk.filter(f =>
    f.startsWith(CODE + '_') && f.endsWith('.mp3') && !expectedSet.has(f),
  )

  return {
    stage: 'audio', started: true, dir: audioDir,
    expected: expected.length, present: present.length,
    missing, extra,
  }
}

async function auditImages(
  slug: string, code: string, kind: 'scenes' | 'thumbnails',
): Promise<StageAudit> {
  let promptsPath: string
  try {
    promptsPath = kind === 'scenes'
      ? await findScenePromptsFile(slug, code)
      : await findThumbPromptsFile(slug, code)
  } catch { return notStarted(kind) }

  const { bgDir, thumbDir } = await resolveImageDirs(slug, promptsPath, code)
  const dir = kind === 'scenes' ? bgDir : thumbDir

  const parsed = await parseImagePromptsDocx(promptsPath).catch(() => null)
  const list = parsed ? (kind === 'scenes' ? parsed.scenes : parsed.thumbnails) : []
  if (!list.length) return notStarted(kind, dir)

  const CODE = code.toUpperCase()
  const stemPrefix = kind === 'scenes' ? 'Scene' : 'Thumb'
  const onDisk = await listDir(dir)

  // "At least one variant with content" counts as present (matches what
  // the existing asset-status.getImageStatus does — the generator writes
  // _v1..._vN and the user only needs ≥1 for the final video to render).
  const presentStems = new Set<string>()
  for (const p of list) {
    const stem = `${CODE}_${stemPrefix}${p.number.toString().padStart(2, '0')}`
    const variants = onDisk.filter(f => f.startsWith(stem + '_v') && f.endsWith('.png'))
    for (const v of variants) {
      if (await fileNonEmpty(path.join(dir, v))) { presentStems.add(stem); break }
    }
  }

  const missing: string[] = []
  const expectedStems = new Set<string>()
  for (const p of list) {
    const stem = `${CODE}_${stemPrefix}${p.number.toString().padStart(2, '0')}`
    expectedStems.add(stem)
    if (!presentStems.has(stem)) missing.push(`${stem}_v*.png`)
  }

  const taskManifest = await readTaskManifest(dir)
  const manifestHasStage = Object.keys(taskManifest.tasks)
    .some(k => k.includes(`_${stemPrefix}`))
  if (!manifestHasStage && presentStems.size === 0) {
    return notStarted(kind, dir)
  }

  // Extras: pngs in this folder that don't map to an expected stem. Renamed
  // files or stale copies from a prior numbering show up here.
  const extra = onDisk.filter(f => {
    if (!f.endsWith('.png')) return false
    if (!f.startsWith(`${CODE}_${stemPrefix}`)) return false
    const m = f.match(/^(.+)_v\d+\.png$/)
    const stem = m ? m[1] : f.replace(/\.png$/, '')
    return !expectedStems.has(stem)
  })

  return {
    stage: kind, started: true, dir,
    expected: list.length, present: presentStems.size,
    missing, extra,
  }
}

async function auditVideo(slug: string, code: string): Promise<StageAudit> {
  const CODE = code.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return notStarted('video')
  const epDir = await findEpisodeDir(outputRoot, code)
  if (!epDir) return notStarted('video')

  const names = await resolveSubfolderNames(slug, code)
  const videoDir = await resolveEpisodeSubfolderDir(slug, code, 'video', epDir, names.video, false)
  const manifest = await readTaskManifest(videoDir)
  const expected = Object.keys(manifest.tasks)
  if (expected.length === 0) return notStarted('video', videoDir)

  const onDisk = await listDir(videoDir)
  const present: string[] = []
  for (const name of expected) {
    if (await fileNonEmpty(path.join(videoDir, name))) present.push(name)
  }
  const missing = expected.filter(n => !present.includes(n))
  const expectedSet = new Set(expected)
  const extra = onDisk.filter(f =>
    f.endsWith('.mp4') && f.toUpperCase().startsWith(CODE + '_') && !expectedSet.has(f),
  )

  return {
    stage: 'video', started: true, dir: videoDir,
    expected: expected.length, present: present.length,
    missing, extra,
  }
}

async function auditMergedAudio(slug: string, code: string): Promise<StageAudit> {
  const stage: AuditStage = 'merged_audio'
  const CODE = code.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return notStarted(stage)
  const epDir = await findEpisodeDir(outputRoot, code)
  if (!epDir) return notStarted(stage)

  let subfolder: string
  try {
    const metaRaw = await fs.readFile(
      // Linked-aware project.json read.
      path.join(pm.getProjectDir(slug) || path.join(pm.projectsRoot(), slug), 'project.json'), 'utf-8',
    )
    const meta = JSON.parse(metaRaw)
    const tmpl = meta.subfolder_names?.merged_audio
      || DEFAULT_SUBFOLDER_NAMES.merged_audio
    subfolder = tmpl.replace('{code}', CODE)
  } catch {
    subfolder = DEFAULT_SUBFOLDER_NAMES.merged_audio.replace('{code}', CODE)
  }

  const entries = await listDir(epDir)
  let mergedDir: string | null = null
  for (const entry of entries) {
    if (stripDecorativePrefix(entry) === subfolder) {
      mergedDir = path.join(epDir, entry); break
    }
  }
  if (!mergedDir) return notStarted(stage)

  const files = await listDir(mergedDir)
  const re = new RegExp(`^${CODE}_merged_audio(?:_v(\\d+))?\\.mp3$`)
  let latestMerged: string | null = null
  for (const f of files) {
    if (!re.test(f)) continue
    if (await fileNonEmpty(path.join(mergedDir, f))) {
      latestMerged = f; break
    }
  }

  const taskManifest = await readTaskManifest(mergedDir)
  const manifestEmpty = Object.keys(taskManifest.tasks).length === 0
  if (!latestMerged && manifestEmpty) {
    return notStarted(stage, mergedDir)
  }

  if (!latestMerged) {
    return {
      stage, started: true, dir: mergedDir,
      expected: 1, present: 0,
      missing: [`${CODE}_merged_audio.mp3`],
      extra: [],
    }
  }
  return {
    stage, started: true, dir: mergedDir,
    expected: 1, present: 1, missing: [], extra: [],
  }
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Run every per-stage audit across every accepted episode.
 *
 * Bounded concurrency (8) keeps a 100-episode project from opening 400+
 * parallel fs.readdir calls at once. Directory listing + existsSync + stat
 * are cheap enough that even without this bound we'd finish well under a
 * second, but being a good disk citizen matters on cloud-synced volumes
 * (iCloud Drive in particular gets slow when flooded).
 */
export async function auditAssets(slug: string): Promise<ProjectAudit> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const queue = ideas.filter(i => i.episode_code)
  const episodes: EpisodeAudit[] = new Array(queue.length)

  async function auditOne(i: number): Promise<void> {
    const idea = queue[i]
    const code = idea.episode_code!
    const [audio, scenes, thumbnails, video, merged] = await Promise.all([
      auditAudio(slug, code).catch(() => notStarted('audio')),
      auditImages(slug, code, 'scenes').catch(() => notStarted('scenes')),
      auditImages(slug, code, 'thumbnails').catch(() => notStarted('thumbnails')),
      auditVideo(slug, code).catch(() => notStarted('video')),
      auditMergedAudio(slug, code).catch(() => notStarted('merged_audio')),
    ])
    episodes[i] = {
      episode_code: code,
      title: idea.title,
      stages: [audio, scenes, thumbnails, video, merged],
    }
  }

  const CONCURRENCY = 8
  let idx = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (idx < queue.length) {
        const i = idx++
        await auditOne(i)
      }
    }),
  )

  const rows = episodes.filter(Boolean)
  let total_missing = 0
  let episodes_with_missing = 0
  for (const ep of rows) {
    let n = 0
    for (const s of ep.stages) if (s.started) n += s.missing.length
    if (n > 0) { total_missing += n; episodes_with_missing++ }
  }

  return {
    project_slug: slug,
    generated_at: new Date().toISOString(),
    episodes: rows,
    total_missing,
    episodes_with_missing,
  }
}
