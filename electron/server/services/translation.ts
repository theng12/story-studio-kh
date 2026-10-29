/**
 * Translation service for Story Studio KH.
 *
 * Translates finished or scripted episodes between English and Khmer (English ↔ Khmer),
 * preserving the chapter structure, headings, and spoken prose rhythm.
 *
 * Downstream steps (narration in target language voice, subtitles, assembly) run normally
 * in the target channel, reusing visual assets and scene plan wherever timing allows.
 *
 * Rules:
 * - AGENTS.md §1: Model is selected by preset or live picker, never hardcoded.
 * - AGENTS.md §4: Target episode is a distinct episode in the target channel.
 * - AGENTS.md §8: Verified completion: done only when every chapter is translated and non-empty.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from './project-manager.js'
import * as ideas from './idea-manager.js'
import { callAiWithRetry, type CallAiContext } from '../lib/ai-client.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath, SCENE_PLAN_SIDECAR } from './utils.js'
import { resolveArtifact, resolveReadPath, matchChapterFile, readArtifactRawText } from '../lib/episode-artifacts.js'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { writeChapterFiles, assembleUnifiedNarration, type NarrationParts } from '../lib/narration-assembly.js'
import { normalizeContentLanguage } from '../lib/content-language.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { getEffectiveFormat } from './format-loader.js'
import { renameEpisodeFolderForTitleChange } from './episode-folder-title-sync.js'
import { pipelineStepLabel } from '../lib/pipeline-continuation.js'
import { isTextVariantFile, readSidecar } from './thumbnail-text-variants.js'
import type { Job, ScenePlan } from '../models/types.js'

/**
 * Provenance + resume state for a translated episode, written beside the
 * episode's own artifacts. `title_translated` is what stops a Retry from
 * translating (and re-renaming) the title a second time; `glossary` is the
 * one per-episode name list every chapter was adapted with.
 */
export const TRANSLATION_SIDECAR = 'translation.json'

export interface TranslationGlossaryEntry {
  /** The name or term as the source narration says it. */
  source: string
  /** The spelling the target narration must use, everywhere, every time. */
  target: string
}

export interface TranslationGlossary {
  entries: TranslationGlossaryEntry[]
  /** The model that built it — the user's own selection (§1), recorded for audit. */
  built_with_model: string
  built_at: string
  /** Source characters sent to the model, and whether the script was capped to fit. */
  source_characters: number
  truncated: boolean
}

/** What the target episode's thumbnails are, and what still has to be done to them. */
export interface TranslationThumbnailReuse {
  /** Artwork copied from the source episode (never a headline variant). */
  copied: string[]
  /** `<stem>_text-<n>.png` variants found in the source and deliberately NOT copied. */
  text_variants_skipped: string[]
  /**
   * True only when the source's own text-layer sidecars name this artwork as their text-free
   * source. Nothing can inspect pixels, so "no variant exists" is reported as not proven.
   */
  clean_base_available: boolean
  /** The target episode still needs its own headline before upload. */
  needs_target_text: boolean
  /** One sentence, fit to show a person. */
  note: string
}

export interface TranslationProvenance {
  schema_version: 1
  source_slug: string
  source_episode_id: string
  source_language: 'en' | 'km'
  target_language: 'en' | 'km'
  title_translated: boolean
  translated_at: string
  /** The one per-episode name glossary; reused on Retry so no second paid call is made. */
  glossary?: TranslationGlossary
  thumbnails?: TranslationThumbnailReuse
}

/** The sidecar's historical name — kept so existing importers keep working. */
export type TranslationSidecar = TranslationProvenance

export interface ChapterToTranslate {
  number: number
  title: string
  text: string
}

export interface IntroductionToTranslate {
  text: string
}

export interface SourceEpisodeScript {
  title: string
  intro?: IntroductionToTranslate
  chapters: ChapterToTranslate[]
}

export interface TranslateEpisodeOptions {
  sourceSlug: string
  sourceEpisodeId: string
  targetSlug: string
  /** Live writing model id (AGENTS.md §1 — never hardcoded). */
  model: string
  targetEpisodeId?: string
  targetTitle?: string
  reuseVisuals?: boolean
  chapters?: number[]
  signal?: AbortSignal
  onProgress?: (percent: number, message: string) => void | Promise<void>
  /** Test hook or caller-injected AI caller. Defaults to callAiWithRetry. */
  callAi?: (model: string, system: string, user: string, ctx?: CallAiContext) => Promise<string>
  /**
   * Keep any chapter/introduction/title already translated for this target
   * episode and translate only what is missing or empty. This is what makes a
   * Retry redo exactly the failed work. Default true.
   */
  resume?: boolean
}

export interface TranslateEpisodeResult {
  targetSlug: string
  targetEpisodeId: string
  targetTitle: string
  sourceSlug: string
  sourceEpisodeId: string
  sourceLanguage: 'en' | 'km'
  targetLanguage: 'en' | 'km'
  translatedChapters: number[]
  reusedChapters: number[]
  hasIntro: boolean
  titleTranslated: boolean
  visualsReused: boolean
  scenePlanReused: boolean
  /** What happened to the thumbnails — the source language's headline is never reused. */
  thumbnails?: TranslationThumbnailReuse | null
}

/**
 * Validate and resolve the translation language pair (English ↔ Khmer).
 */
export function resolveTranslationLanguages(
  sourceContentLanguage?: string | null,
  targetContentLanguage?: string | null,
): { sourceLanguage: 'en' | 'km'; targetLanguage: 'en' | 'km' } {
  const sourceLang = normalizeContentLanguage(sourceContentLanguage)
  const targetLang = normalizeContentLanguage(targetContentLanguage)

  if (!sourceLang) {
    throw Object.assign(
      new Error('Source channel content_language must be "en" or "km" for translation.'),
      { statusCode: 400 },
    )
  }
  if (!targetLang) {
    throw Object.assign(
      new Error('Target channel content_language must be "en" or "km" for translation.'),
      { statusCode: 400 },
    )
  }
  if (sourceLang === targetLang) {
    throw Object.assign(
      new Error(`Source and target channels both have language "${sourceLang}". Translation requires different languages (English ↔ Khmer).`),
      { statusCode: 400 },
    )
  }

  return { sourceLanguage: sourceLang, targetLanguage: targetLang }
}

/**
 * How much source text the glossary pass is given. A long episode's script is
 * capped rather than truncated silently: the prompt says so and the sidecar
 * records it, so nobody has to guess why a late name is missing.
 */
export const GLOSSARY_MAX_TEXT_CHARS = 60_000

const LANGUAGES: Record<'en' | 'km', string> = { en: 'English', km: 'Khmer' }

