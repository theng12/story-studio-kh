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
- Use tags SPARINGLY. Only where they clearly improve delivery — emotional beats, emphasis, a natural breath or pause. Most sentences need none. Aim for at most a few per paragraph.
- DO NOT change, add, remove, reorder, correct, or rephrase ANY of the narration's words. Insert ONLY bracketed tags between existing words.
- Preserve every line break and paragraph exactly as given.
- Output ONLY the tagged narration. No preamble, no commentary, no code fences.`

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
