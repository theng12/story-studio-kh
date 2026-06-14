/**
 * Fish Audio S2 expression markup — the "expressive script" sidecar.
 *
 * Fish S2 takes inline performance tags right in the narration text, e.g.
 * `[whispering] Don't let them hear you.` or open-domain `[dead tired]`. This
 * service runs an LLM pass that inserts those tags into a copy of the episode
 * narration, stores the result per section in a sidecar JSON, and lets the
 * Audio Generator swap the tagged text in at render time (Fish S2-Pro only).
 *
 * The sidecar is keyed by section slug so the REAL narration always stays the
 * authoritative source of section structure — we only override the spoken text.
 *
 * Docs: https://fish.audio/blog/fish-audio-s2-fine-grained-ai-voice-control-at-the-word-level/
 */

import fs from 'fs/promises'
import path from 'path'
import { callAi } from '../lib/ai-client.js'
import type { Job } from '../models/types.js'

/** Filename of the per-episode sidecar, stored next to the narration file. */
export const EXPRESSION_SIDECAR = 'audio_expression.json'

export interface ExpressionSidecar {
  schema_version: 1
  /** Model used for the last LLM markup pass (informational). */
  model?: string
  /** ISO timestamp of the last write (informational). */
  generated_at?: string
  /** Tagged narration per section slug. Missing slug = use plain narration. */
  sections: Record<string, string>
}

export function expressionSidecarPath(narrationPath: string): string {
  return path.join(path.dirname(narrationPath), EXPRESSION_SIDECAR)
}

export async function readExpression(narrationPath: string): Promise<ExpressionSidecar | null> {
  try {
    const raw = await fs.readFile(expressionSidecarPath(narrationPath), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sections && typeof parsed.sections === 'object') {
      return parsed as ExpressionSidecar
    }
  } catch { /* missing or corrupt — treat as no markup */ }
  return null
}

