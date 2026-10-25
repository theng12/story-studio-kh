/**
 * Headline suggestions for the thumbnail text layer.
 *
 * The owner draws a real headline; this offers candidate headlines from the episode's own title and
 * script. Two rules are load-bearing:
 *
 * 1. **Story Studio does not own the writing model** (AGENTS §1 and §7, owner 2026-10-17). The model
 *    is whichever one this channel's active **Thumbnail Prompts** preset names — the same preset the
 *    thumbnail-prompt generator uses. Nothing is hardcoded, and when no preset names a model the
 *    caller gets a plain sentence saying where to choose one, never a substituted model.
 * 2. **The suggestions are written in the channel's language.** The channel's own language setting
 *    wins when it has one; otherwise the script, then the title, decide (the same script detection
 *    the narration guard uses).
 *
 * One request per call — no loops, no retries, no paid fallback.
 */

import { callAi, parseStructuredJson } from '../lib/ai-client.js'
import { resolveChosenChatModel } from './genstudio-default-model.js'
import { getApiKey } from './app-secrets-store.js'
import { dominantScript } from './tts-language-guard.js'
import type { ThumbnailTextSuggestions } from '../contracts/thumbnail-text.js'
import type { OutputBudgetTier } from './output-token-budget.js'

/** The config key the Thumbnail Prompts page writes its preset list to (AGENTS §7). */
const PRESET_LIST_KEY = 'thumbnail_prompts_presets'
const PRESET_ACTIVE_KEYS = ['thumbnail_prompts_last_preset']

export interface SuggestionSource {
  title: string
  script: string
  /** The channel's own language setting, when it has one. */
  channelLanguage?: string | null
  /** The episode's own choice for its thumbnail text; wins over the channel language (§4/§5). */
  overrideLanguage?: string | null
}

/**
 * The writing model the channel's active Thumbnail Prompts preset names.
 *
 * Preset shapes in this app are not uniform: a typed preset nests its form, an older one is flat, and
 * the thumbnail-prompts page has stored the model under `model`, `form.model` and `prompt_model`
 * over its life. All three are read, so a preset the rest of the app can read is never reported as
 * model-less — the same reasoning `PRESET_MODEL_READERS` documents in `routes/pipeline.ts`.
 */
export function modelFromThumbnailPromptsPreset(config: Record<string, any> | null | undefined): string {
  if (!config) return ''
  const list = Array.isArray(config[PRESET_LIST_KEY]) ? config[PRESET_LIST_KEY] : []
  if (!list.length) return ''
  const activeId = PRESET_ACTIVE_KEYS.map(key => config[key]).find(value => typeof value === 'string' && value) || ''
  const preset = list.find((entry: any) => entry?.id === activeId)
    || list.find((entry: any) => entry?.last_used === true)
    || list[list.length - 1]
  const data = (preset?.data ?? preset) as Record<string, any> | undefined
  if (!data) return ''
  return String(data.form?.model || data.model || data.prompt_model || '').trim()
}

/**
 * The language the suggestions should be written in, and why.
 *
 * The episode's own thumbnail-text choice wins, then the channel's language, then the script, then
 * the title. A Latin title on a Khmer channel is NOT enough to call it English — hence the order,
 * and the `language_source` the contract carries so the page can say which rule applied.
 */
export function resolveSuggestionLanguage(source: SuggestionSource): {
  language: string
  language_source: 'override' | 'channel' | 'script' | 'title'
} {
  const override = baseLanguage(source.overrideLanguage)
  if (override) return { language: override, language_source: 'override' }
  const channel = baseLanguage(source.channelLanguage)
  if (channel) return { language: channel, language_source: 'channel' }
  const fromScript = scriptLanguage(source.script)
  if (fromScript) return { language: fromScript, language_source: 'script' }
  const fromTitle = scriptLanguage(source.title)
  if (fromTitle) return { language: fromTitle, language_source: 'title' }
  // Nothing distinctive about the writing system: English is the app's default and the honest
  // answer, and `language_source` says the decision came from the title/nothing rather than a rule.
  return { language: 'en', language_source: 'title' }
}

