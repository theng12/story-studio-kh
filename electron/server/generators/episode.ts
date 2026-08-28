/**
 * Script generator — port of generate_episode.py.
 * Generates narration script, image prompts, and YouTube description.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { callAi, callAiWithRetry } from '../lib/ai-client.js'
import { buildNarrationDocx, buildImagePromptsDocx } from '../lib/docx-builder.js'
import { matchChapterFile, introMarkerPath, resolveArtifact } from '../lib/episode-artifacts.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { getEffectiveFormat, fillPacingArcPlaceholders } from '../services/format-loader.js'
import { applyRecencyToFormat, recordUsage } from '../services/recency-tracker.js'
import { getEffectiveNiche } from '../services/niche-loader.js'
// v1.0.166 — pattern-loader import removed with the Pattern system.
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
  inspectChunkedScriptCompletion,
  readSidecar,
  producerNotesBlock,
  type ChunkedNarrationParams,
  type ChunkedMode,
  type GenerationParams,
} from '../lib/chunked-narration.js'
import { castPromptBlock, castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import type { GenerateScriptRequest, Job, Format, NarratorStyle, Character } from '../models/types.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { isLocalTextModel } from '../services/job-retry-policy.js'

// v1.0.166 — fuseFormatWithPattern() removed with the Pattern system.
// Title shaping happens at idea-time via the Ideas page's title_template
// field; the script generator uses the project's effective format directly.

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

function applyCreativeFreedom(format: Format, req: GenerateScriptRequest): Format {
  const mode = req.creative_mode || 'guided'
  const direction = req.creative_direction?.trim()
  if (!direction) return format
  const script = { ...format.script }
  // Creative direction can shape this episode's imagery, emphasis, and
  // transitions, but it must never erase Formula-owned perspective, opening
  // policy, pacing contract, or human-writing safeguards.
  const priority = mode === 'strict' ? 'follow closely' : mode === 'open' ? 'explore within the Formula' : 'use when compatible'
  script.additionalRules = [...script.additionalRules, `EPISODE CREATIVE DIRECTION — ${priority}: ${direction}`]
  return { ...format, script }
}

// ── Narrative point of view (v1.0.196, expanded v1.0.327) ──────────────────
// First/second/third person — orthogonal to narrator style. Resolved from the
// Script form's picker (req.perspective) with the format's defaultPerspective
// as the fallback, then appended as a prominent rule so it overrides any
// perspective baked into the format's own copy.
//
// v1.0.327 — expanded from 3 broad buckets ('first'/'second'/'third') to 8
// concrete variants. The user reported that "first" was too vague for animal-
// POV scripts ("when my script is about koalas, it should be I" — but as the
// koala, not as a human bystander). Each variant maps to a distinct prompt
// directive so the LLM can tell the difference between, say, an animal
// speaking in first-person and a creator-influencer speaking in first-person.
// Format's `defaultPerspective` still uses the narrow 3-choice enum (kept
// stable so existing format JSONs work unchanged); the user picker can
// override with any of the 8 specific variants.
type Perspective =
  | 'first'                     // generic human first-person narrator
  | 'first-subject'             // I AM the subject of the video (koala, car, building)
  | 'first-plural'              // we / us / our — collective voice
  | 'second'                    // instructional you ("here's what you'd do")
  | 'second-immersive'          // immersive you ("you find yourself in a forest")
  | 'third'                     // third-person limited (follows ONE character)
  | 'third-omniscient'          // all-knowing narrator
  | 'third-documentary'         // objective, fact-based observer

function perspectiveDirective(p: Perspective): string {
  switch (p) {
    case 'first':
      return 'POINT OF VIEW — write the narration in FIRST PERSON: a human speaker refers to themselves as "I", "me", "my" and speaks about their own actions, plan, or experience. Do not narrate the subject from the outside.'
    case 'first-subject':
      return 'POINT OF VIEW — write the narration in FIRST PERSON AS THE SUBJECT of the video. The narrator IS the topic itself — the animal, object, person, or place the video is about. Open by establishing identity ("I am a koala", "I am a Boeing 747", "I am the Mariana Trench") and stay in that voice throughout. Speak from inside the subject\'s experience using "I", "me", "my". Do NOT slip into third-person about the subject ("the koala does X"); the subject IS speaking. Concrete sensory detail from inside the subject\'s perspective.'
    case 'first-plural':
      return 'POINT OF VIEW — write the narration in FIRST PERSON PLURAL: a collective "we"/"us"/"our" voice — a group speaking together about shared experience, identity, or situation. Avoid singular "I" for the protagonist. Use "we", "our", "us", "ourselves" throughout. The narrator represents the group.'
    case 'second':
      return 'POINT OF VIEW — write the narration in SECOND PERSON (instructional/advisory): address the viewer directly as "you" and "your" (e.g. "here\'s what you\'d do…", "you can try…"). The viewer is being told what to do or what would happen if they took an action. Do not use first-person "I"/"we" for the protagonist, nor third-person "he/she/they".'
    case 'second-immersive':
      return 'POINT OF VIEW — write the narration in SECOND PERSON (immersive): put the viewer INTO the scene as the character experiencing the events. "You find yourself in…", "you see…", "you feel…", "you reach for…". The viewer IS the protagonist living the moment. Describe what they experience and sense, not what they should do. Concrete present-tense sensory detail.'
    case 'third':
      return 'POINT OF VIEW — write the narration in THIRD PERSON LIMITED: follow ONE character closely and refer to them by name and as "he", "she", or "they". The narrator stays with this character\'s perspective; we see only what they see and know. Avoid first-person "I"/"we" and second-person "you" for the subject.'
    case 'third-omniscient':
      return 'POINT OF VIEW — write the narration in THIRD PERSON OMNISCIENT: an all-knowing narrator who can see and report past, present, future, and the inner thoughts of every character. Free to switch focus between characters, foreshadow, and comment. Use "he", "she", "they", and proper nouns. Speak with the authority of someone who has the whole story.'
    case 'third-documentary':
      return 'POINT OF VIEW — write the narration in THIRD PERSON DOCUMENTARY: an objective, fact-based observer\'s voice. Refer to subjects by name and role. The narrator is uninvolved, like a documentary voiceover or natural-history host. Avoid emotional language unless directly quoting. Use "he", "she", "they", or proper nouns.'
  }
}
const KNOWN_PERSPECTIVES: ReadonlySet<Perspective> = new Set([
  'first', 'first-subject', 'first-plural',
  'second', 'second-immersive',
  'third', 'third-omniscient', 'third-documentary',
])
function resolvePerspective(reqPerspective: unknown, format: Format): Perspective | '' {
  // A Series Formula is authoritative for perspective. New Story Studio
  // screens no longer offer a per-episode POV picker; this guard also stops
  // saved legacy request payloads from overriding the Formula contract.
  if (format.script.additionalRules.some(rule => rule.startsWith('FORMULA-OWNED PERSPECTIVE —'))) return ''
  const p = String(reqPerspective || '').toLowerCase()
  // v1.0.328 — 'none' is an explicit opt-out: caller wants ZERO POV directive
  // injected. Returns '' so applyPerspectiveToFormat is a no-op below. (The
  // empty-string return is also used for unknown values + formats with no
  // default, but those callers semantically also want "no extra directive".)
  if (p === 'none') return ''
  if (KNOWN_PERSPECTIVES.has(p as Perspective)) return p as Perspective
  // Format's defaultPerspective stays in the narrow 3-choice enum; map it
  // straight through (format JSONs don't yet pick a specific sub-variant).
  const def = format.script.defaultPerspective
  return def === 'first' || def === 'second' || def === 'third' ? def : ''
}
/**
 * v1.0.328 — `customNote` is optional free-text the user wrote in the Script
 * form's "Custom POV note" field. Appended verbatim as an additional rule so
 * the LLM treats it with the same weight as the preset directive (if any).
 * Combinations:
 *   - preset + custom → both injected (preset gives shape, custom adds nuance)
 *   - preset alone    → just the preset directive (existing behaviour)
 *   - custom alone    → just the user's note (e.g. dropdown set to "None")
 *   - neither         → format-untouched (no-op)
 */
