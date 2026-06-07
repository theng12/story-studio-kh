/**
 * Image-prompts generator — batch job executor.
 *
 * Mirrors the synchronous POST /generate/image-prompts + POST
 * /generate/image-prompts/save flow in routes/scripts.ts, but collapses
 * the generate-then-save steps into a single job. Used by the Pipeline
 * batch runner so overnight chains can produce the Scene/Thumbnail
 * prompt docx files without waiting for user review.
 *
 * The interactive route in routes/scripts.ts is untouched — this is an
 * additive batch path.
 */

import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { callAi } from '../lib/ai-client.js'
import { SUPPORTED_MODELS } from '../models/types.js'
import { resolveEpisodePaths, resolveSubfolderNames } from '../services/utils.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { trackGeneration } from '../services/session-tracker.js'
import { castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import type { Job } from '../models/types.js'
import { resolveTextStyle, resolveFontStyle } from '../models/thumbnail-styles.js'
import { matchChapterFile, readArtifactRawText } from '../lib/episode-artifacts.js'

// Preset shape we expect in job.params (from the Image Prompts page's
// usePresets snapshot { form: {...} }, unwrapped by routes/pipeline.ts).
interface ImagePromptsParams {
  episode_id: string
  title?: string
  model?: string
  style_preset?: string
  style_tag?: string
  aspect_ratio?: string
  scenes_per_chapter?: number
  total_scenes?: number
  /**
   * Explicit chapter count from the form. When set, the generator
   * multiplies scenes_per_chapter by this value (NOT by an auto-
   * resolved sidecar count) so the LLM is told to produce exactly
   * the number the user saw in the form. Falls back to sidecar
   * resolution when absent. Lets the user override the auto-detected
   * chapter count without having to drop into Custom-total mode.
   */
  chapter_count?: number
  thumb_count?: number
  thumb_text_style?: string
  thumb_text_style_custom?: string
  thumb_text_position?: string
  thumb_font_style?: string
  thumb_font_style_custom?: string
  /** v1.0.224 — free-text per-project art direction; overrides format + CTR. */
  thumb_art_direction?: string
  /** v1.0.224 — 'ai' bakes the title into the image (format-aware styling);
   *  'composite' asks for a text-free background so a crisp title can be
   *  overlaid afterward via the thumbnail composer. */
  thumb_title_mode?: 'ai' | 'composite'
  /** v1.0.224 — vision-extracted style descriptor from a reference thumbnail
   *  the user wants to replicate. */
  thumb_reference_style?: string
  mode?: 'all' | 'scenes' | 'thumbnails'
  /**
   * Cast for this episode — passed through from a saved Image Prompts
   * preset (the form field added in image-prompts.vue). The batch
   * executor resolves these to Character records and folds the cast
   * block into the prompt so the LLM has the names + descriptions to
   * inline per scene. Empty / missing → today's "no cast" path.
   */
  character_ids?: string[]
  /**
   * v1.0.308 — fill-gaps (smart Retry). When true, load the scene/thumbnail
   * prompts already on disk and generate ONLY the scenes that are missing,
   * then merge — instead of regenerating all `sceneCount` from scratch and
   * overwriting the file. The Jobs-page Retry sends this so a partial failure
   * ("10 scenes missing: 11-20") is repaired cheaply, preserving the prompts
   * that already succeeded. Absent/false → full regeneration (the page's
   * Generate button path, unchanged).
   */
  fill_gaps?: boolean
}

/** Compact a sorted list of ints into "1-3, 7, 11-20" for log/error output. */
function compactRanges(nums: number[]): string {
  if (!nums.length) return ''
  const sorted = [...nums].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]!
  let prev = sorted[0]!
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i]
    if (n === prev + 1) { prev = n; continue }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`)
    if (n !== undefined) { start = n; prev = n }
  }
  return parts.join(', ')
}

function checkProvider(model: string, config: any): string | null {
  const provider = SUPPORTED_MODELS[model]
  if (provider === 'openai' && !config.openai_api_key) return 'No OpenAI key configured'
  if (provider === 'kie' && !config.kie_api_key) return 'No kie.ai key configured'
  return null
}

function aiCreds(config: any) {
  return {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }
}

/**
 * Resolve the actual chapter count for an episode. Source-of-truth order:
 *   1. Sidecar's `total_chapters` (set when outline_only / script-only built).
 *   2. On-disk `_Chapter_NN.docx` count (handles legacy episodes whose
 *      sidecar predates the field, or episodes manually rebuilt with
 *      different counts that didn't go through the chunked flow).
 *   3. Fallback constant 10 — only when neither exists, which means the
 *      episode is purely idea-stage with no script content yet, and the
 *      generator likely shouldn't be running anyway. The earlier hardcoded
 *      `× 10` was the culprit for "I picked 1 prompt per scene with 20
 *      chapters but only got 10 prompts" — generator silently capped at
 *      10 regardless of how many chapters were actually on disk.
 */
async function resolveChapterCount(
  slug: string, episode_id: string, title: string,
): Promise<number> {
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const { readSidecar } = await import('../lib/chunked-narration.js')
    const sidecar = await readSidecar(paths.script_dir, episode_id)
    if (sidecar && typeof sidecar.total_chapters === 'number' && sidecar.total_chapters > 0) {
      return sidecar.total_chapters
    }
    // No sidecar — count chapter files on disk as a fallback (.md or legacy .docx).
    let entries: string[] = []
    try { entries = await fs.readdir(paths.script_dir) } catch { /* missing dir */ }
    const count = entries.filter(n => matchChapterFile(n, episode_id) !== null).length
    if (count > 0) return count
    // v1.0.102+ — last-resort: format default. Previously hardcoded 10
    // (sleep-story median); now reads format.script.defaultChapterCount
    // so broll-narration / prayer projects get 1 (single continuous
    // narration), listicles get their format's default, etc.
    try {
      const { getEffectiveFormat } = await import('../services/format-loader.js')
      const fmt = await getEffectiveFormat(slug)
      const dcc = fmt?.script?.defaultChapterCount
      if (typeof dcc === 'number' && dcc > 0) return dcc
    } catch { /* fall through to legacy 10 */ }
  } catch { /* fall through */ }
  return 10
}

// Read up to 3000 chars of narration for grounding the LLM.
async function readStoryContext(slug: string, episode_id: string, title: string): Promise<string> {
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const raw = await readArtifactRawText(paths.narration_docx)
    return raw.slice(0, 3000)
  } catch {
    return `Episode: ${episode_id}, Title: ${title || 'Unknown'}`
  }
}

/**
 * Parse the LLM's image-prompts JSON response, tolerating markdown
 * fences and stray prose. Throws if no JSON object is recognisable.
 * Used by both the single-call and chunked paths.
 */
function parseImagePromptsJson(raw: string): { scenes?: any[]; thumbnails?: any[] } {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error('LLM returned no JSON object')
  const obj = JSON.parse(text.slice(start, end + 1))
  return {
    scenes: Array.isArray(obj.scenes) ? obj.scenes : [],
    thumbnails: Array.isArray(obj.thumbnails) ? obj.thumbnails : [],
  }
}

/** Shape of `format.imagePrompts.thumbnail` (see ImagePromptFormat). */
interface ThumbnailFmt {
  conceptGuidance?: string
  compositionRules?: string[]
  defaultTextStyle?: string
  defaultFontStyle?: string
  moodKeywords?: string[]
  avoid?: string[]
}

// Fallback thumbnail concept for any format that ships no `thumbnail` block.
const GENERIC_THUMBNAIL_CONCEPT =
  'A bold, high-impact YouTube cover with ONE clear focal subject that signals the topic at a glance. ' +
  'Vivid saturated color, strong directional lighting, clear depth. This is a COVER designed to win the click — not a scene still.'

// Universal YouTube CTR rules applied to every thumbnail regardless of format.
const YOUTUBE_CTR_RULES = [
  'One clear, bold focal subject that reads instantly.',
  'High contrast with saturated, punchy color.',
  'A large expressive face or one dominant object when it suits the topic.',
  'Rule-of-thirds composition with strong, directional lighting and clear foreground/background separation.',
  'Minimal clutter — must stay legible as a tiny mobile preview (~320px wide).',
]

const GENERIC_THUMBNAIL_AVOID = [
  'low contrast or washed-out / muddy color',
  'tiny details that vanish at preview size',
  'busy collages or multiple competing subjects',
  'flat, evenly-lit, boring framing',
]

/**
 * Build the THUMBNAIL portion of the image-prompts request (v1.0.224). Layers,
 * later overriding earlier: (a) per-format art direction → (b) universal
 * YouTube CTR rules → (c) reference-style replication → (d) per-project
 * art-direction override. Then the title-text line branches on `titleMode`:
 * 'ai' bakes a format-aware title into the image; 'composite' demands a
 * text-free background for a crisp overlay added by the composer afterward.
 */
function buildThumbnailDirective(opts: {
  title: string
  thumbs: number
  titleMode: 'ai' | 'composite'
  fontStyle: string
  fontStyleCustom?: string
  textStyle: string
  textStyleCustom?: string
  textPosition: string
  artDirection?: string
  referenceStyle?: string
  fmt?: ThumbnailFmt | null
}): string {
  if (opts.thumbs <= 0) return ''
  const fmt = opts.fmt
  const lines: string[] = []
  lines.push(
    `THUMBNAIL ART DIRECTION — the thumbnail is the single most important asset for click-through. ` +
    `It is a COVER, not a scene still: do NOT reuse the scene style tag for thumbnails. Follow the direction below.`,
  )
  lines.push(`CONCEPT: ${(fmt?.conceptGuidance || '').trim() || GENERIC_THUMBNAIL_CONCEPT}`)
  if (fmt?.compositionRules?.length) {
    lines.push(`COMPOSITION:\n${fmt.compositionRules.map(r => `  - ${r}`).join('\n')}`)
  }
  if (fmt?.moodKeywords?.length) lines.push(`MOOD: ${fmt.moodKeywords.join(', ')}`)
  lines.push(`YOUTUBE BEST-PRACTICES (apply to every thumbnail):\n${YOUTUBE_CTR_RULES.map(r => `  - ${r}`).join('\n')}`)
  lines.push(`AVOID: ${[...(fmt?.avoid || []), ...GENERIC_THUMBNAIL_AVOID].join('; ')}`)

  // (c) reference-style replication — overrides the generic/format look.
  const ref = (opts.referenceStyle || '').trim()
  if (ref) lines.push(`REFERENCE STYLE — replicate this look as closely as possible (overrides the look above): ${ref}`)
  // (d) per-project art direction — highest priority.
  const ad = (opts.artDirection || '').trim()
  if (ad) lines.push(`PRIORITY ART DIRECTION (overrides everything above on any conflict): ${ad}`)

  // Title text — AI-baked (format-aware) vs composite (text-free background).
  if (opts.titleMode === 'composite') {
    lines.push(
      `TITLE TEXT: Render NO text, title, lettering, watermark, or logo anywhere in the image. ` +
      `Leave a clean, uncluttered area (consistent with the composition) where a crisp title will be overlaid afterward.`,
    )
  } else {
    const fontPhrase = resolveFontStyle(opts.fontStyle, opts.fontStyleCustom)
    const textPhrase = resolveTextStyle(opts.textStyle, opts.textStyleCustom)
    lines.push(
      `TITLE TEXT: The episode title "${opts.title}" must appear in ${fontPhrase}, ${textPhrase}, ` +
      `positioned at the ${opts.textPosition || 'center'} of the frame — large, bold, and legible with strong contrast against the background.`,
    )
  }
  return lines.join('\n\n')
}

function buildPrompt(args: {
  episode_id: string
  title: string
  storyContext: string
  /** Pre-rendered cast block from castImagePromptBlock(). Empty string when no cast. */
  castBlock: string
  sceneCount: number
  thumbs: number
  style_tag: string
  aspect_ratio: string
  /** Full thumbnail instruction block from buildThumbnailDirective(); '' when thumbs===0. */
  thumbnailDirective: string
}): string {
  const { episode_id, title, storyContext, castBlock, sceneCount, thumbs, style_tag, aspect_ratio, thumbnailDirective } = args

  const ratioDescriptions: Record<string, string> = {
    '16:9': 'wide 16:9 landscape format with cinematic framing',
    '1:1': 'square 1:1 format with centered composition',
    '9:16': 'tall 9:16 portrait format with vertical composition',
    '4:3': 'classic 4:3 format',
    '3:4': 'portrait 3:4 format',
    '21:9': 'ultrawide 21:9 cinematic format',
  }
  const ratioInstruction = ratioDescriptions[aspect_ratio] || 'wide landscape format'

  const requirements: string[] = []
  if (sceneCount > 0) requirements.push(`Generate exactly ${sceneCount} scene prompts.`)
  if (thumbs > 0) requirements.push(`Generate exactly ${thumbs} thumbnail prompts.`)
  // Per-prompt length floor + structural guidance. Without this the LLM
  // happily ships 1-sentence prompts ("a forest at dusk") that under-
  // specify the image — user complaint that "the prompts are short."
  // The image generator quality scales with descriptor density, so
  // pinning a 60+ word floor and naming the slots the model should fill
  // (subject, setting, lighting, composition, mood, character detail)
  // produces consistently usable prompts without hand-tuning.
  requirements.push(
    `Each prompt must be DETAILED — 60–120 words, 3–5 sentences. ` +
    `Cover: subject + action, setting + props, lighting + time of day, ` +
    `mood + atmosphere, framing/composition, and any visible characters ` +
    `with concrete physical descriptions. Short one-line prompts are unusable.`,
  )
  requirements.push(`Every prompt must end with this style tag: "${style_tag}"`)
  requirements.push(`Every prompt must specify composition for ${ratioInstruction}.`)
  requirements.push(`Every prompt must include inline character descriptions.`)

  return `Generate image prompts for a story episode.

