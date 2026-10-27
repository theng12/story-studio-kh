/**
 * The Still Posts batch writer.
 *
 * ONE request makes the whole batch: N posts, each a quote (or a setup/punchline pair) and the
 * scene each picture shows. Owner, 2026-10-27: posts are "written and drawn in BATCHES", so asking
 * the model once per post would be slower, dearer and would drift in voice across the batch.
 *
 * The rules that matter:
 *  - **The model is never chosen here** (AGENTS §1/§7). The caller passes the model a preset
 *    remembered, or nothing at all — and then this Mac's writing default decides. No literal id.
 *  - **The picture words are scene-only.** Any lettering the model tries to put in the picture is
 *    discarded, because our own renderer draws every word (khmer included).
 *  - **A short batch is a failure, loudly** (AGENTS §8). Fewer usable posts than requested is
 *    reported with the count, never quietly written as a smaller batch.
 */

import { callAi, parseStructuredJson } from '../lib/ai-client.js'
import { getApiKey } from './app-secrets-store.js'
import { resolveChosenChatModel } from './genstudio-default-model.js'
import type { StillPostFormat, StillPostOption, StillPostsLanguage } from '../contracts/still-posts.js'
import { STILL_POST_LANGUAGE_LABELS } from '../contracts/still-posts.js'

export interface StillPostDraftPanel {
  text: string
  scene_prompt: string
}

export interface StillPostDraft {
  panels: StillPostDraftPanel[]
  caption: string
}

export interface WriteStillPostsInput {
  brief: string
  count: number
  format: StillPostFormat
  option: StillPostOption
  language: StillPostsLanguage
  /** The channel's Formula voice, when it declares one. */
  voice: string
  /** A live Gateway chat model id saved on the preset, or null for this Mac's default. */
  writingModel: string | null
  /** Stable identity for the request, so a Retry reconnects instead of writing a second batch. */
  requestIdentity: string
  where: string
}

/** The character budget one quote gets, per language, before it stops fitting a post. */
const MAX_QUOTE_CHARACTERS: Record<StillPostsLanguage, number> = { en: 110, km: 90, zh: 62 }

function panelInstructions(option: StillPostOption): string {
  if (option.panels === 2) {
    return [
      'Each post has TWO panels read together: a setup and a punchline.',
      '- "setup" is the first panel: an ordinary observation or a question.',
      '- "punchline" is the second panel: the turn. Same situation, one beat later.',
      '- Each panel carries its own short line (at most two lines once wrapped).',
    ].join('\n')
  }
  return 'Each post has ONE panel: one short quote, the whole thought, complete on its own.'
}

export function buildWritePrompt(input: WriteStillPostsInput): string {
  const languageName = STILL_POST_LANGUAGE_LABELS[input.language]
  const budget = MAX_QUOTE_CHARACTERS[input.language]
  return [
    `Write ${input.count} social posts for a Still Posts channel. The words appear burned into an illustration.`,
    '',
    input.voice ? `Channel voice:\n${input.voice}` : '',
    input.brief ? `Brief for this batch: ${input.brief}` : '',
    '',
    `Every word you write must be in ${languageName}. Write as a native speaker of ${languageName} would; do not translate from English.`,
    '',
    'The look of the pictures (write scenes that suit it):',
    input.format.style_bible,
    `Background treatment: ${input.format.background}`,
    '',
    panelInstructions(input.option),
    '',
    'Rules for every line:',
    `- At most ${budget} characters, because it is burned into a picture. Shorter is better.`,
    '- Concrete and specific: name an object, a time of day, a small action. Never a slogan.',
    '- No quotes attributed to anyone, no emoji, no hashtags in the line itself, no markdown.',
    '- Do not describe the picture in the line; the picture is described separately.',
    '- No line may be advice, a lesson, or a call to action.',
    '',
    'Rules for every scene:',
    '- ONE sentence describing what the picture shows: the setting, the character\'s pose or action, the mood.',
    '- Describe NO words, letters, numbers, logos or signs — the picture is drawn text-free.',
    '- Vary the scenes across the batch; do not repeat the same setting twice.',
    '',
    'Also write a short social caption for each post (one or two sentences plus three hashtags), '
    + `in ${languageName}.`,
    '',
    'Reply with JSON only, in exactly this shape:',
    input.option.panels === 2
      ? '{"posts":[{"setup":{"line":"...","scene":"..."},"punchline":{"line":"...","scene":"..."},"caption":"..."}]}'
      : '{"posts":[{"line":"...","scene":"...","caption":"..."}]}',
  ].filter(line => line !== '').join('\n')
}

