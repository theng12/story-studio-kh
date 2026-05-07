/**
 * Script generator — port of generate_episode.py.
 * Generates narration script, image prompts, and YouTube description.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { callAi } from '../lib/ai-client.js'
import { buildNarrationDocx, buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { getEffectiveFormat, fillPacingArcPlaceholders } from '../services/format-loader.js'
import { getEffectiveBrand } from '../services/brand-loader.js'
import { loadPattern, applyPatternSubject } from '../services/pattern-loader.js'
import { resolveCharacters } from '../services/character-manager.js'

import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as im from '../services/idea-manager.js'
import {
  generateNarrativeChunked,
  generateListicleChunked,
  getOutlineEntryForChapter,
  buildOutlineOnly,
  expandChapters,
  readSidecar,
  type ChunkedNarrationParams,
  type ChunkedMode,
  type GenerationParams,
} from '../lib/chunked-narration.js'
import { castPromptBlock, castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import type { GenerateScriptRequest, Job, Format, NarratorStyle, Pattern, Character } from '../models/types.js'

/**
 * Apply a Pattern's overrides on top of a resolved Format. Returns a new
 * Format with the pattern's body shape, opening device, and closing device
 * folded in — the rest of the prompt-assembly code keeps working unchanged
 * because everything still looks like a Format.
 *
 * - Pattern.bodyStructure → REPLACES format.script.pacingArc when set
 * - Pattern.openingDevice → prepended to format.script.systemPromptRole as
 *   an additional rule (so the LLM's first move respects it)
 * - Pattern.closingDevice → appended to format.script.closingHint
 * - Pattern.metadataKeywordAdditions → appended to format.metadata.broadKeywords
 *
 * Subject substitution ({X}, {lastButOne}, {last}) happens here too.
 */
function fuseFormatWithPattern(
  format: Format,
  pattern: Pattern,
  subject: string,
  chapterCount: number,
): Format {
  const { resolvedOpeningDevice, resolvedBodyStructure, resolvedClosingDevice }
    = applyPatternSubject(pattern, subject, chapterCount)

  // The opening device is folded into additionalRules so it shows up in the
  // system prompt's rule block — the LLM hits it before generating chapter 1.
  const fusedRules = [
    `Episode opening device (this episode only): ${resolvedOpeningDevice}`,
    ...format.script.additionalRules,
  ]

  return {
    ...format,
    script: {
      ...format.script,
      additionalRules: fusedRules,
      pacingArc: resolvedBodyStructure ?? format.script.pacingArc,
      closingHint: `${format.script.closingHint} ${resolvedClosingDevice}`.trim(),
    },
    metadata: {
      ...format.metadata,
      broadKeywords: [
        ...format.metadata.broadKeywords,
        ...(pattern.metadataKeywordAdditions || []),
      ],
    },
  }
}

/**
 * Narrator-style description lookup over the effective Format. Replaces the
 * old hardcoded NARRATOR_STYLES record. Falls back to the format's default
 * narrator style if the requested id isn't in the format's pool — preserves
 * the prior fallback semantics ("style 'A' default") for back-compat.
 */
function narratorStyleFor(format: Format, styleId: string): NarratorStyle {
  const list = format.script.narratorStyles
  return list.find(s => s.id === styleId)
    ?? list.find(s => s.id === format.script.defaultNarratorStyleId)
    ?? list[0]
}

function systemPrompt(format: Format, productionStandards: string, brand?: import('../models/types.js').Brand | null): string {
  // Format-specific addendum is prepended to the user's free-form standards.
  // Both flow into the same "Follow these production standards exactly:" block
  // so the LLM treats them with the same priority. Empty addendum = no change.
  const standardsBody = [format.productionStandardsAddendum, productionStandards]
    .filter(s => s && s.trim()).join('\n\n')

  const additionalRules = format.script.additionalRules.map(r => `- ${r}`).join('\n')

  const baseSystem = `${format.script.systemPromptRole}

Follow these production standards exactly:

${standardsBody}

Additional rules:
${additionalRules}`

  // Brand persona (if the project has a brand attached) wins position-wise:
  // it sets channel-level voice context that the format-level role refines.
  // No brand → unchanged. Use a synchronous import via lazy require so this
  // function stays sync-safe; callers fetch the brand themselves and pass
  // it down.
  if (brand?.narration?.persona) {
    return `${brand.narration.persona.trim()}\n\n${baseSystem}`
  }
  return baseSystem
}

interface IntroSettings {
  enabled?: boolean
  host_name?: string
  word_target?: number
  custom_opening?: string
  beats?: string[]
}

function narrationPrompt(
  format: Format,
  code: string, title: string, length: number, style: string,
  chapters: number, totalWords: number, wordsPerChapter: number,
  introSettings?: IntroSettings,
  styleOverride?: string,
  introStandards?: string,
  characters?: Character[],
): string {
  const ns = narratorStyleFor(format, style)
  const styleDesc = styleOverride || ns.description
  const wordFloor = Math.floor(totalWords * 0.9)
  const castBlock = castPromptBlock(characters || [])
  const hasIntro = !!introSettings
  const intro = introSettings || {}
  const introWords = hasIntro ? (intro.word_target || 350) : 0
  const hostName = intro.host_name || 'your narrator'

  // Build intro section for prompt
  let introSection = ''
  if (hasIntro) {
    // Use beats array if provided (ordered list from frontend), fallback to defaults
    const beats: string[] = intro.beats || [
      'Welcome & host intro',
      'Story teaser',
      'Community question',
      'Subscribe CTA',
      'Relaxation / breathing exercise',
      'Transition into story',
    ]
    const allBeats = [...beats]
    if (intro.custom_opening) allBeats.unshift(`Use this opening: "${intro.custom_opening}"`)
    const introInstructions = allBeats.map((b, i) => `${i + 1}. ${b}`).join('\n')

    const standardsBlock = introStandards && introStandards.trim()
      ? `\n\nFollow this project's intro format reference:\n${introStandards.trim()}\n`
      : ''
    introSection = `
PART 1 — INTRODUCTION: ~${introWords} words (SEPARATE from story body)

# Introduction (~${introWords} words)

Write the introduction following these beats in order:
${introInstructions}
${standardsBlock}
`
  }

  return `Generate the FULL narration script for a story episode.

Episode code: ${code}
Episode title: ${title}
Target length: ${length} minutes
Narrator style: Style ${style} — ${styleDesc}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL WORD COUNT REQUIREMENTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${hasIntro ? `
The script has TWO parts with SEPARATE word count targets:
PART 1 — INTRODUCTION: ~${introWords} words (SEPARATE from story body)
PART 2 — STORY BODY: MINIMUM ${totalWords} words across ${chapters} chapters (floor: ${wordFloor})

TOTAL OUTPUT: at least ${totalWords + introWords} words.
The story body word count of ${totalWords} does NOT include the introduction.` : `
STORY BODY: MINIMUM ${totalWords} words across ${chapters} chapters (floor: ${wordFloor})
No introduction needed — start directly with the story.`}

Each chapter MUST be approximately ${wordsPerChapter} words.
You MUST write EXACTLY ${chapters} chapters. Not fewer. Not more.
Do NOT truncate or cut the story short for any reason.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${castBlock}
STRUCTURE (output as plain text with markdown-style headings):
${hasIntro ? introSection : ''}
# ${title} — Narration (${totalWords}+ words)

Write EXACTLY ${chapters} chapters. Each chapter MUST be ~${wordsPerChapter} words.
Each chapter heading format: ## Chapter N: [Descriptive Title]

CHAPTER PACING:
${fillPacingArcPlaceholders(format.script.pacingArc, chapters).map(l => `- ${l}`).join('\n')}

${format.script.closingHint}

FINAL CHECK BEFORE RESPONDING:
- Introduction: ~${introWords} words? ✓
- Story body: ${totalWords}+ words (${chapters} chapters × ${wordsPerChapter} words each)? ✓
- Total: ${totalWords + introWords}+ words? ✓
If not, keep writing until you hit the targets.

Output ONLY the script text. No meta-commentary.`
}