/** The one instruction block every adaptation prompt shares. */
function adaptationRules(sourceLanguage: 'en' | 'km', targetLanguage: 'en' | 'km'): string[] {
  const sourceName = LANGUAGES[sourceLanguage]
  const targetName = LANGUAGES[targetLanguage]
  return [
    `You adapt the ${sourceName} narration into ${targetName} for listeners — a storyteller, not a word-for-word translator.`,
    `Adapt it so it sounds like a ${targetName} storyteller telling it aloud:`,
    '- Keep every story beat, fact, name, source and variant statement, in the SAME ORDER. The pictures are timed to that order, so a reordered line moves a picture off its scene.',
    `- Do not mirror ${sourceName} word order or idioms. Restructure sentences into natural spoken ${targetName}, and give an idiom's ${targetName} equivalent instead of a literal rendering.`,
    `- Write numbers, dates and years the way a ${targetName} narrator says them aloud.`,
    targetLanguage === 'km'
      ? 'Use warm storyteller Khmer — the way someone tells a story to a friend, not bookish literary prose. Use proper Khmer grammar, spacing, and punctuation (such as ។ and ៕).'
      : 'Use warm storyteller English — the way someone tells a story to a friend, not bookish written prose.',
    'Add nothing. Drop nothing. Do not include markdown codeblocks (```), translator notes, explanations, or commentary.',
  ]
}

/** The glossary as prompt lines, or an empty string when there is nothing to enforce. */
export function formatGlossaryForPrompt(entries: TranslationGlossaryEntry[] | undefined): string {
  const usable = (entries || []).filter(entry => entry?.source?.trim() && entry?.target?.trim())
  if (!usable.length) return ''
  return [
    'Name glossary — use EXACTLY these spellings, everywhere, every time:',
    ...usable.map(entry => `- ${entry.source.trim()} = ${entry.target.trim()}`),
  ].join('\n')
}

/**
 * The one per-episode glossary prompt (owner, 2026-10-28).
 *
 * Built before any chapter is adapted and passed to the chapters, the
 * introduction and the title, so a god's name or a place's spelling does not
 * change from chapter to chapter. One call per episode, through the model the
 * user chose (§1).
 */
export function buildGlossaryPrompt(
  sourceLanguage: 'en' | 'km',
  targetLanguage: 'en' | 'km',
  script: SourceEpisodeScript,
): { system: string; user: string } {
  const sourceName = LANGUAGES[sourceLanguage]
  const targetName = LANGUAGES[targetLanguage]
  const system = [
    `You are preparing a name glossary for a ${targetName} spoken-narration adaptation of a ${sourceName} episode.`,
    `List every proper name and recurring term a listener must hear spelled CONSISTENTLY: gods, people, places, dynasties, titles, festivals, texts, and recurring foreign terms.`,
    `Give the source spelling and the ${targetName} spelling a narrator would say, one per line, in exactly this form:`,
    '<source spelling> = <target spelling>',
    'No numbering, no bullets, no commentary, no headings, no examples of your own.',
    'If the episode has no proper names at all, reply with exactly: none',
  ].join('\n')

  const lines: string[] = []
  if (script.title) lines.push(`Episode title: ${script.title}`)
  if (script.intro?.text) lines.push('Introduction:', script.intro.text)
  let used = lines.join('\n').length
  const chapters: string[] = []
  for (const chapter of script.chapters) {
    const block = `Chapter ${String(chapter.number).padStart(2, '0')}: ${chapter.title}\n${chapter.text}`
    if (used + block.length > GLOSSARY_MAX_TEXT_CHARS) {
      chapters.push(`[the rest of the script was not sent: the glossary covers the first ${GLOSSARY_MAX_TEXT_CHARS} characters]`)
      break
    }
    chapters.push(block)
    used += block.length
  }
  const user = [lines.join('\n\n'), ...chapters].filter(Boolean).join('\n\n')
  return { system, user }
}

/**
 * Parse a glossary answer. Lines that are not `source = target` are ignored —
 * a model that answers with prose yields an empty glossary, never invented
 * entries. Case-insensitive duplicate source spellings keep the first.
 */
export function parseGlossaryResponse(raw: string, limit = 300): TranslationGlossaryEntry[] {
  const text = String(raw || '')
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/i, '')
  if (/^\s*none\s*\.?\s*$/i.test(text)) return []
  const seen = new Set<string>()
  const entries: TranslationGlossaryEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^[-*•\d.)\s]+/, '').trim()
    if (!cleaned) continue
    const match = /^(.+?)\s*(?:=|→|—|\t)\s*(.+)$/.exec(cleaned)
    if (!match) continue
    const source = match[1]!.trim().replace(/^["'“”]+|["'“”]+$/g, '')
    const target = match[2]!.trim().replace(/^["'“”]+|["'“”]+$/g, '')
    if (!source || !target) continue
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ source, target })
    if (entries.length >= limit) break
  }
  return entries
}

/**
 * Construct prompts for adapting a single chapter into spoken narration.
 */
export function buildChapterTranslationPrompt(
  sourceLanguage: 'en' | 'km',
  targetLanguage: 'en' | 'km',
  chapter: { number: number; title: string; text: string },
  episodeTitle?: string,
  glossary?: TranslationGlossaryEntry[],
): { system: string; user: string } {
  const chNumStr = String(chapter.number).padStart(2, '0')
  const glossaryBlock = formatGlossaryForPrompt(glossary)

  const system = [
    ...adaptationRules(sourceLanguage, targetLanguage),
    'Maintain the exact chapter structure:',
    `- First line must be the chapter heading: ## Chapter ${chNumStr}: <adapted chapter title>`,
    '- Follow with the adapted narration paragraphs.',
    ...(glossaryBlock ? ['', glossaryBlock] : []),
  ].join('\n')

  const user = [
    episodeTitle ? `Episode: ${episodeTitle}` : '',
    `Source Chapter heading: Chapter ${chNumStr}: ${chapter.title}`,
    'Source Text:',
    chapter.text,
  ].filter(Boolean).join('\n\n')

  return { system, user }
}

/**
 * Construct prompts for adapting an introduction into spoken narration.
 */
export function buildIntroductionTranslationPrompt(
  sourceLanguage: 'en' | 'km',
  targetLanguage: 'en' | 'km',
  introText: string,
  episodeTitle?: string,
  glossary?: TranslationGlossaryEntry[],
): { system: string; user: string } {
  const glossaryBlock = formatGlossaryForPrompt(glossary)
  const system = [
    ...adaptationRules(sourceLanguage, targetLanguage),
    'Maintain the exact introduction structure:',
    '- First line must be: # Introduction',
    '- Follow with the adapted introduction paragraphs.',
    ...(glossaryBlock ? ['', glossaryBlock] : []),
  ].join('\n')

  const user = [
    episodeTitle ? `Episode: ${episodeTitle}` : '',
    'Source Introduction Text:',
    introText,
  ].filter(Boolean).join('\n\n')

  return { system, user }
}

