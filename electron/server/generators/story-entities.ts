/**
 * Story entity extraction — Episode Visual Setup, extraction phase
 * (owner-approved 2026-11-05: decisions 54959 → 54963 → 54879).
 *
 * Reads THIS episode's completed chapters and proposes the cast, places,
 * world facts and objects the story actually uses, so the Character Sheet's
 * Story context can be reviewed against the whole script instead of typed
 * from memory. Nothing is added to the inventory here: the proposals go back
 * to the page, the customer keeps or drops each one, and only then does the
 * normal sidecar save write it.
 *
 * The rules that matter:
 *  - **The model is never chosen here** (AGENTS §1/§7). It is the writing
 *    model saved on the active Scene Plan preset — the same product that
 *    writes the episode — and an absent one is a plain refusal, never a
 *    substituted catalogue default.
 *  - **Sizing is live** (AGENTS §1). Chunk boundaries come from the selected
 *    product's published `max_prompt_characters` / `context_window_tokens` and
 *    `max_output_tokens`; a product that publishes neither is refused rather
 *    than sent a guessed limit.
 *  - **Story facts only.** The prompt forbids art style, medium, camera and
 *    channel look; the same boundary the sidecar documents.
 *  - **A partial extraction writes nothing** (AGENTS §8). Every chunk must
 *    parse before the provenance record lands, and the record never touches
 *    the inventory's entities.
 */

import { callAi, parseStructuredJson } from '../lib/ai-client.js'
import { listChatModels } from '../lib/genstudio-client.js'
import { estimatePromptTokens, nonAsciiCharacterCount, resolveOutputTokenBudget } from '../services/output-token-budget.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveChosenChatModel } from '../services/genstudio-default-model.js'
import { resolveExactPreset } from '../services/preset-authority.js'
import { getConfig } from '../services/project-manager.js'
import {
  readCompletedChapterTexts,
  readStoryEntities,
  recordStoryExtraction,
} from '../services/story-entities.js'
import {
  STORY_ENTITY_DESCRIPTION_MAX,
  STORY_ENTITY_NAME_MAX,
  canonicalStoryEntityId,
  isStoryEntityKind,
  type StoryEntitiesExtraction,
  type StoryEntity,
  type StoryEntityKind,
  type StoryEntityProposal,
} from '../contracts/story-entities.js'

export class StoryEntitiesExtractionError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'StoryEntitiesExtractionError'
  }
}

/** The Scene Plan preset is where the episode's writing model is selected. */
const SCENE_PLAN_PRESET = {
  list: 'scene_plan_presets',
  activeKeys: ['scene_plan_last_preset_scene-plan', 'scene_plan_last_preset'],
  label: 'Scene Plan',
}

export const EXTRACTION_SYSTEM_PROMPT = [
  'You read one completed episode script and list the story entities it actually uses.',
  'Reply with JSON only, in exactly this shape:',
  '{"entities":[{"kind":"cast|location|world|object","name":"...","description":"...","important":true}]}',
  '',
  'Kinds:',
  '- cast: a named person or character who acts or speaks in the story.',
  '- location: a named place the story visits.',
  '- world: a rule, culture, technology, creature or fact of this story\'s world.',
  '- object: a distinctive item the story uses or returns to.',
  '',
  'Rules:',
  '- Only entities present in the text you are given. Never invent one.',
  '- description holds STORY FACTS ONLY: appearance, outfit, age, physical state, time of day, weather, damage, injuries, and how they change during the episode.',
  '- Never describe art style, medium, rendering, camera, colour palette, lettering or channel look.',
  '- Use the story\'s own name; reconcile variant spellings to the most complete form.',
  '- important: true only when a scene would be drawn wrong without one canonical reference (a recurring character, a key place, a signature object).',
  '- One concrete sentence per description. No markdown, no prose outside the JSON.',
].join('\n')

/** Room for the per-chunk instruction line and JSON wrapper around the text. */
const PROMPT_OVERHEAD_CHARS = 400

export interface ExtractionSizing {
  maxPromptCharacters?: number
  contextWindowTokens?: number
  outputTokens: number | null
}

export interface ExtractionChunk {
  numbers: number[]
  text: string
}

export interface ExtractedStoryEntity {
  id: string
  kind: StoryEntityKind
  name: string
  description: string
  important: boolean
}

function fitsChunk(
  text: string,
  sizing: ExtractionSizing,
  systemPrompt: string,
): boolean {
  const promptCharacters = systemPrompt.length + text.length + PROMPT_OVERHEAD_CHARS
  if (sizing.maxPromptCharacters !== undefined && promptCharacters > sizing.maxPromptCharacters) return false
  if (sizing.contextWindowTokens !== undefined) {
    const available = sizing.contextWindowTokens - (sizing.outputTokens ?? 0)
    if (available < 1) return false
    if (estimatePromptTokens(promptCharacters, nonAsciiCharacterCount(text)) > available) return false
  }
  return true
}

