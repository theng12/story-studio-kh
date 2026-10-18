/**
 * The per-episode creation snapshot that decides future-only introduction
 * eligibility.
 *
 * `acceptIdea()` writes these facts into `episode_info.json` at the moment the
 * episode is created. Consumers must read the FACT, never guess from queue
 * order, timestamps, or the current project setting:
 *
 *   - `intro_eligible: true` — the channel's automatic-introduction switch was
 *     on when this episode was created.
 *   - absent / no file — an old or imported episode. It is never given an
 *     automatic introduction, never marked as missing one, and never
 *     backfilled. Explicit manual generation remains available.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { ContentLanguage } from '../models/types.js'
import { normalizeContentLanguage } from './content-language.js'

export interface EpisodeCreationFacts {
  content_language?: ContentLanguage
  intro_eligible?: boolean
}

export async function readEpisodeCreationFacts(episodeDir: string): Promise<EpisodeCreationFacts> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(episodeDir, 'episode_info.json'), 'utf-8'),
    ) as Record<string, unknown>
    const language = normalizeContentLanguage(raw?.content_language)
    return {
      ...(language ? { content_language: language } : {}),
      ...(typeof raw?.intro_eligible === 'boolean' ? { intro_eligible: raw.intro_eligible } : {}),
    }
  } catch {
    // Missing, unreadable, or corrupt: no fact. Never infer eligibility.
    return {}
  }
}

export async function episodeIsIntroEligible(episodeDir: string): Promise<boolean> {
  return (await readEpisodeCreationFacts(episodeDir)).intro_eligible === true
}
