/**
 * Chunked-narration sidecar cleanup (v1.0.71+).
 *
 * `lib/chunked-narration.ts` writes a `{episode}_chunked-progress.json`
 * next to each episode's per-chapter docx files. The sidecar drives
 * resume / cancel / crash recovery during a chunked LLM run, but once
 * the unified `{code}_Script_Narration.docx` has been assembled with
 * the expected chapter count, the sidecar has no further purpose.
 *
 * Per-user direction: we do NOT auto-wipe these. Instead, this module
 * exposes:
 *
 *   listChunkedSidecars(slug)
 *     Walk every accepted episode in the project. For each, check
 *     whether a sidecar exists, whether its chapters_done covers the
 *     total chapter count, and whether the unified narration docx
 *     exists. Tag each as "eligible" (safe to delete) or "in_progress"
 *     (still useful for resume).
 *
 *   cleanupChunkedSidecars(slug, { episode_codes? | all_eligible })
 *     Delete sidecars for the supplied episode codes, OR for every
 *     eligible episode in the project. Returns counts + deleted paths
 *     so the UI can confirm.
 *
 * Strict eligibility check: ALL of:
 *   - sidecar JSON exists and parses as a supported recovery schema
 *   - sidecar.chapters_done.length >= sidecar.total_chapters
 *   - {code}_Script_Narration.docx exists in the script_dir
 *
 * Anything else is treated as "in_progress" — never deleted by this
 * path. Even a `force` flag wouldn't make sense; cancelling a
 * half-run by removing its sidecar would orphan the chapter files
 * already on disk and force a full regeneration.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as im from './idea-manager.js'
import { createProjectFactsCache, resolveEpisodePaths, type ProjectFactsCache } from './utils.js'
import { mapWithConcurrency } from '../lib/map-with-concurrency.js'
import { readSidecar } from '../lib/chunked-narration.js'

export interface SidecarEligibility {
  episode_code: string
  /** Sidecar exists on disk. */
  sidecar_present: boolean
  /** Path to the sidecar (always populated, even when not present, so
   *  the UI can show what would be deleted). */
  sidecar_path: string
  /** Bytes — populated only when sidecar_present. */
  sidecar_size_bytes?: number
  /** Sidecar's recorded total chapters. */
  total_chapters?: number
  /** Number of chapters in chapters_done. */
  chapters_done?: number
  /** Unified narration docx exists for this episode. */
  unified_present: boolean
  /** Eligible for cleanup: all three guards pass. */
  eligible: boolean
  /** Why it's not eligible (when eligible=false), short human string. */
  reason?: string
}

export interface ListResult {
  episodes: SidecarEligibility[]
  /** Convenience: count of `eligible: true` entries. */
  eligible_count: number
  /** Convenience: total bytes that would be reclaimed by an
   *  all_eligible=true cleanup. */
  reclaimable_bytes: number
}

export async function listChunkedSidecars(slug: string): Promise<ListResult> {
  const ideas = await im.getIdeas(slug, 'accepted')
  // S8: one facts cache and 8 episodes at a time (was serial, >120 s on the mini).
  const facts = createProjectFactsCache(slug)
  const checked = await mapWithConcurrency(ideas.filter(idea => !!idea.episode_code), 8, idea =>
    // Couldn't resolve this episode's paths (folder missing, etc.): skip silently — the cleanup
    // tool only reports what it CAN see; Repair Folder Structure covers the missing-folder case.
    checkOne(slug, idea.episode_code!, idea.title || '', facts).catch(() => null))
  const episodes = checked.filter((e): e is SidecarEligibility => e !== null)
  let reclaimable = 0
  for (const e of episodes) if (e.eligible && e.sidecar_size_bytes) reclaimable += e.sidecar_size_bytes

  return {
    episodes,
    eligible_count: episodes.filter(e => e.eligible).length,
    reclaimable_bytes: reclaimable,
  }
}