/** Halve a too-long segment at the nearest newline/space, so a huge chapter still fits. */
function splitToFit(text: string, fits: (value: string) => boolean): string[] {
  if (fits(text)) return [text]
  if (text.length <= 1) return []
  let cut = Math.floor(text.length / 2)
  const newline = text.lastIndexOf('\n', cut)
  const space = text.lastIndexOf(' ', cut)
  const at = Math.max(newline, space)
  if (at > text.length * 0.25) cut = at + 1
  return [...splitToFit(text.slice(0, cut), fits), ...splitToFit(text.slice(cut), fits)]
}

/**
 * Split the completed chapters into requests that fit the SELECTED product's
 * published limits. Chapter order is preserved; a chunk names the chapters it
 * covers so the model never invents what another chunk holds.
 */
export function planExtractionChunks(
  chapters: { number: number; text: string }[],
  sizing: ExtractionSizing,
  systemPrompt: string = EXTRACTION_SYSTEM_PROMPT,
): ExtractionChunk[] {
  if (sizing.maxPromptCharacters === undefined && sizing.contextWindowTokens === undefined) {
    throw new StoryEntitiesExtractionError(
      'The selected writing model publishes no prompt limit, so the completed script cannot be sized for extraction. '
      + 'Choose a model that publishes one in Scene Plan, then try again.',
    )
  }
  const fits = (value: string) => fitsChunk(value, sizing, systemPrompt)
  const chunks: ExtractionChunk[] = []
  let current: ExtractionChunk = { numbers: [], text: '' }

  for (const chapter of chapters) {
    const segments = chapter.text.split(/\n{2,}/).map(segment => segment.trim()).filter(Boolean)
    const parts = segments.length ? segments : [chapter.text]
    for (const segment of parts) {
      const pieces = splitToFit(segment, fits)
      if (!pieces.length) {
        throw new StoryEntitiesExtractionError(
          `Chapter ${chapter.number} has a passage that does not fit the selected model's published prompt limit. `
          + 'Choose a model with a larger limit in Scene Plan, then try again.',
        )
      }
      for (const piece of pieces) {
        const nextText = current.text ? `${current.text}\n\n${piece}` : piece
        if (current.numbers.length && !fits(nextText)) {
          chunks.push(current)
          current = { numbers: [chapter.number], text: piece }
        } else {
          current.text = nextText
          if (!current.numbers.includes(chapter.number)) current.numbers.push(chapter.number)
        }
      }
    }
  }
  if (current.text) chunks.push(current)
  return chunks
}

export function buildExtractionUserPrompt(
  episodeId: string,
  chunk: ExtractionChunk,
  totalChapters: number,
): string {
  const range = chunk.numbers.length === 1
    ? `chapter ${chunk.numbers[0]}`
    : `chapters ${chunk.numbers[0]}–${chunk.numbers[chunk.numbers.length - 1]}`
  return [
    `Episode ${episodeId}. This text is ${range} of ${totalChapters} completed chapter(s).`,
    'List the story entities that appear in THIS text only. Do not guess entities from other chapters.',
    '',
    chunk.text,
  ].join('\n')
}

/**
 * Read one chunk's rows into the accumulator. Returns how many rows were
 * unusable, so the caller can report them instead of pretending the answer
 * was complete (§8). A duplicate entity from another chunk merges: the more
 * complete story facts win and `important` is OR-ed.
 */
export function accumulateExtracted(
  rows: unknown[],
  into: Map<string, ExtractedStoryEntity>,
): number {
  let skipped = 0
  for (const row of rows) {
    const record = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<string, unknown>
    if (!isStoryEntityKind(record.kind)) {
      skipped++
      continue
    }
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name || name.length > STORY_ENTITY_NAME_MAX) {
      skipped++
      continue
    }
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    if (description.length > STORY_ENTITY_DESCRIPTION_MAX) {
      skipped++
      continue
    }
    const key = canonicalStoryEntityId(record.kind, name)
    const important = record.important === true
    const previous = into.get(key)
    if (!previous) {
      into.set(key, { id: key, kind: record.kind, name, description, important })
      continue
    }
    if (description.length > previous.description.length) previous.description = description
    previous.important = previous.important || important
  }
  return skipped
}

/** Mint final ids, de-duplicated across the whole extraction. */
export function finalizeExtracted(into: Map<string, ExtractedStoryEntity>): ExtractedStoryEntity[] {
  const used = new Set<string>()
  const out: ExtractedStoryEntity[] = []
  for (const entity of into.values()) {
    const id = canonicalStoryEntityId(entity.kind, entity.name, used)
    used.add(id)
    out.push({ ...entity, id })
  }
  return out
}

/**
 * Attach the stored record to a proposal when its id already exists. The
 * customer's Keep/Drop and `important` choices win over the model's — a
 * re-extraction never reverses a decision, and a dropped entity stays dropped.
 */
export function annotateProposals(
  extracted: ExtractedStoryEntity[],
  stored: StoryEntity[],
): StoryEntityProposal[] {
  const byId = new Map(stored.map(entity => [entity.id, entity]))
  return extracted.map(entity => {
    const existing = byId.get(entity.id)
    if (!existing) return { ...entity, existing: false, review: 'keep' }
    const current = existing.description || ''
    return {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      description: entity.description,
      important: existing.important,
      existing: true,
      review: existing.review,
      ...(current && current !== entity.description ? { current_description: current } : {}),
    }
  })
}