function imagePromptsPrompt(format: Format, code: string, title: string, storySummary: string, styleTag: string, characters?: Character[]): string {
  const [scenesMin, scenesMax] = format.imagePrompts.defaultScenesTotalRange
  const thumbsCount = format.imagePrompts.defaultThumbnails
  const castImageBlock = castImagePromptBlock(characters || [])
  return `Generate ALL image prompts ${format.imagePrompts.purposeNote}.

Episode code: ${code}
Episode title: ${title}

Story summary for reference (stay consistent with these details):
${storySummary}
${castImageBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL REQUIREMENTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. You MUST generate ${scenesMin}-${scenesMax} scene prompts total (2-3 per chapter).
2. You MUST generate exactly ${thumbsCount} thumbnail prompts.
3. Every single prompt MUST end with the style tag shown below.
4. Every single prompt MUST include an inline character description.
5. Do NOT stop early. Write ALL prompts in a single response.

OUTPUT STRUCTURE (use markdown-style headings):

# Character Reference — [Character Name]

Write a full physical description of the main character.

# Chapter Scene Prompts

For EACH chapter, write 2-3 scene prompts. At least ${scenesMin} total.
Format: ## Scene N: [Brief Scene Title]

Each prompt MUST end with this exact style tag:
"${styleTag}"

# Thumbnail Prompts

## Thumbnail 1 through ## Thumbnail ${thumbsCount}

CRITICAL FOR THUMBNAILS: Every thumbnail prompt MUST include:
'The episode title "${title}" is displayed in large, golden, glowing text, perfectly centered and legible against the background.'

Each thumbnail MUST also end with the style tag above.

Output ONLY the prompts. No meta-commentary.`
}

function youtubePrompt(format: Format, code: string, title: string, storySummary: string): string {
  const ds = format.metadata.youtubeDescriptionStructure
  const defaultTagsLine = ds.defaultHashtags.join(' ')
  const remainingHashtags = Math.max(0, ds.totalHashtagCount - ds.defaultHashtags.length)
  return `Generate a YouTube description ${format.metadata.purposeNote}.

Episode code: ${code}
Episode title: ${title}

Story summary for reference:
${storySummary}

OUTPUT FORMAT (plain text, copy-paste ready):

[Title line - max 95 characters]

[Hook paragraph - 2-3 sentences drawing listener in]

──────────────────────────────────────
${ds.musicLabel}: [describe ambient soundscape matching the episode theme]
──────────────────────────────────────

${ds.booksSectionLabel}
- [Book 1] by [Author]
- [Book 2] by [Author]
- [Book 3] by [Author]
- [Book 4] by [Author]
- [Book 5] by [Author]

(Pick 5 real, currently published books thematically matching the episode.)

──────────────────────────────────────
${ds.supportSection}

──────────────────────────────────────
${ds.aiDisclosure}

──────────────────────────────────────
${defaultTagsLine} [+ ${remainingHashtags} more episode-specific hashtags, ${ds.totalHashtagCount} total]

Output ONLY the description. No meta-commentary.`
}

function extractStorySummary(narrationText: string): string {
  const lines = narrationText.split('\n')
  let storyStarted = false
  const summaryLines: string[] = []
  let wordCount = 0

  for (const line of lines) {
    if (line.includes('Narration') && line.startsWith('#')) {
      storyStarted = true
      continue
    }
    if (storyStarted) {
      if (line.trim().startsWith('## ')) {
        summaryLines.push(line)
        continue
      }
      summaryLines.push(line)
      wordCount += line.split(/\s+/).length
      if (wordCount > 2000) break
    }
  }

  if (!summaryLines.length) return narrationText.split(/\s+/).slice(0, 2000).join(' ')
  return summaryLines.join('\n')
}

function autoSelectStyle(format: Format, code: string): string {
  const numMatch = code.match(/\d+/)
  const epNum = numMatch ? parseInt(numMatch[0]) : 0
  const styles = format.script.narratorStyles
  if (!styles.length) return 'A'  // safety net; loader rejects empty arrays
  return styles[epNum % styles.length].id
}

// ── Main generator function ─────────────────────────────────────────────────

