/**
 * Thumbnail-prompt job executor.
 *
 * Scene visuals are planned exclusively in Scene Plan. This executor owns
 * only the separate YouTube-thumbnail prompt asset used by the Thumbnail
 * Generator and Pipeline.
 */

import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { callAi, parseStructuredJson } from '../lib/ai-client.js'
import { resolveEpisodePaths, resolveEpisodeTitleByCode, resolveSubfolderNames } from '../services/utils.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { trackGeneration } from '../services/session-tracker.js'
import { castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import { imagePromptGuidanceBlock } from '../lib/image-content-guidance.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import type { Job, ThumbnailRecipeProfile } from '../models/types.js'
import { resolveTextStyle, resolveFontStyle } from '../models/thumbnail-styles.js'
import { DEFAULT_HEADLINE_MODE, HEADLINE_MODE_IDS, headlineInstruction, headlineMode as resolveHeadlineMode } from '../models/thumbnail-headlines.js'
import { readArtifactRawText } from '../lib/episode-artifacts.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { writePromptCompletionManifest } from '../services/prompt-completion.js'
import { thumbnailPromptsOutputContract } from '../lib/story-output-contracts.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveDefaultChatModel } from '../services/genstudio-default-model.js'
import {
  buildPromptCharCapInstruction,
  describeOverCapPrompts,
  parsePromptCharCap,
} from '../services/prompt-char-cap.js'
import { truncateChars } from '../lib/well-formed-text.js'

interface ThumbnailPromptsParams {
  episode_id: string
  title?: string
  model?: string
  style_tag?: string
  aspect_ratio?: string
  thumb_count?: number
  thumb_text_style?: string
  thumb_text_position?: string
  thumb_font_style?: string
  /** Recipe-owned thumbnail copy strategy. The resolved recipe remains authoritative. */
  thumb_headline_mode?: string
  thumb_reference_style?: string
  thumb_creative_direction?: string
  /** A browsable Thumbnail Recipe Catalog id used to shape the generated prompt. */
  thumbnail_template_id?: string
  mode?: 'thumbnails'
  character_ids?: string[]
  fill_gaps?: boolean
  /**
   * The character CEILING each generated prompt is written under — GenStudio's
   * published `max_prompt_characters` for the image model the user intends to
   * render these thumbnails with, resolved by the workspace (only it knows
   * which model that is). Absent means no limit is in force: no instruction is
   * added and nothing is warned about. Never a length to fill, and no prompt is
   * ever truncated to fit. See services/prompt-char-cap.ts.
   */
  prompt_char_cap?: number
}

interface ThumbnailFmt {
  layout?: 'hero' | 'annotated-collage'
  conceptGuidance?: string
  compositionRules?: string[]
  defaultTextStyle?: string
  defaultFontStyle?: string
  moodKeywords?: string[]
  avoid?: string[]
  requiredElements?: string[]
  visualStyleGuidance?: string
  headlineMode?: string
  headlineGuidance?: string
  /** The mode the customer chose on this run. Beats the recipe's default. */
  headlineModeId?: string
}

const GENERIC_THUMBNAIL_CONCEPT =
  'A bold, high-impact YouTube cover with one clear focal subject that signals the topic at a glance. ' +
  'Use vivid saturated color, strong directional lighting, clear depth, and a composition designed to win the click.'

const GENERIC_THUMBNAIL_AVOID = [
  'low contrast or washed-out / muddy color',
  'tiny details that vanish at preview size',
  'busy collages or multiple competing subjects',
  'flat, evenly-lit, boring framing',
]

const ANNOTATED_COLLAGE_AVOID = [
  'a dense undifferentiated montage',
  'supporting callouts that compete with the central anchor',
  'tiny unreadable labels or long sentences',
  'photographic depth that hides the diagram structure',
]

const RATIO_DESCRIPTIONS: Record<string, string> = {
  '16:9': 'wide 16:9 landscape format with cinematic framing',
  '1:1': 'square 1:1 format with centered composition',
  '9:16': 'tall 9:16 portrait format with vertical composition',
  '4:3': 'classic 4:3 format',
  '3:4': 'portrait 3:4 format',
  '21:9': 'ultrawide 21:9 cinematic format',
}

function aiCreds(_config: unknown) {
  return {}
}

async function readStoryContext(
  slug: string,
  episodeId: string,
  title: string,
): Promise<string> {
  try {
    const paths = await resolveEpisodePaths(slug, episodeId, title || '')
    const raw = await readArtifactRawText(paths.narration_docx)
    return truncateChars(raw, 3000)
  } catch {
    return `Episode: ${episodeId}, Title: ${title || 'Unknown'}`
  }
}

function parseThumbnailPromptsJson(raw: string): any[] {
  const parsed = parseStructuredJson(raw) as Record<string, unknown>
  // Name what came back instead of what did not. Every failure here happens
  // after GenStudio completed and charged for the request, so "no JSON object"
  // with nothing else attached was the same information-destroying message that
  // made the scene-pack incident cost hours to diagnose.
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `GenStudio completed the request, but the thumbnail response parsed to ${parsed === null ? 'null' : typeof parsed}, not a JSON object. The result was rejected locally.`,
    )
  }
  if (Array.isArray(parsed)) {
    throw new Error(
      `GenStudio completed the request, but the thumbnail response was a bare array of ${parsed.length}, not an object with a "thumbnails" key. The result was rejected locally.`,
    )
  }
  if (!Array.isArray(parsed.thumbnails)) {
    throw new Error(
      `GenStudio completed the request, but the thumbnail response has no "thumbnails" array (present: ${JSON.stringify(Object.keys(parsed))}). The result was rejected locally.`,
    )
  }
  return parsed.thumbnails
}