export async function writeExpression(narrationPath: string, data: ExpressionSidecar): Promise<void> {
  await fs.mkdir(path.dirname(expressionSidecarPath(narrationPath)), { recursive: true }).catch(() => {})
  await fs.writeFile(expressionSidecarPath(narrationPath), JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * System prompt for the markup pass. Strict: insert ONLY bracketed tags,
 * never touch the words. The user reviews/edits the result before it's voiced,
 * so this is a best-effort first draft, not a trusted transform.
 */
const EXPRESSION_SYSTEM = `You add Fish Audio S2 inline performance tags to narration that will be spoken by a text-to-speech voice.

Fish S2 tags are square-bracket directions that affect the words AFTER them, e.g.
  [whispering] Don't let them hear you.
  She set the folder down. [long pause] Then she looked up.
  [excited] We actually did it!
Tags are open-domain — write what you'd tell a voice actor: [warmly], [almost a whisper], [dead tired], [building urgency]. Common ones: whispering, soft voice, loud voice, shouting, excited, angry, sad, warmly, emphasis, sigh, inhale, exhale, gasp, laughing, chuckling, pause, short pause, long pause.

RULES — follow every one exactly:
- PACING IS YOUR FIRST JOB. The voice rushes through full stops with almost no gap, which sounds robotic. Give it rhythm: add a [short pause] after most sentence-ending periods (and after natural mid-sentence beats — commas that carry weight, dashes, colons), and a [long pause] at paragraph breaks and major topic shifts. Vary them so it sounds human, not metronomic — not every single sentence needs one, but silence should never feel absent.
- EVERY PARAGRAPH gets attention. Put a [long pause] at the START of each new paragraph (right after the line break), and make sure no paragraph is left without any pacing/emotion — work through the WHOLE text top to bottom, including the final paragraph. Never skip or thin out the later paragraphs.
- THEN add emotion/performance tags where they clearly help — emotional beats, emphasis, a breath. These are sparser than pauses; a few per paragraph.
- DO NOT change, add, remove, reorder, correct, or rephrase ANY of the narration's words. Insert ONLY bracketed tags between existing words.
- Preserve every line break and paragraph exactly as given.
- Output ONLY the tagged narration. No preamble, no commentary, no code fences.`

/**
 * Deterministic pacing pass (no LLM): insert Fish pause tags at sentence and
 * paragraph boundaries so plain narration stops rushing through full stops.
 * `[long pause]` between paragraphs, `[short pause]` after sentence-ending
 * punctuation. Skips common abbreviations on a single period, and won't double
 * up next to a pause tag that's already there (so it composes with the LLM
 * pass / hand edits). Fish S2-Pro only — the tags would be read aloud by S1.
 */
const PACING_ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'vs', 'etc', 'no', 'inc', 'ltd',
  'prof', 'gen', 'sgt', 'lt', 'col', 'capt', 'rev', 'hon', 'dept', 'fig', 'vol',
])
export function addSentencePacing(text: string): string {
  // 1. ANY line break = a paragraph/beat boundary → [long pause]. Narration is
  //    never hard-wrapped mid-paragraph, so this reliably catches every
  //    paragraph change whether the source — or the LLM expression pass —
  //    separated paragraphs with one newline or two. Newlines don't matter to
  //    Fish; the tag carries the pause, so we flatten them into the tag.
  let t = text.trim().replace(/[ \t]*[\r\n]+[ \t]*/g, ' [long pause] ')
  // 2. [short pause] after sentence-ending . ? ! + whitespace + a capital /
  //    quote / open-paren, skipping common abbreviations on a lone period.
  t = t.replace(/(\S+?)([.!?]+)([ \t]+)(?=["'“‘(]?[A-Z0-9])/g, (m, word: string, punct: string, sp: string) => {
    const bare = word.toLowerCase().replace(/[^a-z]/g, '')
    if (punct === '.' && PACING_ABBREV.has(bare)) return m  // Mr. / Dr. / etc.
    return `${word}${punct}${sp}[short pause] `
  })
  // 3. Never stack pauses (the LLM pass + this pass can land on the same spot).
  t = t.replace(/\[(?:short|long) pause\](?:\s*\[(?:short|long) pause\])+/g, (m) => (m.includes('long') ? '[long pause]' : '[short pause]'))
  return t.replace(/[ \t]{2,}/g, ' ').trim()
}

interface AiKeys { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }

/**
 * Run the LLM markup pass over one section's text. Returns the tagged text
 * (or the original on an empty/failed response so a section is never blanked).
 */
export async function markupSectionText(
  model: string,
  sectionText: string,
  apiKeys: AiKeys,
  slug: string,
): Promise<string> {
  const out = await callAi(model, EXPRESSION_SYSTEM, sectionText, apiKeys, false, { slug })
  const trimmed = (out || '').trim()
  return trimmed.length ? trimmed : sectionText
}

export interface ExpressionMarkupParams {
  episode_id: string
  title?: string
  /** Text model for the markup pass; defaults to deepseek-v4-flash. */
  model?: string
  /** Limit to these section slugs; omit/empty = every section. */
  slugs?: string[]
}

/**
 * Background "Tag all" job — runs the LLM markup over every (or selected)
 * section server-side, saving the sidecar after EACH section so progress
 * survives navigation, a crash, or cancellation. This is why "Tag all" keeps
 * working after the operator leaves the Audio Generator page.
 */
export async function runExpressionMarkupJob(job: Job): Promise<void> {
  const params = job.params as ExpressionMarkupParams
  const episodeId = params.episode_id
  if (!episodeId) throw new Error('episode_id is required')
  const model = (typeof params.model === 'string' && params.model.trim()) ? params.model.trim() : 'deepseek-v4-flash'

  const pm = await import('./project-manager.js')
  const { findNarrationFile } = await import('../generators/audio.js')
  const { parseNarrationDocx } = await import('../lib/docx-parser.js')
  const { isCancelled } = await import('./job-queue.js')

  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  const narrationPath = await findNarrationFile(job.project_slug, episodeId)
  const parsed = await parseNarrationDocx(narrationPath)
  const targets = (Array.isArray(params.slugs) && params.slugs.length)
    ? parsed.filter(s => params.slugs!.includes(s.slug))
    : parsed
  if (!targets.length) { job.output_lines.push('No matching sections to tag.'); job.progress = 100; return }

  const apiKeys: AiKeys = {
    anthropic_api_key: (config as any).anthropic_api_key,
    openai_api_key: (config as any).openai_api_key,
    kie_api_key: (config as any).kie_api_key,
  }
  job.output_lines.push(`Tagging ${targets.length} section(s) with ${model}…`)

  const existing = await readExpression(narrationPath)
  const sectionsOut: Record<string, string> = { ...(existing?.sections || {}) }
  for (let i = 0; i < targets.length; i++) {
    if (isCancelled(job.job_id)) { job.output_lines.push('Cancelled by user.'); return }
    const s = targets[i]!
    job.output_lines.push(`  ${s.label} (${i + 1}/${targets.length})`)
    sectionsOut[s.slug] = await markupSectionText(model, s.text, apiKeys, job.project_slug)
    // Persist after every section so partial progress is never lost.
    await writeExpression(narrationPath, {
      schema_version: 1, model, generated_at: new Date().toISOString(), sections: sectionsOut,
    })
    job.progress = Math.round(((i + 1) / targets.length) * 100)
  }
  job.output_lines.push('Expression markup complete.')
}