async function checkOne(slug: string, code: string, title: string, facts?: ProjectFactsCache): Promise<SidecarEligibility> {
  const paths = await resolveEpisodePaths(slug, code, title, facts)
  const sidecarPath = path.join(paths.script_dir, `${code}_chunked-progress.json`)
  const unifiedPath = paths.narration_docx
  const unifiedPresent = existsSync(unifiedPath)
  const sidecarPresent = existsSync(sidecarPath)

  const result: SidecarEligibility = {
    episode_code: code,
    sidecar_present: sidecarPresent,
    sidecar_path: sidecarPath,
    unified_present: unifiedPresent,
    eligible: false,
  }
  if (!sidecarPresent) {
    result.reason = 'No sidecar — already cleaned up or never ran in chunked mode.'
    return result
  }
  try {
    const stat = await fs.stat(sidecarPath)
    result.sidecar_size_bytes = stat.size
    // Use the canonical reader so current v3 checkpoints and supported v1/v2
    // checkpoints share the same safe upgrade and validation behavior.
    const parsed = await readSidecar(paths.script_dir, code)
    if (!parsed) {
      result.reason = 'Sidecar is unreadable or uses an unknown format — not safe to clean up.'
      return result
    }
    result.total_chapters = Number.isInteger(parsed.total_chapters) && parsed.total_chapters > 0
      ? parsed.total_chapters
      : 0
    result.chapters_done = Array.isArray(parsed.chapters_done) ? parsed.chapters_done.length : 0
    if (!result.total_chapters) {
      result.reason = 'Sidecar has no valid chapter total — not safe to clean up.'
      return result
    }
    if (!unifiedPresent) {
      result.reason = 'Unified narration docx not present — sidecar still needed for resume.'
      return result
    }
    if ((result.chapters_done || 0) < (result.total_chapters || 0)) {
      result.reason = `Only ${result.chapters_done}/${result.total_chapters} chapters done — sidecar still needed for resume.`
      return result
    }
    result.eligible = true
  } catch (e: any) {
    result.reason = `Sidecar unreadable (${e?.message || 'unknown error'}) — not safe to auto-clean.`
  }
  return result
}

export interface CleanupOptions {
  episode_codes?: string[]
  all_eligible?: boolean
}

export interface CleanupResult {
  deleted: Array<{ episode_code: string; path: string; bytes_freed: number }>
  skipped: Array<{ episode_code: string; reason: string }>
  total_bytes_freed: number
}

export async function cleanupChunkedSidecars(
  slug: string, opts: CleanupOptions,
): Promise<CleanupResult> {
  // Resolve target list. For all_eligible, fan out to listChunkedSidecars
  // (the same eligibility check that the UI saw, so we never delete
  // something the user wasn't shown).
  let targets: string[] = []
  if (opts.all_eligible) {
    const list = await listChunkedSidecars(slug)
    targets = list.episodes.filter(e => e.eligible).map(e => e.episode_code)
  } else if (opts.episode_codes?.length) {
    targets = [...opts.episode_codes]
  }

  const deleted: CleanupResult['deleted'] = []
  const skipped: CleanupResult['skipped'] = []
  let totalBytes = 0

  for (const code of targets) {
    try {
      const ideas = await im.getIdeas(slug, 'accepted')
      const idea = ideas.find(i => i.episode_code === code)
      const title = idea?.title || ''
      const eligibility = await checkOne(slug, code, title)
      if (!eligibility.eligible) {
        skipped.push({ episode_code: code, reason: eligibility.reason || 'not eligible' })
        continue
      }
      const bytes = eligibility.sidecar_size_bytes || 0
      await fs.rm(eligibility.sidecar_path, { force: true })
      deleted.push({ episode_code: code, path: eligibility.sidecar_path, bytes_freed: bytes })
      totalBytes += bytes
    } catch (e: any) {
      skipped.push({ episode_code: code, reason: e?.message || 'unknown error' })
    }
  }

  return { deleted, skipped, total_bytes_freed: totalBytes }
}
