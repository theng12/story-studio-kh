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

import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import type { GenerateScriptRequest, Job } from '../models/types.js'

const NARRATOR_STYLES: Record<string, string> = {
  A: 'Warm and intimate. First-person narrator, very close to the character\'s inner world. Feels like a whispered confidence.',
  B: 'Gentle third-person observer. Lyrical, slightly poetic, like watching from a warm window.',
  C: 'Classic quiet storyteller. Traditional "once there was" tone, timeless and cosy, like a fireside tale.',
  D: 'Poetic and lyrical. Rich metaphors, flowing sentences, language that sounds like music. Every paragraph is art.',
  E: 'Whimsical and playful. Light-hearted, a little cheeky, with gentle humour. Perfect for younger audiences or lighthearted tales.',
  F: 'Mysterious and atmospheric. Fog-shrouded prose, building intrigue slowly. The world feels ancient and full of secrets.',
  G: 'Grandparent bedtime voice. Warm, unhurried, with the cadence of someone who has told a thousand stories and loves every one.',
  H: 'Nature documentary calm. Patient, reverent, finding wonder in small details of the natural world.',
  I: 'Meditative and mindful. Present-tense awareness, grounding the listener in each sensory moment. Breath-paced prose.',
  J: 'Fairy tale narrator. Storybook formality with a wink. "Once upon a time" energy, clear moral arcs, satisfying endings.',
}

function systemPrompt(productionStandards: string): string {
  return `You are a world-class sleep story author.

Follow these production standards exactly:

${productionStandards}

Additional rules:
- Write prose that feels like a skilled human author — literary, calm, immersive.
- No robotic pronoun chains. Never start more than 2 consecutive sentences with the same pronoun.
- Use the character's name or a descriptive noun at least once every 3-4 sentences.
- No singular they/them for individual characters — always use he/she matching the character.
- Chapter headings use Arabic numbers only (Chapter 1, Chapter 2...), never Roman numerals.
- Each chapter heading must include a descriptive title.`
}

interface IntroSettings {
  enabled?: boolean
  host_name?: string
  word_target?: number
  custom_opening?: string
  beats?: string[]
}

