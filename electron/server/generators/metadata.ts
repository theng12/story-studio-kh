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
  const max_chars = req.max_chars ?? 5000
  const title_count = req.title_count ?? 5
  const title_max_length = req.title_max_length ?? 100
  const title_platform_preset = req.title_platform_preset || 'Universal'
  const tag_count = req.tag_count ?? 15

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
    const descPrompt = buildDescriptionPrompt(episode_id, title, storyContext, sections, max_chars)
    const descRaw = await callAi(model, '', descPrompt, aiCreds(config), false,
      { slug: project_slug, jobId: job.job_id, signal: controller.signal })
    const description = descRaw.trim()
    job.output_lines.push(`  → ${description.length} chars`)

    // ── 2. Titles ───────────────────────────────────────────────────────
    job.output_lines.push(`Generating ${title_count} title option(s)…`)
    const platformNote = title_platform_preset && title_platform_preset !== 'custom'
      ? `Optimized for ${title_platform_preset} (max ${title_max_length} characters).`
      : `Maximum ${title_max_length} characters per title.`
    const titlePrompt = `Generate ${title_count} SEO-optimized video title options for a sleep story episode.
Episode: ${episode_id} — ${title}
Story context:
${storyContext.slice(0, 1500)}

Requirements:
- ${platformNote}
- Hook-y, curiosity-driven, calm/dreamlike tone.
- One per line. No numbering, quotes, or commentary.`
    const titleRaw = await callAi(model, '', titlePrompt, aiCreds(config), false,
      { slug: project_slug, jobId: job.job_id, signal: controller.signal })
    const titles = titleRaw.split('\n')
      .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, title_count)
    job.output_lines.push(`  → ${titles.length} title(s); picking first: "${titles[0] || '(none)'}" (others saved as alternatives)`)

    // ── 3. Tags ─────────────────────────────────────────────────────────
    job.output_lines.push(`Generating ${tag_count} tag(s)…`)
    const tagPrompt = `Generate ${tag_count} YouTube tags for this sleep story.
Episode: ${episode_id} — ${title}
Description excerpt:
${description.slice(0, 500)}

Requirements:
- 1-4 words per tag, no "#" prefix.
- Mix of broad and episode-specific keywords.
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
  } finally {
    clearInterval(cancelWatcher)
  }
}
