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
  mode?: 'all' | 'scenes' | 'thumbnails'
  /**
   * Cast for this episode — passed through from a saved Image Prompts
   * preset (the form field added in image-prompts.vue). The batch
   * executor resolves these to Character records and folds the cast
   * block into the prompt so the LLM has the names + descriptions to
   * inline per scene. Empty / missing → today's "no cast" path.
   */
  character_ids?: string[]
}

function checkProvider(model: string, config: any): string | null {
  const provider = SUPPORTED_MODELS[model]
  if (provider === 'anthropic' && !config.anthropic_api_key) return 'No Anthropic key configured'
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
    // No sidecar — count chapter docx files on disk as a fallback.
    let entries: string[] = []
    try { entries = await fs.readdir(paths.script_dir) } catch { /* missing dir */ }
    const re = new RegExp(`^${episode_id}_Chapter_(\\d+)\\.docx$`)
    const count = entries.filter(n => re.test(n)).length
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
    const mammoth = await import('mammoth')
    const result = await mammoth.default.extractRawText({ path: paths.narration_docx })
    return result.value.slice(0, 3000)
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
  thumb_font_style: string
  thumb_font_style_custom?: string
  thumb_text_style: string
  thumb_text_style_custom?: string
  thumb_text_position: string
}): string {
  const { episode_id, title, storyContext, castBlock, sceneCount, thumbs, style_tag, aspect_ratio } = args
  const fontPhrase = resolveFontStyle(args.thumb_font_style, args.thumb_font_style_custom)
  const textPhrase = resolveTextStyle(args.thumb_text_style, args.thumb_text_style_custom)
  const thumbTextInstruction = `The episode title "${title}" displayed in ${fontPhrase}, ${textPhrase}, positioned at the ${args.thumb_text_position || 'center'} of the frame, large and legible.`

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

THUMBNAIL RULE: Every thumbnail must include: '${thumbTextInstruction}'

No markdown, no commentary, just valid JSON.`
}

export async function generateImagePrompts(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as ImagePromptsParams

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')

  const model = req.model || 'gpt-4o'
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

  const basePrompt = buildPrompt({
    episode_id,
    title,
    storyContext,
    castBlock,
    sceneCount,
    thumbs,
    style_tag: req.style_tag || '',
    aspect_ratio: req.aspect_ratio || '16:9',
    thumb_font_style: req.thumb_font_style || 'serif',
    thumb_font_style_custom: req.thumb_font_style_custom,
    thumb_text_style: req.thumb_text_style || 'gold',
    thumb_text_style_custom: req.thumb_text_style_custom,
    thumb_text_position: req.thumb_text_position || 'center',
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
  const useChunkedScenes = sceneCount > SCENE_CHUNK_THRESHOLD

  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  let scenes: any[] = []
  let thumbnails: any[] = []

  try {
    if (useChunkedScenes) {
      job.output_lines.push(
        `[chunked] ${sceneCount} scenes > ${SCENE_CHUNK_THRESHOLD} threshold — splitting into parallel batches of ${SCENE_BATCH_SIZE} (concurrency ${SCENE_CONCURRENCY}).`,
      )
      // Build batch ranges [1..10], [11..20], …, plus thumbnails as a
      // separate single call. Each scene batch reuses the same buildPrompt
      // shape but pinned to "scenes numbered K to K+N-1 (do NOT generate
      // others)".
      const batches: Array<{ from: number; to: number }> = []
      for (let from = 1; from <= sceneCount; from += SCENE_BATCH_SIZE) {
        batches.push({ from, to: Math.min(from + SCENE_BATCH_SIZE - 1, sceneCount) })
      }

      let cursor = 0
      let aborted = false
      let completed = 0
      const collected: any[] = []

      async function sceneWorker(workerId: number): Promise<void> {
        while (cursor < batches.length && !aborted) {
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
          try {
            const raw = await callAi(model, '', batchPrompt, aiCreds(config), false,
              { slug: project_slug, jobId: job.job_id, signal: controller.signal })
            const obj = parseImagePromptsJson(raw)
            // v1.0.86+: don't filter by `s.number` matching the requested
            // from..to range. LLMs frequently number every batch's output
            // as 1..N regardless of how clearly the prompt asks for "scenes
            // 11 through 20" — which made the old filter drop everything
            // but the first batch (the only one whose 1..N numbering
            // happened to overlap the expected range). Symptom user hit
            // 2026-05-12: requested 250 scenes via the chunked path,
            // received only ~3 on disk.
            //
            // New approach: take the first (to-from+1) scenes the LLM
            // returned (any numbering, any title/prompt structure that
            // parses), and RENUMBER them to the batch's expected range.
            // Drop entries that don't carry a usable `prompt` string —
            // those are unusable downstream regardless of numbering.
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
            job.output_lines.push(
              `[chunked]   [w${workerId}] scenes ${from}-${to}: got ${got.length}/${expected}${tail} (${completed}/${batches.length} batches done)`,
            )
          } catch (e: any) {
            job.output_lines.push(
              `[chunked]   [w${workerId}] scenes ${from}-${to} FAILED: ${e?.message || e}`,
            )
            if (jq.isCancelled(job.job_id) || controller.signal.aborted) {
              aborted = true; return
            }
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(SCENE_CONCURRENCY, batches.length) }, (_, i) => sceneWorker(i + 1)),
      )

      if (aborted) throw new Error('Cancelled by user')
      // Sort by number so the docx output is in deterministic order
      // regardless of which worker finished a given batch first.
      scenes = collected.sort((a, b) => Number(a.number) - Number(b.number))

      // Thumbnails: single call (typical thumbs <= 10, fits easily).
      if (thumbs > 0) {
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
    const outPath = path.join(sceneDir, `${episode_id}_Scene_Prompts.docx`)
    await buildImagePromptsDocx(sceneText, episode_id, title, outPath)
    job.output_lines.push(`Saved scenes → ${path.basename(outPath)}`)
  }

  // Save thumbnails
  if (thumbnails.length > 0) {
    const thumbDir = await resolveSubfolder(episodeDir, names.thumb_prompts)
    if (!thumbDir) throw new Error(`Thumbnail prompts folder not found: ${names.thumb_prompts}`)
    let thumbText = `# Thumbnail Prompts\n\n`
    for (const t of thumbnails) thumbText += `## Thumbnail ${t.number}: ${t.title}\n\n${t.prompt}\n\n`
    const outPath = path.join(thumbDir, `${episode_id}_Thumbnail_Prompts.docx`)
    await buildImagePromptsDocx(thumbText, episode_id, title, outPath)
    job.output_lines.push(`Saved thumbnails → ${path.basename(outPath)}`)
  }

  await trackGeneration(project_slug, 'prompts').catch(() => {})
  job.output_lines.push(`Done.`)
}
