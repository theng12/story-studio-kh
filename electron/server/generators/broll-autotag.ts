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
import * as jq from '../services/job-queue.js'
import { analyzeStyle, visionKeyAvailable } from '../lib/vision-client.js'
import type { Job } from '../models/types.js'

interface AutotagParams {
  pool_id: string
  filename: string
  model?: string
  /** When true, suggested tags REPLACE existing tags; when false (default),
   *  they're unioned with whatever the user already set. */
  replace_tags?: boolean
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
  const { pool_id, filename, replace_tags, model } = job.params as AutotagParams
  const visionModel = (model || '').trim()
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

  // v1.0.406 — vision model is user-selectable. Local LM Studio models tag for
  // free (no OpenAI key); OpenAI vision (gpt-4o / gpt-4o-mini) needs the key.
  // Gate only the OpenAI path on the key — analyzeStyle validates the LM Studio
  // URL itself. Works for both video clips (midpoint frame) and image pools
  // (the image itself), since both reduce to a cached thumbnail JPEG.
  const isLocal = visionModel.startsWith('lmstudio:')
  if (!isLocal && !(await visionKeyAvailable())) {
    throw new Error('No vision-capable API key configured. Add an OpenAI key in Settings → API Keys, or pick a local LM Studio vision model.')
  }
  if (visionModel) job.output_lines.push(`Requested vision model: ${visionModel}`)

  const result = await analyzeStyle({
    imagePath: thumbPath,
    mode: 'tags',
    model: visionModel || undefined,
  })
  job.output_lines.push(`Vision model: ${result.model_used}`)

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