function narrationPrompt(
  code: string, title: string, length: number, style: string,
  chapters: number, totalWords: number, wordsPerChapter: number,
  introSettings?: IntroSettings,
  styleOverride?: string,
  introStandards?: string,
): string {
  const styleDesc = styleOverride || NARRATOR_STYLES[style] || NARRATOR_STYLES.A
  const wordFloor = Math.floor(totalWords * 0.9)
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

STRUCTURE (output as plain text with markdown-style headings):
${hasIntro ? introSection : ''}
# ${title} — Narration (${totalWords}+ words)

Write EXACTLY ${chapters} chapters. Each chapter MUST be ~${wordsPerChapter} words.
Each chapter heading format: ## Chapter N: [Descriptive Title]

CHAPTER PACING:
- Chapters 1-3: Setting, character introduction, gentle world-building
- Chapters 4-6: Gentle journey, exploration, small discoveries
- Chapters 7-${chapters - 1}: Slowing pace, deeper calm, sensory details
- Chapter ${chapters}: Resolution, peace, drifting into sleep

The story should be calming, immersive, and perfect for falling asleep to.

FINAL CHECK BEFORE RESPONDING:
- Introduction: ~${introWords} words? ✓
- Story body: ${totalWords}+ words (${chapters} chapters × ${wordsPerChapter} words each)? ✓
- Total: ${totalWords + introWords}+ words? ✓
If not, keep writing until you hit the targets.

Output ONLY the script text. No meta-commentary.`
}

function imagePromptsPrompt(code: string, title: string, storySummary: string, styleTag: string): string {
  return `Generate ALL image prompts for a sleep story episode.

Episode code: ${code}
Episode title: ${title}

Story summary for reference (stay consistent with these details):
${storySummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL REQUIREMENTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. You MUST generate 24-30 scene prompts total (2-3 per chapter).
2. You MUST generate exactly 5 thumbnail prompts.
3. Every single prompt MUST end with the style tag shown below.
4. Every single prompt MUST include an inline character description.
5. Do NOT stop early. Write ALL prompts in a single response.

OUTPUT STRUCTURE (use markdown-style headings):

# Character Reference — [Character Name]

Write a full physical description of the main character.

# Chapter Scene Prompts

For EACH chapter, write 2-3 scene prompts. At least 24 total.
Format: ## Scene N: [Brief Scene Title]

Each prompt MUST end with this exact style tag:
"${styleTag}"

# Thumbnail Prompts

## Thumbnail 1 through ## Thumbnail 5

CRITICAL FOR THUMBNAILS: Every thumbnail prompt MUST include:
'The episode title "${title}" is displayed in large, golden, glowing text, perfectly centered and legible against the background.'

Each thumbnail MUST also end with the style tag above.

Output ONLY the prompts. No meta-commentary.`
}

function youtubePrompt(code: string, title: string, storySummary: string): string {
  return `Generate a YouTube description for a sleep story episode.

Episode code: ${code}
Episode title: ${title}

Story summary for reference:
${storySummary}

OUTPUT FORMAT (plain text, copy-paste ready):

[Title line - max 95 characters]

[Hook paragraph - 2-3 sentences drawing listener in]

──────────────────────────────────────
MUSIC: [describe ambient soundscape matching the episode theme]
──────────────────────────────────────

📚 BOOKS WE RECOMMEND FOR QUIET NIGHTS:
- [Book 1] by [Author]
- [Book 2] by [Author]
- [Book 3] by [Author]
- [Book 4] by [Author]
- [Book 5] by [Author]

(Pick 5 real, currently published books thematically matching the episode.)

──────────────────────────────────────
💛 SUPPORT:
Subscribe for free — it keeps the stories coming.

──────────────────────────────────────
🤖 AI DISCLOSURE:
This story was written with the assistance of AI tools and reviewed for quality and warmth.

──────────────────────────────────────
#SleepStory #BedtimeStory [+ 13 more episode-specific hashtags, 15 total]

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

function autoSelectStyle(code: string, prefix: string): string {
  const numMatch = code.match(/\d+/)
  const epNum = numMatch ? parseInt(numMatch[0]) : 0
  return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'][epNum % 10]
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
  const title = req.title
  const length = req.length || 45
  let style = req.style === 'auto' ? autoSelectStyle(episode_id, project.episode_prefix) : req.style
  // Resolve custom style text without mutating the shared NARRATOR_STYLES object
  let customStyleText: string | undefined
  if (style && (style.startsWith('style-') || style === 'custom')) {
    customStyleText = (params as any).custom_style_text || (params as any).intro_settings?.custom_style_text
  }
  const chapters = req.chapters || 10
  let totalWords = req.total_words || (length === 45 ? 5500 : 7500)
  let wordsPerChapter = req.words_per_chapter || Math.floor(totalWords / chapters)

  // Extract style tag from standards (look for the pattern)
  const styleTagMatch = standards.match(/"([^"]*Storybook[^"]*)"/)
  const styleTag = styleTagMatch?.[1] || 'Storybook 2D illustration style, flat design, bold outlines, warm and luminous colour palette, bright golden and shiny accent details, soft cel-shaded depth, dreamlike and cosy atmosphere.'

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
  const sysPrompt = systemPrompt(standards)

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
    const narrationText = await callAi(req.model, sysPrompt,
      narrationPrompt(episode_id, title, length, style, chapters, totalWords, wordsPerChapter, introEnabled ? introSettings : undefined, customStyleText, introStandardsText),
      apiKeys, true, { slug: project_slug, jobId: job.job_id, signal: controller.signal })

    const wordCount = narrationText.split(/\s+/).length
    job.output_lines.push(`Narration: ${wordCount.toLocaleString()} words`)

    const storySummary = extractStorySummary(narrationText)

    // Call 2: Image prompts. Check cancellation before every follow-up LLM
    // call — each is a separate paid request, and an auto-run script gen can
    // have 3+ calls. Pre-call check stops new work while leaving the already-
    // produced narration intact on disk for the user.
    let imageText: string | null = null
    if (!skipImages && !jq.isCancelled(job.job_id)) {
      job.output_lines.push('Generating image prompts...')
      imageText = await callAi(req.model, sysPrompt,
        imagePromptsPrompt(episode_id, title, storySummary, styleTag), apiKeys, false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      const promptCount = (imageText.match(/^##\s/gm) || []).length
      job.output_lines.push(`Image prompts: ${promptCount} prompts`)
    }

    // Call 3: YouTube description
    let ytText: string | null = null
    if (!skipYoutube && !jq.isCancelled(job.job_id)) {
      job.output_lines.push('Generating YouTube description...')
      ytText = await callAi(req.model, sysPrompt,
        youtubePrompt(episode_id, title, storySummary), apiKeys, false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      job.output_lines.push('YouTube description: done')
    }

    // Per-chapter source files first; the unified narration_docx is
    // assembled FROM them so downstream readers (audio reconciler,
    // subtitles, video assembly, story-context readers) keep working.
    // See electron/server/lib/narration-assembly.ts for the contract.
    const { splitNarrationIntoChapters, writeChapterFiles, assembleUnifiedNarration } =
      await import('../lib/narration-assembly.js')
    const parts = splitNarrationIntoChapters(narrationText)
    await writeChapterFiles(paths.script_dir, episode_id, title, parts)
    job.output_lines.push(
      `Wrote ${parts.chapters.length} chapter file(s)` +
      (parts.intro ? ` + intro` : ''),
    )
    await assembleUnifiedNarration(paths.script_dir, episode_id, title)
    job.output_lines.push(`Assembled: ${path.basename(paths.narration_docx)}`)

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
  const apiKeys = { anthropic_api_key: config.anthropic_api_key, openai_api_key: config.openai_api_key, kie_api_key: config.kie_api_key }
  const sysPrompt = systemPrompt(standards)
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
  const style = req.style || 'A'
  const styleDesc = NARRATOR_STYLES[style as keyof typeof NARRATOR_STYLES] || NARRATOR_STYLES.A

  const chapterPrompt = `Regenerate ONLY Chapter ${chapterNumber} of an existing narration script.

Episode: "${title}" (code ${episode_id})
Narrator style: Style ${style} — ${styleDesc}
Total chapters in this episode: ${totalChapters}
Target word count for this chapter: ~${wordsPerChapter} words

${priorSummaries.length ? `Story so far (prior chapters, summarised):\n${priorSummaries.join('\n')}\n` : ''}

Write ONLY Chapter ${chapterNumber}. Keep tone, pacing, and narrative continuity consistent with the prior chapters. Match the chapter pacing position: ${
  chapterNumber === 1 ? 'opening — gentle world-building, character introduction.'
  : chapterNumber === totalChapters ? 'final — resolution, peace, drifting into sleep.'
  : chapterNumber <= totalChapters / 2 ? 'early-middle — exploration, small discoveries.'
  : 'late — slowing pace, deeper calm, sensory details.'
}

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
  const title = req.title
  const length = req.length || 45
  const style = req.style || 'A'

  let customStyleText: string | undefined
  if (style && (style.startsWith('style-') || style === 'custom')) {
    customStyleText = req.custom_style_text
  }

  const introSettings: IntroSettings = {
    enabled: true,
    host_name: req.host_name || '',
    word_target: req.word_target || 350,
    custom_opening: req.custom_opening || '',
    beats: req.beats || [
      'Welcome & host intro',
      'Story teaser',
      'Community question',
      'Subscribe CTA',
      'Relaxation / breathing exercise',
      'Transition into story',
    ],
  }

  const paths = await resolveEpisodePaths(project_slug, episode_id, title)

  // Create directories if needed
  await fs.mkdir(paths.script_dir, { recursive: true })

  const apiKeys = { anthropic_api_key: config.anthropic_api_key, openai_api_key: config.openai_api_key, kie_api_key: config.kie_api_key }
  const sysPrompt = systemPrompt(standards)
  const introStandardsText = (config as any).intro_standards || ''

  job.output_lines.push(`Generating introduction...`)

  // Generate introduction-only prompt
  const introPrompt = `Generate ONLY the introduction section for a story episode. Do NOT include the story chapters.

Episode code: ${episode_id}
Episode title: ${title}
Target introduction length: ${introSettings.word_target} words

Narrator style: ${style}

Write ONLY the introduction following these beats:
${(introSettings.beats || []).map((b, i) => `${i + 1}. ${b}`).join('\n')}

${introSettings.custom_opening ? `Use this opening line: "${introSettings.custom_opening}"` : ''}

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
