/**
 * The one audience-language boundary for Story Studio.
 *
 * The project's `content_language` is the authority for the language of
 * audience-facing output. It governs output language ONLY: recipe examples,
 * format text, and style references stay authoritative for structure, voice,
 * and section order — they are never rewritten or translated.
 *
 * An absent/cleared value returns an empty directive so legacy projects keep
 * byte-identical prompts. There is deliberately no per-run override.
 */

import type { ContentLanguage, ProjectMeta } from '../models/types.js'
import { getProject } from '../services/project-manager.js'

export type { ContentLanguage }

export function normalizeContentLanguage(value: unknown): ContentLanguage | null {
  return value === 'en' || value === 'km' ? value : null
}

/**
 * The exact instruction appended to an audience-facing prompt. Empty for an
 * unset language (legacy prompts must stay byte-identical).
 */
export function languageDirective(value: unknown): string {
  const language = normalizeContentLanguage(value)
  if (!language) return ''
  const languageLine = language === 'km'
    ? 'Write ALL audience-facing text in Khmer (Khmer script). Technical identifiers stay as-is.'
    : 'Write ALL audience-facing text in English.'
  return `${languageLine} This language instruction takes precedence over the language of recipe examples, style references, and format text; those remain authoritative for structure, voice, and section order only.`
}

export function projectContentLanguageDirective(
  project: Pick<ProjectMeta, 'content_language'> | null | undefined,
): string {
  return languageDirective(project?.content_language)
}

/** Read the live project setting. Missing/unreadable projects are unset. */
export async function getContentLanguage(slug: string): Promise<ContentLanguage | null> {
  const project = await getProject(slug).catch(() => null)
  return normalizeContentLanguage(project?.content_language)
}