// `generateEpisode` is no longer exposed as a public job executor. The
// legacy `'script'` job type was removed in M1 — chapters and introduction
// are now generated via separate `script-only` and `introduction-only`
// jobs. This function survives ONLY as the underlying implementation
// `generateScriptOnly` calls (with `intro_settings.enabled = false`).
// Do NOT register it as an executor again. Internal use only.
async function generateEpisode(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateScriptRequest

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')

  const project = await pm.getProject(project_slug)
  if (!project) throw new Error('Project not found')

  const standards = await pm.getStandards(project_slug) || ''
  let format = await getEffectiveFormat(project_slug)
  const title = req.title
  const length = req.length || format.script.defaultLengthMinutes
  let style = req.style === 'auto' ? autoSelectStyle(format, episode_id) : req.style
  // Resolve custom style text without mutating the shared narrator-styles array
  let customStyleText: string | undefined
  if (style && (style.startsWith('style-') || style === 'custom')) {
    customStyleText = (params as any).custom_style_text || (params as any).intro_settings?.custom_style_text
  }
  const chapters = req.chapters || format.script.defaultChapterCount
  let totalWords = req.total_words || (length === 45 ? 5500 : 7500)
  let wordsPerChapter = req.words_per_chapter || Math.floor(totalWords / chapters)

  // Pattern composition (Phase 4b): when the request carries a pattern_id,
  // load it and fuse it on top of the Format. The result is a derived
  // Format that the rest of the prompt machinery treats normally — pacing
  // arc, opening rule, closing hint, metadata keywords are all updated.
  // Missing patterns log + skip (Format alone still produces a usable
  // episode), preserving back-compat with no-pattern requests.
  if (req.pattern_id) {
    const pattern = await loadPattern(req.pattern_id)
    if (pattern) {
      const subject = req.pattern_subject || ''
      format = fuseFormatWithPattern(format, pattern, subject, chapters)
      job.output_lines.push(`Applied pattern: ${pattern.name}` + (subject ? ` (subject: "${subject}")` : ''))
    } else {
      job.output_lines.push(`Pattern '${req.pattern_id}' not found — generating without pattern`)
    }
  }

  // Character resolution (Phase 5): if character_ids was passed, fetch the
  // cast and thread them into both the script + image prompts. Empty array
  // (or missing field) preserves back-compat with the "LLM invents the cast"
  // path. Missing characters log + skip (we don't fail the whole job because
  // one of N character ids was bad).
  const characters = req.character_ids?.length
    ? await resolveCharacters(project_slug, req.character_ids)
    : []
  if (characters.length) {
    job.output_lines.push(`Cast: ${characters.map(c => c.name).join(', ')}`)
  }

  // Style tag — prefer a project-defined override in production_standards (legacy
  // hook for sleep-story Storybook tag), fall back to the format's defaultStyleTag.
  const styleTagMatch = standards.match(/"([^"]*Storybook[^"]*)"/)
  const styleTag = styleTagMatch?.[1] || format.imagePrompts.defaultStyleTag

  const paths = await resolveEpisodePaths(project_slug, episode_id, title)

  // Create directories
  for (const dir of [
    paths.script_dir, paths.scene_prompts_dir, paths.thumb_prompts_dir,
    paths.metadata_dir, paths.bg_dir, paths.thumb_dir,
    paths.audio_dir, paths.video_dir,
  ]) {
    await fs.mkdir(dir, { recursive: true })
  }

  const apiKeys = { anthropic_api_key: config.anthropic_api_key, openai_api_key: config.openai_api_key, kie_api_key: config.kie_api_key }
  const brand = await getEffectiveBrand(project_slug)
  const sysPrompt = systemPrompt(format, standards, brand)

  const skipImages = !req.generate_image_prompts
  const skipYoutube = !req.generate_youtube_desc

  job.output_lines.push(`Generating narration script...`)

  // AbortController + 500 ms cancel watcher — mirrors the subtitles generator.
  // Streamed LLM completions ignore an external `isCancelled` callback, so we
  // thread a signal through `callAi` → provider → SDK; the SDK tears down the
  // HTTP stream on abort, and the provider wrapper normalises that to
  // `Cancelled by user` which the queue classifies as 'cancelled'.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    // Call 1: Narration
    const introSettings: IntroSettings = (params as any).intro_settings || {}
    const introEnabled = introSettings.enabled === true
    const introStandardsText = (config as any).intro_standards || ''

    // v1.0.71+: dispatch to chunked mode when the target wordcount would
    // overflow a single LLM call. Single-call max output is ~16k tokens
    // (Anthropic streaming) ≈ 12k words. Two signals can trigger chunking:
    //   1. word-count heuristic (CHUNK_THRESHOLD_WORDS) — fast pre-check
    //   2. dynamic budget check — projects with a heavy character cast,
    //      long production standards, or large brand persona can crowd
    //      the cap even at lower word counts. Assemble the user prompt
    //      once and feed its real size into `shouldChunkByBudget`.
    // Chunked mode writes per-chapter docx files incrementally, so cancel
    // / crash / restart preserves partial work and a re-run resumes from
    // the on-disk sidecar.
    // v1.0.72+: chunked-always. Phase 3 of the outline-first refactor
    // removes the single-call path. Every script run now flows through
    // buildOutlineOnly + expandChapters (auto-approved here for back-
    // compat with the script-only contract: outline + expand in one job).
    // Sub-threshold projects pay one extra LLM call (the outline phase),
    // gaining: (a) consistent UX with longer scripts, (b) per-chapter
    // resume after a crash, (c) the same sidecar that powers per-chapter
    // outline-aware regen via chapter-only.
    //
    // The user-facing two-phase flow (Generate Outline → review → Expand)
    // bypasses this generator entirely — frontend POSTs /generate/outline-
    // only + /generate/expand-chapters directly. This path remains for
    // pipeline-batch + the Generate All chained run.
    const chunkedParams = {
      episode_id,
      title,
      totalChapters: chapters,
      wordsPerChapter,
      format,
      systemPrompt: sysPrompt,
      scriptDir: paths.script_dir,
      model: req.model,
      apiKeys,
      characters: characters.length ? characters : undefined,
      signal: controller.signal,
      isCancelled: () => jq.isCancelled(job.job_id),
      patternId: req.pattern_id,
      patternSubject: req.pattern_subject,
      force: !!(params as any).force,
    }
    const result = format.script.chaptersIndependent
      ? await generateListicleChunked(job, chunkedParams)
      : await generateNarrativeChunked(job, chunkedParams)
    job.output_lines.push(
      `Narration: ${result.chaptersWritten}/${chapters} chapters on disk ` +
      `(${result.totalBatches} batch${result.totalBatches === 1 ? '' : 'es'}` +
      `${result.fromResume ? ', resumed from sidecar' : ''}).`,
    )
    // The chunked path wrote per-chapter docx files incrementally; assemble
    // the unified narration_full.docx from disk so downstream readers
    // (audio reconciler, subtitles, video assembly, story-context readers)
    // see one cohesive script. See lib/narration-assembly.ts for contract.
    const { assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
    await assembleUnifiedNarration(paths.script_dir, episode_id, title)
    job.output_lines.push(`Assembled: ${path.basename(paths.narration_docx)}`)

    // Story summary used by image-prompts + YouTube description prompts.
    // Always read from the on-disk unified docx — there's no bulk LLM
    // response to extract from anymore.
    let storySummary: string
    try {
      const { narrationDocxToMarkdown } = await import('../lib/docx-parser.js')
      const md = await narrationDocxToMarkdown(paths.narration_docx)
      storySummary = extractStorySummary(md)
    } catch {
      storySummary = `Episode: ${episode_id}, Title: ${title}`
    }

    // Call 2: Image prompts. Check cancellation before every follow-up LLM
    // call — each is a separate paid request, and an auto-run script gen can
    // have 3+ calls. Pre-call check stops new work while leaving the already-
    // produced narration intact on disk for the user.
    let imageText: string | null = null
    if (!skipImages && !jq.isCancelled(job.job_id)) {
      job.output_lines.push('Generating image prompts...')
      imageText = await callAi(req.model, sysPrompt,
        imagePromptsPrompt(format, episode_id, title, storySummary, styleTag, characters), apiKeys, false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      const promptCount = (imageText.match(/^##\s/gm) || []).length
      job.output_lines.push(`Image prompts: ${promptCount} prompts`)
    }

    // Call 3: YouTube description
    let ytText: string | null = null
    if (!skipYoutube && !jq.isCancelled(job.job_id)) {
      job.output_lines.push('Generating YouTube description...')
      ytText = await callAi(req.model, sysPrompt,
        youtubePrompt(format, episode_id, title, storySummary), apiKeys, false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      job.output_lines.push('YouTube description: done')
    }

    if (imageText) {
      // Save scene prompts docx to Scene Prompts folder
      await buildImagePromptsDocx(imageText, episode_id, title, paths.scene_prompts_docx)
      job.output_lines.push(`Saved: ${path.basename(paths.scene_prompts_docx)}`)
      // Save thumbnail prompts docx to Thumbnail Prompts folder
      await buildImagePromptsDocx(imageText, episode_id, title, paths.thumb_prompts_docx)
      job.output_lines.push(`Saved: ${path.basename(paths.thumb_prompts_docx)}`)
    }

    if (ytText) {
      // Wrap legacy "youtube description" output into the new metadata format
      const meta = {
        title: '',
        description: ytText.trim(),
        tags: [] as string[],
        savedAt: new Date().toISOString(),
        version: 1,
      }
      const { formatMetadataTxt } = await import('../services/folder-migration.js')
      await fs.mkdir(paths.metadata_dir, { recursive: true })
      await fs.writeFile(paths.metadata_txt, formatMetadataTxt(meta))
      await fs.writeFile(paths.metadata_json, JSON.stringify(meta, null, 2) + '\n')
      job.output_lines.push(`Saved: ${path.basename(paths.metadata_txt)} + ${path.basename(paths.metadata_json)}`)
    }

    job.output_lines.push(`All files saved to: ${paths.episode_dir}`)
    job.output_dir = paths.episode_dir
  } finally {
    clearInterval(cancelWatcher)
  }
}

// Generate script (chapters only, no introduction).
//
// One bulk LLM call for narrative cohesion (the chapter-only refactor
// chose this over per-chapter calls so chapter 7's pacing reflects
// chapters 1–6). The bulk output is then split into per-chapter source
// files by `generateEpisode` → `writeChapterFiles` → `assembleUnifiedNarration`.
// See plans/jiggly-rolling-aurora.md for the storage model.
//
// Old multi-version loop (version_count → _v2.docx, _v3.docx) was
// dropped: the per-chapter regen flow replaces it.
export async function generateScriptOnly(job: Job): Promise<void> {
  // Spread typing: explicit Record<string, any> so the index signature
  // survives strict TS narrowing of the inner literal.
  const baseParams: Record<string, any> = { ...job.params, intro_settings: { enabled: false } }

  // Chapters regenerate wipes any prior intro (the new bulk pass produced
  // chapters-only content; any old _Introduction.docx + .intro.json sidecar
  // are now stale). Delete up-front, idempotent on missing files.
  const paths = await resolveEpisodePaths(job.project_slug, job.episode_id, (baseParams.title as string) || '')
  const introMarker = paths.narration_docx.replace(/\.docx$/, '.intro.json')
  const introDocx = path.join(paths.script_dir, `${job.episode_id}_Introduction.docx`)
  await fs.unlink(introMarker).catch(() => {})
  await fs.unlink(introDocx).catch(() => {})

  await generateEpisode({ ...job, params: baseParams })

  // v1.0.70 — auto-rewrite the idea title's leading count number when
  // it disagrees with the chapter count we actually generated. Catches
  // the case where the user accepted "7 historical cold cases" and
  // generated 10 chapters anyway: the on-disk script has 10, so the
  // idea title should too. Idempotent on titles without a leading
  // number, and on matches where title-number == chapters already.
  //
  // The folder rename (post-rewrite) is the LAST thing the script job
  // does. By the time the user clicks "Generate Audio" the folder is
  // at its new name and `resolveEpisodePaths(NEW_TITLE)` finds it.
  // The job queue is serialized so no concurrent reader is mid-stat
  // on the old path.
  try {
    const generatedChapters = Number(baseParams.chapters)
    const title = (baseParams.title as string) || ''
    if (Number.isFinite(generatedChapters) && generatedChapters > 0 && title) {
      const m = title.match(/^(?:(?:the|top)\s+)?(\d+)\b/i)
      if (m) {
        const titleNumber = parseInt(m[1]!, 10)
        if (titleNumber !== generatedChapters) {
          const start = m.index! + m[0].length - m[1]!.length
          const newTitle = title.slice(0, start) + String(generatedChapters) + title.slice(start + m[1]!.length)
          // Find the idea by episode_code and update its title.
          const ideas = await im.getIdeas(job.project_slug, 'accepted')
          const idea = ideas.find(i => (i.episode_code || '').toUpperCase() === (job.episode_id || '').toUpperCase())
          if (idea) {
            // Persist title FIRST so a rename failure doesn't leave the
            // record stale: ideas.json is the source of truth, the disk
            // folder catches up if it can.
            await im.updateIdea(job.project_slug, idea.id, { title: newTitle })
            const { renameEpisodeFolderForTitleChange } = await import('../services/episode-folder-title-sync.js')
            const result = await renameEpisodeFolderForTitleChange(
              job.project_slug, job.episode_id, title, newTitle,
            )
            const renameNote = result.renamed
              ? `Folder renamed → ${path.basename(result.new_dir!)}.`
              : 'Folder unchanged on disk (will use the new name on first generator run).'
            job.output_lines.push(
              `[title-sync] Idea title rewritten: "${title}" → "${newTitle}" `
              + `(chapters generated: ${generatedChapters}). ${renameNote}`,
            )
            for (const w of result.warnings) job.output_lines.push(`[title-sync] ${w}`)
          }
        }
      }
    }
  } catch (e: any) {
    // Title sync is purely cosmetic; never fail the script job over it.
    job.output_lines.push(`[title-sync] skipped (${e?.message || e})`)
  }
}

// Regenerate ONE chapter, keeping all others on disk untouched.
//
// Flow:
//   1. Eager-migrate from a legacy unified-only narration if needed
//      (so users with old episodes can immediately use the per-chapter
//      regen flow).
//   2. Read prior chapters' text from disk to summarise as context for
//      the LLM — the regen prompt carries narrative continuity.
//   3. Single LLM call producing just `## Chapter NN: Title\n\nbody`.
//   4. Overwrite `{code}_Chapter_NN.docx` (keeping siblings intact).
//   5. Re-assemble unified narration so audio / subtitles / video all
//      see the new content.
//
// The unified narration's `Chapter_NN` section is the only one that
// changes; if audio for that chapter was already generated, it's now
// stale (UI surfaces a "⚠ stale" pill via mtime comparison; user
// decides when to regenerate audio).
export async function generateChapterOnly(job: Job): Promise<void> {
  const req = job.params as any
  const { project_slug, episode_id } = job
  const title = req.title as string
  const chapterNumber = Number(req.chapter_number)
  if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
    throw new Error(`Invalid chapter_number: ${req.chapter_number}`)
  }

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')
  const project = await pm.getProject(project_slug)
  if (!project) throw new Error('Project not found')

  const standards = await pm.getStandards(project_slug) || ''
  const format = await getEffectiveFormat(project_slug)
  const brand = await getEffectiveBrand(project_slug)
  const apiKeys = { anthropic_api_key: config.anthropic_api_key, openai_api_key: config.openai_api_key, kie_api_key: config.kie_api_key }
  const sysPrompt = systemPrompt(format, standards, brand)
  const paths = await resolveEpisodePaths(project_slug, episode_id, title)

  const {
    ensureChapterFilesMigrated,
    writeChapterFiles,
    assembleUnifiedNarration,
    chapterFilePath,
  } = await import('../lib/narration-assembly.js')
  await ensureChapterFilesMigrated(paths.script_dir, episode_id, title)

  // Load prior chapters as context — short summaries so we don't blow
  // the prompt budget on long episodes. Audio reconciler-grade exact
  // text isn't needed here, just enough to anchor tone + plot.
  let entries: string[] = []
  try { entries = await fs.readdir(paths.script_dir) } catch { /* empty */ }
  const chapterRe = new RegExp(`^${episode_id}_Chapter_(\\d+)\\.docx$`)
  const existingNumbers = entries
    .map(n => n.match(chapterRe))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => parseInt(m[1], 10))
    .sort((a, b) => a - b)

  const { narrationDocxToMarkdown } = await import('../lib/docx-parser.js')
  const priorSummaries: string[] = []
  for (const n of existingNumbers) {
    if (n >= chapterNumber) continue
    try {
      const md = await narrationDocxToMarkdown(chapterFilePath(paths.script_dir, episode_id, n))
      const body = md.replace(/^##[^\n]*\n+/, '').trim()
      const firstParagraph = body.split('\n\n').find(p => p.trim().length > 0) || ''
      const summary = firstParagraph.split(/\s+/).slice(0, 60).join(' ')
      priorSummaries.push(`Chapter ${n}: ${summary}…`)
    } catch { /* skip unreadable */ }
  }

  const wordsPerChapter = Number(req.words_per_chapter) || 550
  const totalChapters = Number(req.chapters) || existingNumbers.length || chapterNumber
  const style = req.style || format.script.defaultNarratorStyleId
  const styleDesc = narratorStyleFor(format, style).description

  // v1.0.72+: Outline-aware regeneration. The chunked path persists a
  // sidecar with the original outline (title, hook_line, key_facts for
  // listicle / synopsis, key_beats for narrative). Without this lookup,
  // chapter-only used to ask the LLM to "regenerate Chapter 5" with no
  // memory of what topic Chapter 5 originally was — for listicle, that
  // meant regen drifted to a brand-new topic every time. With it, the
  // model gets the original outline entry threaded into the prompt so
  // the regen stays on-topic.
  //
  // Returns null for single-call non-chunked projects (no sidecar exists)
  // → falls through to the legacy prompt unchanged.
  const outlineLookup = await getOutlineEntryForChapter(paths.script_dir, episode_id, chapterNumber)
  let outlineBlock = ''
  let independenceLine = ''
  if (outlineLookup) {
    const { entry, mode } = outlineLookup
    if (mode === 'listicle') {
      // Listicle chapters are independent — no transition contamination.
      // The hook + key_facts are the LLM's seed material for staying on
      // the same topic across regens.
      const facts = entry.key_facts?.length
        ? `\nKey facts: ${entry.key_facts.map(f => `"${f}"`).join('; ')}`
        : ''
      const hook = entry.hook_line ? `\nHook: ${entry.hook_line}` : ''
      outlineBlock = `\nOriginal topic: "${entry.title}"${hook}${facts}\n`
      independenceLine = '\nThis is an INDEPENDENT chapter — do NOT reference other chapters or build transitions to / from them.\n'
    } else {
      // Narrative outline — synopsis + key_beats anchor tone + plot.
      const beats = entry.key_beats?.length
        ? `\nKey beats: ${entry.key_beats.map(b => `"${b}"`).join('; ')}`
        : ''
      const synopsis = entry.synopsis ? `\nSynopsis: ${entry.synopsis}` : ''
      outlineBlock = `\nOutline title: "${entry.title}"${synopsis}${beats}\n`
    }
  }

  // Per-chapter pacing hint sourced from the format's pacing arc. Picks the
  // most relevant arc bullet for this chapter's position so regenerated
  // chapters match the format's structural cadence (sleep stories drift, action
  // formats escalate, history formats progress chronologically, etc.).
  const arc = fillPacingArcPlaceholders(format.script.pacingArc, totalChapters)
  function pickPacingHint(n: number): string {
    if (!arc.length) return ''
    if (n === totalChapters && arc.length >= 1) return arc[arc.length - 1]
    const idx = Math.min(arc.length - 1, Math.floor(((n - 1) / Math.max(1, totalChapters - 1)) * (arc.length - 1)))
    return arc[idx]
  }

  const chapterPrompt = `Regenerate ONLY Chapter ${chapterNumber} of an existing narration script.

Episode: "${title}" (code ${episode_id})
Narrator style: Style ${style} — ${styleDesc}
Total chapters in this episode: ${totalChapters}
Target word count for this chapter: ~${wordsPerChapter} words
${outlineBlock}${independenceLine}
${priorSummaries.length && !independenceLine ? `Story so far (prior chapters, summarised):\n${priorSummaries.join('\n')}\n` : ''}

Write ONLY Chapter ${chapterNumber}. ${outlineLookup?.mode === 'listicle'
  ? 'Stay on the topic above; do not invent a different subject.'
  : `Keep tone, pacing, and narrative continuity consistent with the prior chapters. Match the chapter pacing position: ${pickPacingHint(chapterNumber)}`}

Output format (markdown):
## Chapter ${chapterNumber}: [Descriptive Title]

[Body — approximately ${wordsPerChapter} words.]

Output ONLY the chapter heading + body. No commentary, no other chapters.`

  job.output_lines.push(`Regenerating Chapter ${chapterNumber}…`)
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)
  try {
    const chapterText = await callAi(req.model, sysPrompt, chapterPrompt, apiKeys, true,
      { slug: project_slug, jobId: job.job_id, signal: controller.signal })

    // Parse out the title from the heading the model produced. Fall back
    // to a synthesised title if the model omitted it.
    const headingMatch = chapterText.trim().match(/^##\s+Chapter\s+\d+\s*[:\-–—]\s*(.+)$/im)
    const newTitle = headingMatch ? headingMatch[1].trim() : `Chapter ${chapterNumber}`
    const body = chapterText.replace(/^##\s+Chapter\s+\d+[^\n]*\n+/m, '').trim()

    await writeChapterFiles(paths.script_dir, episode_id, title, {
      chapters: [{ number: chapterNumber, title: newTitle, text: body }],
    })
    job.output_lines.push(`Wrote: ${episode_id}_Chapter_${String(chapterNumber).padStart(2, '0')}.docx`)

    await assembleUnifiedNarration(paths.script_dir, episode_id, title)
    job.output_lines.push(`Re-assembled: ${path.basename(paths.narration_docx)}`)
  } finally {
    clearInterval(cancelWatcher)
  }
}

// Generate introduction only (requires script to exist)
export async function generateIntroductionOnly(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as any

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')

  const project = await pm.getProject(project_slug)
  if (!project) throw new Error('Project not found')

  const standards = await pm.getStandards(project_slug) || ''
  const format = await getEffectiveFormat(project_slug)
  const title = req.title
  const length = req.length || format.script.defaultLengthMinutes
  const style = req.style || format.script.defaultNarratorStyleId

  let customStyleText: string | undefined
  if (style && (style.startsWith('style-') || style === 'custom')) {
    customStyleText = req.custom_style_text
  }

  // v1.0.71+: format-aware intro defaults. Sleep-story formats keep the
  // 350-word multi-beat shape (welcome / story teaser / community / CTA /
  // breathing / transition); listicle / explainer formats opt into a
  // short host-personality intro via Format.script.introDefaults
  // (typically ~50 words, no breathing exercise). Per-request fields
  // still win when present — this only fills in what the caller didn't
  // provide.
  const fmtIntro = format.script.introDefaults
  const fallbackBeats = fmtIntro?.beats?.length ? fmtIntro.beats : [
    'Welcome & host intro',
    'Story teaser',
    'Community question',
    'Subscribe CTA',
    'Relaxation / breathing exercise',
    'Transition into story',
  ]
  const fallbackWordTarget = (typeof fmtIntro?.wordTarget === 'number' && fmtIntro.wordTarget > 0)
    ? fmtIntro.wordTarget : 350
  const introSettings: IntroSettings = {
    enabled: true,
    host_name: req.host_name || '',
    word_target: req.word_target || fallbackWordTarget,
    custom_opening: req.custom_opening || '',
    beats: req.beats || fallbackBeats,
  }

  const paths = await resolveEpisodePaths(project_slug, episode_id, title)

  // Create directories if needed
  await fs.mkdir(paths.script_dir, { recursive: true })

  const apiKeys = { anthropic_api_key: config.anthropic_api_key, openai_api_key: config.openai_api_key, kie_api_key: config.kie_api_key }
  const brand = await getEffectiveBrand(project_slug)
  const sysPrompt = systemPrompt(format, standards, brand)
  const introStandardsText = (config as any).intro_standards || ''

  job.output_lines.push(`Generating introduction...`)

  // v1.0.71+: format-supplied example text. Listicle / explainer
  // formats ship a short host-personality template that's far more
  // useful than abstract beats for matching the channel's voice. We
  // substitute {host_name} and {channel_name} from the request +
  // brand so the example stays generic in the format JSON. Empty
  // when the format doesn't ship one (sleep-story, etc.).
  let formatExampleBlock = ''
  if (fmtIntro?.exampleText?.trim()) {
    const channelName = brand?.channel?.name?.trim() || project?.name?.trim() || ''
    const hostName = (introSettings.host_name || '').trim() || '[your name]'
    const filled = fmtIntro.exampleText
      .replace(/\{host_name\}/g, hostName)
      .replace(/\{channel_name\}/g, channelName || '[channel name]')
    formatExampleBlock = `\nExample style — match this voice + length (don't copy verbatim, but stay this short and personal):\n"""\n${filled}\n"""\n`
  }

  // Generate introduction-only prompt
  const introPrompt = `Generate ONLY the introduction section for a story episode. Do NOT include the story chapters.

Episode code: ${episode_id}
Episode title: ${title}
Target introduction length: ${introSettings.word_target} words

Narrator style: ${style}

Write ONLY the introduction following these beats:
${(introSettings.beats || []).map((b, i) => `${i + 1}. ${b}`).join('\n')}

${introSettings.custom_opening ? `Use this opening line: "${introSettings.custom_opening}"` : ''}
${formatExampleBlock}
${introStandardsText ? `\nFollow this intro format reference:\n${introStandardsText}\n` : ''}

Target word count: ~${introSettings.word_target} words
Output ONLY the introduction text. No meta-commentary. No story chapters.`

  // Per-chapter refactor: intro is now its own source file, written
  // alongside the per-chapter docx files. The unified narration is then
  // re-assembled from those sources. Audio / subtitles / video assembly
  // still read the unified file — Introduction shows up as the first
  // section inside it because assembleUnifiedNarration places intro
  // before chapters.
  //
  // We require at least one chapter source on disk first (intro is by
  // contract dependent on chapters for context). Eager-migrate from a
  // legacy unified-only narration if needed so users with old episodes
  // can still run intro generation without manually re-running the
  // script step.
  const { ensureChapterFilesMigrated, writeChapterFiles, assembleUnifiedNarration } =
    await import('../lib/narration-assembly.js')
  await ensureChapterFilesMigrated(paths.script_dir, episode_id, title)

  // After potential migration, verify chapters exist.
  let scriptDirEntries: string[] = []
  try { scriptDirEntries = await fs.readdir(paths.script_dir) } catch { /* missing */ }
  const chapterRe = new RegExp(`^${episode_id}_Chapter_\\d+\\.docx$`)
  const hasAnyChapter = scriptDirEntries.some(n => chapterRe.test(n))
  if (!hasAnyChapter) {
    throw new Error(
      'No chapter source files found. Generate the script (chapters) first; ' +
      'introduction is appended to the unified narration after it exists.',
    )
  }

  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)
  try {
    const introText = await callAi(style === 'custom' ? 'gpt-4o' : req.model, sysPrompt, introPrompt, apiKeys, true,
      { slug: project_slug, jobId: job.job_id, signal: controller.signal })
    const wordCount = introText.split(/\s+/).length
    job.output_lines.push(`Introduction: ${wordCount.toLocaleString()} words`)

    // Write _Introduction.docx as its own source file (no title-block
    // branding — it's a slice that gets concatenated into the unified
    // file by assembleUnifiedNarration).
    await writeChapterFiles(paths.script_dir, episode_id, title, {
      chapters: [],
      intro: { text: introText.trim() },
    })
    job.output_lines.push(`Wrote: ${episode_id}_Introduction.docx`)

    // Re-assemble unified narration so downstream sees the intro section.
    await assembleUnifiedNarration(paths.script_dir, episode_id, title)
    job.output_lines.push(`Re-assembled: ${path.basename(paths.narration_docx)}`)

    // Sidecar marker so /projects/:slug/episodes can flip
    // `episode.status.introduction = true` without re-parsing the docx on
    // every list call. Also records intro metadata for later display.
    const introMarkerPath = paths.narration_docx.replace(/\.docx$/, '.intro.json')
    await fs.writeFile(introMarkerPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      host_name: introSettings.host_name,
      word_target: introSettings.word_target,
      word_count: wordCount,
      custom_opening: introSettings.custom_opening || null,
      beats: introSettings.beats,
    }, null, 2))
  } finally {
    clearInterval(cancelWatcher)
  }
}

// ── Outline-only / expand-chapters executors ────────────────────────────
//
// Phase 2 of the outline-first refactor. The chunked-narration module
// already has buildOutlineOnly() and expandChapters() — these are thin
// job executors that wire up the same setup generateEpisode does (config
// load, format resolution, brand persona, character cast, paths, abort
// signal) and then delegate to the chunked-narration helpers.
//
// generateScriptOnly stays as the legacy one-shot path (Phase 3 will
// replace it). The executors below are NEW alongside it; both can ship
// in the same release with the back-compat one-shot still available.

/**
 * Shared setup for outline-only + expand-chapters executors. Builds the
 * ChunkedNarrationParams from the job's request, plus the cancel-watcher
 * the LLM stream needs. Returns the params + a teardown fn the executor
 * MUST call in a finally block to stop the watcher.
 */
/**
 * Shared setup for outline-only + expand-chapters executors.
 *
 * source: 'request' (default)
 *   Builds params from the request body (today's GenerateScriptRequest).
 *   Used by outline-only — the user's form choices ARE the source of truth
 *   the first time around.
 *
 * source: 'sidecar'
 *   Prefers the sidecar's persisted generation_params over the request
 *   body. Used by expand-chapters so expansion always runs against the
 *   model / words / pattern / characters the outline was built with —
 *   even if the user edited the form between outline build and expand.
 *   Falls back to request fields when the sidecar is on v2 (no
 *   generation_params yet) or when a specific field wasn't persisted.
 */
async function setupChunkedJobContext(
  job: Job,
  opts: { source?: 'request' | 'sidecar' } = {},
): Promise<{
  params: ChunkedNarrationParams
  mode: ChunkedMode
  teardown: () => void
}> {
  const source = opts.source ?? 'request'
  const { project_slug, episode_id, params: jobParams } = job
  const req = jobParams as GenerateScriptRequest

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')
  const project = await pm.getProject(project_slug)
  if (!project) throw new Error('Project not found')

  const standards = await pm.getStandards(project_slug) || ''
  let format = await getEffectiveFormat(project_slug)
  const title = req.title

  // For expand-chapters, prefer the sidecar's persisted snapshot over the
  // request body. The sidecar was written at outline-build time and is the
  // authoritative record of what the outline was built against. Fields
  // missing from generation_params (or absent because the sidecar is v2)
  // fall through to the request body — keeps in-flight outlines working
  // through the schema bump.
  let snapshot: GenerationParams | null = null
  let snapshotTotalChapters: number | undefined
  if (source === 'sidecar') {
    const paths = await resolveEpisodePaths(project_slug, episode_id, title)
    const sidecar = await readSidecar(paths.script_dir, episode_id)
    if (sidecar) {
      snapshot = sidecar.generation_params
      snapshotTotalChapters = sidecar.total_chapters
    }
  }

  const model = snapshot?.model || req.model
  // Without a model the downstream callAi → provider dispatch crashes inside
  // `modelId.startsWith(...)` and every batch fails with the cryptic
  // "Cannot read properties of undefined (reading 'startsWith')". Surface a
  // clear, actionable error here instead.
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('No model selected — pick a model in the script form before expanding.')
  }
  const length = snapshot?.length ?? req.length ?? format.script.defaultLengthMinutes
  const chapters = snapshotTotalChapters ?? req.chapters ?? format.script.defaultChapterCount
  const totalWords = snapshot?.total_words ?? req.total_words ?? (length === 45 ? 5500 : 7500)
  const wordsPerChapter = snapshot?.words_per_chapter ?? req.words_per_chapter ?? Math.floor(totalWords / chapters)
  const patternId = snapshot?.pattern_id ?? req.pattern_id
  const patternSubject = snapshot?.pattern_subject ?? req.pattern_subject
  const characterIds = snapshot?.character_ids ?? req.character_ids
  const customStyleText = snapshot?.custom_style_text ?? (req as any).custom_style_text

  // Pattern fusion (same path generateEpisode uses).
  if (patternId) {
    const pattern = await loadPattern(patternId)
    if (pattern) {
      const subject = patternSubject || ''
      format = fuseFormatWithPattern(format, pattern, subject, chapters)
      job.output_lines.push(`Applied pattern: ${pattern.name}` + (subject ? ` (subject: "${subject}")` : ''))
    } else {
      job.output_lines.push(`Pattern '${patternId}' not found — generating without pattern`)
    }
  }

  const characters = characterIds?.length
    ? await resolveCharacters(project_slug, characterIds)
    : []
  if (characters.length) {
    job.output_lines.push(`Cast: ${characters.map(c => c.name).join(', ')}`)
  }

  const paths = await resolveEpisodePaths(project_slug, episode_id, title)
  await fs.mkdir(paths.script_dir, { recursive: true })

  const apiKeys = {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }
  const brand = await getEffectiveBrand(project_slug)
  const sysPrompt = systemPrompt(format, standards, brand)

  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  // Snapshot the resolved fields onto params so buildOutlineOnly can write
  // them into the v3 sidecar. On expand runs this is informational only
  // (the sidecar already has it), but populating consistently keeps the
  // contract simple.
  const generationParams: GenerationParams = {
    model,
    length,
    total_words: totalWords,
    words_per_chapter: wordsPerChapter,
    pattern_id: patternId,
    pattern_subject: patternSubject,
    character_ids: characterIds,
    custom_style_text: customStyleText,
  }

  const params: ChunkedNarrationParams = {
    episode_id,
    title,
    totalChapters: chapters,
    wordsPerChapter,
    format,
    systemPrompt: sysPrompt,
    scriptDir: paths.script_dir,
    model,
    apiKeys,
    characters: characters.length ? characters : undefined,
    signal: controller.signal,
    isCancelled: () => jq.isCancelled(job.job_id),
    patternId,
    patternSubject,
    force: !!(jobParams as any).force,
    generationParams,
  }
  const mode: ChunkedMode = format.script.chaptersIndependent ? 'listicle' : 'narrative'

  return {
    params,
    mode,
    teardown: () => clearInterval(cancelWatcher),
  }
}

