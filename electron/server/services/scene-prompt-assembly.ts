/**
 * The ONE composition of a scene image prompt.
 *
 * A stored `visual_prompt` is not the text the image model receives. The scene
 * renderer appends the anchor character descriptors and the Style Bible to
 * every prompt it renders (`generators/continuity-render.ts`), for EVERY
 * project — the renderer is the only scene-image path. Scene Plan therefore has
 * to budget the writer against a ceiling that leaves room for exactly this
 * text.
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
 * Nothing here shortens a prompt, and nothing invents a limit.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveStyleBible } from '../lib/style-bible.js'
import { getCharacter } from './character-manager.js'
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
