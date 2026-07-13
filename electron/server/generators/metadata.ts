/**
 * Metadata generator — batch job executor.
 *
 * Mirrors the synchronous POST /generate/metadata/all + POST
 * /generate/metadata/save flow from routes/scripts.ts, collapsed into
 * a single job for the Pipeline batch runner. Auto-picks the first
 * of the generated titles (no review step in batch mode) and saves a
 * consolidated JSON + pretty-printed .txt.
 *
 * The interactive routes stay in place for the Metadata page's
 * review-then-save UX.
 */

import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { callAi, callAiWithRetry } from '../lib/ai-client.js'
import { prependAvoidanceToPrompt, recordUsageForScope } from '../services/recency-tracker.js'
import { SUPPORTED_MODELS } from '../models/types.js'
import { resolveEpisodePaths, resolveSubfolderNames } from '../services/utils.js'
import { readArtifactRawText } from '../lib/episode-artifacts.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { trackGeneration } from '../services/session-tracker.js'
import { formatMetadataTxt } from '../services/folder-migration.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import { appendSourcesToDescription, sourcesSectionEnabled } from '../lib/research-sources.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import type { Job } from '../models/types.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { writeMetadataCompletionManifest } from '../services/metadata-completion.js'

interface MetadataParams {
  episode_id: string
  title?: string
  model?: string
  sections?: Array<any>          // same shape as /generate/metadata/description expects
  max_chars?: number             // description max
  title_count?: number
  title_max_length?: number
  title_platform_preset?: string
  /**
   * 'paraphrase' (default — current behaviour, LLM rewrites the title)
   * 'use_idea_title' — copy the episode's idea title verbatim, optionally
   *   appending `title_suffix` (eg ' | A Cozy Sleep Story')
   * 'manual' — use `manual_title` verbatim, optionally with `title_suffix`
   *
   * Fixed modes skip the LLM call and emit exactly one title (no count).
   */
  title_mode?: 'paraphrase' | 'use_idea_title' | 'manual'
  /** Channel-level prefix prepended to every produced title (every mode). */
  title_prefix?: string
  title_suffix?: string
  manual_title?: string
  tag_count?: number
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

async function readStoryContext(slug: string, episode_id: string, title: string, maxChars = 2000): Promise<string> {
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const raw = await readArtifactRawText(paths.narration_docx)
    return raw.slice(0, maxChars)
  } catch {
    return `Episode: ${episode_id}, Title: ${title}`
  }
}

// `buildDescriptionPrompt` is imported above from lib/metadata-prompt.ts —
// shared with routes/scripts.ts so the section→prompt mapping has one
// source of truth.

function nextVersion(files: string[], code: string): number {
  let max = 0
  const re = new RegExp(`^${code}_Metadata(?:_v(\\d+))?\\.json$`)
  for (const f of files) {
    const m = f.match(re)
    if (m) {
      const v = m[1] ? parseInt(m[1], 10) : 1
      if (v > max) max = v
    }
  }
  return max + 1
}

function metadataFilenames(code: string, version: number): { json: string; txt: string } {
  const suffix = version <= 1 ? '' : `_v${version}`
  return {
    json: `${code}_Metadata${suffix}.json`,
    txt: `${code}_Metadata${suffix}.txt`,
  }
}

async function resolveMetadataDir(slug: string, episode_id: string, title: string): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episode_id, title || '')
  let episodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = path.dirname(episodeDir)
  const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
  if (actualDir) episodeDir = actualDir
  const names = await resolveSubfolderNames(slug, episode_id)
  const dir = await resolveSubfolder(episodeDir, names.metadata)
  if (!dir) throw new Error(`Metadata folder not found: ${names.metadata}`)
  return dir
}

