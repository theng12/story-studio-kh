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

/**
 * Does an answer actually contain audience text in the channel's script?
 *
 * WHY THIS EXISTS. On 2026-10-30 the mini's Khmer channels came back with English
 * chapters (DM0022 chapters 9–16) and English outline titles. A refusal fails
 * loudly on its own, but English prose parsed into chapters and was written as
 * if it were the episode. An injected "reply in English" line upstream of Story
 * is the likely cause; Story must not depend on that route behaving.
 *
 * THE MEASUREMENT is deliberately simple: count Khmer letters (Unicode
 * U+1780–U+17FF and the Khmer symbol block U+19E0–U+19FF) and Latin letters
 * (A–Z, a–z), and ignore everything else — digits, punctuation and any other
 * script. An answer counts as Khmer when it has at least 30 Khmer letters AND
 * Khmer letters are at least 20% of all letters. That threshold is what allows
 * English names, product names and numerals inside Khmer prose (a Khmer chapter
 * with a hundred English characters still sits above 80%) while an English
 * chapter, an English refusal, or a chapter in another script has no Khmer at
 * all. A channel with no stated language is never checked.
 */
export interface ScriptMeasurement {
  khmer: number
  latin: number
  /** `km` when the answer is Khmer-dominant, `latin` when it is not, `none` when it has no letters. */
  script: 'km' | 'latin' | 'none'
}

const KHMER_MIN_LETTERS = 30
const KHMER_MIN_SHARE = 5 // one Khmer letter per four others: 20%

export function measureAnswerScript(text: string): ScriptMeasurement {
  let khmer = 0
  let latin = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x1780 && code <= 0x17ff) khmer++
    else if (code >= 0x19e0 && code <= 0x19ff) khmer++
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++
  }
  const script = khmer + latin === 0 ? 'none' : khmer >= KHMER_MIN_LETTERS && khmer * KHMER_MIN_SHARE >= khmer + latin ? 'km' : 'latin'
  return { khmer, latin, script }
}

/**
 * True when the answer is in the channel's language, or when the channel has no
 * stated language (the check never guesses).
 */
export function answerMatchesLanguage(text: string, language: unknown): boolean {
  const expected = normalizeContentLanguage(language)
  if (!expected) return true
  const measured = measureAnswerScript(text)
  if (measured.script === 'none') return false
  return expected === 'km' ? measured.script === 'km' : measured.script !== 'km'
}

/** The language's own name, for a message a person reads. */
export function languageName(value: unknown): string {
  const language = normalizeContentLanguage(value)
  return language === 'km' ? 'Khmer' : language === 'en' ? 'English' : ''
}

/**
 * The directive as the LAST paragraph of a prompt. The system prompt already
 * carries it, but an instruction injected upstream (an "answer in English"
 * line) came back after it and won; the final line is the one a model follows.
 */
export function languageDirectiveTail(prompt: string, value: unknown): string {
  const directive = languageDirective(value)
  return directive ? `${prompt}\n\n${directive}` : prompt
}
