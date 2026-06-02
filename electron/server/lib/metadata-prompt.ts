/**
 * Shared LLM-prompt builder for the YouTube description generator.
 *
 * Previously this function was duplicated in `routes/scripts.ts` and
 * `generators/metadata.ts` — they drifted apart in subtle ways and the
 * Apr 2026 section refactor (split metadata → narrator/music/channels,
 * split cta → cta/support) made the duplication unsustainable. Both
 * call sites now import from here.
 *
 * Section schema reference (mirrors metadata.vue defaultSections):
 *   hook         { characters: number; starting_format?: string }
 *   narrator     { name: string }
 *   music        { title: string; link: string; disclaimer: string }
 *   channels     { channels: Array<{ name: string; url: string; kind?: 'own'|'recommended' }> }
 *   videos       { videos: Array<{ name: string; url: string }> }
 *   playlists    { playlists: Array<{ name: string; url: string }> }
 *   cta          { custom_lines?: string[] }
 *   support      { platforms: Array<{ kind: string; url: string; label?: string }> }
 *   affiliate    { text: string }
 *   ai-disclosure{ text: string }
 *   hashtags     { count: number }
 *   custom-*     { instructions: string }
 *
 * Legacy shapes that still arrive from old presets / saved jobs are
 * handled inline below — frontend auto-migrates on load, so the legacy
 * branches are a defence-in-depth fallback for stale POST bodies.
 */

import type { Format } from '../models/types.js'
import { METADATA_SECTIONS } from './metadata-sections.js'

interface Section {
  id: string
  label: string
  type?: string
  enabled: boolean
  config?: Record<string, any>
}

/**
 * Build the LLM description prompt.
 *
 * `format` (v1.0.69+, optional) supplies format-aware hashtags and
 * description structure when the hashtags / music / support sections
 * don't ship explicit values. Older callers (route shims, tests) can
 * omit it and the function falls back to the legacy sleep-story
 * defaults so existing behaviour stays identical.
 */
export function buildDescriptionPrompt(
  episode_id: string,
  title: string,
  storyContext: string,
  sections: Section[],
  maxChars: number,
  format?: Format | null,
): string {
  let sectionInstructions = ''
  for (const section of sections || []) {
    if (!section.enabled) continue
    const cfg = section.config || {}
    const def = METADATA_SECTIONS[section.id]
    if (def) {
      // v1.0.199 — registry-driven: each section type's prompt fragment lives
      // in metadata-sections.ts, so adding a section type is one entry there.
      sectionInstructions += def.buildInstruction(cfg, { format }, section as any)
    } else if (section.type === 'custom' && cfg.instructions) {
      sectionInstructions += `\n- ${section.label.toUpperCase()}: ${cfg.instructions}`
    }
  }

  // v1.0.103+ — niche-level description-shape guidance. When the niche
  // (typically merged into format.metadata.descriptionShape via
  // applyNicheToFormat) supplies a voice / rule-list / CTA tone /
  // closing benediction, surface them at the TOP of the prompt so the
  // LLM anchors on the channel voice before reading the section
  // instructions. Without these the prompt is generic and prayer
  // channels get "Hey guys! Welcome back to the channel" hype copy.
  const descShape = format?.metadata?.descriptionShape
  let nicheVoiceBlock = ''
  if (descShape) {
    const parts: string[] = []
    if (descShape.voiceGuidance) {
      parts.push(`CHANNEL VOICE — read this first, write in this voice:\n${descShape.voiceGuidance}`)
    }
    if (descShape.descriptionShapeRules?.length) {
      parts.push(`DESCRIPTION SHAPE RULES (MUST follow):\n${descShape.descriptionShapeRules.map(r => `- ${r}`).join('\n')}`)
    }
    if (descShape.ctaShape) {
      parts.push(`CTA TONE (when a like-share-subscribe paragraph appears):\n${descShape.ctaShape}`)
    }
    if (descShape.closingBenediction) {
      parts.push(`CLOSING LINE (the FINAL non-hashtag line of the description, verbatim or near-verbatim):\n${JSON.stringify(descShape.closingBenediction)}`)
    }
    if (parts.length > 0) nicheVoiceBlock = `\n\n${parts.join('\n\n')}\n`
  }

  return `Generate a YouTube description for a story episode.

Episode: ${episode_id} — ${title}

Story context:
${storyContext}${nicheVoiceBlock}

Include these sections IN THIS ORDER:
${sectionInstructions}

Use separator lines (──────) between major sections.
Total length must not exceed ${maxChars} characters.
Output ONLY the description text, ready to copy-paste. No meta-commentary.`
}