/**
 * Parse translated chapter LLM response into structured chapter parts.
 * Enforces non-empty title and text (§8).
 */
export function parseTranslatedChapter(
  raw: string,
  expectedNumber: number,
): { number: number; title: string; text: string } {
  const cleaned = raw.trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  if (!cleaned) {
    throw new Error(`Translated Chapter ${expectedNumber} output was empty.`)
  }

  const lines = cleaned.split('\n')
  let title = ''
  let bodyStartIndex = 0
  let headingFound = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    // ## Chapter NN: Title or ## Reason NN: Title
    const headingMatch = line.match(/^##\s*(?:(?:Chapter|Reason|Topic|Section|Part|Lesson|Bit|Beat)\s*\d+)?\s*[:\-–—]?\s*(.*)$/i)
    if (headingMatch && headingMatch[1]?.trim()) {
      title = headingMatch[1].trim()
      bodyStartIndex = i + 1
      headingFound = true
      break
    }
    if (line.startsWith('#')) {
      title = line.replace(/^#+\s*/, '').replace(/^(?:Chapter|Reason|Topic|Section|Part)\s*\d+\s*[:\-–—]?\s*/i, '').trim()
      bodyStartIndex = i + 1
      headingFound = true
      break
    }
  }

  // Some models return the title as a plain first line, separated by a blank
  // line from the body. Only that shape is treated as a title; a solid prose
  // block with no blank line is left whole as body and gets a default title.
  if (!headingFound) {
    const first = lines.findIndex(l => l.trim())
    const second = lines.findIndex((l, i) => i > first && l.trim())
    if (first >= 0 && first + 1 === second && !lines[first + 1]?.trim().length
      && lines[first]!.trim().length <= 120) {
      title = lines[first]!.trim()
      bodyStartIndex = first + 1
    }
  }

  const text = lines.slice(bodyStartIndex).join('\n').trim()

  if (!text) {
    throw new Error(`Translated Chapter ${expectedNumber} has empty body text.`)
  }
  if (!title) {
    title = `Chapter ${String(expectedNumber).padStart(2, '0')}`
  }

  return { number: expectedNumber, title, text }
}

/**
 * Parse translated introduction LLM response.
 * Enforces non-empty text (§8).
 */
export function parseTranslatedIntro(raw: string): { text: string } {
  const cleaned = raw.trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  if (!cleaned) {
    throw new Error('Translated Introduction output was empty.')
  }

  const lines = cleaned.split('\n')
  let bodyStartIndex = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    if (/^#+\s*Intro(?:duction)?/i.test(line)) {
      bodyStartIndex = i + 1
      break
    }
  }

  const text = lines.slice(bodyStartIndex).join('\n').trim()
  if (!text) {
    const fallbackText = lines.filter(l => !/^#+\s*Intro/i.test(l.trim())).join('\n').trim()
    if (!fallbackText) throw new Error('Translated Introduction has empty body text.')
    return { text: fallbackText }
  }

  return { text }
}

/** Prompt for adapting the episode title itself. */
export function buildTitleTranslationPrompt(
  sourceLanguage: 'en' | 'km',
  targetLanguage: 'en' | 'km',
  sourceTitle: string,
  glossary?: TranslationGlossaryEntry[],
): { system: string; user: string } {
  const sourceName = LANGUAGES[sourceLanguage] || LANGUAGES.en
  const targetName = LANGUAGES[targetLanguage] || LANGUAGES.km
  const glossaryBlock = formatGlossaryForPrompt(glossary)
  const system = [
    `You adapt episode titles from ${sourceName} into ${targetName} for a spoken narration.`,
    `Give a title a ${targetName} narrator would say aloud to a listener: natural, warm and spoken rather than a literal rendering of the ${sourceName} wording.`,
    'Keep the title saying what the episode is about, and use the name spellings in the glossary below exactly.',
    'Output ONLY the adapted title on one line — no quotes, no labels, no explanation, no punctuation wrapper.',
    ...(glossaryBlock ? ['', glossaryBlock] : []),
  ].join('\n')
  return { system, user: `Episode title: ${sourceTitle}` }
}

/**
 * Parse a translated title. One line, non-empty. Quotation marks and a
 * leading "Title:" label are the only presentation defects repaired; an empty
 * answer fails (§8 — an empty title is not a title).
 */
export function parseTranslatedTitle(raw: string): string {
  const lines = raw.trim()
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length) throw new Error('Translated title output was empty.')
  let title = lines[0]!.replace(/^(?:episode\s+)?title\s*[:\-–—]\s*/i, '').trim()
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  if (!title) throw new Error('Translated title output was empty.')
  return title
}

/**
 * Load script chapters and introduction from the source episode.
 */
