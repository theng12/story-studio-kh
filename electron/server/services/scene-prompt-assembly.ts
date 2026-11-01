/**
 * The ONE composition of a scene image prompt.
 *
 * A stored `visual_prompt` is not the text the image model receives. The scene
 * renderer appends the anchor character descriptors and the Style Bible to
 * every prompt it renders (`generators/continuity-render.ts`), for EVERY
 * project. `generators/scene-image.ts` (the single-image path) submits the
 * stored `visual_prompt` bare, without the anchors or the Style Bible, so this
 * assembly is the worst case a stored prompt meets, not the only one. Scene
 * Plan therefore budgets the writer against a ceiling that leaves room for
 * exactly this text, so the prompt fits wherever it is rendered.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The budget and the renderer must agree on what is appended, byte for byte. A
 * second copy of the composition — even one that looks identical — could drift
 * and would only show up as a render-time refusal on a prompt Scene Plan
 * believed fitted. So the composition lives here once:
 *
 *   - `composeSceneRenderPrompt` is what the renderer submits.
 *   - `sceneRenderAssemblyParts` names and measures the pieces it adds, so the
 *     writer's allowance is the published ceiling minus EXACTLY that text.
 *
 * The readers here deliberately match the renderer's tolerance: an absent or
 * unreadable `continuity.json` means "no anchors" there, and a missing or
 * corrupt character is skipped there. `resolveStyleBible` is the same resolver
 * the renderer calls, so style text can never differ between the two.
 *
 * A ceiling shorter than that assembly still has to be met, and the Style
 * Bible is the piece that gives: `fitRenderedStyleBible` cuts it at a sentence
 * end so the scene and the character details reach the model whole. The Style
 * Bible ON DISK is never rewritten — only the text submitted for one render.
 *
 * Nothing here invents a limit. The ceiling is whatever the caller read live
 * from the selected model's published `max_prompt_characters`; no published
 * figure means the fit is never called and the prompt is sent as composed.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveStyleBible } from '../lib/style-bible.js'
import { getCharacter } from './character-manager.js'
import { promptCharacterCount } from './prompt-char-cap.js'
import type { AssemblyPart } from './prompt-char-cap.js'

export interface ScenePromptCharacterDescription {
  name: string
  description: string
}

/** The "Name: description; …" text the renderer puts after "Character details — ". */
export function sceneCharacterText(
  characters: readonly ScenePromptCharacterDescription[],
  includeCharacter = true,
): string {
  if (!includeCharacter) return ''
  return characters.map(character => `${character.name}: ${character.description}`).join('; ')
}

/**
 * The layers appended on top of the prompt body, each named and carrying the
 * EXACT text (including the separator the renderer joins with), so
 * `measureAssemblyOverhead` counts what the render will really add.
 */
export function sceneRenderAssemblyParts(
  characters: readonly ScenePromptCharacterDescription[],
  styleBible: string,
  includeCharacter = true,
): AssemblyPart[] {
  const charText = sceneCharacterText(characters, includeCharacter)
  return [
    ...(charText ? [{ label: 'anchor character descriptors', text: `\n\nCharacter details — ${charText}.` }] : []),
    ...(styleBible ? [{ label: 'Style Bible', text: `\n\nStyle: ${styleBible}` }] : []),
  ]
}

/**
 * The prompt the scene renderer submits: the body, then the character layer,
 * then the Style Bible, joined by blank lines. Sections are omitted when empty,
 * so a project with neither renders the bare body exactly as before.
 */
export function composeSceneRenderPrompt(
  visualPrompt: string,
  characters: readonly ScenePromptCharacterDescription[],
  styleBible: string,
  includeCharacter = true,
): string {
  return [visualPrompt.trim(), ...sceneRenderAssemblyParts(characters, styleBible, includeCharacter).map(part => part.text)].join('')
}

