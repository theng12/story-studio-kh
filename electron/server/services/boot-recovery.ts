/**
 * Boot-time recovery evidence audit.
 *
 * Story Studio no longer contacts Kie, fal.ai, ElevenLabs, Fish Audio,
 * GenAIPro, or Studio Hub directly. Historical task manifests remain useful
 * audit evidence, so startup may inspect them, but it never polls, downloads,
 * or re-submits an external provider task. GenStudio-owned work is resumed by
 * retrying the original Story Studio job through the GenStudio gateway.
 */

import path from 'path'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths } from './utils.js'
import { readManifest, type Manifest } from './task-manifest.js'
import { fileExistsWithContent, isCloudEvictedPlaceholder } from '../lib/http-retry.js'

export interface RecoverySweepSummary {
  scannedManifests: number
  scannedEntries: number
  recovered: number
  pending: number
  expired: number
  failed: number
  bytesFreed: number
  budgetExhausted: boolean
}

export interface RecoverySweepOpts {
  /** Cap total manifest entries inspected (default 50). No network calls occur. */
  maxItems?: number
  /** Logger — defaults to console.log. Pass a no-op for tests. */
  onLog?: (msg: string) => void
}

const ASSET_KIND = ['bg', 'thumb', 'audio', 'video'] as const
type AssetKind = typeof ASSET_KIND[number]

function isGenStudioProvider(provider: string | undefined): boolean {
  return provider === 'genstudio'
    || provider === 'genstudio-image'
    || provider === 'genstudio-audio'
    || provider === 'genstudio-video'
}

/**
 * Inspects retained task evidence without contacting any execution provider.
 * Missing GenStudio outputs remain pending for a user-initiated gateway retry;
 * missing legacy-provider outputs are counted as failed with a clear log line.
 */
export async function proactiveRecoverySweep(
  opts: RecoverySweepOpts = {},
): Promise<RecoverySweepSummary> {
  const log = opts.onLog ?? ((msg: string) => console.warn(msg))
  const maxItems = Math.max(0, opts.maxItems ?? 50)
  const summary: RecoverySweepSummary = {
    scannedManifests: 0,
    scannedEntries: 0,
    recovered: 0,
    pending: 0,
    expired: 0,
    failed: 0,
    bytesFreed: 0,
    budgetExhausted: false,
  }

  const projects = await pm.listProjects().catch(() => [])
  for (const project of projects) {
    if (summary.scannedEntries >= maxItems) {
      summary.budgetExhausted = true
      break
    }
    try {
      await inspectProject(project.slug, summary, maxItems, log)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[boot-recovery] project '${project.slug}' evidence scan failed: ${message}`)
    }
  }

  return summary
}

async function inspectProject(
  slug: string,
  summary: RecoverySweepSummary,
  maxItems: number,
  log: (msg: string) => void,
): Promise<void> {
  const ideas = await im.getIdeas(slug).catch(() => [])
  for (const idea of ideas.filter(item => !!item.episode_code)) {
    if (summary.scannedEntries >= maxItems) {
      summary.budgetExhausted = true
      return
    }

    let paths
    try {
      paths = await resolveEpisodePaths(slug, idea.episode_code as string, idea.title || '')
    } catch {
      continue
    }

    for (const kind of ASSET_KIND) {
      const directory = directoryFor(kind, paths)
      if (!existsSync(directory)) continue

      let manifest: Manifest
      try {
        manifest = await readManifest(directory)
      } catch {
        continue
      }
      const entries = Object.entries(manifest.tasks)
      if (!entries.length) continue
      summary.scannedManifests++

      for (const [filename, entry] of entries) {
        if (summary.scannedEntries >= maxItems) {
          summary.budgetExhausted = true
          return
        }
        summary.scannedEntries++

        const filePath = path.join(directory, filename)
        if (await fileExistsWithContent(filePath)) continue
        if (await isCloudEvictedPlaceholder(filePath)) continue
        if (!entry?.task_id) continue

        if (isGenStudioProvider(entry.provider)) {
          summary.pending++
          log(
            `[boot-recovery] ${filename}: retained GenStudio job ${entry.task_id}; `
            + 'retry the original job to resume through GenStudio.',
          )
          continue
        }

        summary.failed++
        log(
          `[boot-recovery] ${filename}: legacy ${entry.provider || 'unknown'} task `
          + `${entry.task_id} was not contacted. Direct provider recovery is retired; `
          + 'the manifest remains as audit evidence.',
        )
      }
    }
  }
}

function directoryFor(kind: AssetKind, paths: Awaited<ReturnType<typeof resolveEpisodePaths>>): string {
  if (kind === 'bg') return paths.bg_dir
  if (kind === 'thumb') return paths.thumb_dir
  if (kind === 'audio') return paths.audio_dir
  return paths.video_dir
}