export function normalizeGeneratedPromptItems(items: any[], expected: number): any[] {
  return (Array.isArray(items) ? items : [])
    .filter(item => item && typeof item.prompt === 'string' && item.prompt.trim())
    .slice(0, Math.max(0, expected))
    .map((item, index) => ({ ...item, number: index + 1, prompt: item.prompt.trim() }))
}

/** Build a compact, opinionated thumbnail brief. */
export function buildThumbnailDirective(opts: {
  thumbs: number
  title: string
  textStyle?: string
  fontStyle?: string
  textPosition?: string
  referenceStyle?: string
  fmt?: ThumbnailFmt | null
  creativeDirection?: string
  /** The headline mode the customer chose on this run. Beats the recipe's. */
  headlineModeId?: string
}): string {
  if (opts.thumbs <= 0) return ''
  const annotatedCollage = opts.fmt?.layout === 'annotated-collage'
  const layoutGuidance = annotatedCollage
    ? 'Use one large central anchor subject plus a disciplined ring of small supporting object callouts. Keep every callout visually subordinate, separated by white space, and readable at mobile size. This is an annotated explainer cover.'
    : 'Use one dominant focal subject, an immediate emotional hook, strong subject/background separation, and an uncluttered composition that keeps the title easy to read at mobile size.'
  const universalAvoid = annotatedCollage ? ANNOTATED_COLLAGE_AVOID : GENERIC_THUMBNAIL_AVOID
  // The mode the CUSTOMER chose wins over the recipe's own default. The recipe
  // still supplies one when nothing has been chosen, which is what it is for --
  // but it must not overrule a deliberate choice, which is exactly the
  // "there's no proper control" this replaces.
  const selectedHeadlineMode = opts.headlineModeId || opts.fmt?.headlineMode || DEFAULT_HEADLINE_MODE
  const headlineInstructionText = headlineInstruction(selectedHeadlineMode, opts.title)
  const lines = [
    `THUMBNAIL GOAL: create a distinct, professional YouTube cover. It must communicate the episode's emotional promise at a glance on mobile.`,
    `CONCEPT: ${(opts.fmt?.conceptGuidance || '').trim() || GENERIC_THUMBNAIL_CONCEPT}`,
    `LAYOUT: ${layoutGuidance}`,
    `Avoid: ${[...(opts.fmt?.avoid || []), ...universalAvoid].join('; ')}.`,
    headlineInstructionText,
  ]
  const fontStyle = !opts.fontStyle || opts.fontStyle === 'auto'
    ? opts.fmt?.defaultFontStyle
    : opts.fontStyle
  const textStyle = !opts.textStyle || opts.textStyle === 'auto'
    ? opts.fmt?.defaultTextStyle
    : opts.textStyle
  const font = fontStyle ? resolveFontStyle(fontStyle) : ''
  const text = textStyle ? resolveTextStyle(textStyle) : ''
  const position = !opts.textPosition || opts.textPosition === 'auto' ? '' : opts.textPosition
  if (!font && !text && !position) {
    lines.push('TITLE DESIGN: choose the font, text treatment, and placement that best suits each variation while keeping the title highly readable.')
  } else {
    lines.push(`TITLE DESIGN: ${font ? `use ${font}` : 'choose the font'}; ${text ? `use ${text}` : 'choose the text treatment'}; ${position ? `place it at the ${position}` : 'choose the strongest placement'}.`)
  }
  if (opts.fmt?.compositionRules?.length) {
    lines.push(`COMPOSITION:\n${opts.fmt.compositionRules.map(rule => `  - ${rule}`).join('\n')}`)
  }
  if (opts.fmt?.requiredElements?.length) lines.push(`REQUIRED VISUAL ELEMENTS: ${opts.fmt.requiredElements.join('; ')}`)
  if (opts.fmt?.moodKeywords?.length) lines.push(`MOOD: ${opts.fmt.moodKeywords.join(', ')}`)
  if (opts.fmt?.visualStyleGuidance?.trim()) lines.push(`RECIPE VISUAL LANGUAGE: ${opts.fmt.visualStyleGuidance.trim()}`)
  if (opts.fmt?.headlineGuidance?.trim()) lines.push(`HEADLINE RULES: ${opts.fmt.headlineGuidance.trim()}`)
  if (opts.creativeDirection?.trim()) lines.push(`USER IDEA: ${opts.creativeDirection.trim()}`)
  if (opts.referenceStyle?.trim()) lines.push(`REFERENCE DIRECTION: ${opts.referenceStyle.trim()}`)
  return lines.join('\n\n')
}

