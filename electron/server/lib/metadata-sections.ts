/**
 * Metadata description SECTION REGISTRY (v1.0.199).
 *
 * The single source of truth for description section TYPES. Each entry declares
 * its default config + how it turns into an LLM prompt instruction. The prompt
 * builder (metadata-prompt.ts) loops sections and calls the registry instead of
 * a hardcoded switch — so adding a section type is one entry here (plus a
 * frontend catalog entry / editor). The frontend ships a mirrored catalog for
 * the builder UI.
 *
 * A section whose `buildInstruction` returns '' contributes nothing to the
 * prompt — used by deterministic sections like 'sources' (the real-link block
 * is appended in code, not written by the LLM).
 */

import type { Format } from '../models/types.js'

export interface SectionContext {
  format?: Format | null
}

export interface SectionShape {
  id: string
  label: string
  type?: string
  config?: Record<string, any>
}

export interface MetadataSectionDef {
  id: string
  label: string
  /** Default config seeded when this section is added in the builder. */
  defaultConfig: Record<string, any>
  /** When false, the section produces no LLM instruction (e.g. deterministic
   *  sources). Default true. */
  prompted?: boolean
  /** Returns the prompt instruction fragment ('' = contributes nothing). */
  buildInstruction(cfg: Record<string, any>, ctx: SectionContext, section: SectionShape): string
}

const SUPPORT_KIND_LABEL: Record<string, string> = {
  patreon: 'Patreon',
  kofi: 'Ko-fi',
  buymeacoffee: 'Buy Me a Coffee',
  'youtube-members': 'YouTube Membership',
  custom: 'Custom',
}

