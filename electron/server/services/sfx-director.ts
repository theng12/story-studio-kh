/**
 * SFX director — the LLM that reads the timed subtitle transcript and proposes
 * a SPARSE set of sound cues (ambient beds + spot one-shots). Output is an
 * unresolved SfxPlan (cues carry label + timing only; clip resolution is a
 * separate step). See docs/sfx-sound-layer-spec.md.
 *
 * Historical prompt and parser helpers remain pure and unit-testable. The
 * executable director entry point is fail-closed pending a typed GenStudio API.
 */
import type { SrtCue } from '../lib/subtitle-builder.js'
import {
  normalizePlan,
  DEFAULT_BED_GAIN_DB,
  DEFAULT_SPOT_GAIN_DB,
  type SfxPlan,
} from './sfx-plan.js'

export type SfxIntensity = 'minimal' | 'moderate' | 'rich'

function sanitizeJsonControlChars(s: string): string {
  return s.replace(/"(?:[^"\\]|\\.)*"/g, (str) =>
    str
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, ''),
  )
}

const INTENSITY_GUIDANCE: Record<SfxIntensity, string> = {
  minimal: 'Be extremely sparse — usually just ONE quiet ambient bed for the whole video and at most a couple of spot effects. When in doubt, add nothing.',
  moderate: 'Be sparse. A bed or two for atmosphere, and only a handful of spot effects on the strongest, most concrete moments. Silence between is good.',
  rich: 'You may be a little more active, but still restrained — never wall-to-wall. Most lines should have NO spot effect.',
}

export interface DirectorOptions {
  intensity?: SfxIntensity
  /** Optional visual hints (e.g. per-beat clip labels) to enrich placement. */
  visual_hints?: Array<{ at_sec: number; label: string }>
}

/** Render the timed transcript the LLM places against. Pure. */
export function renderTranscript(cues: SrtCue[]): string {
  return cues
    .map(c => `[${c.start_sec.toFixed(1)}s–${c.end_sec.toFixed(1)}s] ${c.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
}

/** Build the system + user prompt. Pure. */
export function buildDirectorPrompt(cues: SrtCue[], opts: DirectorOptions = {}): { system: string; user: string } {
  const intensity = opts.intensity ?? 'moderate'
  const totalSec = cues.length ? cues[cues.length - 1]!.end_sec : 0

  const system = [
    'You are a sound designer scoring a narrated video with sound effects.',
    'You are given the narration as a timed transcript. Propose sound effects that make the video feel alive WITHOUT distracting from the voice.',
    '',
    'Two kinds of cue:',
    '- "beds": ambient atmospheres that play quietly UNDER the narration across a time span (e.g. "city street at night", "newsroom hum", "tense low drone"). Usually one at a time.',
    '- "spots": short one-shot effects anchored to a single concrete moment (e.g. "door slam", "cash register", "phone notification", "whoosh").',
    '',
    'Rules:',
    `- ${INTENSITY_GUIDANCE[intensity]}`,
    '- Restraint is the craft: dense, wall-to-wall SFX sounds amateur. Most narration lines should have NO spot effect.',
    '- Only place a spot where the narration or scene clearly implies a concrete, real-world sound.',
    '- Use short, concrete, SEARCHABLE sound nouns (what you would type into a sound-effect library), not abstractions.',
    `- All timestamps must be within 0 and ${totalSec.toFixed(1)} seconds. Beds need start_sec < end_sec.`,
    '- Return ONLY a JSON object. No prose, no markdown fences.',
  ].join('\n')

  const schema = [
    '{',
    '  "beds": [ { "label": "city street at night", "start_sec": 0, "end_sec": 30.0 } ],',
    '  "spots": [ { "label": "door slam", "at_sec": 12.4 } ]',
    '}',
  ].join('\n')

  const userParts = [
    `Total duration: ${totalSec.toFixed(1)}s.`,
    'Timed transcript:',
    renderTranscript(cues),
  ]
  if (opts.visual_hints?.length) {
    userParts.push(
      '\nOn-screen visuals (use as extra context for what sounds fit):',
      opts.visual_hints.map(h => `[${h.at_sec.toFixed(1)}s] ${h.label}`).join('\n'),
    )
  }
  userParts.push('\nReturn JSON in exactly this shape:', schema, '\nReturn the JSON now.')

  return { system, user: userParts.join('\n') }
}

/** Tolerant parse — strips fences + prose, extracts the JSON object. Pure. */
export function parseDirectorJson(raw: string): { beds?: any[]; spots?: any[] } {
  if (!raw) return {}
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      const obj = JSON.parse(sanitizeJsonControlChars(cleaned.slice(first, last + 1)))
      return obj && typeof obj === 'object' ? obj : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Convert parsed director output into a normalized, UNRESOLVED SfxPlan.
 * Cues carry label + timing only (source/clip empty, status 'proposed'), so the
 * plan does not affect the render until a later resolution step fills clips.
 * Timestamps are clamped into [0, totalDurationSec]. Pure.
 */
export function directorJsonToPlan(parsed: { beds?: any[]; spots?: any[] }, totalDurationSec: number): SfxPlan {
  const cap = Math.max(0, totalDurationSec)
  const clamp = (v: any) => Math.max(0, Math.min(cap, Number(v) || 0))

  const beds = (Array.isArray(parsed.beds) ? parsed.beds : [])
    .filter(b => b && typeof b.label === 'string' && b.label.trim())
    .map(b => {
      const start = clamp(b.start_sec)
      const end = Math.max(start, clamp(b.end_sec))
      return {
        label: String(b.label).trim(),
        start_sec: start,
        end_sec: end,
        source: '' as const,
        clip: '',
        gain_db: DEFAULT_BED_GAIN_DB,
        status: 'proposed' as const,
      }
    })
    .filter(b => b.end_sec > b.start_sec)

  const spots = (Array.isArray(parsed.spots) ? parsed.spots : [])
    .filter(s => s && typeof s.label === 'string' && s.label.trim())
    .map(s => ({
      label: String(s.label).trim(),
      at_sec: clamp(s.at_sec),
      source: '' as const,
      clip: '',
      gain_db: DEFAULT_SPOT_GAIN_DB,
      status: 'proposed' as const,
    }))

  // enabled:true is safe — unresolved cues can't affect the render
  // (planAffectsRender requires a resolved clip), so this just means "live once
  // its cues are resolved".
  return normalizePlan({ schema_version: 1, enabled: true, beds, spots })
}

/**
 * Historical orchestration entry point. Automatic SFX direction requires a
 * typed GenStudio endpoint so retries, billing, and evidence stay centralized.
 */
export async function runSfxDirector(opts: {
  cues: SrtCue[]
  model: string
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }
  intensity?: SfxIntensity
  visual_hints?: Array<{ at_sec: number; label: string }>
  slug?: string
}): Promise<SfxPlan> {
  void opts
  throw new Error('GENSTUDIO_CAPABILITY_UNAVAILABLE: Automatic SFX direction requires a qualified typed GenStudio KH SFX route.')
}