export async function loadSourceEpisodeScript(
  sourceSlug: string,
  sourceEpisodeId: string,
): Promise<SourceEpisodeScript> {
  const paths = await resolveEpisodePathsByCode(sourceSlug, sourceEpisodeId)
  if (!existsSync(paths.episode_dir)) {
    throw Object.assign(
      new Error(`Source episode ${sourceEpisodeId} not found in project ${sourceSlug}`),
      { statusCode: 404 },
    )
  }

  let title = sourceEpisodeId
  const ideaStore = await ideas.getIdeas(sourceSlug).catch(() => [] as ideas.StoredIdea[])
  const matchingIdea = ideaStore.find(i => i.episode_code?.toUpperCase() === sourceEpisodeId.toUpperCase())
  if (matchingIdea?.title) {
    title = matchingIdea.title
  }

  let intro: IntroductionToTranslate | undefined
  const chapters: ChapterToTranslate[] = []

  let entries: string[] = []
  try {
    entries = await fs.readdir(paths.script_dir)
  } catch {
    // Missing script_dir
  }

  const chapterNumbers = Array.from(new Set(
    entries.map(n => matchChapterFile(n, sourceEpisodeId)).filter((x): x is number => x !== null),
  )).sort((a, b) => a - b)

  const introFile = resolveArtifact(paths.script_dir, `${sourceEpisodeId}_Introduction`)
  if (introFile) {
    const rawIntro = await readArtifactRawText(introFile)
    try {
      const parsedIntro = parseTranslatedIntro(rawIntro)
      if (parsedIntro.text) {
        intro = { text: parsedIntro.text }
      }
    } catch {
      // Ignore unparseable intro
    }
  }

  if (chapterNumbers.length > 0) {
    for (const num of chapterNumbers) {
      const chFile = resolveArtifact(paths.script_dir, `${sourceEpisodeId}_Chapter_${String(num).padStart(2, '0')}`)
      if (!chFile) continue
      const rawText = await readArtifactRawText(chFile)
      try {
        const parsed = parseTranslatedChapter(rawText, num)
        chapters.push(parsed)
      } catch {
        // If chapter file exists but could not be parsed as markdown, fall back to whole content as body
        const text = rawText.trim()
        if (text) {
          chapters.push({
            number: num,
            title: `Chapter ${String(num).padStart(2, '0')}`,
            text,
          })
        }
      }
    }
  } else {
    // Fall back to unified narration docx/md if present
    const narrationPath = resolveReadPath(paths.narration_docx)
    if (existsSync(narrationPath)) {
      const sections = await parseNarrationDocx(narrationPath)
      for (const section of sections) {
        if (section.slug === 'Introduction') {
          intro = { text: section.text }
        } else {
          const matchNum = section.label.match(/\d+/)
          const num = matchNum ? parseInt(matchNum[0], 10) : chapters.length + 1
          chapters.push({
            number: num,
            title: section.title || section.label,
            text: section.text,
          })
        }
      }
    }
  }

  if (!chapters.length) {
    throw Object.assign(
      new Error(`Episode ${sourceEpisodeId} in project ${sourceSlug} has no script chapters to translate.`),
      { statusCode: 400 },
    )
  }

  return { title, intro, chapters }
}

/**
 * Copy visual assets (images, thumbnails) and scene plan from source to target episode.
 *
 * The pictures are the whole point of translating into a second channel (owner,
 * 2026-10-28): the target episode shows exactly these stills, clips and
 * thumbnails, in this order. What must NOT travel is anything the source
 * language wrote:
 *
 * - a rendered headline (`<stem>_text-<n>.png`) is English type over the art, so
 *   it is skipped and named. The artwork underneath is what is wanted;
 * - the merged narration, the timings and the scene text are NOT copied here.
 *   `services/translation-timeline-rebase.ts` retimes the plan against the
 *   target narration once it exists.
 */
export async function copyVisualAssetsAndScenePlan(
  sourceSlug: string,
  sourceEpisodeCode: string,
  targetSlug: string,
  targetEpisodeCode: string,
  targetLanguage: 'en' | 'km' = 'km',
): Promise<{
  visualsReused: boolean
  scenePlanReused: boolean
  thumbnails: TranslationThumbnailReuse | null
}> {
  const sourcePaths = await resolveEpisodePathsByCode(sourceSlug, sourceEpisodeCode)
  const targetPaths = await resolveEpisodePathsByCode(targetSlug, targetEpisodeCode)

  let visualsReused = false
  let scenePlanReused = false

  // 1. Copy images
  if (existsSync(sourcePaths.bg_dir)) {
    await fs.mkdir(targetPaths.bg_dir, { recursive: true })
    const files = await fs.readdir(sourcePaths.bg_dir).catch(() => [] as string[])
    for (const file of files) {
      if (/\.(?:webp|png|jpe?g|gif|mp4)$/i.test(file)) {
        await fs.copyFile(path.join(sourcePaths.bg_dir, file), path.join(targetPaths.bg_dir, file))
        visualsReused = true
      }
    }
  }

  // 2. Copy thumbnails — artwork only, never another language's drawn headline.
  let thumbnails: TranslationThumbnailReuse | null = null
  if (existsSync(sourcePaths.thumb_dir)) {
    await fs.mkdir(targetPaths.thumb_dir, { recursive: true })
    const files = (await fs.readdir(sourcePaths.thumb_dir).catch(() => [] as string[]))
      .filter(file => /\.(?:webp|png|jpe?g)$/i.test(file) && !file.startsWith('.'))
    const variants = files.filter(file => isTextVariantFile(file))
    const artwork = files.filter(file => !isTextVariantFile(file))
    for (const file of artwork) {
      await fs.copyFile(path.join(sourcePaths.thumb_dir, file), path.join(targetPaths.thumb_dir, file))
      visualsReused = true
    }
    // A text-layer sidecar names the art it was drawn on and the contract requires that art to be
    // text-free, so its presence is positive evidence a clean base exists. Without one, nothing on
    // disk can tell whether the image model drew words into the picture — say that, never assume.
    let provenSource: string | null = null
    for (const variant of variants) {
      const record = await readSidecar(path.join(sourcePaths.thumb_dir, variant)).catch(() => null)
      if (record?.ok && artwork.includes(record.sidecar.source_filename)) {
        provenSource = record.sidecar.source_filename
        break
      }
    }
    const targetName = LANGUAGES[targetLanguage] || LANGUAGES.km
    // Translation only ever crosses en <-> km, so the source language is the other one.
    const sourceName = targetLanguage === 'km' ? LANGUAGES.en : LANGUAGES.km
    const cleanBase = !!provenSource
    thumbnails = {
      copied: artwork,
      text_variants_skipped: variants,
      clean_base_available: cleanBase,
      needs_target_text: artwork.length > 0,
      note: !artwork.length
        ? 'The source episode has no thumbnail artwork to copy.'
        : cleanBase
          ? `${artwork.length} thumbnail artwork file(s) copied text-free (${provenSource} is proven text-free by the source's own text-layer record); `
            + `the ${targetName} headline is drawn by this channel's own thumbnail text layer, and the source language's headline was not copied.`
          : `${artwork.length} thumbnail artwork file(s) copied, but nothing proves they are free of ${sourceName} text: `
            + `the source never applied a text layer, so the words may be drawn into the picture itself. `
            + `Give this ${targetName} episode its own thumbnail before upload — the source language's text is never reused.`,
    }
  }

  // 3. Copy scene_plan.json
  const sourcePlanPath = await resolveScenePlanPath(sourceSlug, sourceEpisodeCode, sourcePaths.episode_dir)
  if (existsSync(sourcePlanPath)) {
    try {
      const planContent = await fs.readFile(sourcePlanPath, 'utf-8')
      const plan = JSON.parse(planContent) as ScenePlan
      if (plan && Array.isArray(plan.scenes)) {
        for (const scene of plan.scenes) {
          if (!scene.image_path) continue
          if (scene.image_path.startsWith(sourcePaths.bg_dir + path.sep)) {
            // Scene stills live in a folder named after the SOURCE episode
            // code; the target's own folder carries the target code.
            scene.image_path = path.join(targetPaths.bg_dir, path.basename(scene.image_path))
          } else if (scene.image_path.startsWith(sourcePaths.episode_dir + path.sep)) {
            const rel = path.relative(sourcePaths.episode_dir, scene.image_path)
            scene.image_path = path.join(targetPaths.episode_dir, rel)
          }
        }
        // Anything a previous retime recorded belongs to the source episode's clock, never to this one.
        delete plan.translation_rebase
        delete plan.source_timeline
        await fs.mkdir(targetPaths.scene_prompts_dir, { recursive: true })
        const targetPlanPath = path.join(targetPaths.scene_prompts_dir, SCENE_PLAN_SIDECAR)
        await writeJsonAtomic(targetPlanPath, plan)
        scenePlanReused = true
      }
    } catch {
      // Ignore corrupt source plan
    }
  }

  return { visualsReused, scenePlanReused, thumbnails }
}