/**
 * Build outline only — the first half of the chunked flow. Persists a
 * sidecar with `outline_approved_at: null` (unless the request body has
 * `auto_approve: true`, used by pipeline-batch headless callers). The
 * frontend's OutlineReviewPanel then reads/edits the outline and PUT
 * /outline approves it before expand-chapters can run.
 */
export async function generateOutlineOnly(job: Job): Promise<void> {
  const { params, mode, teardown } = await setupChunkedJobContext(job)
  const autoApprove = !!(job.params as any).auto_approve
  try {
    job.output_lines.push(`Building outline (${mode})…`)
    const result = await buildOutlineOnly(job, params, mode, { auto_approve: autoApprove })
    job.output_lines.push(
      `Outline ${result.fromCache ? 'loaded from cache' : 'built'}: ` +
      `${result.outline.length} chapter slots ` +
      `${result.approved ? '(auto-approved)' : '— review & approve to expand'}.`,
    )
  } finally {
    teardown()
  }
}

/**
 * Expand chapters from an approved outline. Refuses unless the sidecar's
 * outline_approved_at is set OR `auto_approve: true` is on the request.
 * Optional `chapters: number[]` filter expands only those slots; absent =
 * expand all pending. Per-entry words_per_chapter overrides flow through
 * the sidecar (set via PUT /outline) into the batch prompts.
 */