function extractionError(part: number, total: number, message: string): Error {
  return new Error(
    `Reading the completed script failed (part ${part} of ${total}): ${message}. Nothing was changed.`,
  )
}

/**
 * Extract proposals for one episode. Read-only against the inventory's
 * entities; on success it records which script was read, so a later page load
 * can say honestly whether the script has changed since.
 */
export async function extractEpisodeStoryEntities(
  slug: string,
  episodeId: string,
): Promise<StoryEntitiesExtraction> {
  // Validates the episode (404 before any work) and gives the proposals the
  // stored Keep/Drop decisions they must preserve.
  const current = await readStoryEntities(slug, episodeId)
  const script = await readCompletedChapterTexts(slug, episodeId)
  if (script.chapters === null) {
    throw new StoryEntitiesExtractionError(
      'The completed script folder is not on disk, so there is nothing to extract from. Generate the chapters first, then extract.',
    )
  }
  if (script.chapters === 0) {
    throw new StoryEntitiesExtractionError(
      'No completed chapter files were found for this episode. Generate the chapters first, then extract.',
    )
  }
  if (!script.fingerprint) {
    throw new StoryEntitiesExtractionError(
      'The completed chapter files could not be measured, so extraction cannot record which script it read. '
      + 'Check this episode\'s script folder, then try again.',
    )
  }

  const config = await getConfig(slug)
  if (!config) throw new StoryEntitiesExtractionError('Channel not found.')
  const { preset, missingReason } = resolveExactPreset(
    config,
    SCENE_PLAN_PRESET.list,
    SCENE_PLAN_PRESET.activeKeys,
    undefined,
    SCENE_PLAN_PRESET.label,
  )
  const chosen = typeof preset?.data?.model === 'string' ? preset.data.model.trim() : ''
  if (!chosen) {
    throw new StoryEntitiesExtractionError(
      missingReason || 'The active Scene Plan preset has no writing model. Choose one in Scene Plan, then try again.',
    )
  }

  const apiKey = await getApiKey('genstudio').catch(() => '')
  const model = await resolveChosenChatModel(apiKey, chosen, 'Scene Plan')
  const catalogue = await listChatModels(apiKey)
  const product = catalogue.find(entry => entry.id === model)
  if (!product) {
    throw new StoryEntitiesExtractionError(
      `The writing model "${model}" is not in the live catalogue, so its limits cannot be read. Choose another in Scene Plan.`,
    )
  }
  const maxPromptCharacters = Number.isInteger(product.max_prompt_characters) && product.max_prompt_characters! > 0
    ? product.max_prompt_characters!
    : undefined
  const contextWindowTokens = Number.isInteger(product.context_window_tokens) && product.context_window_tokens! > 0
    ? product.context_window_tokens!
    : undefined
  const outputTokens = resolveOutputTokenBudget('standard', product.max_output_tokens)
  const sizing: ExtractionSizing = { maxPromptCharacters, contextWindowTokens, outputTokens }

  const chunks = planExtractionChunks(script.texts, sizing)
  if (!chunks.length) {
    throw new StoryEntitiesExtractionError('The completed chapters are empty, so there is nothing to extract.')
  }

  const accumulated = new Map<string, ExtractedStoryEntity>()
  let skippedRows = 0
  for (const [index, chunk] of chunks.entries()) {
    const part = index + 1
    let raw: string
    try {
      raw = await callAi(
        model,
        EXTRACTION_SYSTEM_PROMPT,
        buildExtractionUserPrompt(episodeId, chunk, script.chapters),
        {},
        false,
        {
          outputBudget: 'standard',
          jsonMode: true,
          disableReasoning: true,
          temperature: 0.2,
          // Stable across a retry of the same script, so a retry reconnects
          // instead of paying for a second read.
          requestIdentity: `story-entities:${slug}:${episodeId}:${script.fingerprint}:${index}`,
        },
      )
    } catch (error: any) {
      throw extractionError(part, chunks.length, error?.message || String(error))
    }

    let parsed: unknown
    try {
      parsed = parseStructuredJson(raw)
    } catch (error: any) {
      throw extractionError(part, chunks.length, `the answer was not readable as JSON (${error?.message || error})`)
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as any)?.entities)
        ? (parsed as any).entities
        : null
    if (!rows) throw extractionError(part, chunks.length, 'the answer held no entities list')
    skippedRows += accumulateExtracted(rows, accumulated)
  }

  const extracted = finalizeExtracted(accumulated)
  const extractedAt = new Date().toISOString()

  // Provenance only after every chunk parsed. The inventory's entities are
  // untouched: the customer reviews the proposals before anything is added.
  await recordStoryExtraction(slug, episodeId, {
    extracted_at: extractedAt,
    model,
    chapters: script.chapters,
    script_fingerprint: script.fingerprint,
  })

  return {
    proposals: annotateProposals(extracted, current.doc.entities),
    chapters: script.chapters,
    model,
    script_fingerprint: script.fingerprint,
    extracted_at: extractedAt,
    skipped_rows: skippedRows,
  }
}