const DEFS: MetadataSectionDef[] = [
  {
    id: 'hook',
    label: 'Hook / Intro Paragraph',
    defaultConfig: { characters: 220, starting_format: '' },
    buildInstruction(cfg) {
      const charTarget = Number(cfg.characters) || (Number(cfg.sentences) ? Number(cfg.sentences) * 80 : 250)
      let s = `\n- HOOK: Write a hook paragraph of approximately ${charTarget} characters (±15% is fine) that draws viewers in.`
      if (cfg.starting_format) {
        s += ` The hook MUST begin with EXACTLY this text, then continue naturally: ${JSON.stringify(cfg.starting_format)}.`
      }
      return s
    },
  },
  {
    // Legacy monolithic section — kept for stale presets POSTed pre-migration.
    id: 'metadata',
    label: 'Metadata (legacy)',
    defaultConfig: {},
    buildInstruction(cfg) {
      let s = `\n- METADATA TABLE: Include a separator line, then:`
      if (cfg.narrator_enabled) s += ` NARRATOR: ${cfg.narrator_name || 'the narrator'},`
      if (cfg.music) s += ` MUSIC: [describe ambient soundscape matching episode theme],`
      if (cfg.channel_enabled) s += ` CHANNEL: ${cfg.channel_name || 'the channel'},`
      return s
    },
  },
  {
    id: 'narrator',
    label: 'Narrator Credit',
    defaultConfig: { name: '' },
    buildInstruction(cfg) {
      const name = cfg.name || 'the narrator'
      return `\n- NARRATOR CREDIT: Credit the narrator on its own line — Narrator: ${name}.`
    },
  },
  {
    id: 'music',
    label: 'Music Credit',
    defaultConfig: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' },
    buildInstruction(cfg) {
      if (!(cfg.title || cfg.link || cfg.disclaimer)) return ''
      let s = `\n- MUSIC: Include a "🎵 MUSIC" section with:`
      if (cfg.title) s += ` Title — "${cfg.title}".`
      if (cfg.link) s += ` Link — ${cfg.link}.`
      if (cfg.disclaimer) s += ` Disclaimer/credit line — "${cfg.disclaimer}".`
      return s
    },
  },
  {
    id: 'channels',
    label: 'Channel Mentions',
    defaultConfig: { channels: [{ name: '', url: '', kind: 'own' }] },
    buildInstruction(cfg) {
      const channels = (cfg.channels || []).filter((c: any) => c.name || c.url)
      if (!channels.length) return ''
      const own = channels.filter((c: any) => c.kind === 'own' || !c.kind)
      const rec = channels.filter((c: any) => c.kind === 'recommended')
      let s = `\n- CHANNEL MENTIONS:`
      if (own.length) {
        s += `\n  Our channel(s):`
        for (const c of own) s += `\n    - ${c.name || 'Channel'}${c.url ? ` → ${c.url}` : ''}`
      }
      if (rec.length) {
        s += `\n  Recommended channels:`
        for (const c of rec) s += `\n    - ${c.name || 'Channel'}${c.url ? ` → ${c.url}` : ''}`
      }
      return s
    },
  },
  {
    id: 'videos',
    label: 'Video Recommendations',
    defaultConfig: { videos: [{ name: '', url: '' }] },
    buildInstruction(cfg) {
      const videos = (cfg.videos || []).filter((v: any) => v.name || v.url)
      if (videos.length) {
        let s = `\n- VIDEO RECOMMENDATIONS: Include "🎬 MORE VIDEOS:" section with these videos:`
        for (const v of videos) s += `\n  - ${v.name || 'Video'}${v.url ? ` → ${v.url}` : ''}`
        return s
      }
      return `\n- VIDEO RECOMMENDATIONS: Include "🎬 MORE VIDEOS:" section with placeholder entries.`
    },
  },
  {
    id: 'playlists',
    label: 'Playlists',
    defaultConfig: { playlists: [{ name: '', url: '' }] },
    buildInstruction(cfg) {
      const playlists = (cfg.playlists || []).filter((p: any) => p.name || p.url)
      if (!playlists.length) return ''
      let s = `\n- PLAYLISTS: Include "📋 PLAYLISTS:" section with these playlists:`
      for (const p of playlists) s += `\n  - ${p.name || 'Playlist'}${p.url ? ` → ${p.url}` : ''}`
      return s
    },
  },
  {
    id: 'cta',
    label: 'Subscribe / Like CTA',
    defaultConfig: { custom_lines: [] },
    buildInstruction(cfg) {
      if (cfg.patreon_url || cfg.custom_text) {
        let s = `\n- SUBSCRIBE / LIKE CTA: Include a short subscribe + like CTA.`
        if (cfg.custom_text) s += ` Use this line as inspiration: "${cfg.custom_text}".`
        if (cfg.patreon_url) s += ` Mention Patreon link separately: ${cfg.patreon_url}.`
        return s
      }
      let s = `\n- SUBSCRIBE / LIKE CTA: Write 1-2 short calls-to-action that invite viewers to subscribe and like (NOT pay).`
      const lines = (cfg.custom_lines || []).filter((l: string) => l && l.trim())
      if (lines.length) {
        s += ` Use these lines verbatim or as inspiration:`
        for (const l of lines) s += `\n  - ${l}`
      }
      return s
    },
  },
  {
    id: 'support',
    label: 'Support / Membership',
    defaultConfig: { platforms: [] },
    buildInstruction(cfg) {
      const platforms = (cfg.platforms || []).filter((p: any) => p.url)
      if (!platforms.length) return ''
      let s = `\n- SUPPORT / MEMBERSHIP: Include a "💛 SUPPORT THE CHANNEL" section listing these platforms:`
      for (const p of platforms) {
        const label = p.kind === 'custom' ? (p.label || 'Custom') : (SUPPORT_KIND_LABEL[p.kind] || p.kind)
        s += `\n  - ${label}: ${p.url}`
      }
      return s
    },
  },
  {
    id: 'sources',
    label: '📚 Sources',
    defaultConfig: {},
    prompted: false,  // deterministic — the real-link block is appended in code.
    buildInstruction() { return '' },
  },
  {
    id: 'affiliate',
    label: 'Affiliate Disclaimer',
    defaultConfig: { text: 'As an Amazon Associate we earn from qualifying purchases.' },
    buildInstruction(cfg) {
      return `\n- AFFILIATE DISCLAIMER: Include: "${cfg.text || 'As an Amazon Associate we earn from qualifying purchases.'}"`
    },
  },
  {
    id: 'ai-disclosure',
    label: 'AI Disclosure',
    defaultConfig: { text: 'Created with the help of AI tools and reviewed before publishing.' },
    buildInstruction(cfg) {
      return `\n- AI DISCLOSURE: Include "🤖 AI DISCLOSURE:" section with: "${cfg.text || 'Created with the help of AI tools and reviewed before publishing.'}"`
    },
  },
  {
    id: 'hashtags',
    label: 'Hashtags (inside description)',
    defaultConfig: { count: 15 },
    buildInstruction(cfg, ctx) {
      const fmtHashtags = ctx.format?.metadata?.youtubeDescriptionStructure
      const count = cfg.count || fmtHashtags?.totalHashtagCount || 15
      const exampleHashtags = (Array.isArray(cfg.defaultHashtags) && cfg.defaultHashtags.length)
        ? cfg.defaultHashtags
        : (fmtHashtags?.defaultHashtags?.length ? fmtHashtags.defaultHashtags : [])
      if (exampleHashtags.length > 0) {
        const exampleLine = exampleHashtags.slice(0, 3).join(' ')
        return `\n- HASHTAGS: Include ${count} relevant hashtags at the end. Include common ones like ${exampleLine} plus episode-specific ones.`
      }
      return `\n- HASHTAGS: Include ${count} relevant hashtags at the end, all derived from this specific episode's subject matter.`
    },
  },
]

export const METADATA_SECTIONS: Record<string, MetadataSectionDef> = Object.fromEntries(DEFS.map(d => [d.id, d]))
export const METADATA_SECTION_LIST: MetadataSectionDef[] = DEFS