export async function generateExpandChapters(job: Job): Promise<void> {
  const { params, teardown } = await setupChunkedJobContext(job, { source: 'sidecar' })
  const req = job.params as any
  const autoApprove = !!req.auto_approve
  // Filter array of chapter numbers to expand. Lives under its own key so it
  // doesn't collide with `req.chapters` (the chapter-count number read by
  // setupChunkedJobContext). Frontend sends it as `chapters_to_expand`.
  const chaptersFilter: number[] | undefined = Array.isArray(req.chapters_to_expand)
    ? (req.chapters_to_expand as unknown[])
        .map(n => Number(n))
        .filter(n => Number.isFinite(n) && n > 0)
    : undefined

  try {
    if (chaptersFilter?.length) {
      job.output_lines.push(`Expanding selected chapters: ${chaptersFilter.join(', ')}…`)
    } else {
      job.output_lines.push(`Expanding all pending chapters…`)
    }
    const result = await expandChapters(job, params, {
      chaptersToExpand: chaptersFilter,
      auto_approve: autoApprove,
    })
    job.output_lines.push(
      `Expansion complete: ${result.chaptersWritten} chapter file(s) on disk ` +
      `(${result.totalBatches} batch${result.totalBatches === 1 ? '' : 'es'}).`,
    )

    // Re-assemble the unified narration so downstream readers (audio
    // reconciler, subtitles, video assembly) see fresh chapters. Mirrors
    // generateChapterOnly's post-write step.
    const { assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
    const paths = await resolveEpisodePaths(job.project_slug, job.episode_id, params.title)
    await assembleUnifiedNarration(paths.script_dir, job.episode_id, params.title)
    job.output_lines.push(`Re-assembled: ${path.basename(paths.narration_docx)}`)
  } finally {
    teardown()
  }
}