export function enforceThumbnailPromptElements(prompt: string, opts: {
  aspectRatio: string
  title: string
  textStyle?: string
  fontStyle?: string
  textPosition?: string
  headlineMode?: string
}): string {
  const out = (prompt || '').trim()
  if (!out) return out
  const ratio = opts.aspectRatio || '16:9'
  const ratioPhrase = RATIO_DESCRIPTIONS[ratio] || `${ratio} format`
  const clauses: string[] = []
  if (!out.includes(ratio)) {
    clauses.push(`Rendered as a ${ratioPhrase} — this is a YouTube thumbnail (${ratio}).`)
  } else if (!/thumbnail/i.test(out)) {
    clauses.push('This is a YouTube thumbnail.')
  }
  if (opts.title.trim() && !out.includes(opts.title.trim())) {
    const font = !opts.fontStyle || opts.fontStyle === 'auto'
      ? 'a font chosen to suit the concept'
      : resolveFontStyle(opts.fontStyle)
    const text = !opts.textStyle || opts.textStyle === 'auto'
      ? 'a treatment chosen to suit the concept'
      : resolveTextStyle(opts.textStyle)
    const position = !opts.textPosition || opts.textPosition === 'auto'
      ? 'the strongest placement for the composition'
      : opts.textPosition
    const headlineLabel = opts.headlineMode === 'curiosity-hook' ? 'thumbnail hook' : 'episode title'
    clauses.push(`Render the exact ${headlineLabel} "${opts.title.trim()}" inside the image as large, highly legible display text using ${font}, ${text}, positioned at ${position}. This is the finished thumbnail; do not use placeholder or gibberish lettering.`)
  }
  return clauses.length ? `${out}\n\n${clauses.join(' ')}` : out
}