// ── Meeting a published ceiling by shortening the Style Bible ─────────────
//
// A model that publishes a short `max_prompt_characters` — FLUX.2 Klein and
// Z-Image are around 500 tokens, and Studio Hub is about to publish figures
// near 1,900–2,000 — refuses a long prompt, and the assembled scene prompt is
// easily 3,300 characters once the Style Bible is appended. The scene text is
// the picture; the Style Bible is a description of the LOOK. So when the two
// cannot both fit, the Style Bible is what gives.
//
// The cut is at a SENTENCE end, never mid-word and never mid-sentence: a
// half-clause is not a weaker style, it is a different and less predictable
// one. When no whole sentence fits, none is sent at all — a bare "Style:"
// label with nothing after it is noise, and one lonely clause that happened to
// be short is a worse steer than the scene text alone.

/** Characters that CLOSE a sentence in English and in Khmer (`។` U+17D4). */
const SENTENCE_ENDINGS = '.!?។'
/** Closing punctuation that belongs to the sentence it terminates. */
const SENTENCE_TRAILERS = '"\'”’»)]}'

export interface StyleSentence {
  /** The sentence, including its terminator and closing punctuation. */
  text: string
  /** Index one past the last character of this sentence in the original. */
  end: number
}

/**
 * The Style Bible's whole sentences, in order, each carrying the index it ends
 * at so a caller can keep the ORIGINAL bytes rather than rejoin them.
 *
 * A terminator only ends a sentence when whitespace or the end of the text
 * follows it — a '.' inside a number or an abbreviation ends nothing. Text
 * with no terminator at the end is returned whole as the final unit: it is the
 * complete remainder, not a cut.
 */
export function splitStyleSentences(text: string): StyleSentence[] {
  const sentences: StyleSentence[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (!SENTENCE_ENDINGS.includes(text[i]!)) continue
    let end = i + 1
    while (end < text.length && SENTENCE_TRAILERS.includes(text[end]!)) end++
    if (end < text.length && !/\s/.test(text[end]!)) continue
    const sentence = text.slice(start, end).trim()
    if (sentence) sentences.push({ text: sentence, end })
    start = end
  }
  const rest = text.slice(start).trim()
  if (rest) sentences.push({ text: rest, end: text.length })
  return sentences
}

/**
 * What one assembled prompt became against a published ceiling.
 *
 * Three outcomes, deliberately NOT collapsed into a length: a prompt that
 * already fits, one whose Style Bible was shortened, and a scene whose OWN
 * text will not fit. The last is not something this function may repair —
 * dropping the scene would be deciding what the picture shows — so the caller
 * is handed the two figures and refuses, exactly as the submit guard does.
 */
export type SceneRenderPromptFit =
  | { kind: 'fits'; prompt: string }
  | { kind: 'trimmed'; prompt: string; styleText: string; droppedStyleCharacters: number }
  | { kind: 'scene-too-long'; headCharacters: number; limit: number }

/**
 * Fit one assembled scene prompt to a published ceiling by shortening the
 * Style Bible at a sentence end.
 *
 * `head` is the prompt with NO Style Bible layer — the scene text and the
 * character details — and must be the exact text the renderer would submit
 * without the bible (`composeSceneRenderPrompt(visual, characters, '', ...)`),
 * so the whole assembly can never disagree with itself.
 *
 * Measured the whole way: the separator and label are counted from the real
 * joined text, the ceiling is counted with the same `trim().length` the
 * provider's submit guard uses, and the kept style text is a SLICE of the
 * original so nothing is re-spaced or rewritten on the way through.
 */