/** A quote is the words that get burned in: trimmed, single-spaced, never carrying a stray newline run. */
function normalizeLine(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function normalizeScene(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

/** Read one post out of whatever shape the model returned, or null when it is unusable. */
export function readDraft(entry: unknown, option: StillPostOption, language: StillPostsLanguage): StillPostDraft | null {
  const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, any>
  const max = MAX_QUOTE_CHARACTERS[language]
  const caption = String(record.caption ?? '').trim().slice(0, 1200)

  if (option.panels === 2) {
    const setup = record.setup && typeof record.setup === 'object' ? record.setup : null
    const punchline = record.punchline && typeof record.punchline === 'object' ? record.punchline : null
    if (!setup || !punchline) return null
    const panels = [
      { text: normalizeLine(setup.line, max), scene_prompt: normalizeScene(setup.scene) },
      { text: normalizeLine(punchline.line, max), scene_prompt: normalizeScene(punchline.scene) },
    ]
    if (panels.some(panel => !panel.text || !panel.scene_prompt)) return null
    return { panels, caption }
  }

  const text = normalizeLine(record.line ?? record.quote ?? record.text, max)
  const scene = normalizeScene(record.scene ?? record.scene_prompt)
  if (!text || !scene) return null
  return { panels: [{ text, scene_prompt: scene }], caption }
}

/**
 * Ask the writing model for a batch.
 *
 * Throws — with the model's name or the "choose one on <where>" sentence — rather than substituting
 * a model, and throws when the answer cannot be read as JSON. It does NOT decide whether the batch
 * is big enough; the caller owns that count and reports it.
 */
export async function writeStillPosts(input: WriteStillPostsInput): Promise<StillPostDraft[]> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  const model = await resolveChosenChatModel(apiKey, input.writingModel, input.where)

  const raw = await callAi(model, '', buildWritePrompt(input), {}, false, {
    outputBudget: 'standard' as import('./output-token-budget.js').OutputBudgetTier,
    jsonMode: true,
    disableReasoning: true,
    temperature: 0.9,
    requestIdentity: input.requestIdentity,
  })

  let parsed: unknown
  try {
    parsed = parseStructuredJson(raw)
  } catch (error: any) {
    throw new Error(
      `The writing model (${model}) returned something that is not readable as a batch of posts `
      + `(${error?.message || error}). Nothing was written to disk. Try again.`,
    )
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.posts)
      ? (parsed as any).posts
      : null
  if (!rows) {
    throw new Error(
      `The writing model (${model}) returned no posts list. Nothing was written to disk. Try again.`,
    )
  }

  const drafts: StillPostDraft[] = []
  for (const row of rows) {
    const draft = readDraft(row, input.option, input.language)
    if (draft) drafts.push(draft)
  }
  return drafts
}

/** The sentence a short batch is reported with — it names what is missing and what Retry does. */
export function shortBatchMessage(requested: number, got: number): string {
  return `The writing model returned ${got} usable post${got === 1 ? '' : 's'} of the ${requested} requested. `
    + `The ${got} usable post${got === 1 ? ' was' : 's were'} kept. `
    + 'Retry writes only the missing ones; it does not rewrite the posts already on screen.'
}

export { MAX_QUOTE_CHARACTERS }
