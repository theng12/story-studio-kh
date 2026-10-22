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
import { callAi, callAiWithModelPolicy, parseStructuredJson } from '../lib/ai-client.js'
import { resolveEpisodePaths, resolveEpisodeTitleByCode, resolveSubfolderNames } from '../services/utils.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { trackGeneration } from '../services/session-tracker.js'
import { castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import { imagePromptGuidanceBlock } from '../lib/image-content-guidance.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import type { Character, Job, ThumbnailRecipeProfile } from '../models/types.js'
import { resolveTextStyle, resolveFontStyle } from '../models/thumbnail-styles.js'
import { letteringPhraseMaps, type LetteringPhraseMaps } from '../services/lettering-catalogue.js'
import { DEFAULT_HEADLINE_MODE, HEADLINE_MODE_IDS, headlineInstruction, headlineInvents, headlineMode as resolveHeadlineMode } from '../models/thumbnail-headlines.js'
import { readArtifactRawText } from '../lib/episode-artifacts.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { writePromptCompletionManifest } from '../services/prompt-completion.js'
import { thumbnailPromptsOutputContract } from '../lib/story-output-contracts.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveChosenChatModel } from '../services/genstudio-default-model.js'
import { freshGenerationRequestIdentity } from '../lib/fresh-generation-action.js'
import {
  addAssemblyOverhead,
  buildPromptCharCapInstruction,
  describeOverCapPrompts,
  measureAssemblyOverhead,
  promptBodyCeiling,
  type AssemblyOverhead,
} from '../services/prompt-char-cap.js'
import { requireLiveImagePromptCharCap } from '../services/image-prompt-cap.js'
import {
  assembleThumbnailRenderPrompt,
  castStyleKeywordBound,
  matchedStyleKeywords,
  savedThumbnailReferenceGuidanceFor,
  thumbnailRenderAssemblyOverhead,
} from './images.js'
import { truncateChars } from '../lib/well-formed-text.js'
import { pipelinePolicyCheckpointStore, pipelinePolicyForJob } from '../lib/pipeline-model-policy.js'

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
  /**
   * The customer's own words for the `custom` lettering ids. `resolveTextStyle`
   * / `resolveFontStyle` have always accepted them, but nothing ever sent them,
   * so choosing "Custom…" and typing a description fell back to the built-in
   * gold treatment / serif and the text was silently ignored.
   */
  thumb_text_style_custom?: string
  thumb_font_style_custom?: string
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
   * The character CEILING SELECTION these prompts are written under — 'auto'
   * (follow the intended image model), 'none' (no ceiling), or a whole number
   * the customer chose. The SELECTION travels, never a number resolved
   * earlier: the ceiling is resolved when the job runs, against the LIVE
   * catalogue, so it follows the selected model — on this run and on every
   * retry. Absent means no limit is in force: no instruction is added and
   * nothing is warned about. Never a length to fill, and no prompt is ever
   * truncated to fit. See services/prompt-char-cap.ts and
   * services/image-prompt-cap.ts.
   */
  prompt_char_cap?: number | 'auto' | 'none'
  /**
   * The image model these prompts are written FOR. Named so the ceiling is
   * resolved for the model the customer actually selected.
   */
  intended_image_model?: string
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
      `The Gateway completed the request, but the thumbnail response parsed to ${parsed === null ? 'null' : typeof parsed}, not a JSON object. The result was rejected locally.`,
    )
  }
  if (Array.isArray(parsed)) {
    throw new Error(
      `The Gateway completed the request, but the thumbnail response was a bare array of ${parsed.length}, not an object with a "thumbnails" key. The result was rejected locally.`,
    )
  }
  if (!Array.isArray(parsed.thumbnails)) {
    throw new Error(
      `The Gateway completed the request, but the thumbnail response has no "thumbnails" array (present: ${JSON.stringify(Object.keys(parsed))}). The result was rejected locally.`,
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
  /**
   * Phrases for installed-pack lettering styles, keyed by style id, resolved by
   * `letteringPhraseMaps()` before this synchronous builder runs. A pack style
   * is not in the hardcoded `FONT_STYLES` / `TEXT_STYLES` maps, so without
   * these a bought style silently fell back to the built-in serif — the picker
   * showed the swatch and the image model was told to draw something else.
   */
  fontPhrases?: Record<string, string>
  textPhrases?: Record<string, string>
  /**
   * The customer's own description for a `custom` lettering id. Passed through
   * to the resolver rather than substituted, so a blank one still falls back the
   * way it always did.
   */
  fontCustomText?: string
  textCustomText?: string
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
  const font = (fontStyle && opts.fontPhrases?.[fontStyle]) || (fontStyle ? resolveFontStyle(fontStyle, opts.fontCustomText) : '')
  const text = (textStyle && opts.textPhrases?.[textStyle]) || (textStyle ? resolveTextStyle(textStyle, opts.textCustomText) : '')
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

/**
 * The word "Episode" was being PAINTED onto thumbnails.
 *
 * A prompt that says "render the exact episode title" hands a text-drawing
 * image model a string with the label attached, and it letters the label too --
 * "Episode" sitting above the real title. Titles are drawn here by design; the
 * defect is only the label riding in with them.
 *
 * The phrase arrives from three independent places: the LLM that authors the
 * prompt, content-pack headline and composition guidance whose bytes are signed
 * and so cannot be edited, and built-in niche concept guidance. Only this choke
 * point sees all three, which is why the rewrite lives here and runs on every
 * prompt unconditionally rather than at any one source.
 *
 * Scoped deliberately: it strips "episode" only where it binds to the text
 * being drawn. A prompt that merely mentions the episode elsewhere is untouched.
 */
const EPISODE_LABEL_ON_DRAWN_TEXT = /\bepisode(?:['’]s)?[\s-]+(title|headline)\b/gi

export function stripEpisodeLabelFromDrawnText(text: string): string {
  return text.replace(EPISODE_LABEL_ON_DRAWN_TEXT, '$1')
}

/**
 * What the save step needs to know to write the aspect-ratio and title
 * clauses onto a thumbnail prompt.
 */
export interface ThumbnailPromptElements {
  aspectRatio: string
  title: string
  textStyle?: string
  fontStyle?: string
  textPosition?: string
  headlineMode?: string
  /** Installed-pack phrases, resolved before this synchronous call. See
   *  `buildThumbnailDirective` — the same reason applies to this clause. */
  fontPhrases?: Record<string, string>
  textPhrases?: Record<string, string>
  /** Free-form descriptions for a `custom` lettering id. */
  fontCustomText?: string
  textCustomText?: string
}

/**
 * The exact clause TEXTS the save step appends to a thumbnail prompt.
 *
 * Exported so the character ceiling the prompt body is written under can be
 * computed from the very text the save step appends, instead of from an
 * estimate of how long that text might be. The ratio clause has two forms and
 * the title clause is skipped for a prompt that already carries the title, so
 * the caller decides which apply; the texts themselves are computed once, here.
 */
export function thumbnailPromptClauseTexts(opts: ThumbnailPromptElements): { ratio: string; title: string } {
  const ratio = opts.aspectRatio || '16:9'
  const ratioPhrase = RATIO_DESCRIPTIONS[ratio] || `${ratio} format`
  const ratioClause = `Rendered as a ${ratioPhrase} — this is a YouTube thumbnail (${ratio}).`
  let titleClause = ''
  // "No text at all" must not get a title clause bolted back on.
  if (opts.headlineMode !== 'none' && opts.title.trim()) {
    const font = !opts.fontStyle || opts.fontStyle === 'auto'
      ? 'a font chosen to suit the concept'
      : (opts.fontPhrases?.[opts.fontStyle] || resolveFontStyle(opts.fontStyle, opts.fontCustomText))
    const text = !opts.textStyle || opts.textStyle === 'auto'
      ? 'a treatment chosen to suit the concept'
      : (opts.textPhrases?.[opts.textStyle] || resolveTextStyle(opts.textStyle, opts.textCustomText))
    const position = !opts.textPosition || opts.textPosition === 'auto'
      ? 'the strongest placement for the composition'
      : opts.textPosition
    // Never "episode title": this clause is an instruction to draw text, and
    // the model draws the label along with it. The title is quoted right after,
    // so the word carries no information the model needs.
    // Every inventing mode (two-three words, question, summary, …) — not only the
    // curiosity hook — carries its own words in `title`; calling them "the title"
    // made the image model letter the hook AND the full title.
    const headlineLabel = headlineInvents(opts.headlineMode) ? 'thumbnail hook' : 'title'
    titleClause = `Render the exact ${headlineLabel} "${opts.title.trim()}" inside the image as large, highly legible display text using ${font}, ${text}, positioned at ${position}. This is the finished thumbnail; do not use placeholder or gibberish lettering.`
  }
  return { ratio: ratioClause, title: titleClause }
}

/**
 * The clauses that apply to THIS prompt. A prompt that already states the
 * aspect ratio, or already carries the title, gets the shorter form or none.
 */
export function thumbnailPromptClauses(prompt: string, opts: ThumbnailPromptElements): string[] {
  const out = stripEpisodeLabelFromDrawnText((prompt || '').trim())
  if (!out) return []
  const ratio = opts.aspectRatio || '16:9'
  const texts = thumbnailPromptClauseTexts(opts)
  const clauses: string[] = []
  if (!out.includes(ratio)) {
    clauses.push(texts.ratio)
  } else if (!/thumbnail/i.test(out)) {
    clauses.push('This is a YouTube thumbnail.')
  }
  if (texts.title && !out.includes(opts.title.trim())) clauses.push(texts.title)
  return clauses
}

/**
 * The characters the save step can add on top of the prompt body.
 *
 * This is the LARGEST the save step can add: the exact clause texts above,
 * measured, plus the separator that is appended with them. A prompt that
 * already states the ratio or repeats the title gets less — so this is a SAFE
 * BOUND, not an item-exact accounting, and it is what a caller reserves
 * before the prompt body exists. Nothing is estimated and nothing is
 * truncated.
 */
export function thumbnailSaveOverhead(opts: ThumbnailPromptElements): AssemblyOverhead {
  const texts = thumbnailPromptClauseTexts(opts)
  const clauses = [texts.ratio, texts.title].filter(Boolean)
  return measureAssemblyOverhead([
    // The separator is appended with the clauses, so it is counted with them.
    { label: 'aspect-ratio and title clauses', text: clauses.length ? `\n\n${clauses.join(' ')}` : '' },
  ])
}

export function enforceThumbnailPromptElements(prompt: string, opts: ThumbnailPromptElements): string {
  const out = stripEpisodeLabelFromDrawnText((prompt || '').trim())
  if (!out) return out
  const clauses = thumbnailPromptClauses(out, opts)
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
  /**
   * The ceiling the prompt BODY is written under, or absent for "no limit in
   * force". It is the published image-model ceiling minus the characters the
   * final assembly adds on top of the body — the save-step clauses and the
   * render-step extras — so the assembled prompt the model receives fits the
   * published ceiling. Never a length to fill, and no prompt is ever
   * truncated. See services/prompt-char-cap.ts.
   */
  promptCharCap?: number
  /**
   * The PUBLISHED ceiling the body budget came out of, and how many
   * characters the assembly adds on top of the body. The instruction the
   * writer reads names both, so it never claims the model's limit is smaller
   * than it is.
   */
  promptCharCapTotal?: number
  promptCharReservedCharacters?: number
}): string {
  const ratioInstruction = RATIO_DESCRIPTIONS[args.aspectRatio] || `${args.aspectRatio} format`
  const curiosityHook = headlineInvents(args.headlineMode)
  const headlineRequirement = args.headlineMode === 'none'
    ? '4. Render no words or letters anywhere in the image.'
    : args.headlineMode === 'curiosity-hook'
      ? '4. Invent a truthful 1–4 word curiosity hook for every variation. Return it in that variation\'s "title" field and render the exact same hook as legible in-image typography. Do not put the full episode title inside the artwork.'
      : curiosityHook
      ? '4. Write the headline the HEADLINE rule asks for, for every variation. Return it in that variation\'s "title" field and render the exact same words as legible in-image typography. Do not put the full episode title inside the artwork.'
      : '4. Render the exact episode title as legible in-image typography.'
  const titleExample = args.headlineMode === 'curiosity-hook' ? 'SHORT CURIOSITY HOOK' : curiosityHook ? 'SHORT HOOK' : args.title.replace(/"/g, '\\"')
  // A ceiling, never a length to reach: requirement 2 above still decides how
  // long a prompt should be. Empty when no limit is in force.
  const charCapInstruction = buildPromptCharCapInstruction(args.promptCharCap, {
    publishedCap: args.promptCharCapTotal,
    reservedCharacters: args.promptCharReservedCharacters,
  })
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
    throw new Error('No Gateway API Key configured. Add it in Settings → This Mac before generating thumbnail prompts.')
  }
  const saved = typeof config?.prompt_model === 'string' ? config.prompt_model : null
  return resolveChosenChatModel(apiKey, saved, 'the Thumbnail Prompts page')
}

/**
 * The episode's cast — the population the render matches style keywords
 * against. A cast that cannot be read costs prompt length, never correctness.
 *
 * Exported so a caller that has to RESERVE room for the style keywords — the
 * single-row regenerate route — reads the same cast the render reads, instead
 * of guessing one.
 */
export async function episodeCast(projectSlug: string, episodeId: string): Promise<Character[]> {
  try {
    return await cm.listCharacters(projectSlug, { episodeCode: episodeId })
  } catch {
    return []
  }
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
  const model = req.model?.trim() || pipelinePolicyForJob(job.params, 'image_prompts')?.assigned_model
    || await resolveDefaultImagePromptsModel(config)
  const count = Math.max(1, Math.round(Number(req.thumb_count) || 5))
  const fillGaps = req.fill_gaps === true
  // THE CHARACTER CEILING, RESOLVED LIVE — NOW, NOT AT ENQUEUE TIME.
  //
  // The request carries the SELECTION ('auto' / 'none' / a whole number) and
  // the image model the prompts are written FOR. The number is resolved here,
  // against the live catalogue, on every run — and a retry IS a fresh run, so
  // a retry re-reads the catalogue rather than repeating a ceiling that was
  // true when the job was queued. A model that publishes a different limit
  // today is obeyed today.
  //
  // Absent = no limit in force; nothing is invented. This is the ceiling for
  // the ASSEMBLED prompt — the stored prompt plus everything the render adds
  // on top of it. The prompt BODY is written under the smaller ceiling derived
  // from it below.
  //
  // A selection that cannot be resolved — a model the catalogue no longer
  // publishes, a malformed setting, a missing Gateway key — STOPS the job
  // here, before anything is written or charged. The refusal is typed, so the
  // queue refuses to burn three attempts on an answer that cannot change.
  const publishedCap = await requireLiveImagePromptCharCap({
    intendedImageModel: req.intended_image_model,
    setting: req.prompt_char_cap,
    label: 'The Thumbnail Prompts selection',
    nothingHappened: 'No thumbnail prompt was written, and no credits were charged for it.',
  })
  job.output_lines.push(`Target: ${count} thumbnail prompt(s).`)
  job.output_lines.push(publishedCap
    ? `Prompt length ceiling: ${publishedCap.toLocaleString()} characters for the assembled thumbnail prompt — the stored prompt plus the clauses and extras the render adds. A ceiling only — an over-length prompt is reported, never shortened.`
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
  // Resolved inside the generation branch (a fully-verified repair run has
  // nothing to write and must not read the pack registry) but declared here
  // because the enforcement pass below runs for every run.
  let letteringPhrases: LetteringPhraseMaps = { font: {}, text: {} }
  // The cast the render matches style keywords against, and the reference
  // guidance it appends. Read OUTSIDE the generation branch, so the advisory
  // after the write describes the same assembly even on a repair-only run that
  // writes nothing: a run that repairs nothing still has to be able to SAY
  // that a prompt it found on disk is over the ceiling, and it can only say
  // so with the guidance the render will add.
  //
  // It is a SAFE BOUND, not an item-exact accounting: the style keywords are
  // the largest set the render could append for the cast, and the render
  // guidance comes from the generator tab at render time, so it can differ
  // from what was reserved here. The render still measures the assembled
  // prompt before it submits and refuses an over-length one there.
  let renderCast: Character[] = []
  let renderReferenceGuidance = ''
  if (publishedCap) {
    renderCast = await episodeCast(projectSlug, episodeId)
    // The reference guidance the RENDER will append — the same helper the
    // render uses, in the render's own order (the request's asset, else the
    // project's saved one), so the two cannot disagree: no saved reference
    // asset means the render appends nothing, and nothing is reserved for it.
    renderReferenceGuidance = savedThumbnailReferenceGuidanceFor(
      pm.getProjectDir(projectSlug) || path.join(pm.projectsRoot(), projectSlug),
      (req as any)?.thumbnail_reference_asset || (config as any)?.thumbnail_reference_asset || null,
    )
  }
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
    // A lettering style bought as a Content Pack is NOT in the built-in
    // `FONT_STYLES` / `TEXT_STYLES` maps, so the synchronous builders below can
    // only honour it if its phrase is resolved here first. Without this bridge
    // the picker showed the swatch the customer paid for and the image model was
    // told to draw the built-in serif instead. A failure to read the catalogue
    // must not silently downgrade a paid style, so it is recorded on the job.
    try {
      letteringPhrases = await letteringPhraseMaps()
    } catch (error: any) {
      job.output_lines.push(`Lettering catalogue unavailable, using built-in styles only: ${error?.message || error}`)
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
      fontPhrases: letteringPhrases.font,
      textPhrases: letteringPhrases.text,
      fontCustomText: req.thumb_font_style_custom,
      textCustomText: req.thumb_text_style_custom,
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

    /**
     * The characters the FINAL assembly adds on top of the prompt body.
     *
     * The published ceiling applies to the prompt the model RECEIVES, not to
     * the body the writer produces: the save step appends the aspect-ratio and
     * title clauses, and the render appends the reference guidance and the
     * style keywords. A body written to the published ceiling therefore
     * produces an assembled prompt over it — which is exactly how a compliant
     * thumbnail prompt came to be refused at the model.
     *
     * Every piece is MEASURED from the text the render appends:
     *   - the save-step clauses, from the same clause texts the save step uses;
     *   - the reference guidance, when the project names a thumbnail reference
     *     asset;
     *   - the style keywords of the episode's cast — the LARGEST set the render
     *     can append, because which characters a prompt mentions is not known
     *     until the prompt exists.
     *
     * It is a SAFE BOUND, not an item-exact accounting: the style keywords are
     * the largest set the render could append, and the render-time guidance
     * from the generator tab is not known here. Over-reserving costs prompt
     * length; under-reserving would cost correctness — and the render measures
     * the assembled prompt before it submits, so an over-length prompt is
     * refused there with the exact numbers rather than submitted.
     *
     * Nothing is estimated, and nothing is truncated: this only makes the
     * ceiling the writer is given smaller.
     */
    const renderAssembly = {
      referenceGuidance: renderReferenceGuidance,
      styleKeywords: publishedCap ? castStyleKeywordBound(renderCast) : [],
    }
    const assemblyOverhead = addAssemblyOverhead(
      thumbnailSaveOverhead({
        aspectRatio: req.aspect_ratio || '16:9',
        title,
        textStyle: req.thumb_text_style || 'auto',
        fontStyle: req.thumb_font_style || 'auto',
        textPosition: req.thumb_text_position || 'auto',
        headlineMode,
        fontPhrases: letteringPhrases.font,
        textPhrases: letteringPhrases.text,
        fontCustomText: req.thumb_font_style_custom,
        textCustomText: req.thumb_text_style_custom,
      }),
      thumbnailRenderAssemblyOverhead(renderAssembly),
    )
    // The ceiling for the BODY: the published ceiling minus what the assembly
    // adds on top of it. Undefined when no ceiling is published — an unknown
    // limit is not a number, and none is invented here.
    const bodyCeiling = promptBodyCeiling(publishedCap, assemblyOverhead)
    if (bodyCeiling) {
      job.output_lines.push(
        `Reserved ${assemblyOverhead.characters.toLocaleString()} characters for the clauses and extras the render adds to each prompt; `
        + `each prompt body is written under ${bodyCeiling.toLocaleString()} characters.`,
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
      // The ceiling for the BODY, not the published ceiling: the assembly
      // adds its own characters on top, and those count against the same
      // published limit.
      promptCharCap: bodyCeiling,
      promptCharCapTotal: publishedCap,
      promptCharReservedCharacters: assemblyOverhead.characters,
    })
    if (artStyle?.negatives.length) {
      prompt += `\n\nAvoid in all thumbnail artwork: ${artStyle.negatives.join(', ')}`
    }
    try {
      const { prependAvoidanceToPrompt } = await import('../services/recency-tracker.js')
      prompt = await prependAvoidanceToPrompt(projectSlug, 'image_prompts', prompt, episodeId)
    } catch {
      // Recency enrichment cannot block generation.
    }

    const controller = new AbortController()
    const cancelWatcher = setInterval(() => {
      if (jq.isCancelled(job.job_id)) controller.abort()
    }, 500)
    try {
      job.output_lines.push(`Calling ${model} for ${targetNumbers.length} thumbnail prompt(s)…`)
      const promptPolicy = pipelinePolicyForJob(job.params, 'image_prompts')
      const promptCheckpoint = pipelinePolicyCheckpointStore(job.params, () => jq.checkpointJobState(job))
      const promptRequestIdentity = freshGenerationRequestIdentity(job, `thumbnail-prompts-${targetNumbers.join('-')}`)
        ?? `${projectSlug}:${episodeId}:thumbnail-prompts-${targetNumbers.join('-')}`
      const raw = promptPolicy
        ? await callAiWithModelPolicy(promptPolicy, '', prompt, aiCreds(config), false, {
            slug: projectSlug,
            jobId: job.job_id,
            signal: controller.signal,
            requestIdentity: promptRequestIdentity,
            pipelinePolicyCheckpoint: promptCheckpoint,
            pipelinePolicyCheckpointKey: promptRequestIdentity,
            onModelSelected: selected => {
              job.output_lines.push(`[pipeline] image prompts using Gateway product "${selected}".`)
            },
            outputContract: thumbnailPromptsOutputContract(targetNumbers.length),
            outputBudget: 'standard',
            disableReasoning: true,
            temperature: 0.35,
          })
        : await callAi(model, '', prompt, aiCreds(config), false, {
        slug: projectSlug,
        jobId: job.job_id,
        signal: controller.signal,
        requestIdentity: promptRequestIdentity,
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
        title: headlineInvents(headlineMode) ? String(item.title || '').trim() || title : title,
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
      // An inventing mode's words live in the row's own title, not the episode's.
      title: headlineInvents(headlineMode) ? String(item.title || '').trim() || title : title,
      textStyle: req.thumb_text_style || 'auto',
      fontStyle: req.thumb_font_style || 'auto',
      textPosition: req.thumb_text_position || 'auto',
      headlineMode,
      fontPhrases: letteringPhrases.font,
      textPhrases: letteringPhrases.text,
      fontCustomText: req.thumb_font_style_custom,
      textCustomText: req.thumb_text_style_custom,
    }),
  }))
  const missing = Array.from({ length: count }, (_, index) => index + 1)
    .filter(number => !thumbnails.some(item => Number(item.number) === number && item.prompt?.trim()))
  job.output_lines.push(`Verified ${count - missing.length}/${count} thumbnail prompt(s).`)
  // Advisory only. Every prompt is saved in full; nothing is shortened.
  //
  // Measured on the ASSEMBLED prompt — the stored prompt plus the reference
  // guidance and the style keywords the render appends — because that is what
  // the model receives and what the published ceiling applies to. The stored
  // prompt is shorter than this, so a stored prompt over the ceiling is
  // certainly over it too.
  const overCapNotice = describeOverCapPrompts(
    thumbnails.map(item => ({
      label: `thumbnail ${item.number}`,
      text: assembleThumbnailRenderPrompt(String(item.prompt || ''), {
        referenceGuidance: renderReferenceGuidance,
        styleKeywords: matchedStyleKeywords(String(item.prompt || ''), renderCast),
      }),
    })),
    publishedCap,
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