/** A stated language as its BCP-47 base tag ('en-US' → 'en'); '' when none was stated. */
function baseLanguage(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().split(/[-_]/)[0] || ''
}

function scriptLanguage(text: string): string | null {
  const script = dominantScript(text || '')
  if (!script) return null
  // The script's own first language code: 'km' for Khmer, 'en' for Latin.
  return script.name === 'Latin' ? 'en' : script.codes[0] || null
}

/** Languages the prompt can name, so the model is not left guessing from a bare code. */
const LANGUAGE_NAMES: Record<string, string> = {
  km: 'Khmer',
  en: 'English',
  th: 'Thai',
  lo: 'Lao',
  my: 'Burmese',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  vi: 'Vietnamese',
  hi: 'Hindi',
  ru: 'Russian',
  ar: 'Arabic',
}

function buildPrompt(source: SuggestionSource, language: string): string {
  const languageName = LANGUAGE_NAMES[language] || language
  return [
    `Write YouTube thumbnail headlines in ${languageName} for this episode.`,
    '',
    source.title ? `Episode title: ${source.title}` : '',
    source.script ? `Episode script (excerpt):\n${source.script.slice(0, 4000)}` : '',
    '',
    'Rules:',
    `- Every headline must be written in ${languageName}. Do not translate the script; write as a native speaker of ${languageName} would.`,
    '- Return 9 headlines: 3 short (2-4 words), 3 medium (5-8 words), 3 longer (9-14 words).',
    '- A thumbnail headline is read at a glance: concrete, specific, no clickbait lies, no quotes, no emoji.',
    '- Never repeat the episode title verbatim.',
    '',
    'Reply with JSON only, in this exact shape:',
    '{"suggestions":[{"text":"...","length":"short"},{"text":"...","length":"medium"},{"text":"...","length":"long"}]}',
  ].filter(line => line !== '').join('\n')
}

interface ParsedSuggestions {
  suggestions?: Array<{ text?: unknown, length?: unknown }>
}

/**
 * Ask the channel's own writing model for headlines.
 *
 * Refuses, with the customer-readable sentence, when the active preset names no model — the same
 * refusal the Pipeline preflight gives for a model-less preset, because inventing a model here would
 * be Story Studio choosing what the owner's copy is written with.
 */
export async function suggestThumbnailHeadlines(input: {
  config: Record<string, any> | null | undefined
  source: SuggestionSource
  where: string
}): Promise<ThumbnailTextSuggestions> {
  const chosen = modelFromThumbnailPromptsPreset(input.config)
  const apiKey = await getApiKey('genstudio').catch(() => '')
  // Throws with the "choose one on <where>" sentence when nothing is chosen, and with the model's
  // name when the chosen one is no longer usable. Never substitutes.
  const model = await resolveChosenChatModel(apiKey, chosen, input.where)

  const { language, language_source } = resolveSuggestionLanguage(input.source)
  const raw = await callAi(model, '', buildPrompt(input.source, language), {}, false, {
    outputBudget: 'standard' as import('./output-token-budget.js').OutputBudgetTier,
    jsonMode: true,
    disableReasoning: true,
    temperature: 0.8,
    requestIdentity: `thumbnail-text-suggestions:${language}:${input.source.title.slice(0, 80)}`,
  })

  const parsed = parseStructuredJson(raw) as ParsedSuggestions | undefined
  const suggestions = (parsed?.suggestions ?? [])
    .map(entry => {
      const rawLength = entry?.length
      const length: 'short' | 'medium' | 'long' =
        rawLength === 'short' || rawLength === 'medium' || rawLength === 'long'
          ? rawLength
          : 'medium'
      return {
        text: String(entry?.text ?? '').trim(),
        length,
      }
    })
    .filter(entry => entry.text.length > 0)

  if (!suggestions.length) {
    throw new Error(
      'The writing model returned no usable headlines. Nothing was written to disk. Try again, '
      + 'or type a headline yourself.',
    )
  }

  return { language, language_source, suggestions, model }
}
