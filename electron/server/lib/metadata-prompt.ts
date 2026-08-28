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
import { internalSectionNamesDirective } from './metadata-label-leak.js'

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
  // Every capitalised name this prompt is about to use to address an
  // instruction, collected as the sections are built so the directive below can
  // quote them back. v1.4.75 — see lib/metadata-label-leak.ts for why.
  const internalNames: string[] = []
  for (const section of sections || []) {
    if (!section.enabled) continue
    const cfg = section.config || {}
    const def = METADATA_SECTIONS[section.id]
    if (def) {
      // v1.0.199 — registry-driven: each section type's prompt fragment lives
      // in metadata-sections.ts, so adding a section type is one entry there.
      const instruction = def.buildInstruction(cfg, { format }, section as any)
      sectionInstructions += instruction
      // A section that contributed nothing named nothing. And a section whose
      // instruction quotes the heading it wants (`"🎵 MUSIC"`) is naming the
      // reader's heading, not an internal label — telling the model never to
      // print MUSIC would delete the section it just asked for.
      if (instruction && def.promptLabel && !def.literalHeader) internalNames.push(def.promptLabel)
    } else if (section.type === 'custom' && cfg.instructions) {
      // The operator's own name for a block he added. It gets shouted into the
      // prompt exactly like a built-in one, and it leaked exactly like one —
      // `ABOUT ME:` appeared above a host bio that the same channel publishes
      // unlabelled in its other episodes.
      const customName = section.label.toUpperCase()
      sectionInstructions += `\n- ${customName}: ${cfg.instructions}`
      internalNames.push(customName)
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

  // A description shape may state what goes between sections. Only when it
  // says nothing does the long-standing rule below apply, so a shape asking for
  // no dividers is no longer contradicted by the very next line of its prompt.
  const separatorLine = descShape?.separatorRule
    || 'Use separator lines (──────) between major sections.'

  return `Generate a YouTube description for a story episode.

Episode: ${episode_id} — ${title}

Story context:
${storyContext}${nicheVoiceBlock}

Include these sections IN THIS ORDER:
${sectionInstructions}${internalSectionNamesDirective(internalNames)}

${separatorLine}
Total length must not exceed ${maxChars} characters.
Output ONLY the description text, ready to copy-paste. No meta-commentary.`
}