export async function generateMetadata(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as MetadataParams

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')

  // Model + defaults. Batch mode inherits whatever the user set on the
  // Metadata page; any missing params fall back to sensible defaults.
  const model = req.model || 'deepseek-v4-flash'
  const credErr = checkProvider(model, config)
  if (credErr) throw new Error(credErr)

  const title = req.title || episode_id
  const sections = Array.isArray(req.sections) ? req.sections : []

  // Format-aware defaults (v1.0.69). The interactive metadata flow in
  // routes/scripts.ts:/metadata/all already used format.metadata.purposeNote
  // / titleStyleHint / tagsContext / broadKeywords for its prompts; the
  // batch generator lagged behind and emitted sleep-story-flavoured
  // language ("for a sleep story episode", "calm/dreamlike tone",
  // "#SleepStory") regardless of the project's actual channel format.
  // Loading the effective format here lets every channel get prompts
  // and counts tuned to its own vibe. Falls back gracefully when the
  // format file is missing (returns null → undefined-coalesce to
  // legacy hardcoded numbers).
  const format = await getEffectiveFormat(project_slug)
  const fmtMeta = format?.metadata
  const max_chars = req.max_chars ?? fmtMeta?.defaultMaxChars ?? 5000
  const title_count = req.title_count ?? fmtMeta?.defaultTitleCount ?? 5
  const title_max_length = req.title_max_length ?? fmtMeta?.defaultTitleMaxLength ?? 100
  const title_platform_preset = req.title_platform_preset || 'Universal'
  const tag_count = req.tag_count ?? fmtMeta?.defaultTagCount ?? 15

  job.output_lines.push(`Reading narration for story context…`)
  const storyContext = await readStoryContext(project_slug, episode_id, title)

  // AbortController + 500 ms watcher — same pattern as subtitles + episode.
  // Three sequential LLM calls below; a user cancel mid-batch tears down
  // the in-flight fetch instead of letting it run to max_tokens.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    // ── 0. Channel-locked template fast-path (v1.0.89+) ────────────────
    // When the project has a metadata_template, ONE small LLM call fills
    // every `{placeholder}` referenced by the template. Title / desc /
    // tags then come from template substitution — not from three
    // separate generate-from-scratch calls. Brand consistency without
    // re-rolling per episode.
    const tpl = (config as any).metadata_template
    const templateActive = !!(tpl && (tpl.title || tpl.description || (Array.isArray(tpl.tags) && tpl.tags.length)))
    let templateOutput: { title: string; description: string; tags: string[] } | null = null
    if (templateActive) {
      const { extractPlaceholders, deterministicValues, llmFillablePlaceholders, buildExtractionPrompt, parseExtractionResponse, renderTemplate } = await import('../lib/metadata-template.js')
      const placeholders = extractPlaceholders(tpl)
      const llmKeys = llmFillablePlaceholders(placeholders)
      job.output_lines.push(`Channel template detected — filling ${placeholders.length} placeholder(s) (${llmKeys.length} via LLM)…`)
      let llmValues: Record<string, string> = {}
      if (llmKeys.length) {
        const extractPrompt = buildExtractionPrompt({ episodeCode: episode_id, title, storyContext, placeholders: llmKeys })
        const raw = await callAiWithRetry(model, '', extractPrompt, aiCreds(config), false,
          { slug: project_slug, jobId: job.job_id, signal: controller.signal })
        llmValues = parseExtractionResponse(raw, llmKeys)
      }
      const values = { ...deterministicValues(episode_id), ...llmValues }
      templateOutput = renderTemplate(tpl, values)
      job.output_lines.push(`  → title: "${templateOutput.title.slice(0, 80)}"`)
      job.output_lines.push(`  → ${templateOutput.tags.length} tag(s); description ${templateOutput.description.length} chars`)
    }

    // ── 1. Description ──────────────────────────────────────────────────
    let description: string
    if (templateOutput && templateOutput.description) {
      description = templateOutput.description
      job.output_lines.push(`Description from template (${description.length} chars).`)
    } else {
      job.output_lines.push(`Generating description (max ${max_chars} chars)…`)
      // v1.0.108+ — prepend the niche's avoidance instruction when its
      // rule covers the 'metadata' scope (e.g. prayer's scripture refs).
      // No-op for niches that don't ship recencyAvoidance or don't
      // include 'metadata' in their scopes.
      const descPrompt = await prependAvoidanceToPrompt(
        project_slug,
        'metadata',
        buildDescriptionPrompt(episode_id, title, storyContext, sections, max_chars, format),
      )
      const descRaw = await callAiWithRetry(model, '', descPrompt, aiCreds(config), false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      description = descRaw.trim()
      job.output_lines.push(`  → ${description.length} chars`)
      // Post-generation: scan the description for matches against the
      // niche's regex and append to the recency log. Fail-soft — never
      // surface to the user; an analytics-style side effect.
      await recordUsageForScope(project_slug, episode_id, 'metadata', description).catch(() => null)
    }

    // v1.0.197 — append the kept research sources (deterministic, real URLs);
    // v1.0.198 — gated on the Sources section being present + enabled.
    {
      const sourcesRes = await appendSourcesToDescription(project_slug, episode_id, description, format, max_chars, sourcesSectionEnabled(sections))
      description = sourcesRes.description
      if (sourcesRes.appended) {
        job.output_lines.push(`Appended ${sourcesRes.appended} research source(s) to the description${sourcesRes.dropped ? ` (+${sourcesRes.dropped} dropped for length)` : ''}.`)
      }
    }

    // ── 2. Titles ───────────────────────────────────────────────────────
    // Fixed-title modes (use_idea_title / manual) skip the LLM and emit
    // exactly one title with optional channel prefix + suffix wrapping.
    // v1.0.90+: the frontend defaults to 'use_idea_title' so the picked
    // idea title flows through verbatim unless the user actively asks for
    // paraphrase. Channel prefix/suffix come from the project's saved
    // titleConfig — they're per-channel constants that wrap every episode.
    const title_mode = req.title_mode || 'paraphrase'
    const title_prefix = typeof req.title_prefix === 'string' ? req.title_prefix : ''
    const title_suffix = typeof req.title_suffix === 'string' ? req.title_suffix : ''
    const manual_title = typeof req.manual_title === 'string' ? req.manual_title.trim() : ''
    const wrapTitle = (s: string): string => `${title_prefix}${s}${title_suffix}`

    let titles: string[]
    if (templateOutput && templateOutput.title) {
      // Template output is already fully composed (it included channel
      // copy in the template string). Don't wrap a second time.
      titles = [templateOutput.title]
      job.output_lines.push(`Title from template: "${titles[0]}"`)
    } else if (title_mode === 'use_idea_title' || title_mode === 'manual') {
      const base = title_mode === 'manual' ? manual_title : (title || '').trim()
      if (!base) {
        throw Object.assign(
          new Error(title_mode === 'manual' ? 'manual_title is required' : 'idea title is empty'),
          { statusCode: 400 },
        )
      }
      titles = [wrapTitle(base)]
      job.output_lines.push(`Using ${title_mode === 'manual' ? 'manual' : 'idea'} title: "${titles[0]}"`)
    } else {
      job.output_lines.push(`Generating ${title_count} title option(s)…`)
      // v1.0.108+ — titles-scope avoidance. Same niche regex; gated by
      // the niche's `scopes` array. Most niches won't track titles
      // (prayer titles don't typically cite verses), but the plumbing
      // is here for niches that want it.
      const platformNote = title_platform_preset && title_platform_preset !== 'custom'
        ? `Optimized for ${title_platform_preset} (max ${title_max_length} characters).`
        : `Maximum ${title_max_length} characters per title.`
      // Pull "what worked" inspiration from this channel's analytics.
      // Returns '' when no connected account / scope / cache miss — the
      // generator falls back to its prior behaviour silently.
      let topBlock = ''
      try {
        const { getTopPerformersForSlug } = await import('../lib/youtube-analytics.js')
        const { formatTopPerformersBlock } = await import('../lib/top-performers.js')
        const top = await getTopPerformersForSlug(project_slug, 5)
        topBlock = formatTopPerformersBlock(top)
        if (top.length) job.output_lines.push(`Inspired by ${top.length} top performer(s) from this channel.`)
      } catch { /* analytics is best-effort */ }
      // Format-aware title prompt (v1.0.69). Pulls purposeNote +
      // titleStyleHint from the project's effective Format so listicle /
      // educational / true-crime channels don't get "calm/dreamlike"
      // sleep-story instructions baked into their batch metadata.
      const titlePurpose = fmtMeta?.purposeNote || 'for a sleep story episode'
      const titleTone = fmtMeta?.titleStyleHint || 'Hook-y, curiosity-driven, calm/dreamlike tone'
      const titlePrompt = `Generate ${title_count} SEO-optimized video title options ${titlePurpose}.
Episode: ${episode_id} — ${title}
Story context:
${storyContext.slice(0, 1500)}
${topBlock}
Requirements:
- ${platformNote}
- Tone: ${titleTone}.
- One per line. No numbering, quotes, or commentary.`
      const titlePromptWithAvoidance = await prependAvoidanceToPrompt(project_slug, 'titles', titlePrompt)
      const titleRaw = await callAiWithRetry(model, '', titlePromptWithAvoidance, aiCreds(config), false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      const rawTitles = titleRaw.split('\n')
        .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(Boolean)
        .slice(0, title_count)
      // Post-generation: scan the full title text for matches.
      await recordUsageForScope(project_slug, episode_id, 'titles', titleRaw).catch(() => null)
      // Wrap LLM titles with channel prefix/suffix too — paraphrase mode
      // benefits from channel consistency the same way fixed modes do.
      // The prompt itself doesn't include the prefix (LLM doesn't need to
      // re-derive it), so we only apply it here once at the join step.
      titles = (title_prefix || title_suffix)
        ? rawTitles.map(wrapTitle)
        : rawTitles
      job.output_lines.push(`  → ${titles.length} title(s); picking first: "${titles[0] || '(none)'}" (others saved as alternatives)`)
    }

    // ── 3. Tags ─────────────────────────────────────────────────────────
    let tags: string[]
    if (templateOutput && templateOutput.tags.length) {
      tags = templateOutput.tags.slice(0, tag_count)
      job.output_lines.push(`Tags from template: ${tags.length} tag(s).`)
    } else {
      job.output_lines.push(`Generating ${tag_count} tag(s)…`)
      // Format-aware tag prompt (v1.0.69). Mirrors routes/scripts.ts
      // /metadata/all so batch and interactive runs use identical prompts.
      const tagsContext = fmtMeta?.tagsContext || 'for this sleep story video'
      const broadKeywordsLine = fmtMeta?.broadKeywords?.length
        ? `\n- Broad keywords to draw from: ${fmtMeta.broadKeywords.join(', ')}.`
        : ''
      const tagPrompt = `Generate ${tag_count} YouTube tags ${tagsContext}.
Episode: ${episode_id} — ${title}
Description excerpt:
${description.slice(0, 500)}

Requirements:
- 1-4 words per tag, no "#" prefix.
- Mix of broad and episode-specific keywords.${broadKeywordsLine}
- One per line, no numbering or commentary.`
      const tagRaw = await callAiWithRetry(model, '', tagPrompt, aiCreds(config), false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      tags = tagRaw.split('\n')
        .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^#/, '').replace(/^["']|["']$/g, '').trim())
        .filter(Boolean)
        .slice(0, tag_count)
      job.output_lines.push(`  → ${tags.length} tag(s)`)
    }

    // ── 4. Save (v1 always in batch; overwrites if a v1 exists) ─────────
    const dir = await resolveMetadataDir(project_slug, episode_id, title)
    const existing = await fs.readdir(dir).catch(() => [])
    // Prefer overwriting v1. If v1 exists and the user had bumped past it,
    // nextVersion ensures we write a fresh vN rather than stomp an edited v1.
    const hasV1 = existing.some(f => f === `${episode_id}_Metadata.json`)
    const writeVersion = hasV1 ? nextVersion(existing, episode_id) : 1

    const meta = {
      title: titles[0] || title,    // auto-pick the first title for batch mode
      // Preserve all AI-generated title options so the user can pick a different
      // one later from the metadata page without re-running generation. The
      // metadata page hydrates its title-picker from this array on load.
      title_options: titles.length ? titles : (title ? [title] : []),
      description,
      tags,
      savedAt: new Date().toISOString(),
      version: writeVersion,
    }
    const { json, txt } = metadataFilenames(episode_id, writeVersion)
    const jsonPath = path.join(dir, json)
    // Lock on the JSON path so a batch job and an interactive Save from
    // routes/scripts.ts can't interleave and desync the .txt sidecar.
    await withLock(jsonPath, async () => {
      await writeJsonAtomic(jsonPath, meta)
      await fs.writeFile(path.join(dir, txt), formatMetadataTxt(meta))
    })

    await trackGeneration(project_slug, 'description').catch(() => {})
    job.output_lines.push(`Saved → ${json} + ${txt}`)
    job.output_dir = dir

    const expectedTitleCount = templateOutput?.title || title_mode !== 'paraphrase' ? 1 : title_count
    const expectedTagCount = templateOutput?.tags.length ? Math.min(tag_count, templateOutput.tags.length) : tag_count
    const missing: string[] = []
    if (!description.trim()) missing.push('description')
    for (let index = titles.length; index < expectedTitleCount; index++) {
      missing.push(`title option ${index + 1}`)
    }
    for (let index = tags.length; index < expectedTagCount; index++) {
      missing.push(`tag ${index + 1}`)
    }
    const expected = 1 + expectedTitleCount + expectedTagCount
    await writeMetadataCompletionManifest(dir, episode_id, json, expectedTitleCount, expectedTagCount)
    requireJobCompletion(job, {
      label: 'Metadata generation',
      expected,
      completed: expected - missing.length,
      missing,
      retry_hint: 'The partial metadata file was kept. Retry to generate the missing fields.',
    })
  } finally {
    clearInterval(cancelWatcher)
  }
}
