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

interface Section {
  id: string
  label: string
  type?: string
  enabled: boolean
  config?: Record<string, any>
}

const SUPPORT_KIND_LABEL: Record<string, string> = {
  patreon: 'Patreon',
  kofi: 'Ko-fi',
  buymeacoffee: 'Buy Me a Coffee',
  'youtube-members': 'YouTube Membership',
  custom: 'Custom',
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
    switch (section.id) {
      case 'hook': {
        const charTarget = Number(cfg.characters) || (Number(cfg.sentences) ? Number(cfg.sentences) * 80 : 250)
        sectionInstructions += `\n- HOOK: Write a hook paragraph of approximately ${charTarget} characters (±15% is fine) that draws listeners in.`
        if (cfg.starting_format) {
          sectionInstructions += ` The hook MUST begin with EXACTLY this text, then continue naturally: ${JSON.stringify(cfg.starting_format)}.`
        }
        break
      }

      // Legacy monolithic 'metadata' section. Migrated frontend-side; this
      // branch is a fallback for stale presets POSTed before the migration
      // ran (e.g. via the Pipeline batch which doesn't go through the UI).
      case 'metadata': {
        sectionInstructions += `\n- METADATA TABLE: Include a separator line, then:`
        if (cfg.narrator_enabled) sectionInstructions += ` NARRATOR: ${cfg.narrator_name || 'the narrator'},`
        if (cfg.music) sectionInstructions += ` MUSIC: [describe ambient soundscape matching episode theme],`
        if (cfg.channel_enabled) sectionInstructions += ` CHANNEL: ${cfg.channel_name || 'the channel'},`
        break
      }

      case 'narrator': {
        const name = cfg.name || 'the narrator'
        sectionInstructions += `\n- NARRATOR CREDIT: Credit the narrator on its own line — Narrator: ${name}.`
        break
      }

      case 'music': {
        // Skip silently when nothing's filled in — better than nudging the
        // LLM to invent placeholder music details the user has to remove.
        if (cfg.title || cfg.link || cfg.disclaimer) {
          sectionInstructions += `\n- MUSIC: Include a "🎵 MUSIC" section with:`
          if (cfg.title) sectionInstructions += ` Title — "${cfg.title}".`
          if (cfg.link) sectionInstructions += ` Link — ${cfg.link}.`
          if (cfg.disclaimer) sectionInstructions += ` Disclaimer/credit line — "${cfg.disclaimer}".`
        }
        break
      }

      case 'channels': {
        const channels = (cfg.channels || []).filter((c: any) => c.name || c.url)
        if (channels.length) {
          const own = channels.filter((c: any) => c.kind === 'own' || !c.kind)
          const rec = channels.filter((c: any) => c.kind === 'recommended')
          sectionInstructions += `\n- CHANNEL MENTIONS:`
          if (own.length) {
            sectionInstructions += `\n  Our channel(s):`
            for (const c of own) sectionInstructions += `\n    - ${c.name || 'Channel'}${c.url ? ` → ${c.url}` : ''}`
          }
          if (rec.length) {
            sectionInstructions += `\n  Recommended channels:`
            for (const c of rec) sectionInstructions += `\n    - ${c.name || 'Channel'}${c.url ? ` → ${c.url}` : ''}`
          }
        }
        break
      }

      case 'videos': {
        const videos = (cfg.videos || []).filter((v: any) => v.name || v.url)
        if (videos.length) {
          sectionInstructions += `\n- VIDEO RECOMMENDATIONS: Include "🎬 MORE STORIES:" section with these videos:`
          for (const v of videos) {
            sectionInstructions += `\n  - ${v.name || 'Video'}${v.url ? ` → ${v.url}` : ''}`
          }
        } else {
          sectionInstructions += `\n- VIDEO RECOMMENDATIONS: Include "🎬 MORE STORIES:" section with placeholder entries.`
        }
        break
      }

      case 'playlists': {
        const playlists = (cfg.playlists || []).filter((p: any) => p.name || p.url)
        if (playlists.length) {
          sectionInstructions += `\n- PLAYLISTS: Include "📋 PLAYLISTS:" section with these playlists:`
          for (const p of playlists) {
            sectionInstructions += `\n  - ${p.name || 'Playlist'}${p.url ? ` → ${p.url}` : ''}`
          }
        }
        break
      }

      case 'cta': {
        // Legacy shape (patreon_url + custom_text) was conflated with the
        // support CTA; if it arrives, route the patreon link to support
        // wording inline so we don't lose the user's intent.
        if (cfg.patreon_url || cfg.custom_text) {
          sectionInstructions += `\n- SUBSCRIBE / LIKE CTA: Include a short subscribe + like CTA.`
          if (cfg.custom_text) sectionInstructions += ` Use this line as inspiration: "${cfg.custom_text}".`
          if (cfg.patreon_url) sectionInstructions += ` Mention Patreon link separately: ${cfg.patreon_url}.`
        } else {
          sectionInstructions += `\n- SUBSCRIBE / LIKE CTA: Write 1-2 short, warm calls-to-action that invite viewers to subscribe and like (NOT pay).`
          const lines = (cfg.custom_lines || []).filter((l: string) => l && l.trim())
          if (lines.length) {
            sectionInstructions += ` Use these lines verbatim or as inspiration:`
            for (const l of lines) sectionInstructions += `\n  - ${l}`
          }
        }
        break
      }

      case 'support': {
        const platforms = (cfg.platforms || []).filter((p: any) => p.url)
        if (platforms.length) {
          sectionInstructions += `\n- SUPPORT / MEMBERSHIP: Include a "💛 SUPPORT THE CHANNEL" section listing these platforms:`
          for (const p of platforms) {
            const label = p.kind === 'custom' ? (p.label || 'Custom') : (SUPPORT_KIND_LABEL[p.kind] || p.kind)
            sectionInstructions += `\n  - ${label}: ${p.url}`
          }
        }
        break
      }

      case 'affiliate':
        sectionInstructions += `\n- AFFILIATE DISCLAIMER: Include: "${cfg.text || 'As an Amazon Associate we earn from qualifying purchases.'}"`
        break
      case 'ai-disclosure':
        sectionInstructions += `\n- AI DISCLOSURE: Include "🤖 AI DISCLOSURE:" section with: "${cfg.text || 'This story was written with the assistance of AI tools.'}"`
        break
      case 'hashtags': {
        // Pull defaultHashtags + totalHashtagCount from the project's
        // effective Format when the user-configured `cfg` doesn't pin
        // explicit values. Without this, every batch description for a
        // listicle / true-crime / educational channel would suggest
        // #SleepStory #BedtimeStory as the "common ones" — leaking
        // sleep-story bias into format-aware metadata.
        const fmtHashtags = format?.metadata?.youtubeDescriptionStructure
        const count = cfg.count || fmtHashtags?.totalHashtagCount || 15
        // v1.0.102+ — When neither cfg nor format ship hashtag examples,
        // OMIT the "common ones like X" hint entirely instead of falling
        // back to sleep-story-flavoured ['#SleepStory', '#BedtimeStory'].
        // For custom formats that haven't declared defaults, the prompt
        // simply asks the LLM to invent N relevant hashtags — better than
        // pushing it toward the wrong genre.
        const exampleHashtags = (Array.isArray(cfg.defaultHashtags) && cfg.defaultHashtags.length)
          ? cfg.defaultHashtags
          : (fmtHashtags?.defaultHashtags?.length ? fmtHashtags.defaultHashtags : [])
        if (exampleHashtags.length > 0) {
          const exampleLine = exampleHashtags.slice(0, 3).join(' ')
          sectionInstructions += `\n- HASHTAGS: Include ${count} relevant hashtags at the end. Include common ones like ${exampleLine} plus episode-specific ones.`
        } else {
          sectionInstructions += `\n- HASHTAGS: Include ${count} relevant hashtags at the end, all derived from this specific episode's subject matter.`
        }
        break
      }
      default:
        if (section.type === 'custom' && cfg.instructions) {
          sectionInstructions += `\n- ${section.label.toUpperCase()}: ${cfg.instructions}`
        }
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
