/**
 * Pure helpers that render a Character[] cast into the prompt blocks the
 * LLM sees. Three sites consume these:
 *
 *   1. `generators/episode.ts` — the script-only generator. Uses
 *      `castPromptBlock` for the narration prompt and
 *      `castImagePromptBlock` inside the combined image-prompts subsection.
 *   2. `routes/scripts.ts` — the interactive `/generate/image-prompts`
 *      endpoint that the standalone Image Prompts page hits. Uses
 *      `castImagePromptBlock` so the LLM honours the requirement
 *      "Every prompt must include inline character descriptions" (which
 *      previously had no character data backing it up).
 *   3. `generators/image-prompts.ts` — the batch executor used by the
 *      Pipeline runner for unattended image-prompts generation.
 *
 * Pulled out of `episode.ts` so all three callers share one source of
 * truth — and so the helpers are independently testable without dragging
 * in the whole episode generator graph.
 *
 * Both functions are pure (Character[] → string) and return an empty
 * string when no characters are passed, preserving back-compat with the
 * "LLM invents the cast" path that runs whenever a generation request
 * has no `character_ids`.
 */

import type { Character } from '../models/types.js'

/**
 * Render the cast for a script-generation prompt. Tells the LLM to use
 * the named characters (not invent new ones), to honour each character's
 * description + tonation hint, and — for episodes with 2+ characters —
 * to mark dialog lines with `[CHARACTER_NAME]:` tags so the audio
 * generator can route per-character voices in Phase 6's voice-routing
 * path.
 */
export function castPromptBlock(characters: Character[]): string {
  if (!characters.length) return ''
  const lines = characters.map((c, i) => {
    const role = c.archetype ? ` [${c.archetype}]` : ''
    const tonation = c.speech?.tonation ? ` Tonation: ${c.speech.tonation}.` : ''
    return `${i + 1}. ${c.name}${role}\n   ${c.description}${tonation}`
  })
  const tagInstruction = characters.length >= 2
    ? `\n\nThis episode has multiple named characters. Mark each dialog line with the speaker tag in this exact format:\n  [CHARACTER_NAME]: dialog text\nUse the character's exact name from the cast above (case-sensitive). Narration prose (no speaker tag) is read by the narrator. Do NOT invent character names that aren't in the cast.`
    : `\n\nUse "${characters[0].name}" by name throughout — never invent additional named characters; supporting figures stay descriptive ("the merchant", "her sister") rather than getting names of their own.`

  return `\nCAST (use these characters; do NOT invent names that aren't here):\n${lines.join('\n')}${tagInstruction}\n`
}

/**
 * Render the cast for an image-prompts-generation prompt. Tells the LLM
 * to copy each character's description into every scene prompt that
 * features them — this is what keeps the visuals consistent across
 * regenerations of the same episode AND across multiple episodes that
 * feature the same character.
 *
 * Used by both the combined script+image-prompts path (episode.ts) and
 * the standalone image-prompts paths (route + batch). The auto-detect
 * reference-image flow in Phase 8 (images.ts) keys off the character
 * names appearing in the resulting prompt text — so a character that's
 * named here will also have its uploaded reference images forwarded to
 * Flux Kontext / Nano Banana when the user generates the actual images.
 */
export function castImagePromptBlock(characters: Character[]): string {
  if (!characters.length) return ''
  const lines = characters.map((c) => `- ${c.name}: ${c.description}`)
  return `\nCHARACTER REFERENCE (include these descriptions inline in every scene that features the character — copy them verbatim or paraphrase tightly so the visual stays consistent):\n${lines.join('\n')}\n`
}
