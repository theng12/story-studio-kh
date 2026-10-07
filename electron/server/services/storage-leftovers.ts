/**
 * Leftovers that nothing ever tidies, offered in Free up space (owner policy:
 * nothing is swept automatically; he frees space himself, and everything goes
 * to `_trash`, never deleted).
 *
 *   - Audio-quality copies: each repair stages candidate narration under
 *     `<episode>/.audio-quality-candidates/<action>` and each paid check stages
 *     a copy of the active audio under `.audio-quality-checks/<action>`. They
 *     stay forever. Offered once the action is settled (fixed/cancelled, or a
 *     check that found no issue) or no longer recorded at all.
 *   - Leftover render files: a FAILED Video Assembly keeps its scratch folder
 *     (`<tmp>/story-studio-kh/<slug>/<code>/.tmp_*`) for inspection, and only a
 *     restart sweeps it (after 24 h). Offered while no job runs for the episode.
 */

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { moveToTrashSync } from '../lib/trash-move.js'
import { getWorkTempRoot, sanitizeWorkTempSegment } from '../lib/work-tempdir.js'
import { readAudioQualityProvenance } from './audio-quality-store.js'
import { trashTargetFor } from './chapter-parts.js'
import * as im from './idea-manager.js'
import * as jq from './job-queue.js'
import * as pm from './project-manager.js'
import { dirSize } from './storage-audit.js'
import { resolveEpisodePathsByCode } from './utils.js'

export type LeftoverKind = 'audio_quality_copy' | 'render_scratch'

export interface StorageLeftover {
  kind: LeftoverKind
  episode_code: string
  path: string
  bytes: number
  /** Where it moves: a `_trash` the owner empties himself. */
  trash_path: string
}

const ACTIVE = new Set(['queued', 'running', 'paused'])
/** Test seam for "a job runs for this episode". */
export const _leftoverHooks: { getJobs: (slug: string) => Promise<Array<{ episode_id?: string | null; status: string }>> } = {
  getJobs: slug => jq.getJobs(slug),
}
const SETTLED_ACTIONS = new Set(['fixed', 'cancelled'])

/** Action ids written in `audio_quality.json` (readable or not); null when the file is unreadable. */
async function recordedActionIds(episodeDir: string): Promise<Set<string> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_quality.json'), 'utf8')) as { actions?: unknown }
    return new Set(raw?.actions && typeof raw.actions === 'object' ? Object.keys(raw.actions) : [])
  } catch (error: any) {
    return error?.code === 'ENOENT' ? new Set() : null
  }
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name)
}

/** Everything offered for one project, re-read every time (the list is the authority for a move). */
export async function listStorageLeftovers(slug: string): Promise<StorageLeftover[]> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw Object.assign(new Error('Project not found'), { statusCode: 404 })
  const jobs = await _leftoverHooks.getJobs(slug)
  const busy = new Set(jobs.filter(job => ACTIVE.has(job.status)).map(job => String(job.episode_id || '').toUpperCase()))
  const out: StorageLeftover[] = []
  for (const idea of await im.getIdeas(slug, 'accepted')) {
    const code = String(idea.episode_code || '').toUpperCase()
    if (!code || busy.has(code)) continue
    const paths = await resolveEpisodePathsByCode(slug, code).catch(() => null)
    if (paths) {
      // A folder is "settled" only on positive evidence. An action id still
      // written in the record but not readable keeps its folder, and an
      // unreadable record keeps all of them.
      const recorded = await recordedActionIds(paths.episode_dir)
      const actions = recorded ? (await readAudioQualityProvenance(paths.episode_dir).catch(() => null))?.actions ?? {} : null
      if (recorded && actions) {
        const known = (id: string) => !recorded.has(id) || !!actions[id]
        for (const [folder, settled] of [
          ['.audio-quality-candidates', (id: string) => !recorded.has(id) || SETTLED_ACTIONS.has(actions[id]!.state)],
          ['.audio-quality-checks', (id: string) => !recorded.has(id) || SETTLED_ACTIONS.has(actions[id]!.state)
            || actions[id]!.active_check?.state === 'no_issue_detected'],
        ] as const) {
          const root = path.join(paths.episode_dir, folder)
          for (const id of await subdirs(root)) {
            if (!known(id) || !settled(id)) continue
            const dir = path.join(root, id)
            out.push({ kind: 'audio_quality_copy', episode_code: code, path: dir, bytes: await dirSize(dir), trash_path: trashTargetFor(projectDir, dir) })
          }
        }
      }
    }
    const scratchRoot = path.join(getWorkTempRoot(), sanitizeWorkTempSegment(slug), sanitizeWorkTempSegment(code))
    for (const run of await subdirs(scratchRoot)) {
      if (!run.startsWith('.tmp_')) continue
      const dir = path.join(scratchRoot, run)
      out.push({
        kind: 'render_scratch', episode_code: code, path: dir, bytes: await dirSize(dir),
        trash_path: path.join(projectDir, '_trash', code, 'leftover_render_files', run),
      })
    }
  }
  return out
}

/**
 * Move the chosen leftovers to `_trash`. Each path must still be on a fresh
 * listing (so a job that started meanwhile protects its folder). A move that
 * cannot happen — another drive, a permission — leaves the folder in place.
 */
export async function trashStorageLeftovers(slug: string, paths: unknown): Promise<{
  moved: Array<{ path: string; to: string; bytes: number }>
  left: Array<{ path: string; reason: string }>
}> {
  if (!Array.isArray(paths) || !paths.length || paths.some(item => typeof item !== 'string')) {
    throw Object.assign(new Error('Choose at least one leftover folder.'), { statusCode: 400 })
  }
  const offered = new Map((await listStorageLeftovers(slug)).map(item => [item.path, item]))
  const moved: Array<{ path: string; to: string; bytes: number }> = []
  const left: Array<{ path: string; reason: string }> = []
  for (const requested of new Set(paths as string[])) {
    const item = offered.get(requested)
    if (!item) { left.push({ path: requested, reason: 'No longer offered (in use again, or already gone).' }); continue }
    if (!existsSync(item.path)) { left.push({ path: item.path, reason: 'Already gone.' }); continue }
    try {
      moved.push({ path: item.path, to: moveToTrashSync(item.path, item.trash_path), bytes: item.bytes })
    } catch (error: any) {
      left.push({ path: item.path, reason: error?.code === 'EXDEV'
        ? 'It is on another drive than the project, so it was left where it is.'
        : `Could not move it to _trash (${error?.message || error}); it was left where it is.` })
    }
  }
  return { moved, left }
}
