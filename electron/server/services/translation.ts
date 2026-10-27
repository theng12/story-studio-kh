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
import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { ScenePlan } from '../models/types.js'

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
  hasIntro: boolean
  visualsReused: boolean
  scenePlanReused: boolean
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
 * Construct prompts for translating a single chapter.
 */
export function buildChapterTranslationPrompt(
  sourceLanguage: 'en' | 'km',
  targetLanguage: 'en' | 'km',
  chapter: { number: number; title: string; text: string },
  episodeTitle?: string,
): { system: string; user: string } {
  const sourceName = sourceLanguage === 'km' ? 'Khmer' : 'English'
  const targetName = targetLanguage === 'km' ? 'Khmer' : 'English'
  const chNumStr = String(chapter.number).padStart(2, '0')

  const system = [
    `You are an expert translator specializing in natural narrative storytelling between ${sourceName} and ${targetName}.`,
    `Translate the provided chapter from ${sourceName} into ${targetName}.`,
    'Maintain the exact chapter structure:',
    `- First line must be the chapter heading: ## Chapter ${chNumStr}: <translated chapter title>`,
    '- Follow with the translated narration paragraphs.',
    targetLanguage === 'km'
      ? 'Write natural, literary Khmer prose suitable for audio voiceover narration. Use proper Khmer grammar, spacing, and punctuation (such as ។ and ៕).'
      : 'Write natural, engaging English prose suitable for audio voiceover narration.',
    'Do not include markdown codeblocks (```), translator notes, explanations, or commentary. Output only the chapter markdown.',
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
 * Construct prompts for translating an introduction.
 */
export function buildIntroductionTranslationPrompt(
  sourceLanguage: 'en' | 'km',
  targetLanguage: 'en' | 'km',
  introText: string,
  episodeTitle?: string,
): { system: string; user: string } {
  const sourceName = sourceLanguage === 'km' ? 'Khmer' : 'English'
  const targetName = targetLanguage === 'km' ? 'Khmer' : 'English'

  const system = [
    `You are an expert translator specializing in natural narrative storytelling between ${sourceName} and ${targetName}.`,
    `Translate the provided episode introduction from ${sourceName} into ${targetName}.`,
    'Maintain the exact introduction structure:',
    '- First line must be: # Introduction',
    '- Follow with the translated introduction paragraphs.',
    targetLanguage === 'km'
      ? 'Write natural, literary Khmer prose suitable for audio voiceover narration. Use proper Khmer grammar and punctuation (such as ។ and ៕).'
      : 'Write natural, engaging English prose suitable for audio voiceover narration.',
    'Do not include markdown codeblocks (```), translator notes, explanations, or commentary. Output only the introduction markdown.',
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
 */
export async function copyVisualAssetsAndScenePlan(
  sourceSlug: string,
  sourceEpisodeCode: string,
  targetSlug: string,
  targetEpisodeCode: string,
): Promise<{ visualsReused: boolean; scenePlanReused: boolean }> {
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

  // 2. Copy thumbnails
  if (existsSync(sourcePaths.thumb_dir)) {
    await fs.mkdir(targetPaths.thumb_dir, { recursive: true })
    const files = await fs.readdir(sourcePaths.thumb_dir).catch(() => [] as string[])
    for (const file of files) {
      if (/\.(?:webp|png|jpe?g)$/i.test(file)) {
        await fs.copyFile(path.join(sourcePaths.thumb_dir, file), path.join(targetPaths.thumb_dir, file))
        visualsReused = true
      }
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
        await fs.mkdir(targetPaths.scene_prompts_dir, { recursive: true })
        const targetPlanPath = path.join(targetPaths.scene_prompts_dir, SCENE_PLAN_SIDECAR)
        await writeJsonAtomic(targetPlanPath, plan)
        scenePlanReused = true
      }
    } catch {
      // Ignore corrupt source plan
    }
  }

  return { visualsReused, scenePlanReused }
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

/**
 * Execute end-to-end episode translation.
 *
 * shortcut: runs inside the caller's HTTP request (no job row), so a very long
 * episode keeps that request open. Upgrade to a queued job when a chapter
 * translation is expected to take minutes.
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

  const chaptersToTranslate = options.chapters?.length
    ? sourceScript.chapters.filter(ch => options.chapters!.includes(ch.number))
    : sourceScript.chapters

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

  if (!chaptersToTranslate.length) {
    throw Object.assign(new Error('No matching chapters found to translate.'), { statusCode: 400 })
  }

  const totalSteps = chaptersToTranslate.length + (sourceScript.intro && !options.chapters?.length ? 1 : 0)
  let currentStep = 0

  const aiCaller = options.callAi || ((m: string, s: string, u: string, ctx?: CallAiContext) =>
    callAiWithRetry(m, s, u, {}, false, ctx))

  // 1. Translate Introduction if present and translating full episode
  let translatedIntro: IntroductionToTranslate | undefined
  if (sourceScript.intro && !options.chapters?.length) {
    await options.onProgress?.(
      Math.round((currentStep / totalSteps) * 100),
      'Translating introduction...',
    )
    const introPrompt = buildIntroductionTranslationPrompt(
      sourceLanguage,
      targetLanguage,
      sourceScript.intro.text,
      sourceScript.title,
    )
    let rawIntro: string
    try {
      rawIntro = await aiCaller(
        options.model,
        introPrompt.system,
        introPrompt.user,
        { slug: options.targetSlug, signal: options.signal },
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw Object.assign(
        new Error(`Failed to translate Introduction via model ${options.model}: ${message}`),
        { code: 'TRANSLATION_PROVIDER_ERROR', cause: err },
      )
    }
    translatedIntro = parseTranslatedIntro(rawIntro)
    currentStep++
  }

  // 2. Translate Chapters
  const translatedChapters: ChapterToTranslate[] = []
  for (const ch of chaptersToTranslate) {
    if (options.signal?.aborted) throw new Error('Translation aborted.')
    await options.onProgress?.(
      Math.round((currentStep / totalSteps) * 100),
      `Translating Chapter ${ch.number}...`,
    )
    const chPrompt = buildChapterTranslationPrompt(
      sourceLanguage,
      targetLanguage,
      ch,
      sourceScript.title,
    )
    let raw: string
    try {
      raw = await aiCaller(
        options.model,
        chPrompt.system,
        chPrompt.user,
        { slug: options.targetSlug, signal: options.signal },
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw Object.assign(
        new Error(`Failed to translate Chapter ${ch.number} via model ${options.model}: ${message}`),
        { code: 'TRANSLATION_PROVIDER_ERROR', chapterNumber: ch.number, cause: err },
      )
    }
    const parsed = parseTranslatedChapter(raw, ch.number)
    translatedChapters.push(parsed)
    currentStep++
  }

  // 3. Resolve or create target episode in target channel
  let targetEpisodeCode = options.targetEpisodeId
  let targetTitle = options.targetTitle || sourceScript.title

  if (!targetEpisodeCode) {
    // Add new accepted idea to target channel
    const [createdIdea] = await ideas.addIdeas(options.targetSlug, [{
      title: targetTitle,
      logline: `[Translated from ${options.sourceSlug}/${options.sourceEpisodeId}] ${sourceScript.title}`,
      themes: [],
      suggested_chapters: translatedChapters.length,
      suggested_length: 'standard',
      mood: 'neutral',
    }], options.model)

    if (!createdIdea) {
      throw new Error('Failed to create idea for translated episode in target project.')
    }

    const accepted = await ideas.acceptIdea(options.targetSlug, createdIdea.id, false)
    targetEpisodeCode = accepted.episode_code
    targetTitle = createdIdea.title
  } else {
    // Check if target episode already exists, else create with override_code
    const targetPaths = await resolveEpisodePathsByCode(options.targetSlug, targetEpisodeCode)
    if (!existsSync(targetPaths.episode_dir)) {
      const [createdIdea] = await ideas.addIdeas(options.targetSlug, [{
        title: targetTitle,
        logline: `[Translated from ${options.sourceSlug}/${options.sourceEpisodeId}] ${sourceScript.title}`,
        themes: [],
        suggested_chapters: translatedChapters.length,
        suggested_length: 'standard',
        mood: 'neutral',
      }], options.model)
      if (!createdIdea) {
        throw new Error('Failed to create idea for translated episode in target project.')
      }
      const accepted = await ideas.acceptIdea(options.targetSlug, createdIdea.id, false, {
        override_code: targetEpisodeCode,
      })
      targetEpisodeCode = accepted.episode_code
      targetTitle = createdIdea.title
    } else {
      // Existing episode: reuse its own title so a translation never renames it.
      const targetIdeas = await ideas.getIdeas(options.targetSlug).catch(() => [] as ideas.StoredIdea[])
      const existingTitle = targetIdeas.find(i => i.episode_code?.toUpperCase() === targetEpisodeCode!.toUpperCase())?.title
      if (existingTitle) targetTitle = existingTitle
    }
  }

  const targetPaths = await resolveEpisodePathsByCode(options.targetSlug, targetEpisodeCode)

  // 4. Write translated chapter files & assemble unified narration
  const parts: NarrationParts = {
    intro: translatedIntro ? { text: translatedIntro.text } : undefined,
    chapters: translatedChapters,
  }

  await writeChapterFiles(
    targetPaths.script_dir,
    targetEpisodeCode,
    targetTitle,
    parts,
    { normalizeSpokenProse: true },
  )

  await assembleUnifiedNarration(
    targetPaths.script_dir,
    targetEpisodeCode,
    targetTitle,
  )

  // 5. Verified completion contract (§8)
  await verifyTranslatedCompletion(
    targetPaths.script_dir,
    targetEpisodeCode,
    translatedChapters.map(c => c.number),
    !!translatedIntro,
  )

  // 6. Reuse visuals and scene plan if requested
  let visualsReused = false
  let scenePlanReused = false
  if (options.reuseVisuals !== false) {
    const copied = await copyVisualAssetsAndScenePlan(
      options.sourceSlug,
      options.sourceEpisodeId,
      options.targetSlug,
      targetEpisodeCode,
    )
    visualsReused = copied.visualsReused
    scenePlanReused = copied.scenePlanReused
  }

  await options.onProgress?.(100, 'Translation complete.')

  return {
    targetSlug: options.targetSlug,
    targetEpisodeId: targetEpisodeCode,
    targetTitle,
    sourceSlug: options.sourceSlug,
    sourceEpisodeId: options.sourceEpisodeId,
    sourceLanguage,
    targetLanguage,
    translatedChapters: translatedChapters.map(c => c.number),
    hasIntro: !!translatedIntro,
    visualsReused,
    scenePlanReused,
  }
}
