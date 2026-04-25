/**
 * Text-only LLM wrapper for "Reference Style" analysis on the Script
 * Generator page. The user pastes 1–5 existing scripts they want to
 * imitate; we ask the LLM to extract the format/style/tone/structure so
 * future script generation can follow that pattern.
 *
 * Narrow scope on purpose — mirrors the image style analyzer (see
 * vision-client.ts). Callers that want a full-featured text completion
 * should build a different helper.
 */

const STYLE_ANALYSIS_PROMPT = `You are analyzing one or more reference scripts to extract patterns a writer can follow when producing NEW scripts in the same vein.

Do NOT summarize the story content. Focus entirely on HOW the scripts are written.

For each of these dimensions, produce 2–5 sentences. Be specific and concrete — cite observable patterns, not generic labels.

1. FORMAT — overall document shape. Chapter/section structure, typical section length, opening conventions, recurring phrasings, how transitions are handled, pacing beats.
2. STYLE — voice and diction. Sentence rhythm, vocabulary register (plain/lyrical/archaic/etc.), preferred sentence lengths, characteristic word choices, point-of-view.
3. TONE — mood and emotional colour. Warmth, calmness, playfulness, reverence, gravity. Include the specific emotional register the scripts aim for.
4. STRUCTURE — narrative architecture. How tension builds and releases, where sensory detail sits vs exposition, how characters are introduced, how scenes are closed out, how the ending is reached.

Return strict JSON, nothing else:
{
  "format": "...",
  "style": "...",
  "tone": "...",
  "structure": "..."
}

No markdown fences, no preamble — just the JSON object.`

export interface ReferenceScript {
  label: string
  text: string
}

export interface AnalyzeStyleInput {
  references: ReferenceScript[]
  model: string
  apiKey: string
}

export interface AnalyzeStyleResult {
  format: string
  style: string
  tone: string
  structure: string
  raw: string
  model_used: string
}

function buildUserMessage(refs: ReferenceScript[]): string {
  const parts = refs.map((r, i) => {
    const label = r.label?.trim() || `Reference ${i + 1}`
    // Cap each reference at ~15k chars — matches Claude/OpenAI token ceilings
    // comfortably even when multiple refs are combined, and keeps the prompt
    // cost-predictable. Users who paste novel-length scripts see a note in
    // the UI; truncation happens silently server-side as a safety net.
    const body = (r.text || '').slice(0, 15000)
    return `=== ${label} ===\n${body}`
  })
  return `Here ${refs.length === 1 ? 'is' : 'are'} ${refs.length} reference script(s) to analyze:\n\n${parts.join('\n\n')}`
}

async function callAnthropic(input: AnalyzeStyleInput): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: input.apiKey })
  const resp = await client.messages.create({
    model: input.model,
    max_tokens: 2000,
    system: STYLE_ANALYSIS_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(input.references) }],
  })
  const textBlock = resp.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') throw new Error('Anthropic returned no text')
  return textBlock.text.trim()
}

async function callOpenAi(input: AnalyzeStyleInput): Promise<string> {
  const { default: OpenAI } = await import('openai')
  const { isCompletionTokensModel } = await import('../providers/text/openai.js')
  const client = new OpenAI({ apiKey: input.apiKey })
  // gpt-5 and reasoning models (o1/o3/o4) reject `max_tokens` and require
  // `max_completion_tokens` instead — pick the right field based on model.
  const tokenField = isCompletionTokensModel(input.model)
    ? { max_completion_tokens: 2000 }
    : { max_tokens: 2000 }
  const resp = await client.chat.completions.create({
    model: input.model,
    ...tokenField,
    messages: [
      { role: 'system', content: STYLE_ANALYSIS_PROMPT },
      { role: 'user', content: buildUserMessage(input.references) },
    ],
  })
  const text = resp.choices[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('OpenAI returned no text')
  return text.trim()
}

function parseJsonLoose(raw: string): { format: string; style: string; tone: string; structure: string } {
  // Some models wrap JSON in ```json fences despite the "no fences" instruction.
  // Strip fences if present, then try to locate the JSON object.
  let s = raw.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim()
  }
  // Grab the outermost braces in case the model prepended a sentence.
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('Analyzer did not return a JSON object')
  const jsonText = s.slice(start, end + 1)
  const parsed = JSON.parse(jsonText)
  return {
    format: String(parsed.format || '').trim(),
    style: String(parsed.style || '').trim(),
    tone: String(parsed.tone || '').trim(),
    structure: String(parsed.structure || '').trim(),
  }
}

export async function analyzeScriptStyle(input: AnalyzeStyleInput): Promise<AnalyzeStyleResult> {
  if (!input.apiKey) throw new Error('API key required for style analysis')
  if (!Array.isArray(input.references) || !input.references.length) {
    throw new Error('At least one reference script is required')
  }
  if (input.references.length > 5) {
    throw new Error('Up to 5 reference scripts are supported')
  }
  const model = input.model || 'claude-sonnet-4-6'

  let raw: string
  if (model.startsWith('claude')) {
    raw = await callAnthropic({ ...input, model })
  } else if (model.startsWith('gpt')) {
    raw = await callOpenAi({ ...input, model })
  } else {
    throw new Error(`Model ${model} is not supported for script style analysis. Use a Claude or GPT model.`)
  }

  const parsed = parseJsonLoose(raw)
  return { ...parsed, raw, model_used: model }
}