export function buildThumbnailPrompt(args: {
  episodeId: string
  title: string
  storyContext: string
  castBlock: string
  count: number
  styleTag: string
  aspectRatio: string
  thumbnailDirective: string
  targetNumbers: number[]
  headlineMode?: string
  /** Published image-model ceiling, or absent for "no limit in force". */
  promptCharCap?: number
}): string {
  const ratioInstruction = RATIO_DESCRIPTIONS[args.aspectRatio] || `${args.aspectRatio} format`
  const curiosityHook = args.headlineMode === 'curiosity-hook'
  const headlineRequirement = curiosityHook
    ? '4. Invent a truthful 1–4 word curiosity hook for every variation. Return it in that variation\'s "title" field and render the exact same hook as legible in-image typography. Do not put the full episode title inside the artwork.'
    : '4. Render the exact episode title as legible in-image typography.'
  const titleExample = curiosityHook ? 'SHORT CURIOSITY HOOK' : args.title.replace(/"/g, '\\"')
  // A ceiling, never a length to reach: requirement 2 above still decides how
  // long a prompt should be. Empty when no limit is in force.
  const charCapInstruction = buildPromptCharCapInstruction(args.promptCharCap)
  const charCapRequirement = charCapInstruction ? `\n8. ${charCapInstruction}` : ''
  return `Create exactly ${args.count} distinct YouTube thumbnail briefs for this story episode.

Episode: ${args.episodeId} — ${args.title}

Story context:
${args.storyContext}
${args.castBlock}
REQUIREMENTS:
1. Return entries for thumbnail numbers ${args.targetNumbers.join(', ')} in that order.
2. Each prompt must be detailed: 60–120 words across 3–5 sentences.
3. Specify the click-driving focal image, emotional hook, subject, setting, props, lighting, atmosphere, framing, and composition.
${headlineRequirement}
5. End every prompt with this style tag: "${args.styleTag}".
6. Compose every prompt for ${ratioInstruction} and explicitly state the "${args.aspectRatio}" aspect ratio.
7. Include concrete inline descriptions for every visible recurring character.${charCapRequirement}

FORMAT — return only this JSON object:
{
  "thumbnails": [
    {"number": ${args.targetNumbers[0] || 1}, "title": "${titleExample}", "prompt": "Full prompt text..."}
  ]
}

${args.thumbnailDirective}
${imagePromptGuidanceBlock()}

No markdown and no commentary.`
}

async function loadExistingThumbnails(
  projectSlug: string,
  episodeId: string,
  title: string,
): Promise<any[]> {
  try {
    const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
    const paths = await resolveEpisodePaths(projectSlug, episodeId, title)
    let episodeDir = paths.episode_dir.replace(/\/$/, '')
    const actualDir = await resolveEpisodeDir(path.dirname(episodeDir), episodeId)
    if (actualDir) episodeDir = actualDir
    const names = await resolveSubfolderNames(projectSlug, episodeId)
    const thumbDir = await resolveSubfolder(episodeDir, names.thumb_prompts)
    if (!thumbDir) return []
    const filename = path.join(thumbDir, `${episodeId}_Thumbnail_Prompts.md`)
    await fs.access(filename)
    const parsed = await parseImagePromptsDocx(filename)
    return Array.isArray(parsed.thumbnails) ? parsed.thumbnails : []
  } catch {
    return []
  }
}

/**
 * Resolve the default text model for a thumbnail-prompt run when neither the
 * request nor the project's saved `prompt_model` gave one — or the saved
 * one is no longer live. Never falls back to a hardcoded external product
 * id; GenStudio owns the catalog.
 */
async function resolveDefaultImagePromptsModel(config: any): Promise<string> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    throw new Error('No GenStudio API key configured. Add it in Settings → This Mac before generating thumbnail prompts.')
  }
  const saved = typeof config?.prompt_model === 'string' ? config.prompt_model : null
  const resolved = await resolveDefaultChatModel(apiKey, saved)
  return resolved.modelId
}

