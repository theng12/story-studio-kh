/**
 * Scripted B-Roll shot director — turns the timed narration into beats and asks
 * an LLM for *filmable stock-search queries* per beat (the hard, craft part:
 * abstract narration → concrete searchable nouns). See
 * docs/scripted-broll-format-spec.md (pipeline steps 2–3).
 *
 * Mirrors services/sfx-director.ts: pure beat-grouping + prompt + tolerant parse
 * + plan mapping (all unit-testable), with a thin callAi orchestrator.
 */
import { callAi, sanitizeJsonControlChars } from '../lib/ai-client.js'
import type { SrtCue } from '../lib/subtitle-builder.js'
import { normalizePlan, type BrollPlan, type BrollBeat } from './broll-plan.js'

export interface Beat {
  start_sec: number
  end_sec: number
  line: string
}

/**
 * Group consecutive subtitle cues into beats of ~targetSec each. Pure.
 * A beat closes once it reaches the target length; the final cues form the
 * last beat even if short. Keeps narration lines intact (never splits a cue).
 */
export function cuesToBeats(cues: SrtCue[], targetSec = 5): Beat[] {
  const beats: Beat[] = []
  let cur: { start: number; end: number; parts: string[] } | null = null
  for (const c of cues) {
    if (!cur) cur = { start: c.start_sec, end: c.end_sec, parts: [] }
    cur.end = c.end_sec
    const t = c.text.replace(/\s+/g, ' ').trim()
    if (t) cur.parts.push(t)
    if (cur.end - cur.start >= targetSec) {
      beats.push({ start_sec: cur.start, end_sec: cur.end, line: cur.parts.join(' ') })
      cur = null
    }
  }
  if (cur && cur.end > cur.start) beats.push({ start_sec: cur.start, end_sec: cur.end, line: cur.parts.join(' ') })
  return beats
}

export interface ShotDirectorOptions {
  /** Channel look for the AI-gen fallback; recorded on the plan (not used in queries). */
  broll_style?: string
  /** Extra global guidance woven into queries (e.g. "1950s period", "corporate"). */
  style_hint?: string
}

/** Build the system + user prompt. Pure. */
export function buildShotPrompt(beats: Beat[], opts: ShotDirectorOptions = {}): { system: string; user: string } {
  const system = [
    'You are a video editor sourcing STOCK FOOTAGE for a narrated explainer video.',
    'For each beat of narration, write concrete, filmable search queries to find a matching stock clip on libraries like Pexels and Pixabay.',
    '',
    'The craft: translate ABSTRACT narration into CONCRETE, FILMABLE nouns + actions.',
    'Examples:',
    '- "economic uncertainty" → "stock market ticker red", "worried trader at desk", "falling line chart screen"',
    '- "people are working harder than ever" → "busy office workers typing", "commuters walking rush hour", "tired worker late night laptop"',
    '',
    'Rules:',
    '- For EACH beat give a "queries" array: 1 primary + 2 backups (3 total), best first.',
    '- Each query is a short plain noun phrase (2–5 words) that a stock site would match — what you SEE, not what is meant.',
    '- Prefer generic, widely-available shots over specific people/brands/events (stock libraries lack those).',
    opts.style_hint ? `- Global style to respect where natural: ${opts.style_hint}.` : '',
    '- Return ONLY a JSON object. No prose, no markdown fences.',
  ].filter(Boolean).join('\n')

  const schema = [
    '{',
    '  "beats": [',
    '    { "index": 0, "queries": ["primary query", "backup one", "backup two"] }',
    '  ]',
    '}',
  ].join('\n')

  const beatLines = beats
    .map((b, i) => `[${i}] (${b.start_sec.toFixed(1)}s–${b.end_sec.toFixed(1)}s) ${b.line}`)
    .join('\n')

  const user = [
    `There are ${beats.length} beats. Give queries for every beat index 0..${beats.length - 1}.`,
    'Beats:',
    beatLines,
    '',
    'Return JSON in exactly this shape:',
    schema,
    '',
    'Return the JSON now.',
  ].join('\n')

  return { system, user }
}

/** Tolerant parse — strips fences/prose, extracts the JSON object. Pure. */
export function parseShotJson(raw: string): { beats?: Array<{ index?: number; queries?: any }> } {
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
 * Merge the LLM's per-beat queries back onto the beats → a normalized, UNRESOLVED
 * BrollPlan (clip empty, status 'proposed'). Beats the model skipped keep an
 * empty query list (resolution/UI can re-query them). Pure.
 */
export function shotJsonToPlan(
  beats: Beat[],
  parsed: { beats?: Array<{ index?: number; queries?: any }> },
  opts: ShotDirectorOptions = {},
): BrollPlan {
  const byIndex = new Map<number, string[]>()
  if (Array.isArray(parsed.beats)) {
    parsed.beats.forEach((entry, i) => {
      const idx = Number.isInteger(entry?.index) ? (entry!.index as number) : i
      const queries = Array.isArray(entry?.queries)
        ? entry!.queries.map((q: any) => (typeof q === 'string' ? q.trim() : '')).filter(Boolean)
        : []
      if (queries.length) byIndex.set(idx, queries)
    })
  }

  const planBeats: BrollBeat[] = beats.map((b, i) => ({
    start_sec: b.start_sec,
    end_sec: b.end_sec,
    line: b.line,
    queries: byIndex.get(i) ?? [],
    source: '' as const,
    clip: '',
    in_point_sec: 0,
    status: 'proposed' as const,
  }))

  return normalizePlan({ schema_version: 1, enabled: true, broll_style: opts.broll_style ?? '', beats: planBeats })
}

/** Orchestration: cues → beats → LLM → unresolved plan. */
export async function runShotDirector(opts: {
  cues: SrtCue[]
  model: string
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }
  target_beat_sec?: number
  broll_style?: string
  style_hint?: string
  slug?: string
}): Promise<BrollPlan> {
  const beats = cuesToBeats(opts.cues, opts.target_beat_sec ?? 5)
  if (!beats.length) return normalizePlan({ enabled: true, broll_style: opts.broll_style ?? '', beats: [] })
  const { system, user } = buildShotPrompt(beats, { broll_style: opts.broll_style, style_hint: opts.style_hint })
  const raw = await callAi(opts.model, system, user, opts.apiKeys, false, { slug: opts.slug })
  return shotJsonToPlan(beats, parseShotJson(raw), { broll_style: opts.broll_style })
}