/**
 * Verified completion contract (§8):
 * Translation is done ONLY when every requested chapter is on disk and non-empty.
 */
export async function verifyTranslatedCompletion(
  targetScriptDir: string,
  targetEpisodeCode: string,
  expectedChapterNumbers: number[],
  hasIntro: boolean,
): Promise<void> {
  const missingOrInvalid: string[] = []

  for (const num of expectedChapterNumbers) {
    const chFile = resolveArtifact(targetScriptDir, `${targetEpisodeCode}_Chapter_${String(num).padStart(2, '0')}`)
    if (!chFile || !existsSync(chFile)) {
      missingOrInvalid.push(`Chapter ${num} file is missing (${targetEpisodeCode}_Chapter_${String(num).padStart(2, '0')}.md)`)
      continue
    }
    const stat = await fs.stat(chFile).catch(() => null)
    if (!stat || stat.size === 0) {
      missingOrInvalid.push(`Chapter ${num} file is empty (0 bytes)`)
      continue
    }
    const text = await fs.readFile(chFile, 'utf-8')
    if (!text.trim()) {
      missingOrInvalid.push(`Chapter ${num} file contains only whitespace`)
    }
  }

  if (hasIntro) {
    const introFile = resolveArtifact(targetScriptDir, `${targetEpisodeCode}_Introduction`)
    if (!introFile || !existsSync(introFile)) {
      missingOrInvalid.push(`Introduction file is missing (${targetEpisodeCode}_Introduction.md)`)
    } else {
      const stat = await fs.stat(introFile).catch(() => null)
      if (!stat || stat.size === 0) {
        missingOrInvalid.push('Introduction file is empty (0 bytes)')
      } else {
        const text = await fs.readFile(introFile, 'utf-8')
        if (!text.trim()) {
          missingOrInvalid.push('Introduction file contains only whitespace')
        }
      }
    }
  }

  const narrationDocx = resolveReadPath(path.join(targetScriptDir, `${targetEpisodeCode}_Script_Narration.docx`))
  if (!existsSync(narrationDocx)) {
    missingOrInvalid.push(`Unified narration document is missing (${targetEpisodeCode}_Script_Narration.docx)`)
  } else {
    const stat = await fs.stat(narrationDocx).catch(() => null)
    if (!stat || stat.size === 0) {
      missingOrInvalid.push('Unified narration document is empty (0 bytes)')
    }
  }

  if (missingOrInvalid.length > 0) {
    throw Object.assign(
      new Error(`Translation completion verification failed (§8):\n- ${missingOrInvalid.join('\n- ')}`),
      { code: 'TRANSLATION_INCOMPLETE', details: missingOrInvalid },
    )
  }
}
/** Read this episode's translation sidecar, if one exists. */
export async function readTranslationProvenance(episodeDir: string): Promise<TranslationProvenance | null> {
  const file = path.join(episodeDir, TRANSLATION_SIDECAR)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as TranslationSidecar
    return parsed && parsed.schema_version === 1 ? parsed : null
  } catch {
    return null
  }
}

/**
 * The episode's one name glossary (owner, 2026-10-28).
 *
 * Built ONCE, before any chapter is adapted, through the model the user chose
 * (§1) — a glossary failure fails the job rather than letting each chapter
 * spell a god's name its own way. On Retry the recorded glossary is reused, so
 * the paid call is made once per episode, never once per attempt.
 */