export async function generateImagePrompts(job: Job): Promise<void> {
  const { project_slug: projectSlug, episode_id: episodeId, params } = job
  const req = params as ThumbnailPromptsParams
  if (req.mode && req.mode !== 'thumbnails') {
    throw new Error('Legacy visual-prompt generation is retired. Generate visual prompts in Scene Plan.')
  }

  const config = await pm.getConfig(projectSlug)
  if (!config) throw new Error('Project config not found')

  /**
   * AN EPISODE CODE IS NOT A HEADLINE.
   *
   * This read `req.title || episodeId`, and the resolved title is rendered as
   * the display text INSIDE the thumbnail. With no title on the request, every
   * one of five prompts came back reading
   *
   *   Large bold sans-serif text 'EP0344' is placed on the right
   *
   * — five images with a filing code printed across them, and credits spent to
   * produce them. Measured on a real devotional channel, 2026-08-24.
   *
   * The episode already knows its own title: the folder was created from the
   * idea's title and `resolveEpisodeTitleByCode` reads it back the same way.
   * If there is genuinely no title anywhere, this refuses rather than printing
   * a code — a thumbnail with no words is a fixable mistake, five thumbnails
   * with "EP0344" on them are wasted money.
   */
  const requestedTitle = String(req.title || '').trim()
  const title = requestedTitle || await resolveEpisodeTitleByCode(projectSlug, episodeId)
  if (!title || title === episodeId) {
    throw new Error(
      `This episode has no title yet, and an episode code is not thumbnail text. ` +
      `Give ${episodeId} a title in Ideas or Metadata, then generate its thumbnail prompts.`,
    )
  }
  // A missing model is resolved against GenStudio's live catalog rather than
  // a hardcoded external product id — GenStudio owns the catalog and a
  // retired/renamed literal must never be submitted blind (see
  // services/genstudio-default-model.ts).
  const model = req.model?.trim() || await resolveDefaultImagePromptsModel(config)
  const count = Math.max(1, Math.round(Number(req.thumb_count) || 5))
  const fillGaps = req.fill_gaps === true
  // Resolved by the workspace from the intended image model's published
  // `max_prompt_characters`. Absent = no limit in force; nothing is invented.
  const promptCharCap = parsePromptCharCap(req.prompt_char_cap)
  job.output_lines.push(`Target: ${count} thumbnail prompt(s).`)
  job.output_lines.push(promptCharCap
    ? `Prompt length ceiling: ${promptCharCap.toLocaleString()} characters per thumbnail prompt. A ceiling only — an over-length prompt is reported, never shortened.`
    : 'Prompt length ceiling: none — no image-model limit is in force for this run.')

  const existing = fillGaps
    ? (await loadExistingThumbnails(projectSlug, episodeId, title))
      .filter(item => {
        const number = Number(item?.number)
        return Number.isInteger(number) && number >= 1 && number <= count &&
          typeof item?.prompt === 'string' && item.prompt.trim()
      })
      .map(item => ({ ...item, number: Number(item.number), prompt: item.prompt.trim() }))
    : []
  const existingByNumber = new Map(existing.map(item => [Number(item.number), item]))
  const targetNumbers = Array.from({ length: count }, (_, index) => index + 1)
    .filter(number => !existingByNumber.has(number))
  if (fillGaps) {
    job.output_lines.push(
      targetNumbers.length
        ? `[repair] ${existingByNumber.size}/${count} verified on disk; requesting only ${targetNumbers.length} missing thumbnail prompt(s).`
        : `[repair] all ${count} thumbnail prompts are already verified on disk.`,
    )
  }

  let thumbnails = [...existingByNumber.values()]
  // An explicit choice on the request is authoritative; otherwise the recipe
  // supplies one below; otherwise the catalogue's default.
  let headlineMode: string = HEADLINE_MODE_IDS.includes(String(req.thumb_headline_mode))
    ? String(req.thumb_headline_mode)
    : DEFAULT_HEADLINE_MODE
  if (targetNumbers.length > 0) {
    const storyContext = await readStoryContext(projectSlug, episodeId, title)
    const characters = Array.isArray(req.character_ids) && req.character_ids.length
      ? await cm.resolveCharacters(projectSlug, req.character_ids)
      : []
    const castBlock = castImagePromptBlock(characters)
    if (characters.length) job.output_lines.push(`Cast: ${characters.map(character => character.name).join(', ')}`)

    let thumbnailFormat: ThumbnailFmt | null = null
    let recipeName = ''
    try {
      const { getEffectiveFormat } = await import('../services/format-loader.js')
      const format = await getEffectiveFormat(projectSlug)
      thumbnailFormat = (format?.imagePrompts as any)?.thumbnail || null
    } catch {
      // The generic thumbnail direction remains valid without a format file.
    }
    // A selected catalog recipe sharpens (and, for its explicit fields,
    // overrides) the format's broad thumbnail defaults. It deliberately does
    // not replace the project art style — composition and rendering remain
    // separate choices.
    let recipe: ThumbnailRecipeProfile | undefined
    try {
      const { loadTemplate, getEffectiveTemplateFor } = await import('../services/thumbnail-template-loader.js')
      const selectedId = typeof req.thumbnail_template_id === 'string' && req.thumbnail_template_id.trim()
        ? req.thumbnail_template_id.trim()
        : ''
      let template = selectedId ? await loadTemplate(selectedId) : null
      if (!template && !selectedId) {
        const project = await pm.getProject(projectSlug)
        if (project) {
          const { getEffectiveNicheFor } = await import('../services/niche-loader.js')
          template = await getEffectiveTemplateFor(project, await getEffectiveNicheFor(project), config as any)
        }
      }
      if (selectedId && !template) throw new Error(`Thumbnail Recipe '${selectedId}' was not found`)
      if (template) {
        recipe = template.recipe
        recipeName = template.name
      }
    } catch (error: any) {
      throw new Error(`Could not resolve Thumbnail Recipe: ${error?.message || error}`)
    }
    if (recipe) {
      thumbnailFormat = {
        ...(thumbnailFormat || {}),
        layout: recipe.layout,
        conceptGuidance: recipe.conceptGuidance,
        compositionRules: recipe.compositionRules || thumbnailFormat?.compositionRules,
        requiredElements: recipe.requiredElements,
        avoid: recipe.avoid || thumbnailFormat?.avoid,
        defaultTextStyle: recipe.defaultTextStyle || thumbnailFormat?.defaultTextStyle,
        defaultFontStyle: recipe.defaultFontStyle || thumbnailFormat?.defaultFontStyle,
        visualStyleGuidance: recipe.visualStyleGuidance,
        headlineMode: recipe.headlineMode,
        headlineGuidance: recipe.headlineGuidance,
      }
      // The recipe supplies a DEFAULT. It no longer overrules the customer,
      // who may not have chosen at all — in which case this is the choice.
      if (!req.thumb_headline_mode && recipe?.headlineMode) headlineMode = recipe.headlineMode
    }
    const thumbnailDirective = buildThumbnailDirective({
      thumbs: targetNumbers.length,
      title,
      textStyle: req.thumb_text_style || 'auto',
      fontStyle: req.thumb_font_style || 'auto',
      textPosition: req.thumb_text_position || 'auto',
      referenceStyle: req.thumb_reference_style,
      fmt: thumbnailFormat,
      creativeDirection: req.thumb_creative_direction,
      headlineModeId: headlineMode,
    })
    job.output_lines.push(
      `Thumbnail art direction: ${recipeName ? `recipe “${recipeName}”` : thumbnailFormat ? 'format-specific' : 'generic high-CTR'}, ` +
      `headline: ${resolveHeadlineMode(headlineMode).label.toLowerCase()}` +
      (req.thumb_reference_style ? ', reference style applied' : '') +
      (req.thumb_creative_direction ? ', user idea applied' : ''),
    )

    const explicitStyleTag = (req.style_tag || '').trim()
    const artStyle = explicitStyleTag ? null : await resolveProjectArtStyle(projectSlug)
    let styleTag = explicitStyleTag || artStyle?.description || ''
    if (!styleTag) {
      try {
        const { getEffectiveFormat } = await import('../services/format-loader.js')
        const format = await getEffectiveFormat(projectSlug)
        styleTag = (((format?.imagePrompts as any)?.defaultStyleTag) || '').trim()
      } catch {
        // An empty style tag is explicit and does not restore a legacy style.
      }
    }
    if (artStyle) {
      job.output_lines.push(
        `Art style applied (${artStyle.source}${artStyle.name ? `: ${artStyle.name}` : ''})` +
        (artStyle.referenceImagePaths.length ? '; reference image available to image generation' : ''),
      )
    }

    let prompt = buildThumbnailPrompt({
      episodeId,
      title,
      storyContext,
      castBlock,
      count: targetNumbers.length,
      styleTag,
      aspectRatio: req.aspect_ratio || '16:9',
      thumbnailDirective,
      targetNumbers,
      headlineMode,
      promptCharCap,
    })
    if (artStyle?.negatives.length) {
      prompt += `\n\nAvoid in all thumbnail artwork: ${artStyle.negatives.join(', ')}`
    }
    try {
      const { prependAvoidanceToPrompt } = await import('../services/recency-tracker.js')
      prompt = await prependAvoidanceToPrompt(projectSlug, 'image_prompts', prompt)
    } catch {
      // Recency enrichment cannot block generation.
    }

    const controller = new AbortController()
    const cancelWatcher = setInterval(() => {
      if (jq.isCancelled(job.job_id)) controller.abort()
    }, 500)
    try {
      job.output_lines.push(`Calling ${model} for ${targetNumbers.length} thumbnail prompt(s)…`)
      const raw = await callAi(model, '', prompt, aiCreds(config), false, {
        slug: projectSlug,
        jobId: job.job_id,
        signal: controller.signal,
        outputContract: thumbnailPromptsOutputContract(targetNumbers.length),
        // Standard: a structured pack of N thumbnail prompts.
        outputBudget: 'standard',
        disableReasoning: true,
        temperature: 0.35,
      })
      const generated = normalizeGeneratedPromptItems(
        parseThumbnailPromptsJson(raw),
        targetNumbers.length,
      // Episode-title recipes preserve the real episode title. Curiosity-hook
      // recipes intentionally keep the LLM's short, per-variation hook as the
      // editable thumbnail headline while YouTube metadata keeps its full
      // factual episode title elsewhere.
      ).map((item, index) => ({
        ...item,
        title: headlineMode === 'curiosity-hook' ? String(item.title || '').trim() : title,
        number: targetNumbers[index],
      }))
      for (const item of generated) existingByNumber.set(Number(item.number), item)
      thumbnails = [...existingByNumber.values()].sort((a, b) => Number(a.number) - Number(b.number))
    } finally {
      clearInterval(cancelWatcher)
    }
  }

  thumbnails = thumbnails.map(item => ({
    ...item,
    prompt: enforceThumbnailPromptElements(String(item.prompt || ''), {
      aspectRatio: req.aspect_ratio || '16:9',
      title,
      textStyle: req.thumb_text_style || 'auto',
      fontStyle: req.thumb_font_style || 'auto',
      textPosition: req.thumb_text_position || 'auto',
      headlineMode,
    }),
  }))
  const missing = Array.from({ length: count }, (_, index) => index + 1)
    .filter(number => !thumbnails.some(item => Number(item.number) === number && item.prompt?.trim()))
  job.output_lines.push(`Verified ${count - missing.length}/${count} thumbnail prompt(s).`)
  // Advisory only. Every prompt is saved in full; nothing is shortened.
  const overCapNotice = describeOverCapPrompts(
    thumbnails.map(item => ({ label: `thumbnail ${item.number}`, text: item.prompt })),
    promptCharCap,
  )
  if (overCapNotice) job.output_lines.push(overCapNotice)

  try {
    const { recordUsageForScope } = await import('../services/recency-tracker.js')
    const joined = thumbnails.map(item => `${item.title || ''}\n${item.prompt || ''}`).join('\n\n')
    await recordUsageForScope(projectSlug, episodeId, 'image_prompts', joined)
  } catch (error: any) {
    job.output_lines.push(`Recency tracking skipped: ${error?.message || error}`)
  }

  const paths = await resolveEpisodePaths(projectSlug, episodeId, title)
  let episodeDir = paths.episode_dir.replace(/\/$/, '')
  const actualDir = await resolveEpisodeDir(path.dirname(episodeDir), episodeId)
  if (actualDir) episodeDir = actualDir
  const names = await resolveSubfolderNames(projectSlug, episodeId)
  const thumbDir = await resolveSubfolder(episodeDir, names.thumb_prompts)
  if (!thumbDir) throw new Error(`Thumbnail prompts folder not found: ${names.thumb_prompts}`)
  if (thumbnails.length > 0) {
    let output = '# Thumbnail Prompts\n\n'
    for (const item of thumbnails) {
      output += `## Thumbnail ${item.number}: ${item.title || `Variation ${item.number}`}\n\n${item.prompt}\n\n`
    }
    const outputPath = path.join(thumbDir, `${episodeId}_Thumbnail_Prompts.md`)
    await buildImagePromptsDocx(output, episodeId, title, outputPath)
    job.output_lines.push(`Saved thumbnails → ${path.basename(outputPath)}`)
  }
  await writePromptCompletionManifest(thumbDir, episodeId, 'thumbnail', count)
  await trackGeneration(projectSlug, 'prompts').catch(() => {})

  requireJobCompletion(job, {
    label: 'Thumbnail prompt generation',
    expected: count,
    completed: count - missing.length,
    missing: missing.map(number => `Thumbnail ${number}`),
    retry_hint: 'Verified prompts were saved; Retry requests only the missing thumbnail prompts.',
  })
  job.output_lines.push('Done.')
}
