/**
 * B-Roll auto-tag executor — vision-LLM pass over one clip's cached
 * thumbnail frame, parses tags, merges into the pool sidecar.
 *
 * Cheap (~$0.002/clip on GPT-4o-mini, free if Anthropic key configured
 * and Claude Haiku is picked). Re-uses the thumbnail JPEG that the
 * indexer already cached at <userData>/broll-thumbnails/<sha>.jpg — no
 * re-extraction from the source video required.
 *
 * Tag merge policy:
 *   - Existing user-applied tags are preserved verbatim.
 *   - LLM-suggested tags are normalised (lowercased, deduped) and
 *     unioned in.
 *   - Caller can flip `replace_tags: true` to clobber existing tags
 *     instead — useful for a "re-tag from scratch" pass.
 */
import { existsSync } from 'fs'
import * as bp from '../services/broll-pool-manager.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { analyzeStyle, resolveVisionModel } from '../lib/vision-client.js'
import type { Job } from '../models/types.js'

interface AutotagParams {
  pool_id: string
  filename: string
  model?: string
  /** When true, suggested tags REPLACE existing tags; when false (default),
   *  they're unioned with whatever the user already set. */
  replace_tags?: boolean
}

/** Pick the best vision model for the configured key set. Same fallback
 *  chain as the character describe-from-image route (which is in a
 *  per-PROJECT route — auto-tag operates on the app-level pool so we
 *  don't have a project context here. The job-queue stores a
 *  project_slug='_app_' placeholder; we read app-level keys via
 *  app-settings.ts since this isn't tied to any one project). */
async function resolveVisionApiKey(model: string): Promise<{ model: string; apiKey: string }> {
  const { getAppSetting } = await import('../services/app-settings.js')
  const anthropic = (await getAppSetting('anthropic_api_key').catch(() => '')) as string
  const openai = (await getAppSetting('openai_api_key').catch(() => '')) as string

  const resolved = resolveVisionModel(model)
  if (resolved.startsWith('claude') && anthropic) return { model: resolved, apiKey: anthropic }
  if (resolved.startsWith('gpt') && openai) return { model: resolved, apiKey: openai }
  // Fall through the same auto-pick order the per-character route uses:
  // Claude (best vision) → GPT-4o-mini (cheapest fallback) → error.
  if (anthropic) return { model: 'claude-sonnet-4-6', apiKey: anthropic }
  if (openai) return { model: 'gpt-4o-mini', apiKey: openai }
  throw new Error('No vision-capable API key configured. Add an Anthropic OR OpenAI key in Settings → API Keys.')
}

function parseTagsResponse(raw: string): string[] {
  const trimmed = raw.trim()
  // Strip code fence if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fence ? fence[1]! : trimmed
  // Look for an array literal anywhere in the response.
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try { parsed = JSON.parse(body.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0 && t.length <= 40)
}

export async function generateBrollAutotag(job: Job): Promise<void> {
  const { pool_id, filename, model, replace_tags } = job.params as AutotagParams
  if (!pool_id || !filename) throw new Error('pool_id and filename are required')

  const pool = await bp.getPool(pool_id)
  if (!pool) throw new Error(`Pool '${pool_id}' not found`)

  const clips = await bp.listClips(pool_id, { includeMissing: true })
  const clip = clips.find(c => c.filename === filename)
  if (!clip) throw new Error(`Clip '${filename}' not in pool sidecar`)

  const thumbPath = bp.thumbnailPath(clip.sha256)
  if (!existsSync(thumbPath)) {
    throw new Error(`Thumbnail not cached for ${filename} — re-scan the pool to generate it first.`)
  }

  job.output_lines.push(`Clip: ${filename} (${clip.width}×${clip.height} · ${clip.fps}fps)`)

  const { model: vModel, apiKey } = await resolveVisionApiKey(model || '')
  job.output_lines.push(`Vision model: ${vModel}`)

  const result = await analyzeStyle({
    imagePath: thumbPath,
    model: vModel,
    apiKey,
    mode: 'tags',
  })

  const suggestedTags = parseTagsResponse(result.style_text)
  if (!suggestedTags.length) {
    job.output_lines.push(`⚠ No tags parsed from vision response — leaving existing tags untouched.`)
    return
  }

  const existing = new Set((clip.tags || []).map(t => t.toLowerCase()))
  const next = replace_tags
    ? Array.from(new Set(suggestedTags)).sort()
    : Array.from(new Set([...existing, ...suggestedTags])).sort()

  await bp.setClipTags(pool_id, filename, next)
  const added = suggestedTags.filter(t => !existing.has(t))
  job.output_lines.push(
    replace_tags
      ? `Replaced tags → ${next.join(', ')}`
      : `+${added.length} new tag(s); ${next.length} total → ${next.join(', ')}`,
  )

  // Cancel respect.
  if (jq.isCancelled(job.job_id)) throw new Error('Cancelled')
}
