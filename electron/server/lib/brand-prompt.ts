/**
 * Brand-aware prompt + text helpers.
 *
 * Two operations:
 *   - prependBrandPersona(system, brand) — adds the brand's narrator
 *     persona block to the top of any LLM system prompt. No-op when the
 *     brand has no persona (or no brand at all).
 *   - interpolateBrandPlaceholders(text, brand, project) — replaces
 *     {channel_name} in generated text. Falls back to the project's name
 *     if no brand is attached.
 *
 * Both are pure — no I/O, no async. Service callers fetch the brand once
 * via brand-loader.getEffectiveBrandFor() and feed it here.
 */

import type { Brand, ProjectMeta } from '../models/types.js'

/**
 * Prepend the brand's narrator persona to a system prompt. Returns the
 * original system unchanged when the brand or persona is missing.
 *
 * The persona lives in its own paragraph before the existing system
 * content so format role + production standards keep their relative
 * priority unchanged. Two newlines separate the blocks.
 */
export function prependBrandPersona(system: string, brand: Brand | null | undefined): string {
  const persona = brand?.narration?.persona?.trim()
  if (!persona) return system
  if (!system) return persona
  return `${persona}\n\n${system}`
}

/**
 * Replace {channel_name} placeholders in `text` with the effective name.
 * Resolution: brand.channel.name → project.name → unchanged. Idempotent —
 * texts without the placeholder pass through.
 */
export function interpolateBrandPlaceholders(
  text: string,
  brand: Brand | null | undefined,
  project: ProjectMeta | null | undefined,
): string {
  if (!text || typeof text !== 'string') return text
  if (!text.includes('{channel_name}')) return text
  const channelName = brand?.channel?.name?.trim() || project?.name?.trim() || ''
  if (!channelName) return text
  // Use a literal split/join rather than regex so we don't have to escape
  // the curly braces and so multiple occurrences are handled trivially.
  return text.split('{channel_name}').join(channelName)
}

/**
 * Convenience wrapper: load the brand for a slug (best-effort) so callers
 * that just have a slug don't have to thread the project meta around.
 * Always returns null on error rather than throwing — the brand layer
 * must never break a generation.
 */
export async function getBrandForSlug(slug: string): Promise<Brand | null> {
  if (!slug) return null
  try {
    const bl = await import('../services/brand-loader.js')
    return await bl.getEffectiveBrand(slug)
  } catch {
    return null
  }
}

/**
 * Format a "what worked on this channel" block for injection into LLM
 * prompts. Returns an empty string when the list is empty so callers
 * can append it unconditionally without polluting the prompt with a
 * dangling header.
 *
 * The block is short by design — five titles is enough for the model
 * to pattern-match a vibe without crowding out the rest of the prompt.
 */
export function formatTopPerformersBlock(
  performers: Array<{ title: string; views: number; ctr_percentage?: number }>,
): string {
  if (!performers?.length) return ''
  const lines = performers.map(p => {
    const viewsStr = p.views >= 1000
      ? Math.round(p.views / 1000) + 'K views'
      : p.views.toLocaleString() + ' views'
    const ctrStr = typeof p.ctr_percentage === 'number'
      ? `, ${p.ctr_percentage.toFixed(1)}% CTR`
      : ''
    return `  - "${p.title}" (${viewsStr}${ctrStr})`
  }).join('\n')
  return `\n📈 TOP PERFORMERS ON THIS CHANNEL (recent):
${lines}

Use these as a vibe reference — match the angle, length, and emotional pull of these proven titles. Don't copy them verbatim, but the new output should feel at home alongside them.`
}

/**
 * Scan `text` for any banned-word matches. Returns an array of matched
 * words (deduped, original casing from the brand list). Empty array
 * when there's nothing to flag — the caller decides how to surface
 * warnings.
 */
export function findBannedWords(text: string, brand: Brand | null | undefined): string[] {
  const list = brand?.metadata?.banned_words
  if (!list?.length || !text) return []
  const haystack = text.toLowerCase()
  const seen = new Set<string>()
  for (const word of list) {
    const w = word.trim()
    if (!w) continue
    if (haystack.includes(w.toLowerCase()) && !seen.has(w)) seen.add(w)
  }
  return [...seen]
}