Episode: ${episode_id} — ${title}

Story context:
${storyContext}
${castBlock}
REQUIREMENTS:
${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}
${sceneCount === 0 ? '\nDo NOT generate any scene prompts. Only generate thumbnail prompts.' : ''}
${thumbs === 0 ? '\nDo NOT generate any thumbnail prompts. Only generate scene prompts.' : ''}

FORMAT — return ONLY a JSON object:
{
  "scenes": [{"number": 1, "title": "Brief Title", "prompt": "Full prompt text..."}],
  "thumbnails": [{"number": 1, "title": "Brief Title", "prompt": "Full prompt text..."}]
}
${thumbs > 0 ? `\n${thumbnailDirective}\n` : ''}
No markdown, no commentary, just valid JSON.`
}

export async function generateImagePrompts(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as ImagePromptsParams

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')

  const model = req.model || 'deepseek-v4-flash'
  const credErr = checkProvider(model, config)
  if (credErr) throw new Error(credErr)

  const title = req.title || episode_id
  const mode = req.mode || 'all'

  // Prefer scenes_per_chapter when present (matches UI semantics: that
  // field is the primary control, total_scenes is the "custom total"
  // escape hatch used only when scenes_per_chapter === 0). Falling through
  // to total_scenes first used to let a stale preset value shadow a
  // freshly-saved scenes_per_chapter=1.
  //
  // Chapter count source of truth, in order of preference:
  //   1. Explicit `chapter_count` from the request (form's editable
  //      Chapter count input — what the user saw + can override).
  //   2. Sidecar's total_chapters (what's actually on disk).
  //   3. 10 fallback (last resort, for idea-stage episodes with no
  //      script yet).
  // The earlier hardcoded `× 10` — and the not-yet-fixed default form
  // value of 10 — produced exactly the user-reported case: 20-chapter
  // outline, "1 per chapter" → only 10 prompts because nothing in the
  // pipeline knew about the real count. The form now makes the count
  // explicit and editable; sending it through here makes the user's
  // typed value authoritative.
  const explicitCount = Number(req.chapter_count)
  const chapterCount = Number.isFinite(explicitCount) && explicitCount > 0
    ? Math.round(explicitCount)
    : await resolveChapterCount(project_slug, episode_id, title)
  const spc = Number(req.scenes_per_chapter)
  const sceneCount = mode === 'thumbnails'
    ? 0
    : (Number.isFinite(spc) && spc > 0
      ? spc * chapterCount
      : (req.total_scenes || (req.scenes_per_chapter || 1) * chapterCount))
  const thumbs = mode === 'scenes' ? 0 : (req.thumb_count || 5)
  const countSource = Number.isFinite(explicitCount) && explicitCount > 0
    ? '(from form)'
    : '(from outline)'
  job.output_lines.push(
    `Target: ${sceneCount} scene prompt(s) for ${chapterCount} chapter(s) ${countSource}` +
    (thumbs > 0 ? ` + ${thumbs} thumbnail(s)` : ''),
  )

  // v1.0.308 — fill-gaps (smart Retry). Read the prompts already on disk so we
  // can generate ONLY the missing scenes below and merge, instead of redoing
  // all of them and overwriting the file. Read from the same files the save
  // step writes. On any read problem we leave the maps empty and fall back to
  // full regeneration (safe — never worse than today).
  const fillGaps = req.fill_gaps === true
  const existingSceneMap = new Map<number, any>()
  let existingThumbs: any[] = []
  if (fillGaps) {
    try {
      const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
      const { existsSync } = await import('fs')
      const paths0 = await resolveEpisodePaths(project_slug, episode_id, title)
      let episodeDir0 = paths0.episode_dir.replace(/\/$/, '')
      const actualDir0 = await resolveEpisodeDir(path.dirname(episodeDir0), episode_id)
      if (actualDir0) episodeDir0 = actualDir0
      const names0 = await resolveSubfolderNames(project_slug, episode_id)
      const sceneDir0 = await resolveSubfolder(episodeDir0, names0.scene_prompts)
      const thumbDir0 = await resolveSubfolder(episodeDir0, names0.thumb_prompts)
      const sceneFile0 = sceneDir0 ? path.join(sceneDir0, `${episode_id}_Scene_Prompts.md`) : ''
      const thumbFile0 = thumbDir0 ? path.join(thumbDir0, `${episode_id}_Thumbnail_Prompts.md`) : ''
      if (sceneFile0 && existsSync(sceneFile0)) {
        const parsed = await parseImagePromptsDocx(sceneFile0)
        for (const s of (parsed.scenes || [])) {
          const n = Number(s.number)
          if (Number.isFinite(n) && n > 0) existingSceneMap.set(n, s)
        }
      }
      if (thumbFile0 && existsSync(thumbFile0)) {
        const parsed = await parseImagePromptsDocx(thumbFile0)
        existingThumbs = parsed.thumbnails || []
      }
      job.output_lines.push(
        `[fill-gaps] ${existingSceneMap.size} scene + ${existingThumbs.length} thumbnail prompt(s) already on disk — only missing ones will be generated.`,
      )
    } catch (e: any) {
      job.output_lines.push(`⚠ [fill-gaps] couldn't read existing prompts (${e?.message || e}); generating all.`)
    }
  }

  job.output_lines.push(`Reading narration for story context…`)
  const storyContext = await readStoryContext(project_slug, episode_id, title)

  // Resolve cast for this episode → cast block. Empty array (or missing
  // field on legacy presets) → empty string injected → today's behaviour
  // unchanged.
  const characters = Array.isArray(req.character_ids) && req.character_ids.length
    ? await cm.resolveCharacters(project_slug, req.character_ids)
    : []
  if (characters.length) {
    job.output_lines.push(`Cast: ${characters.map(c => c.name).join(', ')}`)
  }
  const castBlock = castImagePromptBlock(characters)

  // v1.0.224 — resolve per-format thumbnail art direction (best-effort; a
  // missing format falls back to the generic high-CTR directive). The AI
  // title styling defaults to the FORMAT's defaults, not a hardcoded
  // serif/gold (the old sleep-story bias).
  let thumbFmt: ThumbnailFmt | null = null
  if (thumbs > 0) {
    try {
      const { getEffectiveFormat } = await import('../services/format-loader.js')
      const fmt = await getEffectiveFormat(project_slug)
      thumbFmt = (fmt?.imagePrompts as any)?.thumbnail || null
    } catch { /* generic fallback */ }
  }
  const titleMode: 'ai' | 'composite' = req.thumb_title_mode === 'composite' ? 'composite' : 'ai'
  const thumbnailDirective = buildThumbnailDirective({
    title,
    thumbs,
    titleMode,
    fontStyle: req.thumb_font_style || thumbFmt?.defaultFontStyle || 'serif',
    fontStyleCustom: req.thumb_font_style_custom,
    textStyle: req.thumb_text_style || thumbFmt?.defaultTextStyle || 'gold',
    textStyleCustom: req.thumb_text_style_custom,
    textPosition: req.thumb_text_position || 'center',
    artDirection: req.thumb_art_direction,
    referenceStyle: req.thumb_reference_style,
    fmt: thumbFmt,
  })
  if (thumbs > 0) {
    job.output_lines.push(
      `Thumbnail art direction: ${thumbFmt ? 'format-specific' : 'generic high-CTR'}` +
      `, title mode = ${titleMode}` +
      (req.thumb_reference_style ? ', reference style applied' : '') +
      (req.thumb_art_direction ? ', custom art direction applied' : ''),
    )
  }

  const basePrompt = buildPrompt({
    episode_id,
    title,
    storyContext,
    castBlock,
    sceneCount,
    thumbs,
    style_tag: req.style_tag || '',
    aspect_ratio: req.aspect_ratio || '16:9',
    thumbnailDirective,
  })

  // Brand-level image styling: prepend channel keywords + append the
  // long-form style sheet so every generated prompt inherits the look.
  // Per-project format overrides on `defaultStyleTag` still apply to
  // individual scene/thumb prompts above; brand keywords are an additive
  // channel-wide layer.
  let prompt = basePrompt
  try {
    const { getEffectiveBrand } = await import('../services/brand-loader.js')
    const brand = await getEffectiveBrand(project_slug)
    const keywords = brand?.imagePrompts?.style_keywords
    if (keywords?.length) {
      prompt = `${prompt}\n\nBrand style keywords (include on every image prompt you produce): ${keywords.join(', ')}`
      job.output_lines.push(`Brand style keywords applied: ${keywords.join(', ')}`)
    }
    const sheet = brand?.imagePrompts?.style_sheet?.trim()
    if (sheet) {
      prompt = `${prompt}\n\nStyle reference:\n${sheet}`
    }
    const negatives = brand?.imagePrompts?.negative_prompts
    if (negatives?.length) {
      prompt = `${prompt}\n\nAvoid in all images: ${negatives.join(', ')}`
    }
  } catch { /* brand layer must never break image-prompt generation */ }

  // v1.0.108+ — image-prompts-scope recency. Prepends the niche's
  // avoidance instruction when its rule covers 'image_prompts'. No-op
  // for niches that don't ship recencyAvoidance or don't include
  // 'image_prompts' in their scopes (most niches today). Most niches
  // won't track image prompts — but a niche that wants to avoid e.g.
  // "the same lighting setup" or "the same character archetype" can
  // declare it in the JSON without any code changes here.
  try {
    const { prependAvoidanceToPrompt } = await import('../services/recency-tracker.js')
    prompt = await prependAvoidanceToPrompt(project_slug, 'image_prompts', prompt)
  } catch { /* recency must never break image-prompt generation */ }

  // v1.0.71+: scene-prompt chunking. Each scene prompt costs ~150 output
  // tokens; at ≥50 scenes the single-call path approaches the 16k cap.
  // Above the threshold, we split scene generation into parallel batches
  // of 10 (scenes are independent — no transition glue needed) and
  // produce thumbnails in a separate single call. Single-call path stays
  // unchanged below the threshold so the common case is untouched.
  const SCENE_CHUNK_THRESHOLD = 50
  const SCENE_BATCH_SIZE = 10
  const SCENE_CONCURRENCY = 4
  // Which scene numbers still need generating. In fill-gaps mode that's only
  // the ones not already on disk; otherwise it's all of them.
  const allSceneNumbers = Array.from({ length: sceneCount }, (_, i) => i + 1)
  const missingSceneNumbers = fillGaps
    ? allSceneNumbers.filter(n => !existingSceneMap.has(n))
    : allSceneNumbers
  const thumbsNeeded = fillGaps ? existingThumbs.length < thumbs : thumbs > 0
  if (fillGaps) {
    job.output_lines.push(
      missingSceneNumbers.length
        ? `[fill-gaps] generating ${missingSceneNumbers.length} missing scene(s): ${compactRanges(missingSceneNumbers)}` +
          (thumbsNeeded ? ' + thumbnails.' : ' (thumbnails already present — kept).')
        : `[fill-gaps] all ${sceneCount} scene(s) already present` +
          (thumbsNeeded ? '; generating thumbnails only.' : ' and thumbnails present — nothing to regenerate.'),
    )
  }
  // fill-gaps always uses the chunked/batch path so the per-batch filter + merge
  // apply regardless of total count (and the small-count single-call path can't
  // do a partial run).
  const useChunkedScenes = sceneCount > SCENE_CHUNK_THRESHOLD || fillGaps

  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  let scenes: any[] = []
  let thumbnails: any[] = []
  // v1.0.304 — batches that failed every retry. Surfaced at the end so the job
  // reports honestly (it used to print "Done." even when most batches failed).
  let failedSceneBatches: Array<{ from: number; to: number }> = []

  try {
    if (useChunkedScenes) {
      job.output_lines.push(
        fillGaps
          ? `[fill-gaps] generating missing scenes in parallel batches of ${SCENE_BATCH_SIZE} (concurrency ${SCENE_CONCURRENCY}).`
          : `[chunked] ${sceneCount} scenes > ${SCENE_CHUNK_THRESHOLD} threshold — splitting into parallel batches of ${SCENE_BATCH_SIZE} (concurrency ${SCENE_CONCURRENCY}).`,
      )
      // Build batch ranges [1..10], [11..20], …, plus thumbnails as a
      // separate single call. Each scene batch reuses the same buildPrompt
      // shape but pinned to "scenes numbered K to K+N-1 (do NOT generate
      // others)".
      const allBatches: Array<{ from: number; to: number }> = []
      for (let from = 1; from <= sceneCount; from += SCENE_BATCH_SIZE) {
        allBatches.push({ from, to: Math.min(from + SCENE_BATCH_SIZE - 1, sceneCount) })
      }
      // In fill-gaps mode run only the batches that contain a missing scene; a
      // batch with any gap is regenerated whole (keeps the range complete and
      // batch-aligned for the LLM). Fully-present batches are skipped, so a
      // "10 scenes missing: 11-20" failure costs exactly one batch, not 100.
      const missingSet = new Set(missingSceneNumbers)
      const batches = fillGaps
        ? allBatches.filter((b) => {
          for (let n = b.from; n <= b.to; n++) if (missingSet.has(n)) return true
          return false
        })
        : allBatches
      if (fillGaps) {
        job.output_lines.push(
          `[fill-gaps] ${batches.length} batch(es) to run; ${allBatches.length - batches.length} already-complete batch(es) skipped.`,
        )
      }

      let cursor = 0
      let aborted = false
      let completed = 0
      const collected: any[] = []
      const failed: Array<{ from: number; to: number }> = []
      // v1.0.304 — retry a failed batch a few times before giving up. A
      // transient endpoint blip (a Mac that slept mid-run, a Wi-Fi hiccup)
      // used to lose the batch's scenes permanently. With the provider's
      // pre-flight probe + the pool's failover, a retry routes to a healthy
      // endpoint, so most "failures" recover on the next attempt.
      const MAX_BATCH_ATTEMPTS = 3
      const RETRY_BACKOFF_MS = 800

      async function sceneWorker(workerId: number): Promise<void> {
        while (!aborted) {
          if (jq.isCancelled(job.job_id)) { aborted = true; return }
          const idx = cursor++
          if (idx >= batches.length) return
          const { from, to } = batches[idx]!
          // Patch the base prompt: ask only for scenes in this range, no
          // thumbnails. The rest of the prompt (style tag, character cast,
          // story context, format) is unchanged.
          const batchPrompt = prompt.replace(
            /Generate exactly \d+ scene prompts\./,
            `Generate exactly ${to - from + 1} scene prompts numbered ${from} through ${to} (do NOT generate scenes outside this range, do NOT generate thumbnails).`,
          ) + `\n\nIMPORTANT: This response must contain ONLY scenes ${from}..${to}. The "thumbnails" array MUST be empty.`

          let done = false
          let lastErr: any
          for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS && !aborted; attempt++) {
            if (jq.isCancelled(job.job_id)) { aborted = true; return }
            try {
              const raw = await callAi(model, '', batchPrompt, aiCreds(config), false,
                { slug: project_slug, jobId: job.job_id, signal: controller.signal })
              const obj = parseImagePromptsJson(raw)
              // v1.0.86+: don't filter by `s.number` matching the requested
              // from..to range — LLMs frequently renumber every batch 1..N.
              // Take the first (to-from+1) parseable scenes and RENUMBER them
              // to this batch's expected range; drop entries with no usable
              // prompt string.
              const rawScenes = (obj.scenes || []).filter((s: any) =>
                s && typeof s.prompt === 'string' && s.prompt.trim().length > 0,
              )
              const expected = to - from + 1
              const got = rawScenes.slice(0, expected).map((s: any, i: number) => ({
                ...s,
                number: from + i,
              }))
              collected.push(...got)
              completed++
              const tail = rawScenes.length > expected ? ` (truncated from ${rawScenes.length})` : ''
              const retryNote = attempt > 1 ? ` (recovered on retry ${attempt - 1})` : ''
              job.output_lines.push(
                `[chunked]   [w${workerId}] scenes ${from}-${to}: got ${got.length}/${expected}${tail}${retryNote} (${completed}/${batches.length} batches done)`,
              )
              done = true
              break
            } catch (e: any) {
              lastErr = e
              if (jq.isCancelled(job.job_id) || controller.signal.aborted) { aborted = true; return }
              const isLast = attempt === MAX_BATCH_ATTEMPTS
              job.output_lines.push(
                `[chunked]   [w${workerId}] scenes ${from}-${to} attempt ${attempt}/${MAX_BATCH_ATTEMPTS} failed: ${e?.message || e}` +
                (isLast ? ' — giving up on this batch.' : ' — retrying…'),
              )
              if (!isLast) await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS))
            }
          }
          if (!done && !aborted) failed.push({ from, to })
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(SCENE_CONCURRENCY, batches.length) }, (_, i) => sceneWorker(i + 1)),
      )

      if (aborted) throw new Error('Cancelled by user')
      failedSceneBatches = failed.sort((a, b) => a.from - b.from)
      // Sort by number so the docx output is in deterministic order
      // regardless of which worker finished a given batch first. In fill-gaps
      // mode, merge: keep the existing scenes from skipped batches and overlay
      // the freshly-regenerated ones (same number → regenerated wins).
      if (fillGaps && existingSceneMap.size > 0) {
        const merged = new Map<number, any>(existingSceneMap)
        for (const s of collected) {
          const n = Number(s.number)
          if (Number.isFinite(n)) merged.set(n, s)
        }
        scenes = [...merged.values()].sort((a, b) => Number(a.number) - Number(b.number))
      } else {
        scenes = collected.sort((a, b) => Number(a.number) - Number(b.number))
      }

      // Thumbnails: single call (typical thumbs <= 10, fits easily). In fill-
      // gaps mode only regenerate when some are missing; otherwise `thumbnails`
      // stays [] and the save step leaves the existing thumbnail file untouched.
      if (thumbsNeeded) {
        const thumbsOnlyPrompt = prompt
          .replace(/Generate exactly \d+ scene prompts\./, '')
          + `\n\nIMPORTANT: This response must contain ONLY thumbnails (the "scenes" array MUST be empty).`
        const raw = await callAi(model, '', thumbsOnlyPrompt, aiCreds(config), false,
          { slug: project_slug, jobId: job.job_id, signal: controller.signal })
        const obj = parseImagePromptsJson(raw)
        thumbnails = obj.thumbnails || []
      }
    } else {
      job.output_lines.push(`Calling ${model} (mode=${mode}, scenes=${sceneCount}, thumbs=${thumbs})…`)
      const raw = await callAi(model, '', prompt, aiCreds(config), false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      const parsed = parseImagePromptsJson(raw)
      scenes = parsed.scenes || []
      thumbnails = parsed.thumbnails || []
    }
  } finally {
    clearInterval(cancelWatcher)
  }

  job.output_lines.push(`Parsed ${scenes.length} scene(s), ${thumbnails.length} thumbnail(s).`)

  // v1.0.108+ — image-prompts-scope recency. Scan the joined text of
  // every generated prompt for matches and append to the log. Fail-
  // soft: a regex error or unreadable config logs a warning but never
  // fails the parent job.
  try {
    const { recordUsageForScope } = await import('../services/recency-tracker.js')
    const joined = [
      ...scenes.map((s: any) => `${s.title || ''}\n${s.prompt || ''}`),
      ...thumbnails.map((t: any) => `${t.title || ''}\n${t.prompt || ''}`),
    ].join('\n\n')
    await recordUsageForScope(project_slug, episode_id, 'image_prompts', joined)
  } catch (e: any) {
    job.output_lines.push(`⚠ recency record (image_prompts) skipped: ${e?.message || e}`)
  }

  // Resolve episode dir on disk (real folder, not the stale-title one).
  const paths = await resolveEpisodePaths(project_slug, episode_id, title)
  let episodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = path.dirname(episodeDir)
  const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
  if (actualDir) episodeDir = actualDir

  const names = await resolveSubfolderNames(project_slug, episode_id)

  // Save scenes
  if (scenes.length > 0) {
    const sceneDir = await resolveSubfolder(episodeDir, names.scene_prompts)
    if (!sceneDir) throw new Error(`Scene prompts folder not found: ${names.scene_prompts}`)
    let sceneText = `# Scene Prompts\n\n`
    for (const s of scenes) sceneText += `## Scene ${s.number}: ${s.title}\n\n${s.prompt}\n\n`
    const outPath = path.join(sceneDir, `${episode_id}_Scene_Prompts.md`)
    await buildImagePromptsDocx(sceneText, episode_id, title, outPath)
    job.output_lines.push(`Saved scenes → ${path.basename(outPath)}`)
  }

  // Save thumbnails
  if (thumbnails.length > 0) {
    const thumbDir = await resolveSubfolder(episodeDir, names.thumb_prompts)
    if (!thumbDir) throw new Error(`Thumbnail prompts folder not found: ${names.thumb_prompts}`)
    let thumbText = `# Thumbnail Prompts\n\n`
    for (const t of thumbnails) thumbText += `## Thumbnail ${t.number}: ${t.title}\n\n${t.prompt}\n\n`
    const outPath = path.join(thumbDir, `${episode_id}_Thumbnail_Prompts.md`)
    await buildImagePromptsDocx(thumbText, episode_id, title, outPath)
    job.output_lines.push(`Saved thumbnails → ${path.basename(outPath)}`)
  }

  await trackGeneration(project_slug, 'prompts').catch(() => {})

  // v1.0.304 — honest completion. The chunked path used to print "Done." even
  // when most batches failed (e.g. 30/100 scenes saved, job shown green). Now,
  // if any batch failed every retry, we surface it as an ERROR with the exact
  // counts — the partial scenes are already saved above (preserved, not lost),
  // so the user can re-run to fill only the gaps once the endpoint is back.
  if (failedSceneBatches.length > 0) {
    const missing = failedSceneBatches.reduce((n, b) => n + (b.to - b.from + 1), 0)
    const ranges = failedSceneBatches.map(b => `${b.from}-${b.to}`).join(', ')
    throw new Error(
      `Generated ${scenes.length} of ${sceneCount} scene prompts — ` +
      `${failedSceneBatches.length} batch(es) failed after ${3} attempts (${missing} scenes missing: ${ranges}). ` +
      `Likely an unreachable local endpoint. The ${scenes.length} generated scene(s) were saved; ` +
      `click Retry on this job once the endpoint is back — it regenerates only the ${missing} missing scene(s) and keeps the rest.`,
    )
  }
  job.output_lines.push(`Done.`)
}