function applyPerspectiveToFormat(
  format: Format,
  perspective: Perspective | '',
  customNote?: string,
): Format {
  const additions: string[] = []
  if (perspective) additions.push(perspectiveDirective(perspective))
  const trimmed = typeof customNote === 'string' ? customNote.trim() : ''
  if (trimmed) additions.push(`POINT OF VIEW (additional note from the user): ${trimmed}`)
  if (!additions.length) return format
  return {
    ...format,
    script: {
      ...format.script,
      additionalRules: [...format.script.additionalRules, ...additions],
    },
  }
}

/**
 * v1.0.335 — strip `## Image Prompts` / `## Thumbnail Prompts` H2 sections
 * from a production-standards markdown blob. Used by the script-narration
 * system prompt builder to keep image-prompt rules out of the writing LLM's
 * context (they belong to dedicated generators with their own prompts, and
 * carrying them into the chapter call causes the LLM to dump thumbnail
 * prompts inside chapter bodies — see the EP0017/19/23 regression).
 *
 * Stripping rule: any H2 heading whose title CONTAINS the words "image
 * prompt" or "thumbnail" (case-insensitive) is dropped along with all the
 * lines under it, up to the next H2 heading or end of file. H1/H3+/sibling
 * sections are untouched. Empty input returns empty.
 */
