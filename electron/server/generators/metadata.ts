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
import { callAi } from '../lib/ai-client.js'
import { SUPPORTED_MODELS } from '../models/types.js'
import { resolveEpisodePaths, resolveSubfolderNames } from '../services/utils.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { trackGeneration } from '../services/session-tracker.js'
import { formatMetadataTxt } from '../services/folder-migration.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import type { Job } from '../models/types.js'

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
  title_suffix?: string
  manual_title?: string
  tag_count?: number
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

async function readStoryContext(slug: string, episode_id: string, title: string, maxChars = 2000): Promise<string> {
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const mammoth = await import('mammoth')
    const result = await mammoth.default.extractRawText({ path: paths.narration_docx })
    return result.value.slice(0, maxChars)
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
  const model = req.model || 'gpt-4o'
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
    // ── 1. Description ──────────────────────────────────────────────────
    job.output_lines.push(`Generating description (max ${max_chars} chars)…`)
    const descPrompt = buildDescriptionPrompt(episode_id, title, storyContext, sections, max_chars, format)
    const descRaw = await callAi(model, '', descPrompt, aiCreds(config), false,
      { slug: project_slug, jobId: job.job_id, signal: controller.signal })
    const description = descRaw.trim()
    job.output_lines.push(`  → ${description.length} chars`)

    // ── 2. Titles ───────────────────────────────────────────────────────
    // Fixed-title modes skip the LLM call and emit a single title.
    const title_mode = req.title_mode || 'paraphrase'
    const title_suffix = typeof req.title_suffix === 'string' ? req.title_suffix : ''
    const manual_title = typeof req.manual_title === 'string' ? req.manual_title.trim() : ''

    let titles: string[]
    if (title_mode === 'use_idea_title' || title_mode === 'manual') {
      const base = title_mode === 'manual' ? manual_title : (title || '').trim()
      if (!base) {
        throw Object.assign(
          new Error(title_mode === 'manual' ? 'manual_title is required' : 'idea title is empty'),
          { statusCode: 400 },
        )
      }
      titles = [base + title_suffix]
      job.output_lines.push(`Using ${title_mode === 'manual' ? 'manual' : 'idea'} title: "${titles[0]}"`)
    } else {
      job.output_lines.push(`Generating ${title_count} title option(s)…`)
      const platformNote = title_platform_preset && title_platform_preset !== 'custom'
        ? `Optimized for ${title_platform_preset} (max ${title_max_length} characters).`
        : `Maximum ${title_max_length} characters per title.`
      // Pull "what worked" inspiration from this channel's analytics.
      // Returns '' when no connected account / scope / cache miss — the
      // generator falls back to its prior behaviour silently.
      let topBlock = ''
      try {
        const { getTopPerformersForSlug } = await import('../lib/youtube-analytics.js')
        const { formatTopPerformersBlock } = await import('../lib/brand-prompt.js')
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
      const titleRaw = await callAi(model, '', titlePrompt, aiCreds(config), false,
        { slug: project_slug, jobId: job.job_id, signal: controller.signal })
      titles = titleRaw.split('\n')
        .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(Boolean)
        .slice(0, title_count)
      job.output_lines.push(`  → ${titles.length} title(s); picking first: "${titles[0] || '(none)'}" (others saved as alternatives)`)
    }

    // ── 3. Tags ─────────────────────────────────────────────────────────
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
    const tagRaw = await callAi(model, '', tagPrompt, aiCreds(config), false,
      { slug: project_slug, jobId: job.job_id, signal: controller.signal })
    const tags = tagRaw.split('\n')
      .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^#/, '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, tag_count)
    job.output_lines.push(`  → ${tags.length} tag(s)`)

    // ── 4. Save (v1 always in batch; overwrites if a v1 exists) ─────────
    const dir = await resolveMetadataDir(project_slug, episode_id, title)
    const existing = await fs.readdir(dir).catch(() => [])
    // Prefer overwriting v1. If v1 exists and the user had bumped past it,
    // nextVersion ensures we write a fresh vN rather than stomp an edited v1.
    const hasV1 = existing.some(f => f === `${episode_id}_Metadata.json`)
    const writeVersion = hasV1 ? nextVersion(existing, episode_id) : 1

    // Brand-aware post-processing: interpolate {channel_name} placeholders
    // and surface any banned-word matches as warnings (don't block).
    let interpolatedTitles = titles
    let interpolatedDescription = description
    let interpolatedTags = tags
    let bannedFlagged: string[] = []
    try {
      const { getEffectiveBrand } = await import('../services/brand-loader.js')
      const { interpolateBrandPlaceholders, findBannedWords } = await import('../lib/brand-prompt.js')
      const project = await pm.getProject(project_slug)
      const brand = await getEffectiveBrand(project_slug)
      const interp = (s: string) => interpolateBrandPlaceholders(s, brand, project)
      interpolatedTitles = titles.map(interp)
      interpolatedDescription = interp(description)
      interpolatedTags = tags.map(interp)
      // Banned-word scan over the combined output. Persisted on the saved
      // metadata so the page can render a warning chip alongside the
      // existing title/description/tag UI without re-scanning client-side.
      const haystack = [interpolatedTitles.join('\n'), interpolatedDescription, interpolatedTags.join(' ')].join('\n')
      bannedFlagged = findBannedWords(haystack, brand)
      if (bannedFlagged.length) {
        job.output_lines.push(`⚠ Brand banned-word warning: matched ${bannedFlagged.join(', ')}`)
      }
    } catch { /* brand layer must never break metadata generation */ }

    const meta = {
      title: interpolatedTitles[0] || title,    // auto-pick the first title for batch mode
      // Preserve all AI-generated title options so the user can pick a different
      // one later from the metadata page without re-running generation. The
      // metadata page hydrates its title-picker from this array on load.
      title_options: interpolatedTitles.length ? interpolatedTitles : (title ? [title] : []),
      description: interpolatedDescription,
      tags: interpolatedTags,
      // Brand banned-word matches at generation time. Empty array = no
      // matches = no badge. Stored so the page warns even after restart
      // / reload without recomputing client-side.
      brand_warnings: bannedFlagged,
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
  } finally {
    clearInterval(cancelWatcher)
  }
}
