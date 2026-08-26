/**
 * The one place a channel's intent about its openings lives.
 *
 * v1.4.73. Before this, "does this channel open with a host?" had no home at
 * all. The Script page kept the answer in a page-local variable that reset to
 * `false` on every context reload, the unattended batch kept a separate
 * unticked box, and a niche field that only one of twenty-one niches declared
 * decided whether the control was even drawn. Three places, none of them
 * remembering, and seven of ten channels unable to see the feature at all.
 *
 * Everything that produces an episode now asks THIS module, and gets the same
 * answer. The page writes here; the interactive button, the unattended batch
 * and a direct API call all read here.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as pm from './project-manager.js'
import { getEffectiveFormat } from './format-loader.js'
import { isIntroductionMarker } from './asset-status.js'
import {
  INTRODUCTION_SEGMENT_ID,
  normalizeChannelSegments,
  type ChannelSegment,
  type ChannelSegments,
  type FormatIntroDefaults,
} from '../lib/episode-segments.js'

/** The config key these live under. Echoed by `getSafeConfig`; see below. */
export const SEGMENTS_CONFIG_KEY = 'episode_segments'

async function formatIntroDefaults(slug: string): Promise<FormatIntroDefaults | null> {
  try {
    const format = await getEffectiveFormat(slug)
    return (format?.script?.introDefaults as FormatIntroDefaults) || null
  } catch {
    // A channel whose format cannot be read still gets a well-formed recipe.
    return null
  }
}

/**
 * Has this channel EVER produced an opening?
 *
 * Used once per channel, to decide what its saved setting should start as.
 * Walks the episodes tree and stops at the first piece of evidence, so a
 * channel that uses openings answers almost immediately; only a channel that
 * has never made one pays for the full walk, and it pays once.
 *
 * Evidence is the same marker the episode list already reads
 * (`isIntroductionMarker`), so this can never disagree with the tick a person
 * sees on the Production Board.
 */
export async function hasEverProducedSegment(slug: string, segmentId: string): Promise<boolean> {
  if (segmentId !== INTRODUCTION_SEGMENT_ID) return false
  const root = await pm.getProjectOutputRoot(slug)
  if (!root) return false

  // Episode folders, then their subfolders, then the files inside. Bounded
  // deliberately: script artifacts are never deeper than that, and an
  // unbounded walk over a channel with four hundred episodes of media is a
  // very expensive way to answer a yes/no question.
  async function scan(dir: string, depth: number): Promise<boolean> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        if (isIntroductionMarker(entry.name)) return true
      } else if (entry.isDirectory() && depth > 0) {
        if (await scan(path.join(dir, entry.name), depth - 1)) return true
      }
    }
    return false
  }
  return scan(root, 2)
}

/**
 * Read a channel's segments, deciding once for a channel that predates them.
 *
 * A channel upgrading into this feature has never been asked the question, and
 * both possible blanket answers are wrong: `false` makes channels that were
 * producing openings go quiet — the exact failure that started this work — and
 * `true` spends money on channels that never wanted one. So the answer is
 * INFERRED FROM WHAT THE CHANNEL HAS ACTUALLY MADE, recorded with
 * `inferred_at` so the page can say it was inferred rather than chosen, and
 * ask. Inference runs once and is then a saved setting like any other.
 */
export async function getChannelSegments(slug: string): Promise<ChannelSegments> {
  const config = await pm.getConfig(slug)
  const raw = (config as Record<string, unknown>)?.[SEGMENTS_CONFIG_KEY]
  const defaults = await formatIntroDefaults(slug)

  if (raw && typeof raw === 'object') return normalizeChannelSegments(raw, defaults)

  const segments = normalizeChannelSegments({}, defaults)
  const everProduced = await hasEverProducedSegment(slug, INTRODUCTION_SEGMENT_ID)
  if (everProduced) {
    segments[INTRODUCTION_SEGMENT_ID].enabled = true
    segments[INTRODUCTION_SEGMENT_ID].inferred_at = new Date().toISOString()
  }
  await pm.updateConfig(slug, { [SEGMENTS_CONFIG_KEY]: segments } as never)
  return segments
}

/** Write one segment back. The page is the only caller. */
export async function saveChannelSegment(
  slug: string,
  segmentId: string,
  patch: Partial<ChannelSegment>,
): Promise<ChannelSegments> {
  const current = await getChannelSegments(slug)
  if (!current[segmentId]) throw new Error(`Unknown episode segment: ${segmentId}`)
  const merged: ChannelSegment = {
    ...current[segmentId],
    ...patch,
    recipe: { ...current[segmentId].recipe, ...(patch.recipe || {}) },
  }
  // Saving IS the confirmation. A value the owner has just looked at and
  // pressed Save on is no longer an inference, whichever way he left it.
  delete merged.inferred_at
  const next = { ...current, [segmentId]: merged }
  const normalized = normalizeChannelSegments(next, await formatIntroDefaults(slug))
  await pm.updateConfig(slug, { [SEGMENTS_CONFIG_KEY]: normalized } as never)
  return normalized
}

/**
 * Does this channel want an opening on everything it produces?
 *
 * The single question every generation path asks. Never reads a checkbox,
 * never reads a preset, never reads a niche.
 */
export async function channelWantsIntroduction(slug: string): Promise<boolean> {
  try {
    const segments = await getChannelSegments(slug)
    return segments[INTRODUCTION_SEGMENT_ID]?.enabled === true
  } catch {
    // A channel whose settings cannot be read is not a channel that has asked
    // for spending. Refusing to guess `true` here is deliberate.
    return false
  }
}