export function stripImagePromptSections(standards: string): string {
  if (!standards || !standards.trim()) return standards
  const lines = standards.split('\n')
  const out: string[] = []
  let skipping = false
  const stripHeading = /^##\s+/
  const targetHeading = /^##\s+.*\b(image\s*prompt|thumbnail)/i
  for (const line of lines) {
    if (stripHeading.test(line)) {
      // Entering a new H2 — flip skip flag based on whether THIS heading matches.
      skipping = targetHeading.test(line)
      if (skipping) continue
    }
    if (!skipping) out.push(line)
  }
  // Collapse runs of >2 blank lines that the strip may have left behind.
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

function systemPrompt(format: Format, productionStandards: string): string {
  // Formula-derived rules remain authoritative. This legacy free-form file is
  // now an optional project-specific instruction layer, never permission to
  // replace a Formula's point of view, evidence policy, or structure.
  // v1.0.335 — defensively strip ## Image Prompts / ## Thumbnail* H2 blocks
  // from the user's standards. They have no business in the script-narration
  // system prompt (each generator has its own dedicated prompts), and earlier
  // template versions shipped with an "Image Prompts" section whose example
  // string ("watercolor style, soft palette") caused the chunked-narration
  // LLM to emit thumbnail prompts inside chapter bodies (EP0017/19/23).
  // Templates have been cleaned, but legacy projects still have the buggy file
  // on disk — this strip protects them without needing a per-project migration.
  const cleanedStandards = stripImagePromptSections(productionStandards)
  const standardsBody = [format.productionStandardsAddendum, cleanedStandards]
    .filter(s => s && s.trim()).join('\n\n')

  const additionalRules = format.script.additionalRules.map(r => `- ${r}`).join('\n')

  // v1.0.215+ — Universal "write for the voice" guidance. This narration is
  // fed to a text-to-speech engine, so notation that reads fine on the page
  // (em dashes, semicolons, ellipses, markdown) comes out unnatural when
  // spoken — worse on local engines. A deterministic normalizer in the audio
  // path is the hard safeguard; this nudges the LLM to write clean, speakable
  // prose up front so the text on disk is good too. Kept format-agnostic: it
  // governs punctuation + speakability, not the format's tone/voice.
  const ttsWritingGuidance = `Write for the EAR — this script is read aloud by a text-to-speech voice:
- Use ONLY simple, spoken punctuation: periods, commas, and question marks. Do NOT use em dashes or en dashes (—, –), semicolons, ellipses (…), parentheses, asterisks, or any markdown/special symbols — speech engines read them unnaturally. Use a comma or start a new sentence instead.
- Favour natural, speakable sentences with varied length. Avoid long, clause-stacked or piled-up appositive phrasing (e.g. "the old light in his eyes, a sentinel, a friend") that sounds artificial when spoken aloud.
- Spell things as they should be said (e.g. "Doctor" not "Dr.", "and" not "&").
- Write ordinary numbers as words in the narration. Use conventional spoken years: 1871 is "eighteen seventy-one", 2001 is "two thousand one", and 2010 is "twenty ten". Write dates, quantities, percentages, and currency exactly as the voice should say them. Keep digits only when they are intentionally exact identifiers, URLs, citations, equations, model names, file names, addresses, or other technical literals. Required structural headings must retain their requested chapter or section numbers as digits.`

  const baseSystem = `${format.script.systemPromptRole}

${standardsBody ? `OPTIONAL PROJECT INSTRUCTIONS — apply these only when they do not conflict with the Series Formula or Additional rules:

${standardsBody}
` : ''}

Additional rules:
${additionalRules}

${ttsWritingGuidance}`

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

  // Section label — what the format calls its primary content unit.
  // Sleep-story → "Chapter", reasons-explainer → "Reason", listicle →
  // "Topic". Defaults to Chapter/Chapters so every format without the
  // field set in JSON keeps its existing prompt copy unchanged.
  const sectionSingular = format.script.sectionLabel?.singular || 'Chapter'
  const sectionPlural = format.script.sectionLabel?.plural || 'Chapters'
  const sectionLower = sectionSingular.toLowerCase()
  const sectionLowerPlural = sectionPlural.toLowerCase()

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
PART 2 — STORY BODY: MINIMUM ${totalWords} words across ${chapters} ${sectionLowerPlural} (floor: ${wordFloor})

TOTAL OUTPUT: at least ${totalWords + introWords} words.
The story body word count of ${totalWords} does NOT include the introduction.` : `
STORY BODY: MINIMUM ${totalWords} words across ${chapters} ${sectionLowerPlural} (floor: ${wordFloor})
No introduction needed — start directly with the story.`}

Each ${sectionLower} MUST be approximately ${wordsPerChapter} words.
You MUST write EXACTLY ${chapters} ${sectionLowerPlural}. Not fewer. Not more.
Do NOT truncate or cut the story short for any reason.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${castBlock}
STRUCTURE (output as plain text with markdown-style headings):
${hasIntro ? introSection : ''}
# ${title} — Narration (${totalWords}+ words)

Write EXACTLY ${chapters} ${sectionLowerPlural}. Each ${sectionLower} MUST be ~${wordsPerChapter} words.
Each ${sectionLower} heading format: ## ${sectionSingular} N: [Descriptive Title]

${sectionSingular.toUpperCase()} PACING:
${fillPacingArcPlaceholders(format.script.pacingArc, chapters).map(l => `- ${l}`).join('\n')}

${format.script.closingHint}

FINAL CHECK BEFORE RESPONDING:
- Introduction: ~${introWords} words? ✓
- Story body: ${totalWords}+ words (${chapters} ${sectionLowerPlural} × ${wordsPerChapter} words each)? ✓
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
  // v1.0.106+ — append the niche's recency-avoidance instruction (if
  // any) onto format.script.additionalRules so the LLM is told which
  // items the channel used in its last N episodes. No-op when the
  // niche has no recencyAvoidance config OR the log is empty.
  format = await applyRecencyToFormat(format, project_slug)
  format = applyPerspectiveToFormat(format, resolvePerspective((req as any).perspective, format), (req as any).custom_perspective)
  format = applyCreativeFreedom(format, req)
  const title = req.title
  const length = req.length || format.script.defaultLengthMinutes
  let style = req.style === 'auto' ? autoSelectStyle(format, episode_id) : req.style
  // Resolve custom style text without mutating the shared narrator-styles array
  let customStyleText: string | undefined
  if (style && (style.startsWith('style-') || style === 'custom')) {
    customStyleText = (params as any).custom_style_text || (params as any).intro_settings?.custom_style_text
  }
  const chapters = req.chapters || format.script.defaultChapterCount
  // v1.0.168 — word sizing comes straight from the request: the script form
  // now always sends explicit chapters + words_per_chapter, and duration is
  // informational only (no longer drives word math). For API callers that
  // omit the fields, fall back to per-chapter × chapters with a neutral
  // per-chapter default — never the old duration-keyed 5500/7500 guess.
  let wordsPerChapter = req.words_per_chapter || (req.total_words ? Math.floor(req.total_words / chapters) : 550)
  let totalWords = req.total_words || (wordsPerChapter * chapters)

  // v1.0.166 — Pattern composition removed. The Pattern system retired in
  // v1.0.165/166; title shaping now happens at idea-time via the Ideas
  // page's title_template field, so the script generator just uses the
  // project's effective format (+ niche) directly.

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
  const sysPrompt = systemPrompt(format, standards)

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
    // overflow a single LLM call. That ceiling is the SELECTED PRODUCT's
    // published `max_output_tokens`, read live from the GenStudio catalogue
    // (see resolveChunkingBudget) — never a constant. Two signals can trigger
    // chunking:
    //   1. word-count heuristic (chunkThresholdWords) — fast pre-check
    //   2. dynamic budget check — projects with a heavy character cast,
    //      long production standards or a large character cast can crowd
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

    // v1.0.106+ — scan the freshly-assembled narration for niche-tracked
    // items (e.g. prayer scripture references) and append to the
    // project's recency log so the NEXT episode's prompt can avoid them.
    // Non-fatal: a malformed niche regex or unreadable docx logs a
    // warning but doesn't fail the script run.
    await recordRecencyForEpisode(job.project_slug, episode_id, paths.narration_docx)

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
      imageText = await callAiWithRetry(req.model, sysPrompt,
        imagePromptsPrompt(format, episode_id, title, storySummary, styleTag, characters), apiKeys, false,
        // Long: one prompt per scene for the whole episode in a single pass.
        { slug: project_slug, jobId: job.job_id, signal: controller.signal, outputBudget: 'long' })
      const promptCount = (imageText.match(/^##\s/gm) || []).length
      job.output_lines.push(`Image prompts: ${promptCount} prompts`)
    }

    // Call 3: YouTube description
    let ytText: string | null = null
    if (!skipYoutube && !jq.isCancelled(job.job_id)) {
      job.output_lines.push('Generating YouTube description...')
      ytText = await callAiWithRetry(req.model, sysPrompt,
        youtubePrompt(format, episode_id, title, storySummary), apiKeys, false,
        // Standard: a multi-paragraph description, not a title or a tag list.
        { slug: project_slug, jobId: job.job_id, signal: controller.signal, outputBudget: 'standard' })
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
      const { formatMetadataTxt } = await import('../services/metadata-format.js')
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
  const introMarker = introMarkerPath(paths.narration_docx)
  await fs.unlink(introMarker).catch(() => {})
  // Delete both the new .md and any legacy .docx intro source.
  await fs.unlink(path.join(paths.script_dir, `${job.episode_id}_Introduction.md`)).catch(() => {})
  await fs.unlink(path.join(paths.script_dir, `${job.episode_id}_Introduction.docx`)).catch(() => {})

  await generateEpisode({ ...job, params: baseParams })
  const scriptCompletion = await inspectChunkedScriptCompletion(paths.script_dir, job.episode_id)
  requireJobCompletion(job, {
    label: 'Script generation',
    expected: scriptCompletion.expected,
    completed: scriptCompletion.present,
    missing: scriptCompletion.missing.map(chapter => `Chapter ${chapter}`),
    invalid: [
      ...(!scriptCompletion.approved ? ['outline approval'] : []),
      ...(!scriptCompletion.outline_valid ? ['outline chapter count'] : []),
    ],
    retry_hint: 'Completed chapter files were kept. Resume expansion to fill only missing chapters.',
  })

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
  let format = await getEffectiveFormat(project_slug)
  format = await applyRecencyToFormat(format, project_slug)
  format = applyPerspectiveToFormat(format, resolvePerspective((req as any).perspective, format), (req as any).custom_perspective)
  format = applyCreativeFreedom(format, req)
  const apiKeys = { anthropic_api_key: config.anthropic_api_key, openai_api_key: config.openai_api_key, kie_api_key: config.kie_api_key }
  const sysPrompt = systemPrompt(format, standards)
  const paths = await resolveEpisodePaths(project_slug, episode_id, title)
  const savedGuidance = (await readSidecar(paths.script_dir, episode_id))?.generation_params?.manual_guidance?.trim()
  const requestGuidance = typeof req.manual_guidance === 'string' ? req.manual_guidance.trim() : undefined
  const manualGuidance = savedGuidance || requestGuidance

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
  const existingNumbers = entries
    .map(n => matchChapterFile(n, episode_id))
    .filter((n): n is number => n !== null)
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

  // Section vocabulary from the format ("Chapter" by default; explainer
  // formats use "Reason" / "Topic"). Lower-cased variants for inline copy.
  const sectionSingularRegen = format.script.sectionLabel?.singular || 'Chapter'
  const sectionPluralRegen = format.script.sectionLabel?.plural || 'Chapters'
  const sectionLowerRegen = sectionSingularRegen.toLowerCase()
  const sectionLowerPluralRegen = sectionPluralRegen.toLowerCase()

  const chapterPrompt = `Regenerate ONLY ${sectionSingularRegen} ${chapterNumber} of an existing narration script.

Episode: "${title}" (code ${episode_id})
Narrator style: Style ${style} — ${styleDesc}
Total ${sectionLowerPluralRegen} in this episode: ${totalChapters}
Target word count for this ${sectionLowerRegen}: ~${wordsPerChapter} words
${producerNotesBlock(manualGuidance)}
${outlineBlock}${independenceLine}
${priorSummaries.length && !independenceLine ? `Story so far (prior ${sectionLowerPluralRegen}, summarised):\n${priorSummaries.join('\n')}\n` : ''}

Write ONLY ${sectionSingularRegen} ${chapterNumber}. ${outlineLookup?.mode === 'listicle'
  ? 'Stay on the topic above; do not invent a different subject.'
  : `Keep tone, pacing, and narrative continuity consistent with the prior ${sectionLowerPluralRegen}. Match the ${sectionLowerRegen} pacing position: ${pickPacingHint(chapterNumber)}`}

Output format (markdown):
## ${sectionSingularRegen} ${chapterNumber}: [Descriptive Title]

[Body — approximately ${wordsPerChapter} words.]

Output ONLY the ${sectionLowerRegen} heading + body. No commentary, no other ${sectionLowerPluralRegen}.`

  job.output_lines.push(`Regenerating Chapter ${chapterNumber}…`)
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)
  try {
    const chapterText = await callAiWithRetry(req.model, sysPrompt, chapterPrompt, apiKeys, true,
      // Long: a full chapter of narration.
      { slug: project_slug, jobId: job.job_id, signal: controller.signal, outputBudget: 'long' })

    // Parse out the title from the heading the model produced. Fall back
    // to a synthesised title if the model omitted it.
    const headingMatch = chapterText.trim().match(/^##\s+Chapter\s+\d+\s*[:\-–—]\s*(.+)$/im)
    const newTitle = headingMatch ? headingMatch[1].trim() : `Chapter ${chapterNumber}`
    const body = chapterText.replace(/^##\s+Chapter\s+\d+[^\n]*\n+/m, '').trim()
    if (!body) throw new Error(`Chapter ${chapterNumber} generation returned no usable body text.`)

    await writeChapterFiles(paths.script_dir, episode_id, title, {
      chapters: [{ number: chapterNumber, title: newTitle, text: body }],
    })
    job.output_lines.push(`Wrote: ${episode_id}_Chapter_${String(chapterNumber).padStart(2, '0')}.md`)

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
  let format = await getEffectiveFormat(project_slug)
  format = await applyRecencyToFormat(format, project_slug)
  const title = req.title
  const length = req.length || format.script.defaultLengthMinutes
  const style = req.style || format.script.defaultNarratorStyleId

  let customStyleText: string | undefined
  if (style && (style.startsWith('style-') || style === 'custom')) {
    customStyleText = req.custom_style_text
  }

  // v1.0.71+ kept format-aware intro defaults here; a format may still ship
  // its own opening shape (a listicle channel wants ~50 words and no
  // breathing exercise) and `fmtIntro` below is still how its example text
  // reaches the prompt.
  //
  // v1.4.73 — the CHANNEL's recipe is the default, not a per-call guess.
  //
  // This used to assemble its own fallback beat list here, which had quietly
  // drifted out of step with the one the Script page showed: the page offered
  // seven beats, this offered six and had lost the membership mention
  // entirely. So an opening written from the page and an opening written by
  // an unattended batch were written from different instructions. Both now
  // come from `lib/episode-segments.ts` by way of the channel's saved recipe,
  // which itself defaults from the format where the format ships one.
  //
  // Per-request fields still win, so a one-off override from an API call
  // behaves exactly as it did — this only changes what fills in the blanks.
  const fmtIntro = format.script.introDefaults
  const { getChannelSegments } = await import('../services/channel-segments.js')
  const { beatLinesForPrompt, INTRODUCTION_SEGMENT_ID } = await import('../lib/episode-segments.js')
  const channelRecipe = (await getChannelSegments(project_slug))[INTRODUCTION_SEGMENT_ID].recipe
  const introSettings: IntroSettings = {
    enabled: true,
    host_name: req.host_name || channelRecipe.host_name || '',
    word_target: req.word_target || channelRecipe.word_target,
    custom_opening: req.custom_opening || channelRecipe.custom_opening_line || '',
    beats: req.beats?.length ? req.beats : beatLinesForPrompt(channelRecipe),
  }

  const paths = await resolveEpisodePaths(project_slug, episode_id, title)

  // Create directories if needed
  await fs.mkdir(paths.script_dir, { recursive: true })

  const apiKeys = { anthropic_api_key: config.anthropic_api_key, openai_api_key: config.openai_api_key, kie_api_key: config.kie_api_key }
  const sysPrompt = systemPrompt(format, standards)
  const introStandardsText = (config as any).intro_standards || ''

  job.output_lines.push(`Generating introduction...`)

  // v1.0.71+: format-supplied example text. Listicle / explainer
  // formats ship a short host-personality template that's far more
  // useful than abstract beats for matching the channel's voice. We
  // substitute {host_name} and {channel_name} from the request and project
  // so the example stays generic in the format JSON. Empty
  // when the format doesn't ship one (sleep-story, etc.).
  let formatExampleBlock = ''
  if (fmtIntro?.exampleText?.trim()) {
    const channelName = project?.name?.trim() || ''
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

  // Say so when this is about to REPLACE an introduction rather than write a
  // first one. Migration above has just materialised any introduction that
  // lived only inside the unified narration, so by here the file is the
  // honest answer. Deliberately a log line and not a refusal: `force` never
  // reaches this generator (`presetToParams` passes only episode/title/model),
  // so a refusal here would be a lock the owner has no key for — he would
  // press Regenerate and get nothing. The real defence is upstream, in
  // asset-status, which no longer reports these episodes as having none.
  const existingIntro = resolveArtifact(paths.script_dir, `${episode_id}_Introduction`)
  if (existingIntro) {
    const existingWords = (await fs.readFile(existingIntro, 'utf-8').catch(() => ''))
      .trim().split(/\s+/).filter(Boolean).length
    if (existingWords > 0) {
      job.output_lines.push(`Replacing an existing introduction (${existingWords} words) — the previous text is not kept.`)
    }
  }

  // After potential migration, verify chapters exist.
  let scriptDirEntries: string[] = []
  try { scriptDirEntries = await fs.readdir(paths.script_dir) } catch { /* missing */ }
  const hasAnyChapter = scriptDirEntries.some(n => matchChapterFile(n, episode_id) !== null)
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
    const introText = await callAiWithRetry(req.model, sysPrompt, introPrompt, apiKeys, true,
      // Long: a full introduction section of narration.
      { slug: project_slug, jobId: job.job_id, signal: controller.signal, outputBudget: 'long' })
    const cleanedIntro = introText.trim()
    if (!cleanedIntro) throw new Error('Introduction generation returned no usable text.')
    const wordCount = cleanedIntro.split(/\s+/).length
    job.output_lines.push(`Introduction: ${wordCount.toLocaleString()} words`)

    // Write _Introduction.docx as its own source file (no title-block
    // branding — it's a slice that gets concatenated into the unified
    // file by assembleUnifiedNarration).
    await writeChapterFiles(paths.script_dir, episode_id, title, {
      chapters: [],
      intro: { text: cleanedIntro },
    })
    job.output_lines.push(`Wrote: ${episode_id}_Introduction.md`)

    // Re-assemble unified narration so downstream sees the intro section.
    await assembleUnifiedNarration(paths.script_dir, episode_id, title)
    job.output_lines.push(`Re-assembled: ${path.basename(paths.narration_docx)}`)

    // Sidecar marker so /projects/:slug/episodes can flip
    // `episode.status.introduction = true` without re-parsing the narration on
    // every list call. Also records intro metadata for later display.
    const introMarkerFile = introMarkerPath(paths.narration_docx)
    await fs.writeFile(introMarkerFile, JSON.stringify({
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
// load, format resolution, character cast, paths, abort
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
 *   words / pattern / characters the outline was built with — those are
 *   outline-SHAPED (the outline literally counts chapters and allocates
 *   words), so changing them mid-flight would desync the outline from the
 *   prose. Falls back to request fields when the sidecar is on v2 (no
 *   generation_params yet) or when a specific field wasn't persisted.
 *
 *   THE MODEL IS THE ONE EXCEPTION (v1.0.786). It used to be taken from the
 *   snapshot too, for one-voice-across-chapters consistency. But a stored
 *   model id is a CACHED MODEL REFERENCE, which AGENTS.md's first rule
 *   forbids precisely because it goes stale: GenStudio renames and
 *   re-versions products, and when the recorded id stops resolving the run
 *   dead-ends with "not available — choose a published product" and NO way
 *   forward, even with a perfectly good model selected in the form. Nine
 *   paid chapters on disk and no way to write the tenth is not an
 *   acceptable price for stylistic consistency.
 *
 *   So the request body's model wins and the snapshot's is informational.
 *   The consistency concern is real, so the answer is to make the change
 *   VISIBLE rather than to prevent it: a differing model is announced in
 *   the job log here, and in the outline panel before the user clicks.
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
  format = await applyRecencyToFormat(format, project_slug)
  format = applyPerspectiveToFormat(format, resolvePerspective((req as any).perspective, format), (req as any).custom_perspective)
  format = applyCreativeFreedom(format, req)
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

  // MODEL: the currently selected one wins. See the doc comment above for
  // why this single field does not follow the snapshot. The snapshot is only
  // consulted when the caller named no model at all (a headless caller that
  // relies on the outline's record) — never to override a live selection.
  const requestedModel = typeof req.model === 'string' && req.model.trim()
    ? req.model.trim()
    : undefined
  const snapshotModel = typeof snapshot?.model === 'string' && snapshot.model.trim()
    ? snapshot.model.trim()
    : undefined
  const model = requestedModel || snapshotModel
  // Without a model the downstream callAi → provider dispatch crashes inside
  // `modelId.startsWith(...)` and every batch fails with the cryptic
  // "Cannot read properties of undefined (reading 'startsWith')". Surface a
  // clear, actionable error here instead.
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('No model selected — pick a model in the script form before expanding.')
  }
  // Say it out loud when the run will not use the model the outline was built
  // with. Silent substitution is what made the old behaviour hard to reason
  // about in both directions; the log line names both ids so the owner can
  // see exactly what changed and decide whether to reroll earlier chapters.
  if (source === 'sidecar' && snapshotModel && requestedModel && snapshotModel !== requestedModel) {
    job.output_lines.push(
      `Model changed since the outline was built: outline used "${snapshotModel}", ` +
      `expansion will use the currently selected "${requestedModel}". ` +
      `Chapters already on disk are kept as-is — regenerate any you want rewritten in the new voice.`,
    )
  } else if (source === 'sidecar' && !requestedModel && snapshotModel) {
    job.output_lines.push(
      `No model in the request — falling back to the outline's recorded model "${snapshotModel}".`,
    )
  }
  const length = snapshot?.length ?? req.length ?? format.script.defaultLengthMinutes
  const chapters = snapshotTotalChapters ?? req.chapters ?? format.script.defaultChapterCount
  // v1.0.168 — word sizing is chapters × words-per-chapter, never a
  // duration-keyed guess. Prefer explicit per-chapter target; derive total
  // from it. Falls back to a neutral 550/chapter only when nothing is set.
  const wordsPerChapter = snapshot?.words_per_chapter ?? req.words_per_chapter
    ?? (snapshot?.total_words ?? req.total_words ? Math.floor((snapshot?.total_words ?? req.total_words!) / chapters) : 550)
  const totalWords = snapshot?.total_words ?? req.total_words ?? (wordsPerChapter * chapters)
  const requestedStyle = snapshot?.style ?? req.style ?? format.script.defaultNarratorStyleId
  const style = requestedStyle === 'auto'
    ? autoSelectStyle(format, episode_id)
    : requestedStyle
  const perspective = snapshot?.perspective ?? (req as any).perspective
  const customPerspective = snapshot?.custom_perspective ?? (req as any).custom_perspective
  format = applyPerspectiveToFormat(format, resolvePerspective(perspective, format), customPerspective)
  const characterIds = snapshot?.character_ids ?? req.character_ids
  const customStyleText = snapshot?.custom_style_text ?? (req as any).custom_style_text
  // v1.0.297 — optional free-text producer guidance. Prefer the sidecar
  // snapshot on expand runs so chapter bodies get the SAME guidance the
  // outline was built with (names/settings stay consistent into the body).
  const manualGuidanceRaw = snapshot?.manual_guidance ?? (req as any).manual_guidance
  const manualGuidance = typeof manualGuidanceRaw === 'string' && manualGuidanceRaw.trim()
    ? manualGuidanceRaw.trim()
    : undefined

  // v1.0.166 — Pattern fusion removed with the Pattern system.

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
  const narratorStyle = customStyleText || narratorStyleFor(format, style).description
  const sysPrompt = `${systemPrompt(format, standards)}

NARRATOR STYLE — binding for both outline and chapter prose:
${narratorStyle}`

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
    style,
    perspective: typeof perspective === 'string' ? perspective : undefined,
    custom_perspective: typeof customPerspective === 'string' ? customPerspective : undefined,
    character_ids: characterIds,
    custom_style_text: customStyleText,
    manual_guidance: manualGuidance,
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
    force: !!(job.params as any).force,
    manualGuidance,
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
    requireJobCompletion(job, {
      label: 'Script outline generation',
      expected: params.totalChapters,
      completed: Math.min(params.totalChapters, result.outline.length),
      missing: Array.from(
        { length: Math.max(0, params.totalChapters - result.outline.length) },
        (_, index) => `Chapter ${result.outline.length + index + 1}`,
      ),
      invalid: result.outline.length > params.totalChapters ? ['extra outline chapters'] : [],
      retry_hint: 'The partial outline was kept. Retry outline generation before approval and expansion.',
    })
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
    let result = await expandChapters(job, params, {
      chaptersToExpand: chaptersFilter,
      auto_approve: autoApprove,
    })

    // One-click self-healing: providers occasionally return only part of a
    // requested batch without throwing. Retry the still-missing slots once in
    // the same job instead of reporting a misleading successful completion.
    let completion = await inspectChunkedScriptCompletion(params.scriptDir, job.episode_id)
    if (!chaptersFilter?.length && completion.missing.length > 0 && isLocalTextModel(params.model)) {
      job.output_lines.push(
        `Self-healing incomplete expansion: retrying missing chapters ${completion.missing.join(', ')} once…`,
      )
      result = await expandChapters(job, params, {
        chaptersToExpand: completion.missing,
        auto_approve: autoApprove,
      })
      completion = await inspectChunkedScriptCompletion(params.scriptDir, job.episode_id)
    }
    job.output_lines.push(
      `Expansion pass complete: ${completion.present}/${completion.expected} chapter file(s) on disk ` +
      `(${result.totalBatches} batch${result.totalBatches === 1 ? '' : 'es'}).`,
    )

    // Re-assemble the unified narration so downstream readers (audio
    // reconciler, subtitles, video assembly) see fresh chapters. Mirrors
    // generateChapterOnly's post-write step.
    const { assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
    const paths = await resolveEpisodePaths(job.project_slug, job.episode_id, params.title)
    await assembleUnifiedNarration(paths.script_dir, job.episode_id, params.title)
    job.output_lines.push(`Re-assembled: ${path.basename(paths.narration_docx)}`)

    completion = await inspectChunkedScriptCompletion(paths.script_dir, job.episode_id)
    // A deliberately filtered manual run is allowed to remain partial. The
    // strict whole-script postcondition applies to "expand all" and Pipeline
    // runs, where success must mean the complete approved outline is present.
    if (!chaptersFilter?.length && !completion.complete) {
      const detail = !completion.approved
        ? 'the current outline is not approved'
        : completion.outline_valid
        ? `${completion.present}/${completion.expected} chapters are present; missing ${completion.missing.join(', ') || 'unknown'}`
        : `the outline contains an invalid chapter count (${completion.present}/${completion.expected} present)`
      throw new Error(`Chapter expansion did not pass its completion check: ${detail}. Resume expansion to repair it.`)
    }

    // v1.0.106+ — recency record (same as in the legacy generate path
    // above). Done once per expand-chapters run AFTER the unified docx
    // is reassembled, so multi-batch expansions log a single set of
    // matches instead of partials. See recordRecencyForEpisode below.
    await recordRecencyForEpisode(job.project_slug, job.episode_id, paths.narration_docx)
  } finally {
    teardown()
  }
}