export function fitRenderedStyleBible(options: {
  /** The prompt as composed with the WHOLE Style Bible. */
  full: string
  /** The same prompt with no Style Bible layer at all. */
  head: string
  /** The bare Style Bible text, exactly as `resolveStyleBible` returned it. */
  styleBible: string
  /** The model's published `max_prompt_characters`, read live for this render. */
  limit: number
}): SceneRenderPromptFit {
  const full = options.full
  // A ceiling is a whole number of characters or it is not a ceiling. A
  // fractional, absent or negative figure means the same thing as an
  // unpublished one — no trimming, and no number invented from it.
  const limit = Number(options.limit)
  if (!Number.isInteger(limit) || limit < 1) return { kind: 'fits', prompt: full }
  if (promptCharacterCount(full) <= limit) return { kind: 'fits', prompt: full }

  const head = options.head
  const headCharacters = promptCharacterCount(head)
  if (headCharacters > limit) return { kind: 'scene-too-long', headCharacters, limit }

  // What the style layer costs on top of the head. Measured from the text the
  // renderer really joins with, never assumed — a separator that drifted here
  // would silently produce a prompt the model still refuses.
  const styleBible = options.styleBible
  const separator = '\n\nStyle: '
  const roomForStyleText = limit - headCharacters - separator.length
  if (roomForStyleText < 1 || !styleBible) {
    return { kind: 'trimmed', prompt: head, styleText: '', droppedStyleCharacters: styleBible.length }
  }

  let keepEnd = 0
  for (const sentence of splitStyleSentences(styleBible)) {
    if (sentence.end > roomForStyleText) break
    keepEnd = sentence.end
  }
  if (keepEnd < 1) {
    // No WHOLE sentence fits. Send none rather than the shortest clause or a
    // mid-word slice — a bare label with nothing after it is worse than the
    // scene text alone.
    return { kind: 'trimmed', prompt: head, styleText: '', droppedStyleCharacters: styleBible.length }
  }
  const styleText = styleBible.slice(0, keepEnd).trim()
  const prompt = `${head}${separator}${styleText}`
  return {
    kind: 'trimmed',
    prompt,
    styleText,
    droppedStyleCharacters: styleBible.length - styleText.length,
  }
}

export interface SceneRenderAssembly {
  /** Anchor characters whose description the renderer will append. */
  characters: ScenePromptCharacterDescription[]
  /** The Style Bible text the renderer will append (episode, else project default). */
  styleBible: string
}

/**
 * Resolve anchor characters exactly as the renderer does: a missing/corrupt
 * character is skipped, and a character with no description contributes
 * nothing. The caller has already read `anchor_character_ids` with the
 * renderer's tolerance.
 */
export async function loadAnchorCharacters(
  slug: string,
  ids: readonly unknown[],
): Promise<ScenePromptCharacterDescription[]> {
  const characters: ScenePromptCharacterDescription[] = []
  for (const id of ids) {
    try {
      const character = await getCharacter(slug, id as string)
      const name = (character as any)?.name || String(id)
      const description = typeof (character as any)?.description === 'string'
        ? (character as any).description.trim()
        : ''
      if (description) characters.push({ name, description })
    } catch { /* the renderer skips a missing/corrupt anchor character too */ }
  }
  return characters
}

/**
 * Read the two layers the scene renderer appends for this episode.
 *
 * Both reads match the renderer: `continuity.json` may be absent or malformed
 * (then there are no anchors), and the Style Bible comes from the same
 * `resolveStyleBible` call the renderer makes. A style the renderer WILL append
 * is therefore never counted as zero here.
 */
export async function readSceneRenderAssembly(slug: string, episodeDir: string): Promise<SceneRenderAssembly> {
  let anchorIds: unknown[] = []
  const continuityPath = path.join(episodeDir, 'continuity.json')
  if (existsSync(continuityPath)) {
    try {
      const raw = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      anchorIds = Array.isArray(raw?.anchor_character_ids) ? raw.anchor_character_ids : []
    } catch { /* keep defaults, exactly as the renderer does */ }
  }
  const style = await resolveStyleBible({ slug, episodeDir })
  return {
    characters: await loadAnchorCharacters(slug, anchorIds),
    styleBible: style.text,
  }
}