async function ensureEpisodeGlossary(args: {
  options: TranslateEpisodeOptions
  script: SourceEpisodeScript
  sourceLanguage: 'en' | 'km'
  targetLanguage: 'en' | 'km'
  aiCaller: NonNullable<TranslateEpisodeOptions['callAi']>
  sidecar: TranslationProvenance | null
}): Promise<{ glossary: TranslationGlossary; reused: boolean }> {
  const { options, script, sourceLanguage, targetLanguage, aiCaller, sidecar } = args
  const recorded = sidecar?.glossary
  if (options.resume !== false && recorded && Array.isArray(recorded.entries)) {
    await options.onProgress?.(0, `Name glossary already built — kept (${recorded.entries.length} name(s)).`)
    return { glossary: recorded, reused: true }
  }

  const prompt = buildGlossaryPrompt(sourceLanguage, targetLanguage, script)
  let raw: string
  try {
    raw = await aiCaller(options.model, prompt.system, prompt.user, {
      slug: options.targetSlug, signal: options.signal,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw Object.assign(
      new Error(`Failed to build the name glossary via model ${options.model}: ${message}`),
      { code: 'TRANSLATION_PROVIDER_ERROR', cause: err },
    )
  }
  return {
    glossary: {
      entries: parseGlossaryResponse(raw),
      built_with_model: options.model,
      built_at: new Date().toISOString(),
      source_characters: prompt.user.length,
      truncated: prompt.user.includes('the glossary covers the first'),
    },
    reused: false,
  }
}

/** A chapter already on disk and non-empty, parsed; null when it must be (re)translated. */
async function existingTranslatedChapter(
  scriptDir: string,
  code: string,
  number: number,
): Promise<ChapterToTranslate | null> {
  const file = resolveArtifact(scriptDir, `${code}_Chapter_${String(number).padStart(2, '0')}`)
  if (!file) return null
  try {
    const parsed = parseTranslatedChapter(await readArtifactRawText(file), number)
    return parsed.text.trim() ? parsed : null
  } catch {
    return null
  }
}

/** An introduction already on disk and non-empty, parsed; null when it must be (re)translated. */
async function existingTranslatedIntro(scriptDir: string, code: string): Promise<IntroductionToTranslate | null> {
  const file = resolveArtifact(scriptDir, `${code}_Introduction`)
  if (!file) return null
  try {
    const parsed = parseTranslatedIntro(await readArtifactRawText(file))
    return parsed.text.trim() ? parsed : null
  } catch {
    return null
  }
}

/** Find the idea row behind an episode code (its title is the episode's title). */
async function ideaForEpisode(slug: string, code: string): Promise<ideas.StoredIdea | null> {
  const list = await ideas.getIdeas(slug).catch(() => [] as ideas.StoredIdea[])
  return list.find(i => i.episode_code?.toUpperCase() === code.toUpperCase()) ?? null
}

/**
 * Resolve the target episode, creating it in the target channel when it does
 * not exist yet. The episode is created BEFORE any translation so a Retry has
 * somewhere to look for the work an earlier attempt finished, and so the job
 * can be bound to a real episode id.
 */
export async function resolveTranslationTarget(
  options: TranslateEpisodeOptions,
  sourceTitle: string,
): Promise<{ code: string; title: string }> {
  if (options.targetEpisodeId) {
    const existing = await resolveEpisodePathsByCode(options.targetSlug, options.targetEpisodeId)
    if (existsSync(existing.episode_dir)) {
      const idea = await ideaForEpisode(options.targetSlug, options.targetEpisodeId)
      return { code: options.targetEpisodeId, title: idea?.title || options.targetTitle || sourceTitle }
    }
  }

  const wanted = (options.targetTitle || sourceTitle).trim() || 'Translated episode'
  const [created] = await ideas.addIdeas(options.targetSlug, [{
    title: wanted,
    logline: `[Translated from ${options.sourceSlug}/${options.sourceEpisodeId}] ${sourceTitle}`,
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'standard',
    mood: 'neutral',
  }], options.model)
  if (!created) throw new Error('Failed to create the translated episode in the target project.')

  const accepted = await ideas.acceptIdea(
    options.targetSlug,
    created.id,
    false,
    options.targetEpisodeId ? { override_code: options.targetEpisodeId } : {},
  )
  return { code: accepted.episode_code, title: created.title }
}

/**
 * Translate the episode's title through the same writing model, then move the
 * episode record AND its folder to the translated title. Skipped when the
 * caller supplied a title, and skipped on a Retry once the sidecar says it is
 * done — the title is translated once per episode, not once per attempt.
 */
async function translateEpisodeTitle(
  options: TranslateEpisodeOptions,
  aiCaller: NonNullable<TranslateEpisodeOptions['callAi']>,
  args: {
    sourceTitle: string
    sourceLanguage: 'en' | 'km'
    targetLanguage: 'en' | 'km'
    code: string
    currentTitle: string
    sidecar: TranslationProvenance | null
    glossary?: TranslationGlossaryEntry[]
  },
): Promise<{ title: string; translated: boolean }> {
  if (options.targetTitle?.trim()) return { title: options.targetTitle.trim(), translated: true }
  if (options.resume !== false && args.sidecar?.title_translated) {
    return { title: args.currentTitle, translated: true }
  }

  const prompt = buildTitleTranslationPrompt(args.sourceLanguage, args.targetLanguage, args.sourceTitle, args.glossary)
  let raw: string
  try {
    raw = await aiCaller(options.model, prompt.system, prompt.user, {
      slug: options.targetSlug, signal: options.signal,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw Object.assign(
      new Error(`Failed to translate the episode title via model ${options.model}: ${message}`),
      { code: 'TRANSLATION_PROVIDER_ERROR', cause: err },
    )
  }
  const title = parseTranslatedTitle(raw)

  if (title !== args.currentTitle) {
    const idea = await ideaForEpisode(options.targetSlug, args.code)
    if (idea) {
      await ideas.updateIdea(options.targetSlug, idea.id, { title })
      const renamed = await renameEpisodeFolderForTitleChange(
        options.targetSlug, args.code, args.currentTitle, title,
      )
      for (const warning of renamed.warnings) await options.onProgress?.(0, warning)
    }
  }
  return { title, translated: true }
}

/**
 * Execute end-to-end episode translation.
 *
 * Called from the `translate_episode` job executor (and directly by tests).
 * Every model call is one chapter (or the introduction, or the title); the
 * result is refused unless every chapter is on disk and non-empty (§8).
 */
export async function translateEpisodeScript(
  options: TranslateEpisodeOptions,
): Promise<TranslateEpisodeResult> {
  if (!options.model || typeof options.model !== 'string' || !options.model.trim()) {
    throw Object.assign(
      new Error('Writing model is required for translation (§1). Select a model from the live picker or preset.'),
      { statusCode: 400 },
    )
  }

  const sourceProject = await pm.getProject(options.sourceSlug)
  if (!sourceProject) {
    throw Object.assign(new Error(`Source project "${options.sourceSlug}" not found.`), { statusCode: 404 })
  }
  const targetProject = await pm.getProject(options.targetSlug)
  if (!targetProject) {
    throw Object.assign(new Error(`Target project "${options.targetSlug}" not found.`), { statusCode: 404 })
  }

  const { sourceLanguage, targetLanguage } = resolveTranslationLanguages(
    sourceProject.content_language,
    targetProject.content_language,
  )

  const sourceScript = await loadSourceEpisodeScript(options.sourceSlug, options.sourceEpisodeId)

  // A requested chapter the source does not have is its own answer, not a
  // quiet skip: name it rather than return a shorter list that looks complete.
  const requestedMissing = (options.chapters || [])
    .filter(n => !sourceScript.chapters.some(ch => ch.number === n))
  if (requestedMissing.length) {
    throw Object.assign(
      new Error(`Source episode ${options.sourceEpisodeId} has no ${requestedMissing.length === 1 ? 'Chapter' : 'Chapters'} ${requestedMissing.join(', ')} to translate.`),
      { statusCode: 400 },
    )
  }

  const chaptersToTranslate = options.chapters?.length
    ? sourceScript.chapters.filter(ch => options.chapters!.includes(ch.number))
    : sourceScript.chapters
  if (!chaptersToTranslate.length) {
    throw Object.assign(new Error('No matching chapters found to translate.'), { statusCode: 400 })
  }
  const translateIntro = !!sourceScript.intro && !options.chapters?.length

  // 1. The target episode exists before any paid work, so a Retry can find
  //    and keep the chapters an earlier attempt already finished.
  const ensured = await resolveTranslationTarget(options, sourceScript.title)
  const targetEpisodeCode = ensured.code
  let targetPaths = await resolveEpisodePathsByCode(options.targetSlug, targetEpisodeCode)
  let sidecar = await readTranslationProvenance(targetPaths.episode_dir)

  const aiCaller: NonNullable<TranslateEpisodeOptions['callAi']> = options.callAi || ((m, s, u, ctx) =>
    callAiWithRetry(m, s, u, {}, false, ctx))

  // 2. The one per-episode name glossary, before any chapter is adapted, so every chapter, the
  //    introduction and the title spell each name the same way. Reused on Retry (§1: one paid call).
  const glossaryResult = await ensureEpisodeGlossary({
    options, script: sourceScript, sourceLanguage, targetLanguage, aiCaller, sidecar,
  })
  const glossary = glossaryResult.glossary
  if (!glossaryResult.reused) {
    await options.onProgress?.(0, `Built the name glossary: ${glossary.entries.length} name(s).`)
  }

  // 3. The title, through the same model. This can rename the folder, so the
  //    target paths are re-resolved straight afterwards.
  const titleResult = await translateEpisodeTitle(options, aiCaller, {
    sourceTitle: sourceScript.title,
    sourceLanguage,
    targetLanguage,
    code: targetEpisodeCode,
    currentTitle: ensured.title,
    sidecar,
    glossary: glossary.entries,
  })
  const targetTitle = titleResult.title
  targetPaths = await resolveEpisodePathsByCode(options.targetSlug, targetEpisodeCode)
  if (!sidecar) sidecar = await readTranslationProvenance(targetPaths.episode_dir)

  // Record the glossary as soon as it exists: a chapter that fails later must not make a Retry pay
  // for the same glossary again.
  if (!glossaryResult.reused) {
    await writeJsonAtomic(path.join(targetPaths.episode_dir, TRANSLATION_SIDECAR), {
      ...(sidecar || {}),
      schema_version: 1,
      source_slug: options.sourceSlug,
      source_episode_id: options.sourceEpisodeId,
      source_language: sourceLanguage,
      target_language: targetLanguage,
      title_translated: sidecar?.title_translated || false,
      translated_at: sidecar?.translated_at || new Date().toISOString(),
      glossary,
    } satisfies TranslationProvenance)
  }

  const totalSteps = chaptersToTranslate.length + (translateIntro ? 1 : 0)
  let currentStep = 0
  const resume = options.resume !== false

  // 3. Introduction — kept from an earlier attempt when it already has text.
  let translatedIntro: IntroductionToTranslate | undefined
  let introReused = false
  if (translateIntro) {
    const existing = resume ? await existingTranslatedIntro(targetPaths.script_dir, targetEpisodeCode) : null
    if (existing) {
      translatedIntro = existing
      introReused = true
      await options.onProgress?.(Math.round((currentStep / totalSteps) * 100), 'Introduction already translated — kept.')
    } else {
      await options.onProgress?.(Math.round((currentStep / totalSteps) * 100), 'Translating introduction...')
      const introPrompt = buildIntroductionTranslationPrompt(
        sourceLanguage,
        targetLanguage,
        sourceScript.intro!.text,
        sourceScript.title,
        glossary.entries,
      )
      let rawIntro: string
      try {
        rawIntro = await aiCaller(options.model, introPrompt.system, introPrompt.user, {
          slug: options.targetSlug, signal: options.signal,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        throw Object.assign(
          new Error(`Failed to translate Introduction via model ${options.model}: ${message}`),
          { code: 'TRANSLATION_PROVIDER_ERROR', cause: err },
        )
      }
      translatedIntro = parseTranslatedIntro(rawIntro)
    }
    currentStep++
  }

  // 4. Chapters — a chapter already on disk is kept, so a Retry redoes exactly
  //    the missing or failed ones.
  const writtenChapters: ChapterToTranslate[] = []
  const reusedChapters: number[] = []
  for (const ch of chaptersToTranslate) {
    if (options.signal?.aborted) throw new Error('Translation aborted.')
    const existing = resume ? await existingTranslatedChapter(targetPaths.script_dir, targetEpisodeCode, ch.number) : null
    if (existing) {
      reusedChapters.push(ch.number)
      await options.onProgress?.(
        Math.round((currentStep / totalSteps) * 100),
        `Chapter ${ch.number} already translated — kept.`,
      )
      currentStep++
      continue
    }
    await options.onProgress?.(
      Math.round((currentStep / totalSteps) * 100),
      `Translating Chapter ${ch.number}...`,
    )
    const chPrompt = buildChapterTranslationPrompt(
      sourceLanguage, targetLanguage, ch, sourceScript.title, glossary.entries,
    )
    let raw: string
    try {
      raw = await aiCaller(options.model, chPrompt.system, chPrompt.user, {
        slug: options.targetSlug, signal: options.signal,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw Object.assign(
        new Error(`Failed to translate Chapter ${ch.number} via model ${options.model}: ${message}`),
        { code: 'TRANSLATION_PROVIDER_ERROR', chapterNumber: ch.number, cause: err },
      )
    }
    writtenChapters.push(parseTranslatedChapter(raw, ch.number))
    currentStep++
  }

  // 5. Write only what this attempt produced; kept files are left byte-identical.
  if (writtenChapters.length || (translatedIntro && !introReused)) {
    const parts: NarrationParts = {
      intro: translatedIntro && !introReused ? { text: translatedIntro.text } : undefined,
      chapters: writtenChapters,
    }
    await writeChapterFiles(
      targetPaths.script_dir,
      targetEpisodeCode,
      targetTitle,
      parts,
      { normalizeSpokenProse: true },
    )
  }

  // 6. One unified narration from every chapter file on disk (kept + new).
  await withLock(targetPaths.narration_docx, () =>
    assembleUnifiedNarration(targetPaths.script_dir, targetEpisodeCode, targetTitle))

  // 7. Verified completion contract (§8) over EVERY expected chapter.
  await verifyTranslatedCompletion(
    targetPaths.script_dir,
    targetEpisodeCode,
    chaptersToTranslate.map(c => c.number),
    translateIntro,
  )

  // 8. Reuse visuals and scene plan if requested. The pictures travel; the source language's
  //    thumbnail headline and timings do not.
  let visualsReused = false
  let scenePlanReused = false
  let thumbnails: TranslationThumbnailReuse | null = null
  if (options.reuseVisuals !== false) {
    const copied = await copyVisualAssetsAndScenePlan(
      options.sourceSlug,
      options.sourceEpisodeId,
      options.targetSlug,
      targetEpisodeCode,
      targetLanguage,
    )
    visualsReused = copied.visualsReused
    scenePlanReused = copied.scenePlanReused
    thumbnails = copied.thumbnails
  }

  // 9. Provenance + resume state, beside the episode's own artifacts.
  await writeJsonAtomic(path.join(targetPaths.episode_dir, TRANSLATION_SIDECAR), {
    schema_version: 1,
    source_slug: options.sourceSlug,
    source_episode_id: options.sourceEpisodeId,
    source_language: sourceLanguage,
    target_language: targetLanguage,
    title_translated: titleResult.translated,
    translated_at: sidecar?.translated_at || new Date().toISOString(),
    glossary,
    ...(thumbnails ? { thumbnails } : {}),
  } satisfies TranslationProvenance)

  await options.onProgress?.(100, 'Translation complete.')

  return {
    targetSlug: options.targetSlug,
    targetEpisodeId: targetEpisodeCode,
    targetTitle,
    sourceSlug: options.sourceSlug,
    sourceEpisodeId: options.sourceEpisodeId,
    sourceLanguage,
    targetLanguage,
    translatedChapters: writtenChapters.map(c => c.number),
    reusedChapters,
    hasIntro: !!translatedIntro,
    titleTranslated: titleResult.translated,
    visualsReused,
    scenePlanReused,
    thumbnails,
  }
}

/**
 * The steps that follow a verified translation, built from the TARGET channel's
 * own presets: narration → audio assembly → subtitles → final video, plus
 * target-language metadata.
 *
 * A step whose preset is missing, has no voice, or (for metadata) names no
 * writing model is LEFT OUT with one plain sentence — the same rule Pipeline
 * preflight applies — and the reason is returned so the job log can say it.
 * Nothing here picks a model or a voice on the owner's behalf.
 */
export async function buildTranslateDownstreamChain(  targetSlug: string,
  episodeId: string,
  episodeTitle: string,
  targetLanguage: 'en' | 'km',
): Promise<{ chain: Array<{ type: string; title: string; params: Record<string, any> }>; leftOut: string[] }> {
  const { findActivePreset, resolveStepParams, stampPipelineStepFacts, presetHasNoWritingModel, jobTypeForStep } =
    await import('../routes/pipeline.js')
  const config = await pm.getConfig(targetSlug)
  const format = await getEffectiveFormat(targetSlug).catch(() => null)

  const steps = ['audio', 'audio_merge', 'subtitles', 'video_assembly', 'metadata'] as const
  const chain: Array<{ type: string; title: string; params: Record<string, any> }> = []
  const leftOut: string[] = []

  for (const step of steps) {
    const label = pipelineStepLabel(step)
    const { preset, missingReason } = findActivePreset(config, step)
    if (!preset) {
      leftOut.push(`${label}: ${missingReason || `no active preset — save one on the ${label} page.`}`)
      continue
    }
    const data = (preset.data ?? preset) as Record<string, any>
    if (step === 'audio') {
      const voice = data?.form?.voice ?? (preset as any)?.form?.voice
      if (!voice || !String(voice).trim()) {
        leftOut.push(`${label}: the preset has no voice selected — choose a voice on the Audio page and save the preset.`)
        continue
      }
    }
    if (step === 'metadata' && !(typeof data?.model === 'string' && data.model.trim())) {
      leftOut.push(`${label}: the preset has no writing model saved — open it on the YouTube Finalizer page, choose a writing model and save the preset. Story Studio does not pick one for you.`)
      continue
    }
    if (presetHasNoWritingModel(step, preset)) {
      leftOut.push(`${label}: the preset names no writing model — pick one on its page.`)
      continue
    }

    const params = resolveStepParams(step, episodeId, episodeTitle, preset, format)
    // Khmer is script-timed: its own narration IS the caption text (§9 owner rule).
    if (step === 'subtitles' && targetLanguage === 'km') params.method = 'script'
    chain.push({
      type: jobTypeForStep(step),
      title: `Pipeline: ${label} — ${episodeId}`,
      params,
    })
  }

  if (chain.length) stampPipelineStepFacts(chain, 'scene_plan')
  return { chain, leftOut }
}

/**
 * The `translate_episode` job. A Retry runs this again with the same params:
 * the service keeps chapters already on disk and translates only what is
 * missing, then the queue hands the verified episode to the next chain link.
 */
export async function generateTranslateEpisode(
  job: Job,
  /** Test seam: an injected AI caller, exactly like the service's own option. */
  overrides: { callAi?: TranslateEpisodeOptions['callAi'] } = {},
): Promise<void> {
  const params = job.params as Record<string, any>
  const sourceSlug = typeof params.source_slug === 'string' ? params.source_slug : ''
  const sourceEpisodeId = typeof params.source_episode_id === 'string' ? params.source_episode_id : ''
  const model = typeof params.model === 'string' ? params.model : ''
  if (!sourceSlug || !sourceEpisodeId) throw new Error('Translation job has no source episode.')
  if (!model.trim()) throw new Error('No writing model is chosen for this translation.')

  const { isCancelled } = await import('./job-queue.js')
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (isCancelled(job.job_id)) controller.abort()
  }, 500)

  let result: Awaited<ReturnType<typeof translateEpisodeScript>>
  try {
    result = await translateEpisodeScript({
      sourceSlug,
      sourceEpisodeId,
      targetSlug: job.project_slug,
      targetEpisodeId: job.episode_id,
      targetTitle: typeof params.target_title === 'string' ? params.target_title : undefined,
      model,
      reuseVisuals: params.reuse_visuals !== false,
      chapters: Array.isArray(params.chapters)
        ? (params.chapters as unknown[]).map(Number).filter(n => Number.isFinite(n) && n > 0)
        : undefined,
      signal: controller.signal,
      callAi: overrides.callAi,
      onProgress: (percent, message) => {
        job.progress = percent
        job.output_lines.push(message)
      },
    })
  } finally {
    clearInterval(cancelWatcher)
  }

  job.result = result as unknown as Record<string, unknown>
  job.progress = 100
  job.output_lines.push(
    `Translated ${result.translatedChapters.length} chapter(s)`
    + (result.reusedChapters.length ? `, kept ${result.reusedChapters.length} already translated` : '')
    + `; verified ${result.targetEpisodeId} complete.`,
  )
  // The source language's drawn thumbnail headline is never reused: say what is on disk and what
  // this episode still needs before upload.
  if (result.thumbnails) job.output_lines.push(`Thumbnails: ${result.thumbnails.note}`)

  const { chain, leftOut } = await buildTranslateDownstreamChain(
    job.project_slug, result.targetEpisodeId, result.targetTitle, result.targetLanguage,
  )
  for (const reason of leftOut) job.output_lines.push(`Left out — ${reason}`)
  // The queue advances this chain only after this job reports success, and it
  // enqueues each step under job.project_slug / job.episode_id — the target
  // channel and the translated episode.
  job.params.pipeline_chain = chain
  if (chain.length) {
    job.output_lines.push(`Continuing in ${result.targetSlug}: ${chain.map(link => link.title.replace(/^Pipeline: /, '').replace(/ — .*$/, '')).join(' → ')}.`)
  }
}