/**
 * v1.0.106+ helper — read the unified narration docx for an episode,
 * convert to markdown, and run the active niche's recency extract
 * patterns against the text. Matches are appended to the project's
 * recency_log. No-op when the niche has no recencyAvoidance config.
 *
 * Idempotent: re-running for the same episode dedupes by (episode,
 * kind, item) inside `recordUsage`, so a re-expand doesn't double-log.
 *
 * Fail-soft: logs a warning and returns when the docx can't be parsed
 * or the niche regex throws — never fails the parent script-generation
 * job over an analytics-style side effect.
 */
async function recordRecencyForEpisode(slug: string, episode_code: string, narrationDocxPath: string): Promise<void> {
  try {
    const niche = await getEffectiveNiche(slug)
    if (!niche?.recencyAvoidance) return
    const { narrationDocxToMarkdown } = await import('../lib/docx-parser.js')
    const md = await narrationDocxToMarkdown(narrationDocxPath)
    if (!md) return
    const result = await recordUsage(slug, episode_code, niche, md)
    if (result && result.added.length > 0) {
      console.log(`[episode] ${slug}/${episode_code}: recency log updated with ${result.added.length} ${result.kind} (${result.added.join(', ')})`)
    }
  } catch (e: any) {
    console.warn(`[episode] ${slug}/${episode_code}: recency record skipped: ${e.message}`)
  }
}
